import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const projects = [
  { id: "personal", name: "Personal", kind: "personal", sources: [] },
  { id: "api", name: "API", kind: "standard", sources: [{ path: "/repos/api", isDefault: true }] },
  { id: "web", name: "Web", kind: "standard", sources: [{ path: "/repos/web", isDefault: true }] },
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

async function load(providerId = "codex") {
  const metadata = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const spawned: Array<Record<string, unknown>> = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const archived: string[] = [];
  const stopped: string[] = [];
  const retries: Array<Record<string, unknown>> = [];
  const eventRows = new Map<string, unknown[]>();
  let nextId = 1;
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
          return thread;
        },
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
          const thread = makeThreadResponse({
            id,
            projectId: String(input.projectId),
            parentThreadId: typeof input.parentThreadId === "string" ? input.parentThreadId : null,
            visibility: input.visibility === "hidden" ? "hidden" : "visible",
            providerId: typeof input.providerId === "string" ? input.providerId : providerId,
            updatedAt: nextId,
          });
          threads.set(id, thread);
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
    },
  });
  await plugin(bb);
  return { harness, metadata, threads, spawned, sent, archived, stopped, retries, eventRows };
}

test("start creates a personal coordinator with generic Orchestrator identity", async () => {
  const state = await load();
  const result = await state.harness.behavior.callRpc("start", {
    label: "Product",
    task: "Ship the shared API.",
    projectIds: ["api", "web"],
    providerId: "codex",
  });
  assert.deepEqual(result, { threadId: "spawned-1" });
  assert.deepEqual(state.spawned[0]?.environment, { type: "host", workspace: { type: "personal" } });
  assert.deepEqual(state.spawned[0]?.pluginMetadata, {
    role: "coordinator",
    label: "Product",
    allowedProjectIds: ["api", "web"],
  });
  const text = ((state.spawned[0]?.input as Array<{ text?: string }>)[0]?.text) ?? "";
  assert.match(text, /stable `key`/);
  assert.match(text, /A project may have several independent workstreams/);
});

test("dispatch supports several keyed workers in one project and reconciles stale work", async () => {
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
  assert.deepEqual(first.workers.map((worker: { action: string }) => worker.action), ["spawned", "spawned", "spawned"]);
  assert.equal(state.spawned[0]?.model, "gpt-5.6-luna");
  assert.equal(state.spawned[2]?.model, "gpt-5.6-terra");

  const manual = makeThreadResponse({ id: "manual", projectId: "api", parentThreadId: "coord", updatedAt: 99 });
  state.threads.set("manual", manual);
  const second = JSON.parse(await dispatch([
    { key: "api-contract", projectId: "api", prompt: "Define the final contract." },
    { key: "web-client", projectId: "web", prompt: "Consume the contract.", profile: "standard", complexityReason: "Requires integration judgment." },
  ]) as string);
  assert.deepEqual(second.workers.map((worker: { action: string }) => worker.action), ["spawned", "kept"]);
  assert.deepEqual(second.retired, ["spawned-2", "spawned-1"]);
  assert.equal(state.archived.includes("manual"), false, "manual children are never managed");
  assert.deepEqual(state.sent, []);
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
      quick: "budget-code",
      standard: "balanced-code",
      complex: "deep-code",
      critical: "deep-code",
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
    tokenBudget: 0, approval: "never", evaluator: "never",
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

test("provider failures retry only up to the snapshotted attempt limit", async () => {
  const state = await load();
  const dispatched = JSON.parse(await state.harness.behavior.callAgentTool(
    "orchestrator_dispatch",
    { assignments: [{ key: "flaky", projectId: "api", prompt: "Try it." }] },
    { threadId: "coord", projectId: "personal" },
  ) as string);
  const workerId = dispatched.workers[0].threadId as string;
  await state.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: workerId, requestId: "req-1", attemptNumber: 1 }));
  assert.equal(state.retries.length, 1);
  await state.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: workerId, requestId: "req-1", attemptNumber: 2 }));
  assert.equal(state.retries.length, 1);
  const status = JSON.parse(await state.harness.behavior.callAgentTool("orchestrator_status", {}, { threadId: "coord", projectId: "personal" }) as string);
  assert.equal(status.workstreams[0].state, "failed");
});

test("observed token usage enforces the run budget", async () => {
  const state = await load();
  await state.harness.behavior.callRpc("policy_set", {
    maxParallelWorkers: 2, maxWorkersPerRun: 4, maxAttemptsPerWorkstream: 2,
    workerTimeoutMinutes: 30, runTimeoutMinutes: 120, inactiveCleanupMinutes: 60,
    tokenBudget: 100, approval: "never", evaluator: "never",
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
