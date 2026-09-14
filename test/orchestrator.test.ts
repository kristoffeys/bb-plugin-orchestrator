import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
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
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
          metadata.set(threadId, { ...(metadata.get(threadId) ?? {}), ...set });
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
      } as never,
    },
  });
  await plugin(bb);
  return { harness, metadata, threads, spawned, sent, archived, stopped };
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
  assert.deepEqual(second.workers.map((worker: { action: string }) => worker.action), ["updated", "kept"]);
  assert.deepEqual(second.retired, ["spawned-2"]);
  assert.equal(state.archived.includes("manual"), false, "manual children are never managed");
  assert.deepEqual(state.sent, [{ threadId: "spawned-1", text: "Define the final contract." }]);
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
    "orchestrator_finish",
    { workerThreadIds: [workerId] },
    { threadId: "coord", projectId: "personal" },
  );
  assert.equal(state.spawned[0]?.model, "claude-haiku-4-5-20251001");
  assert.deepEqual(state.sent, [{ threadId: "coord", text: "The endpoint is GET /v2/items." }]);
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
