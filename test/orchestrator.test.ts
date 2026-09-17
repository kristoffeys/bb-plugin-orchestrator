import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import plugin, { deriveCoordinatorTitle, ORCHESTRATOR_MIGRATIONS, waitForEnvironmentAttachment } from "../server.ts";
import { DEFAULT_POLICY, effectiveProtectedBranches, parseOrchestrationPolicy } from "../lib/policy.ts";
import { encodeNewThreadOrchestrationMarker } from "../lib/new-thread-marker.ts";

const projects = [
  { id: "personal", name: "Personal", kind: "personal", sources: [] },
  { id: "api", name: "API", kind: "standard", sources: [{ path: "/repos/api", isDefault: true, hostId: "host-local" }] },
  { id: "web", name: "Web", kind: "standard", sources: [{ path: "/repos/web", isDefault: true, hostId: "host-local" }] },
];

const model = (id: string, defaultReasoningEffort = "medium") => ({
  id,
  model: id,
  displayName: id,
  description: `${id} model`,
  isDefault: defaultReasoningEffort === "medium",
  defaultReasoningEffort,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(
    (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
  ),
});

const providerModels: Record<string, ReturnType<typeof model>[]> = {
  codex: [model("gpt-5.6-luna", "low"), model("gpt-5.6-terra"), model("gpt-5.6-sol", "high"), model("gpt-6-astra", "xhigh")],
  "claude-code": [model("claude-haiku-4-5-20251001", "low"), model("claude-sonnet-5"), model("claude-fable-5-1", "high"), model("claude-opus-5[1m]", "xhigh")],
  opencode: [model("budget-code", "low"), model("balanced-code"), model("deep-code", "high")],
};

test("upgrades the prior released migration ledger without changing its statements", () => {
  const db = new Database(":memory:");
  for (const statement of ORCHESTRATOR_MIGRATIONS.slice(0, 12)) db.exec(statement);
  assert.equal(ORCHESTRATOR_MIGRATIONS[11], "CREATE INDEX IF NOT EXISTS workstreams_parent_idx ON workstreams(coordinator_thread_id, parent_key)");
  db.exec(ORCHESTRATOR_MIGRATIONS[12]);
  db.exec(ORCHESTRATOR_MIGRATIONS[13]);
  assert.deepEqual(
    (db.prepare("PRAGMA table_info(workstreams)").all() as Array<{ name: string }>).map((column) => column.name).slice(-2),
    ["requested_reasoning_level", "configured_reasoning_level"],
  );
  assert.ok((db.prepare("PRAGMA table_info(workstreams)").all() as Array<{ name: string }>).some((column) => column.name === "configured_reasoning_level"));
  assert.ok((db.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>).some((column) => column.name === "steps_json"));
  db.close();
});

async function load(providerId = "codex", options: { delayedAttachmentGets?: number; provisioningStatus?: "error"; failFirstReuseProvisioning?: boolean } = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const spawned: Array<Record<string, unknown>> = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const archived: string[] = [];
  const stopped: string[] = [];
  const retries: Array<Record<string, unknown>> = [];
  const eventRows = new Map<string, unknown[]>();
  const environmentDiffInputs: Array<Record<string, unknown>> = [];
  const attachmentTargets = new Map<string, string>();
  const attachmentGets = new Map<string, number>();
  let nextId = 1;
  let reuseFailureRemaining = options.failFirstReuseProvisioning ? 1 : 0;
  threads.set("coord", makeThreadResponse({ id: "coord", projectId: "personal", providerId }));
  metadata.set("coord", { role: "coordinator", label: "Product", allowedProjectIds: ["api", "web"] });

  const { bb, harness } = createFakePluginHost({
    pluginId: "orchestrator",
    sdk: {
      projects: { list: async () => projects as never },
      providers: {
        list: async () => Object.keys(providerModels).map((id) => ({ id, displayName: id, available: true })) as never,
        models: async ({ providerId: requested }: { providerId?: string }) => ({
          providers: [],
          models: providerModels[requested ?? ""] ?? [],
          selectedOnlyModels: [],
          permissionCeiling: "full",
          modelLoadError: null,
        }) as never,
      } as never,
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw new Error("not found");
          const remaining = attachmentGets.get(threadId);
          if (remaining !== undefined) {
            if (remaining <= 1) {
              thread.environmentId = attachmentTargets.get(threadId) ?? null;
              attachmentGets.delete(threadId);
            } else {
              attachmentGets.set(threadId, remaining - 1);
            }
          }
          return thread;
        },
        output: async () => ({ output: "Worker output." }) as never,
        conversationOutline: async () => ({ items: [] }) as never,
        context: async () => ({ usage: null }) as never,
        timeline: async () => ({ maxSeq: 0, rows: [], pendingTodos: null }) as never,
        storageFiles: async () => ({ storageRootPath: "/thread-storage", files: [], truncated: false }) as never,
        getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata.get(threadId) ?? {}) as never,
        updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
          const next = { ...(metadata.get(threadId) ?? {}), ...set };
          for (const key of remove ?? []) delete next[key];
          metadata.set(threadId, next);
          return metadata.get(threadId) as never;
        },
        list: async ({ parentThreadId }: { parentThreadId?: string }) => [...threads.values()].filter(
          (thread) => thread.parentThreadId === parentThreadId && thread.archivedAt === null,
        ) as never,
        spawn: async (input: Record<string, unknown>) => {
          spawned.push(input);
          const id = `spawned-${nextId++}`;
          const environment = input.environment as { type?: string; environmentId?: string } | undefined;
          const intendedEnvironmentId = environment?.type === "reuse"
            ? environment.environmentId ?? null
            : `env-${String(input.projectId)}`;
          const reuseFailure = environment?.type === "reuse" && reuseFailureRemaining > 0;
          if (reuseFailure) reuseFailureRemaining -= 1;
          const provisional = (options.delayedAttachmentGets ?? 0) > 0 || options.provisioningStatus === "error" || reuseFailure;
          const thread = makeThreadResponse({
            id,
            projectId: String(input.projectId),
            environmentId: provisional ? null : intendedEnvironmentId,
            status: options.provisioningStatus ?? (reuseFailure ? "error" : "idle"),
            parentThreadId: typeof input.parentThreadId === "string" ? input.parentThreadId : null,
            visibility: input.visibility === "hidden" ? "hidden" : "visible",
            providerId: typeof input.providerId === "string" ? input.providerId : providerId,
            updatedAt: nextId,
          });
          threads.set(id, thread);
          if (provisional && intendedEnvironmentId !== null && options.provisioningStatus !== "error" && !reuseFailure) {
            attachmentTargets.set(id, intendedEnvironmentId);
            attachmentGets.set(id, options.delayedAttachmentGets ?? 1);
          }
          metadata.set(id, (input.pluginMetadata as Record<string, unknown> | undefined) ?? {});
          return thread;
        },
        update: async ({ threadId, visibility }: { threadId: string; visibility?: "visible" | "hidden" }) => {
          const thread = threads.get(threadId)!;
          if (visibility !== undefined) thread.visibility = visibility;
          return thread;
        },
        send: async ({ threadId, input }: { threadId: string; input: unknown[] }) => {
          const text = input.flatMap((block) => typeof block === "object" && block !== null && "text" in block ? [String(block.text)] : []).join("\n");
          sent.push({ threadId, text });
          return { ok: true, delivery: "sent" } as never;
        },
        archive: async ({ threadId }: { threadId: string }) => {
          archived.push(threadId);
          threads.get(threadId)!.archivedAt = Date.now();
          return { ok: true };
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stopped.push(threadId);
          return { ok: true };
        },
        retry: async (input: Record<string, unknown>) => {
          retries.push(input);
          return { delivery: "sent" } as never;
        },
        events: {
          list: async ({ threadId }: { threadId: string }) => (eventRows.get(threadId) ?? []) as never,
        },
      } as never,
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, mergeBaseBranch: "base-sha" }) as never,
        diffFiles: async (input: Record<string, unknown>) => {
          environmentDiffInputs.push(input);
          const environmentId = String(input.environmentId);
          return ({
          environmentId, outcome: "available", shortstat: "", mergeBaseRef: "base-sha", truncated: false, files: [],
          }) as never;
        },
      } as never,
    },
  });
  await plugin(bb);
  await harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off" });
  return { bb, harness, metadata, threads, spawned, sent, archived, stopped, retries, eventRows, environmentDiffInputs };
}

test("start creates a personal coordinator titled from its task", async () => {
  const state = await load();
  const result = await state.harness.behavior.callRpc("start", {
    label: "Product",
    task: "Ship the shared API.",
    projectIds: ["api", "web"],
    providerId: "codex",
  });
  assert.deepEqual(result, { threadId: "spawned-1" });
  assert.deepEqual(state.spawned[0]?.environment, { type: "host", workspace: { type: "personal" } });
  assert.equal(state.spawned[0]?.title, "Ship the shared API");
  assert.deepEqual(state.spawned[0]?.pluginMetadata, {
    role: "coordinator",
    label: "Product",
    allowedProjectIds: ["api", "web"],
  });
  const text = ((state.spawned[0]?.input as Array<{ text?: string }>)[0]?.text) ?? "";
  assert.match(text, /stable `key`/);
  assert.match(text, /one at a time in a shared project environment/);
  assert.match(text, /read-only descendants/);
  assert.match(text, /protected branches \["main","develop"\]/);
});

test("a new-thread orchestration marker enables the coordinator before first dispatch", async () => {
  const state = await load();
  const marker = encodeNewThreadOrchestrationMarker({ label: "New product run", projectIds: ["api", "web"] });
  const context = makeMessageDispatchHookContext({
    thread: makeThreadResponse({ id: "fresh", projectId: "api", parentThreadId: null }),
    input: {
      text: "Ship the feature.",
      blocks: [{ type: "text", text: "Ship the feature.", mentions: [{ start: 0, end: 12, resource: { kind: "plugin", pluginId: "orchestrator", itemId: `orchestration:${marker}`, label: "Orchestrate" } }] }],
    },
  });
  state.threads.set("fresh", context.thread);
  state.metadata.set("fresh", {});
  const hook = state.harness.inspection.registrations.hooks["message.dispatch"];
  assert.ok(hook !== null);
  assert.deepEqual(await hook(context), { action: "proceed" });
  assert.deepEqual(state.metadata.get("fresh"), { role: "coordinator", label: "New product run", allowedProjectIds: ["api", "web"] });
  assert.equal((await state.harness.behavior.callRpc("run_dashboard_get", { threadId: "fresh" }) as { available: boolean }).available, true);
  assert.deepEqual(await hook(context), { action: "proceed" });
});

test("coordinator titles skip prompt scaffolding and remain compact", () => {
  assert.equal(deriveCoordinatorTitle("# Task\n\nPlease fix the checkout timeout. Preserve retry behavior.", "o2o"), "Fix the checkout timeout");
  const title = deriveCoordinatorTitle(
    "Investigate why synchronizing a very large customer catalog intermittently fails during the final indexing stage and implement a safe fix",
    "o2o",
  );
  assert.equal(title, "Investigate why synchronizing a very large customer catalog intermittently…");
  assert.ok(title.length <= 80);
});

test("auto planning classifies small requests before taking the fast path", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, approval: "never", evaluator: "never" });
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "small", projectId: "api", prompt: "Make a focused fix." }],
  }, { threadId: "coord", projectId: "personal" }), /orchestrator_plan/);
  const planned = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_plan", {
    scale: "small", rationale: "One bounded change in one project.", steps: [],
  }, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(planned.fastPath, true);
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "small", projectId: "api", prompt: "Make a focused fix." }],
  }, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(dispatched.workers[0].state, "running");
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.plan.scale, "small");
  assert.equal(status.plan.version, 1);
});

test("run dashboard combines live worker state with captured completion evidence", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "dashboard", projectId: "api", prompt: "Build the dashboard." }],
  }, { threadId: "coord", projectId: "personal" }) as string);
  const workerThreadId = dispatched.workers[0].threadId as string;

  const live = await state.harness.behavior.callRpc("run_dashboard_get", { threadId: "coord" }) as {
    available: boolean; counts: { active: number }; workstreams: Array<{ live: { outputPreview: string | null } | null }>;
  };
  assert.equal(live.available, true);
  assert.equal(live.counts.active, 1);
  assert.equal(live.workstreams[0]?.live?.outputPreview, "Worker output.");

  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Dashboard complete.", changedFiles: ["app.tsx"], validation: [], blockers: [],
  }, { threadId: workerThreadId, projectId: "api" });

  const completed = await state.harness.behavior.callRpc("run_dashboard_get", { threadId: workerThreadId }) as {
    counts: { completed: number };
    workstreams: Array<{ evidence: { output: string | null; storage: { rootPath: string } | null; environmentDiff: { environmentId: string; outcome: string } | null } | null }>;
  };
  assert.equal(completed.counts.completed, 1);
  assert.equal(completed.workstreams[0]?.evidence?.output, "Worker output.");
  assert.equal(completed.workstreams[0]?.evidence?.storage?.rootPath, "/thread-storage");
  assert.deepEqual(completed.workstreams[0]?.evidence?.environmentDiff, {
    environmentId: "env-api", outcome: "available", shortstat: "", mergeBaseRef: "base-sha", truncated: false, files: [], message: null,
  });
  assert.deepEqual(state.environmentDiffInputs.at(-1), { environmentId: "env-api", target: "all", mergeBaseBranch: "base-sha" });
});

test("large plans run independent investigations in parallel and gate dependent mutation", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, approval: "never", evaluator: "never" });
  const steps = [
    { key: "inspect-api", projectId: "api", prompt: "Inspect the API contract.", accessMode: "read-only", phase: "investigate", successCriteria: ["Publish findings"] },
    { key: "inspect-tests", projectId: "api", prompt: "Inspect test coverage.", accessMode: "read-only", phase: "investigate", successCriteria: ["Identify gaps"] },
    { key: "implement", projectId: "api", prompt: "Implement from both findings.", dependsOn: ["inspect-api", "inspect-tests"], phase: "execute", successCriteria: ["Tests pass"] },
  ];
  await state.harness.behavior.callAgentTool("orchestrator_plan", {
    scale: "large", rationale: "The implementation depends on two independent investigations.", steps,
  }, { threadId: "coord", projectId: "personal" });
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: steps.map((step) => step.key === "implement" ? { ...step, prompt: "Changed without revising the plan." } : step),
  }, { threadId: "coord", projectId: "personal" }), /must match version 1/);
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: steps }, { threadId: "coord", projectId: "personal" }) as string);
  assert.deepEqual(dispatched.workers.map((item: { state: string }) => item.state), ["running", "running", "queued"]);
  assert.deepEqual(state.spawned.slice(0, 2).map((item) => (item.pluginMetadata as { accessMode: string }).accessMode), ["read-only", "read-only"]);
  for (const worker of dispatched.workers.slice(0, 2)) {
    await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
      status: "success", summary: "Investigation complete.", changedFiles: [], validation: [], blockers: [],
    }, { threadId: worker.threadId, projectId: "api" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(worker.threadId)!, lastAssistantText: "Done." });
  }
  assert.equal(state.spawned.length, 3);
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams.find((item: { key: string }) => item.key === "implement").state, "running");
  assert.match(String(state.spawned[2]?.prompt), /inspect-api, inspect-tests/);
});

test("planning rejects dependency cycles and cancels work blocked by a failed prerequisite", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, approval: "never", evaluator: "never" });
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_plan", {
    scale: "large", rationale: "Invalid cycle.", steps: [
      { key: "a", projectId: "api", prompt: "A", dependsOn: ["b"] },
      { key: "b", projectId: "api", prompt: "B", dependsOn: ["a"] },
    ],
  }, { threadId: "coord", projectId: "personal" }), /dependency cycle/);
  const steps = [
    { key: "inspect", projectId: "api", prompt: "Inspect.", accessMode: "read-only" },
    { key: "implement", projectId: "api", prompt: "Implement.", dependsOn: ["inspect"] },
  ];
  await state.harness.behavior.callAgentTool("orchestrator_plan", {
    scale: "large", rationale: "Implementation depends on investigation.", steps,
  }, { threadId: "coord", projectId: "personal" });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: steps }, { threadId: "coord", projectId: "personal" }) as string);
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "failed", summary: "The contract could not be established.", changedFiles: [], validation: [], blockers: ["Missing upstream schema"],
  }, { threadId: dispatched.workers[0].threadId, projectId: "api" });
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(dispatched.workers[0].threadId)!, lastAssistantText: "Blocked." });
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  const dependent = status.workstreams.find((item: { key: string }) => item.key === "implement");
  assert.equal(dependent.state, "cancelled");
  assert.match(dependent.error, /Dependency inspect/);
  assert.equal(state.spawned.length, 1);
});

test("same-project workstreams serialize and share the captured project environment", async () => {
  const state = await load();
  const dispatch = (assignments: unknown[]) => state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments },
    { threadId: "coord", projectId: "personal" },
  );
  const first = JSON.parse(await dispatch([
    { key: "api-contract", projectId: "api", prompt: "Define the contract." },
    { key: "api-tests", projectId: "api", prompt: "Add contract tests." },
    { key: "web-client", projectId: "web", prompt: "Consume the contract.", profile: "standard", complexityReason: "Requires integration judgment." },
  ]) as string);
  assert.deepEqual(first.workers.map((worker: { action: string }) => worker.action), ["spawned", "queued", "spawned"]);
  assert.deepEqual(first.workers.map((worker: { state: string }) => worker.state), ["running", "queued", "running"]);
  const initialEnvironments = state.spawned.map((input) => input.environment as { type: string; environmentProviderId: string; machine: { hostId: string }; inputs: { branchName: string; baseRef: string } });
  assert.equal(initialEnvironments[0]?.type, "provider");
  assert.equal(initialEnvironments[0]?.environmentProviderId, "orchestrator-worktree");
  assert.equal(initialEnvironments[0]?.machine.hostId, "host-local");
  assert.equal(initialEnvironments[0]?.inputs.baseRef, "HEAD");
  assert.match(initialEnvironments[0]?.inputs.branchName ?? "", /^orchestrator\/product-/);
  assert.equal(initialEnvironments[0]?.inputs.branchName, initialEnvironments[1]?.inputs.branchName, "all repositories use the same feature branch name");
  assert.equal(state.spawned[0]?.model, "gpt-5.6-luna");
  assert.equal(state.spawned[1]?.model, "gpt-5.6-terra");

  const manual = makeThreadResponse({ id: "manual", projectId: "api", parentThreadId: "coord", updatedAt: 99 });
  state.threads.set("manual", manual);
  const second = JSON.parse(await dispatch([
    { key: "api-contract", projectId: "api", prompt: "Define the final contract." },
    { key: "web-client", projectId: "web", prompt: "Consume the contract.", profile: "standard", complexityReason: "Requires integration judgment." },
  ]) as string);
  assert.deepEqual(second.workers.map((worker: { action: string }) => worker.action), ["spawned", "kept"]);
  assert.deepEqual(second.retired, ["spawned-1"]);
  assert.deepEqual(state.spawned[2]?.environment, { type: "reuse", environmentId: "env-api" });
  assert.equal(state.archived.includes("manual"), false, "manual children are never managed");
  assert.deepEqual(state.sent, []);
});

test("different projects run in parallel while each project keeps a single active lane", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [
      { key: "api-one", projectId: "api", prompt: "First API task." },
      { key: "api-two", projectId: "api", prompt: "Second API task." },
      { key: "web-one", projectId: "web", prompt: "Web task." },
    ] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.deepEqual(dispatched.workers.map((item: { state: string }) => item.state), ["running", "queued", "running"]);
  assert.deepEqual(state.spawned.map((item) => item.projectId), ["api", "web"]);
});

test("the next same-project workstream reuses the first worker environment", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [
      { key: "first", projectId: "api", prompt: "First task." },
      { key: "second", projectId: "api", prompt: "Second task." },
    ] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.equal(state.spawned.length, 1);
  await state.harness.behavior.callAgentTool(
    "orchestrator_worker_done",
    { status: "success", summary: "First complete.", changedFiles: [], validation: [], blockers: [] },
    { threadId: dispatched.workers[0].threadId, projectId: "api" },
  );
  assert.equal(state.spawned.length, 1, "the project lane stays reserved until the worker is idle");
  await state.harness.behavior.emitThreadEvent("thread.idle", {
    thread: state.threads.get(dispatched.workers[0].threadId)!,
    lastAssistantText: "First complete.",
  });
  assert.equal(state.spawned.length, 2);
  assert.deepEqual(state.spawned[1]?.environment, { type: "reuse", environmentId: "env-api" });
});

test("another project's idle event cannot release a finishing project's lane", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [
      { key: "a-api-running", projectId: "api", prompt: "First API task." },
      { key: "b-api-queued", projectId: "api", prompt: "Second API task." },
      { key: "c-web-running", projectId: "web", prompt: "First web task." },
      { key: "d-web-queued", projectId: "web", prompt: "Second web task." },
    ] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const apiWorkerId = dispatched.workers[0].threadId as string;
  const webWorkerId = dispatched.workers[2].threadId as string;
  const done = { status: "success" as const, summary: "Complete.", changedFiles: [], validation: [], blockers: [] };
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", done, { threadId: apiWorkerId, projectId: "api" });
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", done, { threadId: webWorkerId, projectId: "web" });
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(webWorkerId)!, lastAssistantText: "Complete." });
  assert.equal(state.spawned[2]?.projectId, "web");
  assert.equal(state.spawned.some((input, index) => index > 1 && input.projectId === "api"), false);
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(apiWorkerId)!, lastAssistantText: "Complete." });
  assert.equal(state.spawned[3]?.projectId, "api");
});

test("a changed workstream stops its old worker and reuses the project environment", async () => {
  const state = await load();
  const dispatch = (prompt: string) => state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "replace-me", projectId: "api", prompt }] },
    { threadId: "coord", projectId: "personal" },
  );
  const first = JSON.parse(await dispatch("Original task.") as string);
  const replacement = JSON.parse(await dispatch("Replacement task.") as string);
  assert.deepEqual(replacement.retired, [first.workers[0].threadId]);
  assert.ok(state.stopped.includes(first.workers[0].threadId));
  assert.deepEqual(state.spawned[1]?.environment, { type: "reuse", environmentId: "env-api" });
});

test("transient idle between bootstrap and the real turn does not fail a worker", async () => {
  const state = await load();
  const worker = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "bootstrap", projectId: "api", prompt: "Investigate." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string).workers[0];
  const thread = state.threads.get(worker.threadId)!;
  thread.status = "idle";
  const idle = state.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  thread.status = "active";
  await state.harness.behavior.emitThreadEvent("thread.active", { thread });
  await idle;
  let status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "running");
  assert.equal(state.stopped.includes(worker.threadId), false);

  thread.status = "idle";
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Stopped without reporting." });
  status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "running");
  assert.ok(state.sent.some((message) => message.threadId === worker.threadId && message.text.includes("orchestrator_worker_done")));
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Still stopped without reporting." });
  status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "failed");
  assert.deepEqual(status.workstreams[0].result.blockers, ["Missing orchestrator_worker_done call."]);
});

test("reconciling a new desired set preserves terminal workstream outcomes", async () => {
  const state = await load();
  const first = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "investigate", projectId: "api", prompt: "Investigate." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string).workers[0];
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "failed", summary: "Investigation failed.", changedFiles: [], validation: [], blockers: ["No access"],
  }, { threadId: first.threadId, projectId: "api" });
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(first.threadId)!, lastAssistantText: "Failed." });
  const next = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "implement", projectId: "web", prompt: "Implement." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.deepEqual(next.retired, []);
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  const investigation = status.workstreams.find((item: { key: string }) => item.key === "investigate");
  assert.equal(investigation.state, "failed");
  assert.equal(investigation.error, "Investigation failed.");
  assert.deepEqual(investigation.result.blockers, ["No access"]);
});

test("a new plan resets a terminal run and direct dispatch cannot reuse its old clock", async () => {
  const state = await load();
  const worker = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "old", projectId: "api", prompt: "Old task." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string).workers[0];
  state.eventRows.set("coord", [{ id: "old-session-usage", threadId: "coord", seq: 8, createdAt: Date.now(), scope: { kind: "thread" }, type: "thread/tokenUsage/updated", data: { providerThreadId: "provider-coordinator", tokenUsage: { last: { cachedInputTokens: 80, inputTokens: 90, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 100 }, total: { cachedInputTokens: 80, inputTokens: 90, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 100 }, modelContextWindow: 1000 } } }]);
  await state.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: state.threads.get("coord")!, sequence: 8 });
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "failed", summary: "Old task failed.", changedFiles: [], validation: [], blockers: ["Old blocker"],
  }, { threadId: worker.threadId, projectId: "api" });
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(worker.threadId)!, lastAssistantText: "Failed." });
  await state.harness.behavior.callAgentTool("orchestrator_finish", { workerThreadIds: [worker.threadId] }, { threadId: "coord", projectId: "personal" });
  const before = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(before.run.state, "failed");
  await assert.rejects(state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "new", projectId: "web", prompt: "New task." }] },
    { threadId: "coord", projectId: "personal" },
  ), /Start the next request with orchestrator_plan/);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const planned = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_plan",
    { scale: "small", rationale: "A fresh bounded request.", steps: [] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.equal(planned.restarted, true);
  const after = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(after.run.state, "configured");
  assert.equal(after.run.totalTokens, 0);
  assert.ok(after.run.createdAt > before.run.createdAt);
  assert.deepEqual(after.workstreams, []);
  state.eventRows.set("coord", [{ id: "new-session-usage", threadId: "coord", seq: 10, createdAt: Date.now(), scope: { kind: "thread" }, type: "thread/tokenUsage/updated", data: { providerThreadId: "provider-coordinator", tokenUsage: { last: { cachedInputTokens: 40, inputTokens: 45, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 50 }, total: { cachedInputTokens: 120, inputTokens: 135, outputTokens: 15, reasoningOutputTokens: 0, totalTokens: 150 }, modelContextWindow: 1000 } } }]);
  await state.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: state.threads.get("coord")!, sequence: 10 });
  const withNewUsage = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(withNewUsage.run.totalTokens, 50, "a restarted run counts only coordinator usage added after its baseline");
});

test("workers exchange handoffs and finish archives plus stops managed threads", async () => {
  const state = await load("claude-code");
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "api", projectId: "api", prompt: "Build it." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const workerId = dispatched.workers[0].threadId as string;
  await state.harness.behavior.callAgentTool(
    "orchestrator_message",
    { targetThreadId: "coord", message: "The endpoint is GET /v2/items." },
    { threadId: workerId, projectId: "api" },
  );
  await state.harness.behavior.callAgentTool(
    "orchestrator_worker_done",
    { status: "success", summary: "Built and validated it.", changedFiles: ["api.ts"], validation: [{ command: "npm test", status: "passed", summary: "All pass" }], blockers: [] },
    { threadId: workerId, projectId: "api" },
  );
  await state.harness.behavior.callAgentTool(
    "orchestrator_finish",
    { workerThreadIds: [workerId] },
    { threadId: "coord", projectId: "personal" },
  );
  assert.equal(state.spawned[0]?.model, "claude-haiku-4-5-20251001");
  assert.equal(state.sent[0]?.text, "The endpoint is GET /v2/items.");
  assert.match(state.sent[1]?.text ?? "", /Workstream api completed/);
  assert.deepEqual(state.archived, [workerId]);
  assert.deepEqual(state.stopped, [workerId]);
});

test("an ordinary root thread can opt into orchestration", async () => {
  const state = await load();
  const result = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_enable",
    { label: "Local refactor", projectIds: ["api"] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.deepEqual(result, { threadId: "coord" });
  assert.deepEqual(state.metadata.get("coord"), {
    role: "coordinator",
    label: "Local refactor",
    allowedProjectIds: ["api"],
  });
});

test("thread header RPC enables, describes, and disables orchestration", async () => {
  const state = await load();
  state.metadata.set("coord", {});
  const initial = await state.harness.behavior.callRpc("thread_orchestration_get", {
    threadId: "coord",
  }) as { enabled: boolean; allowedProjectIds: string[]; projects: Array<{ id: string; current: boolean }> };
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.allowedProjectIds, []);
  assert.deepEqual(initial.projects.map(({ id, current }) => ({ id, current })), [
    { id: "api", current: false },
    { id: "web", current: false },
  ]);

  await state.harness.behavior.callRpc("enable", {
    threadId: "coord",
    label: "Interface run",
    projectIds: ["api", "web"],
  });
  assert.equal((await state.harness.behavior.callRpc("thread_orchestration_get", {
    threadId: "coord",
  }) as { enabled: boolean }).enabled, true);

  await state.harness.behavior.callRpc("thread_orchestration_disable", { threadId: "coord" });
  assert.deepEqual(state.metadata.get("coord"), {});
});

test("a newly activated provider is configurable without an Orchestrator code change", async () => {
  const state = await load("opencode");
  const catalog = await state.harness.behavior.callRpc("routing_catalog", null) as {
    providers: Array<{ id: string; models: Array<{ id: string }> }>;
  };
  assert.deepEqual(
    catalog.providers.find((provider) => provider.id === "opencode")?.models.map((entry) => entry.id),
    ["budget-code", "balanced-code", "deep-code"],
  );
  await state.harness.behavior.callRpc("routing_set_provider", {
    providerId: "opencode",
    routes: {
      quick: { modelId: "budget-code", reasoningLevel: "model-default" },
      standard: { modelId: "balanced-code", reasoningLevel: "model-default" },
      complex: { modelId: "deep-code", reasoningLevel: "model-default" },
      critical: { modelId: "deep-code", reasoningLevel: "model-default" },
    },
  });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "small-fix", projectId: "api", prompt: "Make the small fix." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.equal(dispatched.workers[0].providerId, "opencode");
  assert.equal(dispatched.workers[0].model, "budget-code");
  assert.equal(dispatched.workers[0].reasoningLevel, "low");
});

test("durable concurrency queues work and completion launches the next worker", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", {
    maxParallelWorkers: 1, maxWorkersPerRun: 4, maxAttemptsPerWorkstream: 2,
    workerTimeoutMinutes: 30, runTimeoutMinutes: 120, inactiveCleanupMinutes: 60,
    tokenBudget: 0, planningMode: "off", approval: "never", evaluator: "never",
  });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [
      { key: "first", projectId: "api", prompt: "First task." },
      { key: "second", projectId: "web", prompt: "Second task." },
    ] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.deepEqual(dispatched.workers.map((item: { state: string }) => item.state), ["running", "queued"]);
  assert.equal(state.spawned.length, 1);
  await state.harness.behavior.callAgentTool(
    "orchestrator_worker_done",
    { status: "success", summary: "First complete.", changedFiles: [], validation: [], blockers: [] },
    { threadId: dispatched.workers[0].threadId, projectId: "api" },
  );
  await state.harness.behavior.emitThreadEvent("thread.idle", {
    thread: state.threads.get(dispatched.workers[0].threadId)!,
    lastAssistantText: "First complete.",
  });
  assert.equal(state.spawned.length, 2);
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.deepEqual(status.workstreams.map((item: { state: string }) => item.state), ["completed", "running"]);
});

test("run and workstream state survive a plugin reload", async () => {
  const state = await load();
  await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "durable", projectId: "api", prompt: "Persist me." }] },
    { threadId: "coord", projectId: "personal" },
  );
  const reloaded = await state.harness.lifecycle.reload(plugin);
  const status = JSON.parse(await reloaded.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.run.state, "running");
  assert.equal(status.workstreams[0].key, "durable");
  assert.equal(status.workstreams[0].attemptCount, 1);
  assert.equal(status.workstreams[0].environmentId, "env-api");
  assert.equal(status.routing.policy.strategy, "coordinator");
  assert.equal(status.run.policy.commitMode, "owned-or-approved-existing");
  assert.deepEqual(status.run.policy.protectedBranches, ["main", "develop"]);
  assert.deepEqual(status.routing.configuredRoutes, {});
  assert.deepEqual(status.environments.map(({ projectId, environmentId }: { projectId: string; environmentId: string }) => ({ projectId, environmentId })), [
    { projectId: "api", environmentId: "env-api" },
  ]);
});

test("scheduled reconciliation retires a terminal worker whose idle event was missed across reload", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "missed-idle", projectId: "api", prompt: "Complete before reload." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const workerId = dispatched.workers[0].threadId as string;
  await state.harness.behavior.callAgentTool(
    "orchestrator_worker_done",
    { status: "success", summary: "Completed before reload.", changedFiles: [], validation: [], blockers: [] },
    { threadId: workerId, projectId: "api" },
  );
  const reloaded = await state.harness.lifecycle.reload(plugin);
  await reloaded.harness.behavior.runSchedule("cleanup-expired-runs");
  assert.ok(state.archived.includes(workerId));
  assert.ok(state.stopped.includes(workerId));
});

test("disabling orchestration cleans up live managed workers", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "live", projectId: "api", prompt: "Keep working." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  await state.harness.behavior.callRpc("thread_orchestration_disable", { threadId: "coord" });
  assert.ok(state.archived.includes(dispatched.workers[0].threadId));
  assert.ok(state.stopped.includes(dispatched.workers[0].threadId));
  assert.equal(state.metadata.get("coord")?.role, undefined);
});

test("provider failure exhausts retries and advances the same-project queue", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [
      { key: "a-flaky", projectId: "api", prompt: "Try it." },
      { key: "b-after-failure", projectId: "api", prompt: "Run after failure." },
    ] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const workerId = dispatched.workers[0].threadId as string;
  await state.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: workerId, requestId: "req-1", attemptNumber: 1 }));
  assert.equal(state.retries.length, 1);
  await state.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: workerId, requestId: "req-1", attemptNumber: 2 }));
  assert.equal(state.retries.length, 1);
  assert.equal(state.spawned.length, 2);
  assert.deepEqual(state.spawned[1]?.environment, { type: "reuse", environmentId: "env-api" });
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "failed");
  assert.equal(status.workstreams[1].state, "running");
  const analytics = await state.harness.behavior.callRpc("analytics_get", null) as { totals: { sessions: number }; failures: Array<{ reasonCode: string; count: number }>; sessions: Array<{ featureBranch: string }> };
  assert.equal(analytics.totals.sessions, 1);
  assert.match(analytics.sessions[0]?.featureBranch ?? "", /^orchestrator\/product-/);
  assert.ok(analytics.failures.some((failure) => failure.reasonCode === "provider_failure" && failure.count >= 1));
});

test("observed token usage enforces the run budget", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", {
    maxParallelWorkers: 2, maxWorkersPerRun: 4, maxAttemptsPerWorkstream: 2,
    workerTimeoutMinutes: 30, runTimeoutMinutes: 120, inactiveCleanupMinutes: 60,
    tokenBudget: 100, planningMode: "off", approval: "never", evaluator: "never",
  });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "budgeted", projectId: "api", prompt: "Stay bounded." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const workerId = dispatched.workers[0].threadId as string;
  state.eventRows.set(workerId, [{
    id: "event-1", threadId: workerId, seq: 1, createdAt: Date.now(), scope: { kind: "thread" },
    type: "thread/tokenUsage/updated",
    data: { providerThreadId: "provider-thread", tokenUsage: { last: { cachedInputTokens: 0, inputTokens: 101, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 121 }, total: { cachedInputTokens: 0, inputTokens: 101, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 121 }, modelContextWindow: 1000 } },
  }]);
  await state.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: state.threads.get(workerId)!, sequence: 1 });
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.run.state, "failed");
  assert.equal(status.run.totalTokens, 121);
  assert.ok(state.stopped.includes(workerId));
  const analytics = await state.harness.behavior.callRpc("analytics_get", null) as { totals: Record<string, number> };
  assert.deepEqual(analytics.totals, { sessions: 1, completed: 0, failed: 1, totalTokens: 121, inputTokens: 101, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 });
});

test("coordinator token usage counts toward the run budget and learning data", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", tokenBudget: 100 });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "worker", projectId: "api", prompt: "Wait for coordination." }],
  }, { threadId: "coord", projectId: "personal" }) as string);
  state.eventRows.set("coord", [{
    id: "coordinator-token-event", threadId: "coord", seq: 9, createdAt: Date.now(), scope: { kind: "thread" },
    type: "thread/tokenUsage/updated",
    data: { providerThreadId: "provider-coordinator", tokenUsage: { last: { cachedInputTokens: 80, inputTokens: 90, outputTokens: 11, reasoningOutputTokens: 2, totalTokens: 101 }, total: { cachedInputTokens: 80, inputTokens: 90, outputTokens: 11, reasoningOutputTokens: 2, totalTokens: 101 }, modelContextWindow: 1000 } },
  }]);
  await state.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: state.threads.get("coord")!, sequence: 9 });
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.run.state, "failed");
  assert.equal(status.run.totalTokens, 101);
  assert.ok(state.stopped.includes(dispatched.workers[0].threadId));
  const analytics = await state.harness.behavior.callRpc("analytics_get", null) as { totals: Record<string, number> };
  assert.equal(analytics.totals.cachedInputTokens, 80);
  assert.equal(analytics.totals.inputTokens, 10);
});

test("artifacts notify named consumers and remain in durable status", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [
      { key: "backend", projectId: "api", prompt: "Define API." },
      { key: "frontend", projectId: "web", prompt: "Consume API." },
    ] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const backend = dispatched.workers.find((item: { key: string }) => item.key === "backend").threadId;
  const frontend = dispatched.workers.find((item: { key: string }) => item.key === "frontend").threadId;
  await state.harness.behavior.callAgentTool("orchestrator_publish_artifact", {
    kind: "api-contract", name: "Items API", version: "v2", summary: "GET /v2/items returns Item[].", content: "{items: Item[]}", consumers: ["frontend"],
  }, { threadId: backend, projectId: "api" });
  assert.ok(state.sent.some((item) => item.threadId === frontend && item.text.includes("Items API")));
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.artifacts[0].version, "v2");
});

test("critical dispatch approval and evaluator review are enforced", async () => {
  const state = await load();
  const pending = state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "critical", projectId: "api", prompt: "Change auth.", profile: "critical", complexityReason: "Security-sensitive public contract." }] },
    { threadId: "coord", projectId: "personal" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const interaction = state.harness.inspection.pendingInteractions[0];
  assert.equal(interaction?.rendererId, "dispatch-approval");
  state.harness.behavior.submitInteraction(interaction!.id, { approved: true });
  const dispatched = JSON.parse(await pending as string);
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Auth change validated.", changedFiles: ["auth.ts"], validation: [], blockers: [],
  }, { threadId: dispatched.workers[0].threadId, projectId: "api" });
  let status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "reviewing");
  await state.harness.behavior.callAgentTool("orchestrator_review", { key: "critical", decision: "accept" }, { threadId: "coord", projectId: "personal" });
  status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "completed");
});

test("profile routing can select another active provider", async () => {
  const state = await load("codex");
  await state.harness.behavior.callRpc("routing_policy_set", {
    strategy: "profile",
    profileRoutes: {
      quick: { providerId: "opencode", modelId: "budget-code" },
      standard: { providerId: "opencode", modelId: "balanced-code" },
      complex: { providerId: "codex", modelId: "gpt-5.6-sol" },
      critical: { providerId: "codex", modelId: "gpt-6-astra" },
    },
  });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "cheap", projectId: "api", prompt: "Mechanical edit." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.equal(dispatched.workers[0].providerId, "opencode");
  assert.equal(dispatched.workers[0].model, "budget-code");
  assert.equal(state.spawned[0]?.providerId, "opencode");
});

test("provisioning polling waits for delayed attachment and is reload durable", async () => {
  const state = await load("codex", { delayedAttachmentGets: 1 });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "delayed", projectId: "api", prompt: "Wait for the worktree." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.equal(dispatched.workers[0].state, "running");
  assert.equal(state.stopped.length, 0, "a healthy provisioning thread is not stopped");
  const reloaded = await state.harness.lifecycle.reload(plugin);
  const status = JSON.parse(await reloaded.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.environments[0].environmentId, "env-api");
});

test("provisioning helper handles timeout, terminal error, and cancellation", async () => {
  const provisional = { id: "worker", environmentId: null, status: "active", archivedAt: null };
  let clock = 0;
  await assert.rejects(waitForEnvironmentAttachment({
    initial: provisional,
    getThread: async () => provisional,
    timeoutMs: 10,
    pollIntervalMs: 5,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  }), /within 10ms/);
  await assert.rejects(waitForEnvironmentAttachment({
    initial: { ...provisional, status: "error" },
    getThread: async () => provisional,
  }), /ended with status error/);
  const controller = new AbortController();
  await assert.rejects(waitForEnvironmentAttachment({
    initial: provisional,
    getThread: async () => provisional,
    signal: controller.signal,
    sleep: async () => { controller.abort(); },
  }), (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("definitive provisioning failure cleans up the spawned thread", async () => {
  const state = await load("codex", { provisioningStatus: "error" });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "broken", projectId: "api", prompt: "Provision." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  assert.equal(dispatched.workers[0].state, "failed");
  assert.deepEqual(state.stopped, ["spawned-1"]);
  assert.deepEqual(state.archived, ["spawned-1"]);
});

test("dispatch cancellation aborts provisioning and cleans up without spawning more workers", async () => {
  const state = await load("codex", { delayedAttachmentGets: 10 });
  const controller = new AbortController();
  const pending = state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [
      { key: "first", projectId: "api", prompt: "Provision slowly." },
      { key: "second", projectId: "web", prompt: "Must not spawn after cancellation." },
    ],
  }, { threadId: "coord", projectId: "personal", signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(state.spawned.length, 1);
  assert.deepEqual(state.stopped, ["spawned-1"]);
});

test("a stale durable environment lease is cleared and reprovisioned", async () => {
  const state = await load("codex", { failFirstReuseProvisioning: true });
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [
      { key: "first", projectId: "api", prompt: "First." },
      { key: "second", projectId: "api", prompt: "Second." },
    ],
  }, { threadId: "coord", projectId: "personal" }) as string);
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", { status: "success", summary: "First done.", changedFiles: [], validation: [], blockers: [] }, { threadId: dispatched.workers[0].threadId, projectId: "api" });
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(dispatched.workers[0].threadId)!, lastAssistantText: "Done." });
  const environments = state.spawned.map((item) => item.environment as { type: string; environmentId?: string; inputs?: { branchName: string } });
  assert.equal(environments[0]?.type, "provider");
  assert.deepEqual(environments[1], { type: "reuse", environmentId: "env-api" });
  assert.equal(environments[2]?.type, "provider");
  assert.equal(environments[0]?.inputs?.branchName, environments[2]?.inputs?.branchName, "reprovisioning keeps the run branch");
  assert.ok(state.stopped.includes("spawned-2"));
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[1].state, "running");
  assert.equal(status.environments[0].environmentId, "env-api");
});

test("nested delegation is namespaced, visible under its parent, read-only, and shares the run environment", async () => {
  const state = await load();
  const root = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "root", projectId: "api", prompt: "Own the change." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string).workers[0];
  const delegated = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_delegate",
    { assignments: [{ key: "inspect", projectId: "api", prompt: "Inspect only." }] },
    { threadId: root.threadId, projectId: "api" },
  ) as string);
  assert.equal(delegated.workers[0].key, "root/inspect");
  assert.equal(delegated.workers[0].accessMode, "read-only");
  assert.equal(state.spawned[1]?.parentThreadId, root.threadId);
  assert.deepEqual(state.spawned[1]?.environment, { type: "reuse", environmentId: "env-api" });
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: root.threadId, projectId: "api" }) as string);
  assert.deepEqual(status.workstreams.map((item: { key: string; parentKey: string | null; depth: number }) => [item.key, item.parentKey, item.depth]), [
    ["root", null, 0], ["root/inspect", "root", 1],
  ]);
});

test("parent completion joins deterministically after descendants finish", async () => {
  const state = await load();
  const root = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "root", projectId: "api", prompt: "Coordinate." }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const child = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "child", projectId: "api", prompt: "Read only." }],
  }, { threadId: root.threadId, projectId: "api" }) as string).workers[0];
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Too early.", changedFiles: [], validation: [], blockers: [],
  }, { threadId: root.threadId, projectId: "api" }), /descendants are live/);
  await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.threads.get(root.threadId)!, lastAssistantText: "Waiting for child." });
  let status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "running", "an idle parent waiting on descendants remains healthy");
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Inspection complete.", changedFiles: [], validation: [], blockers: [],
  }, { threadId: child.threadId, projectId: "api" });
  assert.ok(state.sent.some((message) => message.threadId === root.threadId && message.text.includes("Child workstream")));
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Joined child result.", changedFiles: [], validation: [], blockers: [],
  }, { threadId: root.threadId, projectId: "api" });
  status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.deepEqual(status.workstreams.map((item: { state: string }) => item.state), ["completed", "completed"]);
});

test("delegation enforces project, fan-out, depth, and total-run limits", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", maxChildrenPerWorker: 1, maxDelegationDepth: 1, maxWorkersPerRun: 2 });
  const root = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "root", projectId: "api", prompt: "Coordinate." }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "a", projectId: "api", prompt: "A" }, { key: "b", projectId: "web", prompt: "B" }],
  }, { threadId: root.threadId, projectId: "api" }), /at most 1 direct children/);
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "bad", projectId: "personal", prompt: "Bad project" }],
  }, { threadId: root.threadId, projectId: "api" }), /not allowed/);
  const child = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "child", projectId: "api", prompt: "Inspect." }],
  }, { threadId: root.threadId, projectId: "api" }) as string).workers[0];
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "grandchild", projectId: "api", prompt: "Too deep." }],
  }, { threadId: child.threadId, projectId: "api" }), /depth limit 1/);

  const capped = await load();
  await capped.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", maxChildrenPerWorker: 2, maxDelegationDepth: 2, maxWorkersPerRun: 2 });
  const cappedRoot = JSON.parse(await capped.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Root." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  await assert.rejects(capped.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "a", projectId: "api", prompt: "A" }, { key: "b", projectId: "web", prompt: "B" }],
  }, { threadId: cappedRoot.threadId, projectId: "api" }), /run cap of 2/);
});

test("plan revisions cannot bypass the cumulative run workstream cap", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", maxWorkersPerRun: 2 });
  await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "first", projectId: "api", prompt: "First scope." }],
  }, { threadId: "coord", projectId: "personal" });
  await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "second", projectId: "api", prompt: "Revised scope." }],
  }, { threadId: "coord", projectId: "personal" });
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "third", projectId: "api", prompt: "Another revision." }],
  }, { threadId: "coord", projectId: "personal" }), /already used 2 distinct workstreams.*cumulative run cap of 2/);
});

test("replacement and parent failure recursively clean up descendants", async () => {
  const state = await load();
  const root = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "root", projectId: "api", prompt: "Version one." }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const child = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "child", projectId: "api", prompt: "Inspect." }],
  }, { threadId: root.threadId, projectId: "api" }) as string).workers[0];
  await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "root", projectId: "api", prompt: "Version two." }],
  }, { threadId: "coord", projectId: "personal" });
  assert.ok(state.stopped.includes(child.threadId));
  const replacementId = "spawned-3";
  const nextChild = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [{ key: "next", projectId: "api", prompt: "Inspect next." }],
  }, { threadId: replacementId, projectId: "api" }) as string).workers[0];
  await state.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: replacementId, requestId: "failure-1", attemptNumber: 1 }));
  await state.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: replacementId, requestId: "failure-1", attemptNumber: 2 }));
  assert.ok(state.stopped.includes(nextChild.threadId));
});

test("read-only descendants cannot report writes or commits", async () => {
  const state = await load();
  const root = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Root." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const child = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", { assignments: [{ key: "child", projectId: "api", prompt: "Read." }] }, { threadId: root.threadId, projectId: "api" }) as string).workers[0];
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "I wrote.", changedFiles: ["x.ts"], validation: [], blockers: [], commits: ["abcdef1"], branch: { name: "feature", ownership: "orchestrator" },
  }, { threadId: child.threadId, projectId: "api" }), /Read-only/);
});

test("successful completion cannot report unresolved blockers", async () => {
  const state = await load();
  const worker = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "quality", projectId: "api", prompt: "Finish cleanly." }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  await assert.rejects(state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Mostly done.", changedFiles: [], validation: [], blockers: ["Production verification is still missing."],
  }, { threadId: worker.threadId, projectId: "api" }), /Successful work cannot have blockers/);
});

test("commit policy defaults and protected branch normalization are durable and replaceable", async () => {
  assert.equal(DEFAULT_POLICY.commitMode, "owned-or-approved-existing");
  assert.equal(DEFAULT_POLICY.pushMode, "explicit-approval");
  assert.equal(DEFAULT_POLICY.planningMode, "auto");
  assert.equal(DEFAULT_POLICY.tokenBudget, 40_000_000);
  assert.deepEqual(effectiveProtectedBranches(DEFAULT_POLICY), ["main", "develop"]);
  const parsed = parseOrchestrationPolicy({ ...DEFAULT_POLICY, protectedBranches: [" release ", "release", "master"] });
  assert.deepEqual(parsed.protectedBranches, ["release", "master"]);
  const removed = parseOrchestrationPolicy({ ...DEFAULT_POLICY, protectedBranches: [] });
  assert.deepEqual(removed.protectedBranches, []);
  assert.throws(() => parseOrchestrationPolicy({ ...DEFAULT_POLICY, protectedBranches: ["  "] }), /too_small|Too small/i);
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", protectedBranches: [" release ", "release"] });
  assert.deepEqual((await state.harness.behavior.callRpc("policy_get", null) as typeof DEFAULT_POLICY).protectedBranches, ["release"]);
});

async function commitPolicyWorker(policy: Partial<typeof DEFAULT_POLICY> = {}) {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", evaluator: "never", ...policy });
  const worker = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "commit", projectId: "api", prompt: "Commit atomically." }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const dashboard = await state.harness.behavior.callRpc("run_dashboard_get", { threadId: "coord" }) as { run: { featureBranch: string } };
  return { state, worker, featureBranch: dashboard.run.featureBranch };
}

test("commit modes enforce owned, approved-existing, and disabled behavior", async () => {
  const disabled = await commitPolicyWorker({ commitMode: "disabled" });
  await assert.rejects(disabled.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Committed.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["aaaaaaa"], branch: { name: "feature", ownership: "orchestrator" },
  }, { threadId: disabled.worker.threadId, projectId: "api" }), /Commits are disabled/);

  const ownedOnly = await commitPolicyWorker({ commitMode: "owned-only" });
  await assert.rejects(ownedOnly.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Committed.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["bbbbbbb"], branch: { name: "feature", ownership: "existing" }, commitApproval: { approvedByUser: true, evidence: "User approved commit." },
  }, { threadId: ownedOnly.worker.threadId, projectId: "api" }), /only on Orchestrator-owned/);
  await assert.rejects(ownedOnly.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Wrong branch.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["bbbbbbb"], branch: { name: "orchestrator/other", ownership: "orchestrator" },
  }, { threadId: ownedOnly.worker.threadId, projectId: "api" }), /must stay on the run branch/);
  await ownedOnly.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Two atomic commits.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["bbbbbbb", "ccccccc"], branch: { name: ownedOnly.featureBranch, ownership: "orchestrator" },
  }, { threadId: ownedOnly.worker.threadId, projectId: "api" });
  const status = JSON.parse(await ownedOnly.state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.deepEqual(status.workstreams[0].result.commits, ["bbbbbbb", "ccccccc"]);

  const approvedExisting = await commitPolicyWorker();
  const input = { status: "success" as const, summary: "Existing branch commit.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["ddddddd"], branch: { name: "feature", ownership: "existing" as const } };
  await assert.rejects(approvedExisting.state.harness.behavior.callAgentTool("orchestrator_worker_done", input, { threadId: approvedExisting.worker.threadId, projectId: "api" }), /requires explicit user approval/);
  await approvedExisting.state.harness.behavior.callAgentTool("orchestrator_worker_done", { ...input, commitApproval: { approvedByUser: true, evidence: "User approved this commit action." } }, { threadId: approvedExisting.worker.threadId, projectId: "api" });
});

test("protected branches and push approval are enforced independently", async () => {
  const protectedRun = await commitPolicyWorker();
  await assert.rejects(protectedRun.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Bad target.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["eeeeeee"], branch: { name: "main", ownership: "orchestrator" },
  }, { threadId: protectedRun.worker.threadId, projectId: "api" }), /main is protected/);

  const masterDefault = await commitPolicyWorker();
  await masterDefault.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Approved master commit.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["abababa"], branch: { name: "master", ownership: "existing" }, commitApproval: { approvedByUser: true, evidence: "User approved committing to master." },
  }, { threadId: masterDefault.worker.threadId, projectId: "api" });

  const configuredMaster = await commitPolicyWorker({ protectedBranches: ["master"] });
  await assert.rejects(configuredMaster.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Protected master.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["acacaca"], branch: { name: "master", ownership: "existing" }, commitApproval: { approvedByUser: true, evidence: "Approval cannot override protection." },
  }, { threadId: configuredMaster.worker.threadId, projectId: "api" }), /master is protected/);

  const pushDisabled = await commitPolicyWorker({ pushMode: "disabled", protectedBranches: [] });
  await assert.rejects(pushDisabled.state.harness.behavior.callAgentTool("orchestrator_worker_done", {
    status: "success", summary: "Push.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["fffffff"], pushedCommits: ["fffffff"], branch: { name: "master", ownership: "orchestrator" }, pushApproval: { approvedByUser: true, evidence: "Approved push." },
  }, { threadId: pushDisabled.worker.threadId, projectId: "api" }), /Pushes are disabled/);

  const pushAllowed = await commitPolicyWorker({ protectedBranches: [] });
  const pushed = { status: "success" as const, summary: "Push.", changedFiles: ["a.ts"], validation: [], blockers: [], commits: ["1234567"], pushedCommits: ["1234567"], branch: { name: pushAllowed.featureBranch, ownership: "orchestrator" as const } };
  await assert.rejects(pushAllowed.state.harness.behavior.callAgentTool("orchestrator_worker_done", pushed, { threadId: pushAllowed.worker.threadId, projectId: "api" }), /Every push requires separate explicit user approval/);
  await pushAllowed.state.harness.behavior.callAgentTool("orchestrator_worker_done", { ...pushed, pushApproval: { approvedByUser: true, evidence: "User explicitly approved this push." } }, { threadId: pushAllowed.worker.threadId, projectId: "api" });
});

test("exact provider/model routes retain distinct reasoning and pass explicit spawn inputs", async () => {
  for (const level of ["low", "medium", "high", "xhigh"] as const) {
    const state = await load();
    await state.harness.behavior.callRpc("routing_policy_set", {
      strategy: "profile",
      profileRoutes: { quick: { providerId: "codex", modelId: "gpt-5.6-luna", reasoningLevel: level }, standard: { providerId: "codex", modelId: "gpt-5.6-terra", reasoningLevel: "medium" }, complex: null, critical: null },
    });
    const worker = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
      assignments: [{ key: `reason-${level}`, projectId: "api", prompt: "Use configured reasoning." }],
    }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
    assert.equal(state.spawned[0]?.reasoningLevel, level);
    assert.deepEqual(state.spawned[0]?.executionInputSources, { providerId: "explicit", model: "explicit", reasoningLevel: "explicit" });
    assert.equal(worker.requestedReasoningLevel, level);
    assert.equal(worker.reasoningLevel, level);
    assert.equal(state.threads.get(worker.threadId)!.providerId, "codex");
  }
});

test("provider-local routes keep reasoning with each exact model", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("routing_set_provider", { providerId: "codex", routes: {
    quick: { modelId: "gpt-5.6-luna", reasoningLevel: "low" },
    standard: { modelId: "gpt-5.6-terra", reasoningLevel: "xhigh" },
    complex: { modelId: "gpt-5.6-sol", reasoningLevel: "high" },
    critical: { modelId: "gpt-6-astra", reasoningLevel: "xhigh" },
  } });
  const workers = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [
    { key: "quick", projectId: "api", prompt: "Quick." },
    { key: "standard", projectId: "web", prompt: "Standard.", profile: "standard", complexityReason: "Needs ordinary implementation judgment." },
  ] }, { threadId: "coord", projectId: "personal" }) as string).workers;
  assert.deepEqual(workers.map((worker: { model: string; configuredReasoningLevel: string; reasoningLevel: string }) => [worker.model, worker.configuredReasoningLevel, worker.reasoningLevel]), [
    ["gpt-5.6-luna", "low", "low"], ["gpt-5.6-terra", "xhigh", "xhigh"],
  ]);
});

test("legacy profile reasoning migrates onto persisted exact routes", async () => {
  const state = await load();
  await state.bb.storage.kv.set("routing-policy", {
    strategy: "profile",
    profileRoutes: { quick: { providerId: "codex", modelId: "gpt-5.6-luna" }, standard: null, complex: null, critical: null },
    profileReasoning: { quick: "high", standard: "medium", complex: "high", critical: "xhigh" },
  });
  await state.bb.storage.kv.set("provider-routes", { codex: {
    quick: "gpt-5.6-luna", standard: "gpt-5.6-terra", complex: "gpt-5.6-sol", critical: "gpt-6-astra",
  } });
  const routing = await state.harness.behavior.callRpc("routing_get", null) as { policy: { profileRoutes: { quick: { reasoningLevel: string } | null } }; routes: { codex: { quick: { reasoningLevel: string } } } };
  assert.equal(routing.policy.profileRoutes.quick?.reasoningLevel, "high");
  assert.equal(routing.routes.codex.quick.reasoningLevel, "high");
  assert.deepEqual(await state.bb.storage.kv.get("routing-policy"), routing.policy);
});

test("reasoning rejects unsupported levels and model-default uses the declared default", async () => {
  const invalid = await load();
  await assert.rejects(invalid.harness.behavior.callRpc("routing_policy_set", {
    strategy: "profile",
    profileRoutes: { quick: { providerId: "codex", modelId: "gpt-5.6-luna", reasoningLevel: "max" }, standard: null, complex: null, critical: null },
  }), /not supported/);
  const defaults = await load();
  await defaults.harness.behavior.callRpc("routing_policy_set", {
    strategy: "profile",
    profileRoutes: { quick: { providerId: "codex", modelId: "gpt-5.6-luna", reasoningLevel: "model-default" }, standard: null, complex: null, critical: null },
  });
  const worker = JSON.parse(await defaults.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "default", projectId: "api", prompt: "Use model default." }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  assert.equal(worker.requestedReasoningLevel, "model-default");
  assert.equal(worker.reasoningLevel, "low");
  assert.equal(defaults.spawned[0]?.reasoningLevel, "low");
});

test("reasoning policy survives reload and descendants inherit or override their profile route", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("routing_policy_set", {
    strategy: "profile",
    profileRoutes: { quick: { providerId: "opencode", modelId: "budget-code", reasoningLevel: "high" }, standard: null, complex: null, critical: null },
  });
  const root = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", {
    assignments: [{ key: "root", projectId: "api", prompt: "Root.", reasoningLevel: "low" }],
  }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const delegated = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", {
    assignments: [
      { key: "inherited", projectId: "api", prompt: "Inherit." },
      { key: "override", projectId: "api", prompt: "Override.", reasoningLevel: "medium" },
    ],
  }, { threadId: root.threadId, projectId: "api" }) as string);
  assert.deepEqual(delegated.workers.map((item: { reasoningLevel: string }) => item.reasoningLevel), ["high", "medium"]);
  assert.deepEqual(delegated.workers.map((item: { providerId: string; model: string }) => [item.providerId, item.model]), [["opencode", "budget-code"], ["opencode", "budget-code"]]);
  const reloaded = await state.harness.lifecycle.reload(plugin);
  const status = JSON.parse(await reloaded.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.routing.policy.profileRoutes.quick.reasoningLevel, "high");
  assert.deepEqual(status.workstreams.map((item: { configuredReasoningLevel: string; requestedReasoningLevel: string; effectiveReasoningLevel: string }) => [item.configuredReasoningLevel, item.requestedReasoningLevel, item.effectiveReasoningLevel]), [
    ["high", "low", "low"], ["high", "high", "high"], ["high", "medium", "medium"],
  ]);
});

test("only terminal coordinators regain orchestrator_enable discoverability", async () => {
  const state = await load();
  const active = await state.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: state.threads.get("coord")!, pluginMetadata: state.metadata.get("coord")! as never,
  }));
  assert.equal(active.tools.some((tool) => tool.name === "orchestrator_enable"), false);
  const worker = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "done", projectId: "api", prompt: "Finish." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const workerConfig = await state.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: state.threads.get(worker.threadId)!, pluginMetadata: state.metadata.get(worker.threadId)! as never,
  }));
  assert.equal(workerConfig.tools.some((tool) => tool.name === "orchestrator_enable"), false);
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", { status: "success", summary: "Done.", changedFiles: [], validation: [], blockers: [] }, { threadId: worker.threadId, projectId: "api" });
  await state.harness.behavior.callAgentTool("orchestrator_finish", { workerThreadIds: [worker.threadId] }, { threadId: "coord", projectId: "personal" });
  const terminal = await state.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: state.threads.get("coord")!, pluginMetadata: state.metadata.get("coord")! as never,
  }));
  assert.ok(terminal.tools.some((tool) => tool.name === "orchestrator_enable"));
  assert.ok(terminal.tools.some((tool) => tool.name === "orchestrator_plan"));
  await state.harness.behavior.callAgentTool("orchestrator_enable", { label: "Reset", projectIds: ["web"] }, { threadId: "coord", projectId: "personal" });
  const refreshed = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(refreshed.run.state, "configured");
  assert.deepEqual(refreshed.run.allowedProjectIds, ["web"]);
});

test("reload reconciliation resumes an idle parent after a missed descendant event", async () => {
  const state = await load();
  const root = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Join." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const child = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_delegate", { assignments: [{ key: "child", projectId: "api", prompt: "Inspect." }] }, { threadId: root.threadId, projectId: "api" }) as string).workers[0];
  await state.harness.behavior.callAgentTool("orchestrator_worker_done", { status: "success", summary: "Child done.", changedFiles: [], validation: [], blockers: [] }, { threadId: child.threadId, projectId: "api" });
  state.sent.length = 0;
  const reloaded = await state.harness.lifecycle.reload(plugin);
  await reloaded.harness.behavior.runSchedule("cleanup-expired-runs");
  const status = JSON.parse(await reloaded.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams.find((item: { key: string }) => item.key === "root").state, "running");
  assert.ok(state.sent.some((message) => message.threadId === root.threadId && message.text.includes("All managed descendants")));
  assert.ok(state.archived.includes(child.threadId));
});

test("disable, worker timeout, and run expiry recursively clean nested threads", async () => {
  const disabled = await load();
  const disabledRoot = JSON.parse(await disabled.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Root." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
  const disabledChild = JSON.parse(await disabled.harness.behavior.callAgentTool("orchestrator_delegate", { assignments: [{ key: "child", projectId: "api", prompt: "Read." }] }, { threadId: disabledRoot.threadId, projectId: "api" }) as string).workers[0];
  await disabled.harness.behavior.callRpc("thread_orchestration_disable", { threadId: "coord" });
  assert.ok(disabled.stopped.includes(disabledRoot.threadId));
  assert.ok(disabled.stopped.includes(disabledChild.threadId));

  const originalNow = Date.now;
  try {
    const timed = await load();
    await timed.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", workerTimeoutMinutes: 5 });
    const timedRoot = JSON.parse(await timed.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Root." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
    const timedChild = JSON.parse(await timed.harness.behavior.callAgentTool("orchestrator_delegate", { assignments: [{ key: "child", projectId: "api", prompt: "Read." }] }, { threadId: timedRoot.threadId, projectId: "api" }) as string).workers[0];
    timed.threads.get(timedRoot.threadId)!.status = "active";
    timed.threads.get(timedChild.threadId)!.status = "active";
    const base = originalNow();
    Date.now = () => base + 6 * 60_000;
    await timed.harness.behavior.runSchedule("cleanup-expired-runs");
    assert.ok(timed.stopped.includes(timedRoot.threadId));
    assert.ok(timed.stopped.includes(timedChild.threadId));

    Date.now = originalNow;
    const expired = await load();
    await expired.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", runTimeoutMinutes: 10 });
    const expiredRoot = JSON.parse(await expired.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Root." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
    const expiredChild = JSON.parse(await expired.harness.behavior.callAgentTool("orchestrator_delegate", { assignments: [{ key: "child", projectId: "api", prompt: "Read." }] }, { threadId: expiredRoot.threadId, projectId: "api" }) as string).workers[0];
    expired.threads.get(expiredRoot.threadId)!.status = "active";
    expired.threads.get(expiredChild.threadId)!.status = "active";
    const expiryBase = originalNow();
    Date.now = () => expiryBase + 11 * 60_000;
    await expired.harness.behavior.runSchedule("cleanup-expired-runs");
    assert.ok(expired.stopped.includes(expiredRoot.threadId));
    assert.ok(expired.stopped.includes(expiredChild.threadId));
    const status = JSON.parse(await expired.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
    assert.equal(status.run.state, "cancelled");
    assert.equal(status.run.error, "Run exceeded its 10-minute runtime limit.");

    Date.now = originalNow;
    const inactive = await load();
    await inactive.harness.behavior.callRpc("policy_set", { ...DEFAULT_POLICY, planningMode: "off", runTimeoutMinutes: 120, inactiveCleanupMinutes: 10 });
    const inactiveRoot = JSON.parse(await inactive.harness.behavior.callAgentTool("orchestrator_dispatch", { assignments: [{ key: "root", projectId: "api", prompt: "Root." }] }, { threadId: "coord", projectId: "personal" }) as string).workers[0];
    inactive.threads.get(inactiveRoot.threadId)!.status = "active";
    const inactiveBase = originalNow();
    Date.now = () => inactiveBase + 11 * 60_000;
    await inactive.harness.behavior.runSchedule("cleanup-expired-runs");
    const inactiveStatus = JSON.parse(await inactive.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
    assert.equal(inactiveStatus.run.error, "Run was inactive for 10 minutes.");
  } finally {
    Date.now = originalNow;
  }
});
