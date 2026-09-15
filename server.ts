import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { coordinatorPrompt, type OrchestratorProject } from "./lib/coordinator-prompt.ts";
import {
  DEFAULT_POLICY,
  DEFAULT_ROUTING_POLICY,
  effectiveProtectedBranches,
  orchestrationPolicy,
  reasoningChoice,
  routingPolicy,
  workerProfile,
  type WorkerProfile,
} from "./lib/policy.ts";
import { OrchestratorStore, type WorkstreamRecord } from "./lib/state.ts";

const reasoningLevel = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
const permissionMode = z.enum(["auto", "accept-edits", "full"]);
const serviceTier = z.enum(["default", "fast"]);
const executionInputSource = z.enum(["explicit", "client-preference"]);
const attachment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), url: z.string().min(1) }),
  z.object({ type: z.literal("localImage"), path: z.string().min(1) }),
  z.object({ type: z.literal("localFile"), path: z.string().min(1), mimeType: z.string().optional(), name: z.string().optional(), sizeBytes: z.number().optional() }),
]);
const projectIds = z.array(z.string().min(1)).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, "Project ids must be unique.");
const startInput = z.object({
  label: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(100_000),
  projectIds,
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: reasoningLevel.optional(),
  permissionMode: permissionMode.optional(),
  serviceTier: serviceTier.optional(),
  executionInputSources: z.object({
    providerId: executionInputSource.optional(), model: executionInputSource.optional(), reasoningLevel: executionInputSource.optional(),
    permissionMode: executionInputSource.optional(), serviceTier: executionInputSource.optional(),
  }).optional(),
  attachments: z.array(attachment).optional(),
});
const enableInput = z.object({ threadId: z.string().min(1), label: z.string().trim().min(1).max(200), projectIds });
const profileRoutes = z.object({ quick: z.string().min(1), standard: z.string().min(1), complex: z.string().min(1), critical: z.string().min(1) });
const routingMap = z.record(z.string().min(1), profileRoutes);
const catalogModel = z.object({
  id: z.string(), model: z.string(), displayName: z.string(), description: z.string(), isDefault: z.boolean(),
  defaultReasoningLevel: reasoningLevel, supportedReasoningLevels: z.array(reasoningLevel),
});
const catalogProvider = z.object({ id: z.string(), displayName: z.string(), models: z.array(catalogModel), modelLoadError: z.string().nullable(), recommendedRoutes: profileRoutes.nullable() });
const routeMetric = z.object({ providerId: z.string(), model: z.string(), profile: workerProfile, samples: z.number(), successes: z.number(), failures: z.number(), averageDurationMs: z.number(), averageTokens: z.number() });
const routeRecommendation = z.object({ profile: workerProfile, providerId: z.string(), model: z.string(), samples: z.number(), successRate: z.number(), reason: z.string() });
const threadOrchestrationState = z.object({
  eligible: z.boolean(), enabled: z.boolean(), label: z.string(), allowedProjectIds: z.array(z.string()),
  projects: z.array(z.object({ id: z.string(), name: z.string(), current: z.boolean() })),
});

export const rpcContract = defineRpcContract({
  start: { input: startInput, output: z.object({ threadId: z.string() }) },
  enable: { input: enableInput, output: z.object({ threadId: z.string() }) },
  thread_orchestration_get: { input: z.object({ threadId: z.string().min(1) }), output: threadOrchestrationState },
  thread_orchestration_disable: { input: z.object({ threadId: z.string().min(1) }), output: z.null() },
  routing_catalog: { input: z.null(), output: z.object({ providers: z.array(catalogProvider) }) },
  routing_get: { input: z.null(), output: z.object({ routes: routingMap, policy: routingPolicy, metrics: z.array(routeMetric), recommendations: z.array(routeRecommendation) }) },
  routing_set_provider: { input: z.object({ providerId: z.string().min(1), routes: profileRoutes }), output: z.object({ routes: routingMap }) },
  routing_policy_set: { input: routingPolicy, output: routingPolicy },
  policy_get: { input: z.null(), output: orchestrationPolicy },
  policy_set: { input: orchestrationPolicy, output: orchestrationPolicy },
});

const workerAssignment = z.object({
  key: z.string().trim().min(1).max(100).regex(/^[^/]+$/, "Keys cannot contain '/'."),
  projectId: z.string().min(1),
  prompt: z.string().trim().min(1).max(50_000),
  title: z.string().trim().min(1).max(200).optional(),
  profile: workerProfile.default("quick"),
  complexityReason: z.string().trim().min(1).max(500).optional(),
  reasoningLevel: reasoningChoice.optional(),
}).superRefine((assignment, ctx) => {
  if (assignment.profile !== "quick" && assignment.complexityReason === undefined) {
    ctx.addIssue({ code: "custom", path: ["complexityReason"], message: `The ${assignment.profile} profile needs a complexity reason.` });
  }
});
const completionResult = z.object({
  status: z.enum(["success", "blocked", "failed"]),
  summary: z.string().trim().min(1).max(5_000),
  changedFiles: z.array(z.string().max(1_000)).max(200).default([]),
  validation: z.array(z.object({ command: z.string().max(2_000), status: z.enum(["passed", "failed", "not-run"]), summary: z.string().max(2_000) })).max(50).default([]),
  blockers: z.array(z.string().max(2_000)).max(30).default([]),
  commits: z.array(z.string().regex(/^[0-9a-f]{7,64}$/i, "Commit SHAs must be hexadecimal.")).max(50).default([]),
  branch: z.object({
    name: z.string().trim().min(1).max(500),
    ownership: z.enum(["orchestrator", "existing"]),
  }).optional(),
  commitApproval: z.object({ approvedByUser: z.literal(true), evidence: z.string().trim().min(1).max(2_000) }).optional(),
  pushedCommits: z.array(z.string().regex(/^[0-9a-f]{7,64}$/i, "Pushed commit SHAs must be hexadecimal.")).max(50).default([]),
  pushApproval: z.object({ approvedByUser: z.literal(true), evidence: z.string().trim().min(1).max(2_000) }).optional(),
});
const artifactInput = z.object({
  kind: z.enum(["api-contract", "schema", "decision", "migration", "interface", "note"]),
  name: z.string().trim().min(1).max(200), version: z.string().trim().min(1).max(100).optional(),
  summary: z.string().trim().min(1).max(2_000), content: z.string().max(50_000).optional(), path: z.string().max(2_000).optional(),
  consumers: z.array(z.string().min(1).max(100)).max(50).default([]),
});
const BUILTIN_ROUTE_MODELS: Record<string, Record<WorkerProfile, string>> = {
  "claude-code": { quick: "claude-haiku-4-5-20251001", standard: "claude-sonnet-5", complex: "claude-fable-5-1", critical: "claude-opus-5[1m]" },
  codex: { quick: "gpt-5.6-luna", standard: "gpt-5.6-terra", complex: "gpt-5.6-sol", critical: "gpt-6-astra" },
};
const metadataSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("coordinator"), label: z.string().min(1), allowedProjectIds: z.array(z.string().min(1)) }),
  z.object({
    role: z.literal("worker"), coordinatorThreadId: z.string().min(1), key: z.string().min(1), projectId: z.string().min(1),
    parentKey: z.string().nullable().default(null), depth: z.number().int().min(0).default(0), accessMode: z.enum(["mutating", "read-only"]).default("mutating"),
    assignment: z.string(), profile: workerProfile, complexityReason: z.string().optional(), providerId: z.string().min(1),
    model: z.string().min(1), requestedReasoningLevel: reasoningChoice.default("model-default"), reasoningLevel,
  }),
]);
type OrchestratorMetadata = z.infer<typeof metadataSchema>;

type ProvisioningThread = { id: string; environmentId: string | null; status: string; archivedAt?: number | null };

const abortError = () => Object.assign(new Error("Worker provisioning was cancelled."), { name: "AbortError" });

export async function waitForEnvironmentAttachment<T extends ProvisioningThread>(input: {
  initial: T;
  getThread: () => Promise<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  }));
  const started = now();
  let thread = input.initial;
  let lastGetError: unknown;
  for (;;) {
    if (input.signal?.aborted) throw abortError();
    if (thread.environmentId !== null) return thread;
    if (thread.status === "error" || thread.archivedAt != null) {
      throw new Error(`Worker ${thread.id} provisioning ended with status ${thread.status}.`);
    }
    if (now() - started >= timeoutMs) {
      const suffix = lastGetError === undefined ? "" : ` Last lookup failed: ${lastGetError instanceof Error ? lastGetError.message : String(lastGetError)}.`;
      throw new Error(`Worker ${thread.id} did not receive a project environment within ${timeoutMs}ms.${suffix}`);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (now() - started))), input.signal);
    try {
      thread = await input.getThread();
      lastGetError = undefined;
    } catch (error) {
      lastGetError = error;
    }
  }
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS runs (coordinator_thread_id TEXT PRIMARY KEY, label TEXT NOT NULL, allowed_project_ids_json TEXT NOT NULL, state TEXT NOT NULL, policy_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, total_tokens INTEGER NOT NULL DEFAULT 0, first_dispatch_approved INTEGER NOT NULL DEFAULT 0, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS workstreams (coordinator_thread_id TEXT NOT NULL, key TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT, assignment TEXT NOT NULL, profile TEXT NOT NULL, complexity_reason TEXT, provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT UNIQUE, attempt_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, last_event_seq INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, result_json TEXT, error TEXT, PRIMARY KEY (coordinator_thread_id, key))`,
    `CREATE TABLE IF NOT EXISTS artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, coordinator_thread_id TEXT NOT NULL, workstream_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, version TEXT, summary TEXT NOT NULL, content TEXT, path TEXT, consumers_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS route_metrics (provider_id TEXT NOT NULL, model TEXT NOT NULL, profile TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider_id, model, profile))`,
    `CREATE INDEX IF NOT EXISTS workstreams_thread_id_idx ON workstreams(thread_id)`,
    `CREATE TABLE IF NOT EXISTS run_project_environments (coordinator_thread_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (coordinator_thread_id, project_id))`,
    `ALTER TABLE workstreams ADD COLUMN lane_released_at INTEGER`,
    `ALTER TABLE workstreams ADD COLUMN parent_key TEXT`,
    `ALTER TABLE workstreams ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE workstreams ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'mutating'`,
    `ALTER TABLE workstreams ADD COLUMN requested_reasoning_level TEXT NOT NULL DEFAULT 'model-default'`,
    `CREATE INDEX IF NOT EXISTS workstreams_parent_idx ON workstreams(coordinator_thread_id, parent_key)`,
  ]);
  const store = new OrchestratorStore(db);
  const ROUTING_KEY = "provider-routes";
  const ROUTING_POLICY_KEY = "routing-policy";
  const POLICY_KEY = "orchestration-policy";
  const readRoutes = async () => { const parsed = routingMap.safeParse(await bb.storage.kv.get(ROUTING_KEY)); return parsed.success ? parsed.data : {}; };
  const readRoutingPolicy = async () => { const parsed = routingPolicy.safeParse(await bb.storage.kv.get(ROUTING_POLICY_KEY)); return parsed.success ? parsed.data : DEFAULT_ROUTING_POLICY; };
  const readPolicy = async () => { const parsed = orchestrationPolicy.safeParse(await bb.storage.kv.get(POLICY_KEY)); return parsed.success ? parsed.data : DEFAULT_POLICY; };

  const providerCatalog = async () => Promise.all((await bb.sdk.providers.list()).filter((provider) => provider.available).map(async (provider) => {
    try {
      const result = await bb.sdk.providers.models({ providerId: provider.id });
      const fallback = result.models.find((model) => model.isDefault) ?? result.models[0];
      return {
        id: provider.id, displayName: provider.displayName,
        models: result.models.map((model) => ({
          id: model.id, model: model.model, displayName: model.displayName, description: model.description, isDefault: model.isDefault,
          defaultReasoningLevel: model.defaultReasoningEffort, supportedReasoningLevels: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        })),
        modelLoadError: result.modelLoadError === null ? null : result.modelLoadError.code,
        recommendedRoutes: fallback === undefined ? null : Object.fromEntries(workerProfile.options.map((profileId) => {
          const requested = BUILTIN_ROUTE_MODELS[provider.id]?.[profileId];
          const match = result.models.find((model) => model.id === requested || model.model === requested);
          return [profileId, (match ?? fallback).id];
        })) as z.output<typeof profileRoutes>,
      };
    } catch (error) {
      return { id: provider.id, displayName: provider.displayName, models: [], modelLoadError: error instanceof Error ? error.message : "Could not load models.", recommendedRoutes: null };
    }
  }));

  const metadata = async (threadId: string): Promise<OrchestratorMetadata | null> => {
    const parsed = metadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }));
    return parsed.success ? parsed.data : null;
  };
  const resolveProjects = async (ids: readonly string[]) => {
    const all = await bb.sdk.projects.list({ includePersonal: true });
    const byId = new Map(all.map((project) => [project.id, project]));
    const selected: OrchestratorProject[] = ids.map((id) => {
      const project = byId.get(id);
      if (project === undefined || project.kind === "personal") throw new Error(`No orchestratable project with id ${id}.`);
      const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
      return { id: project.id, name: project.name, ...(source === undefined ? {} : { path: source.path }) };
    });
    return { all, selected };
  };
  const requireCoordinator = async (threadId: string) => {
    const value = await metadata(threadId);
    if (value?.role !== "coordinator") throw new Error("This tool is only available to an Orchestrator coordinator.");
    return value;
  };
  const retiredWorkerIds = new Set<string>();
  const intentionallyStoppingWorkerIds = new Set<string>();
  const retireWorker = async (threadId: string) => {
    if (retiredWorkerIds.has(threadId)) return;
    intentionallyStoppingWorkerIds.add(threadId);
    let archiveError: unknown;
    try { await bb.sdk.threads.archive({ threadId }); } catch (error) { archiveError = error; }
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch (error) {
      intentionallyStoppingWorkerIds.delete(threadId);
      throw error;
    }
    if (archiveError !== undefined) throw archiveError;
    retiredWorkerIds.add(threadId);
  };
  const stopWorkers = async (threadIds: readonly string[]) => {
    await Promise.all(threadIds.map(async (threadId) => {
      intentionallyStoppingWorkerIds.add(threadId);
      try {
        await bb.sdk.threads.stop({ threadId });
      } catch (error) {
        intentionallyStoppingWorkerIds.delete(threadId);
        throw error;
      }
    }));
  };
  const archiveWorkers = async (threadIds: readonly string[]) => {
    await Promise.all(threadIds.map(async (threadId) => {
      await bb.sdk.threads.archive({ threadId });
      retiredWorkerIds.add(threadId);
    }));
  };
  const notify = async (threadId: string, text: string, senderThreadId?: string) => {
    try {
      await bb.sdk.threads.send({ threadId, ...(senderThreadId === undefined ? {} : { senderThreadId }), mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    } catch (error) {
      bb.log.warn(`Could not notify ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const cleanupRun = async (coordinatorThreadId: string, state: "completed" | "failed" | "cancelled", reason: string) => {
    store.setRunState(coordinatorThreadId, state, state === "completed" ? null : reason);
    const all = store.listWorkstreams(coordinatorThreadId);
    const live = all.filter((item) => !["completed", "failed", "cancelled"].includes(item.state));
    await Promise.allSettled(all.flatMap((item) => item.threadId === null ? [] : [retireWorker(item.threadId)]));
    for (const item of live) store.setWorkstreamState(coordinatorThreadId, item.key, state === "completed" ? "completed" : "cancelled", { error: reason });
    for (const item of all) store.releaseProjectLane(coordinatorThreadId, item.key);
    bb.realtime.publish("run-changed", { threadId: coordinatorThreadId });
  };

  const cancelDescendants = async (coordinatorThreadId: string, parentKey: string, reason: string) => {
    const descendants = store.listDescendants(coordinatorThreadId, parentKey);
    const live = descendants.filter((item) => !["completed", "failed", "cancelled"].includes(item.state));
    await Promise.allSettled(descendants.flatMap((item) => item.threadId === null ? [] : [retireWorker(item.threadId)]));
    for (const item of live) store.setWorkstreamState(coordinatorThreadId, item.key, "cancelled", { error: reason });
    for (const item of descendants) store.releaseProjectLane(coordinatorThreadId, item.key);
    return descendants;
  };

  const enable = async (input: z.output<typeof enableInput>) => {
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    if (thread.parentThreadId !== null) throw new Error("Only a root thread can become an orchestrator.");
    await resolveProjects(input.projectIds);
    const existingRun = store.getRun(input.threadId);
    if (existingRun !== null && ["completed", "failed", "cancelled"].includes(existingRun.state)) store.resetRun(input.threadId);
    await bb.sdk.threads.updatePluginMetadata({ threadId: input.threadId, set: { role: "coordinator", label: input.label, allowedProjectIds: input.projectIds } });
    store.upsertRun({ coordinatorThreadId: input.threadId, label: input.label, allowedProjectIds: input.projectIds, policy: await readPolicy() });
    bb.realtime.publish("thread-orchestration-changed", { threadId: input.threadId });
    return { threadId: input.threadId };
  };

  const threadOrchestrationStateFor = async (threadId: string) => {
    const [thread, allProjects, value] = await Promise.all([
      bb.sdk.threads.get({ threadId }), bb.sdk.projects.list({ includePersonal: true }), metadata(threadId),
    ]);
    const projects = allProjects.filter((project) => project.kind !== "personal").map((project) => ({ id: project.id, name: project.name, current: project.id === thread.projectId }));
    const currentProject = projects.find((project) => project.current);
    const enabled = value?.role === "coordinator";
    return {
      eligible: thread.parentThreadId === null && value?.role !== "worker",
      enabled,
      label: enabled ? value.label : thread.title ?? thread.titleFallback ?? currentProject?.name ?? "Orchestrated work",
      allowedProjectIds: enabled ? value.allowedProjectIds : currentProject === undefined ? [] : [currentProject.id],
      projects,
    };
  };

  const workerExecution = async (coordinatorProviderId: string, profileId: WorkerProfile, assignmentReasoning?: z.output<typeof reasoningChoice>) => {
    const routePolicy = await readRoutingPolicy();
    const target = routePolicy.strategy === "profile" ? routePolicy.profileRoutes[profileId] : null;
    const providerId = target?.providerId ?? coordinatorProviderId;
    const result = await bb.sdk.providers.models({ providerId });
    if (result.modelLoadError !== null) throw new Error(`Could not load ${providerId} models: ${result.modelLoadError.code}.`);
    const configuredModelId = target?.modelId ?? (await readRoutes())[providerId]?.[profileId] ?? BUILTIN_ROUTE_MODELS[providerId]?.[profileId];
    if (configuredModelId === undefined) throw new Error(`No ${profileId} worker model is configured for provider ${providerId}. Open Orchestrator settings and save its routing.`);
    const selected = result.models.find((model) => model.id === configuredModelId || model.model === configuredModelId);
    if (selected === undefined) throw new Error(`Configured ${profileId} model ${configuredModelId} is no longer available for provider ${providerId}.`);
    const supported = selected.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
    const requestedReasoningLevel = assignmentReasoning ?? routePolicy.profileReasoning[profileId];
    const selectedReasoning = requestedReasoningLevel === "model-default" ? selected.defaultReasoningEffort : requestedReasoningLevel;
    if (!supported.includes(selectedReasoning)) {
      throw new Error(`Configured ${profileId} reasoning ${requestedReasoningLevel} is not supported by ${providerId}/${selected.id}. Supported levels: ${supported.join(", ")}.`);
    }
    return { providerId: selected.routeProviderId ?? providerId, model: selected.model, requestedReasoningLevel, reasoningLevel: selectedReasoning };
  };

  const workerPrompt = (item: WorkstreamRecord) => {
    const run = store.getRun(item.coordinatorThreadId)!;
    const protectedBranches = effectiveProtectedBranches(run.policy);
    const access = item.accessMode === "read-only"
      ? "This delegated workstream is read-only. Do not edit files, create commits, or push. Report findings through messages/artifacts and worker_done."
      : "This is the sole mutating workstream in its project lane. Nested delegation is read-only only, so descendants cannot race this writer.";
    return `${item.assignment}\n\nManaged workstream contract:\n- This workstream shares one durable project environment with this run's other ${item.projectId} workstreams. Preserve unrelated changes and do not switch environments.\n- ${access}\n- You may delegate bounded read-only subtasks only with orchestrator_delegate; never spawn threads directly.\n- Commit mode is ${run.policy.commitMode}; push mode is ${run.policy.pushMode}; protected branches are ${JSON.stringify(protectedBranches)}. Protected branches cannot be committed to or pushed. Existing branches require separate explicit user approval for commits and pushes. Orchestrator-owned branches need no commit approval. Never push without explicit user approval.\n- Publish interface/API/schema decisions early with orchestrator_publish_artifact so consumers can proceed.\n- Use orchestrator_message for questions and blockers.\n- Before ending, call orchestrator_worker_done exactly once with ordered commit SHAs, changed files, validation, and blockers. Parent completion is rejected while descendants are live. An idle turn without that record is treated as a failed workstream.`;
  };

  const launchQueuedUnlocked = async (coordinatorThreadId: string, signal?: AbortSignal) => {
    const run = store.getRun(coordinatorThreadId);
    if (run === null || ["completed", "failed", "cancelled", "awaiting_approval"].includes(run.state)) return [];
    const all = store.listWorkstreams(coordinatorThreadId);
    let available = Math.max(0, run.policy.maxParallelWorkers - all.filter((item) => item.state === "running").length);
    const activeProjects = new Set(all.filter((item) => item.accessMode === "mutating" && (
      item.state === "running"
      || item.state === "reviewing"
      || (item.threadId !== null && item.laneReleasedAt === null && ["completed", "failed", "cancelled"].includes(item.state))),
    ).map((item) => item.projectId));
    const launched: WorkstreamRecord[] = [];
    for (const item of all.filter((candidate) => candidate.state === "queued" && candidate.attemptCount < run.policy.maxAttemptsPerWorkstream)) {
      if (signal?.aborted) throw abortError();
      if (available <= 0) break;
      if (item.accessMode === "mutating" && activeProjects.has(item.projectId)) continue;
      const parent = item.parentKey === null ? null : store.getWorkstream(coordinatorThreadId, item.parentKey);
      if (item.parentKey !== null && (parent?.threadId == null || parent.state !== "running")) {
        store.setWorkstreamState(coordinatorThreadId, item.key, "cancelled", { error: "Delegating parent is no longer live." });
        continue;
      }
      const spawn = async (environment: { type: "project-default" } | { type: "reuse"; environmentId: string }) => bb.sdk.threads.spawn({
          projectId: item.projectId,
          environment,
          parentThreadId: parent?.threadId ?? coordinatorThreadId,
          visibility: "visible",
          title: item.title ?? `${run.label}: ${item.key}`,
          prompt: workerPrompt(item),
          providerId: item.providerId,
          model: item.model,
          reasoningLevel: item.reasoningLevel as z.output<typeof reasoningLevel>,
          executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit" },
          pluginMetadata: {
            role: "worker", coordinatorThreadId, key: item.key, parentKey: item.parentKey, depth: item.depth,
            accessMode: item.accessMode, projectId: item.projectId, assignment: item.assignment,
            profile: item.profile, ...(item.complexityReason === null ? {} : { complexityReason: item.complexityReason }),
            providerId: item.providerId, model: item.model, requestedReasoningLevel: item.requestedReasoningLevel,
            reasoningLevel: item.reasoningLevel,
          },
        });
      const spawnAttached = async (environment: { type: "project-default" } | { type: "reuse"; environmentId: string }) => {
        const provisional = await spawn(environment);
        try {
          const attached = await waitForEnvironmentAttachment({
            initial: provisional,
            getThread: () => bb.sdk.threads.get({ threadId: provisional.id }),
            signal,
          });
          if (attached.environmentId === null) throw new Error(`Worker ${attached.id} environment attachment was lost.`);
          return attached as typeof attached & { environmentId: string };
        } catch (error) {
          await retireWorker(provisional.id);
          throw error;
        }
      };
      try {
        let lease = store.getProjectEnvironment(coordinatorThreadId, item.projectId);
        let spawned: Awaited<ReturnType<typeof spawnAttached>>;
        try {
          spawned = await spawnAttached(lease === null ? { type: "project-default" } : { type: "reuse", environmentId: lease.environmentId });
        } catch (error) {
          if (lease === null || (error instanceof Error && error.name === "AbortError")) throw error;
          store.clearProjectEnvironment(coordinatorThreadId, item.projectId);
          lease = null;
          spawned = await spawnAttached({ type: "project-default" });
        }
        store.setProjectEnvironment(coordinatorThreadId, item.projectId, spawned.environmentId);
        launched.push(store.setWorkstreamState(coordinatorThreadId, item.key, "running", { threadId: spawned.id, incrementAttempt: true })!);
        if (item.accessMode === "mutating") activeProjects.add(item.projectId);
        available -= 1;
      } catch (error) {
        const cancelled = error instanceof Error && error.name === "AbortError";
        store.setWorkstreamState(coordinatorThreadId, item.key, cancelled ? "cancelled" : "failed", {
          error: `Could not launch worker: ${error instanceof Error ? error.message : String(error)}`,
        });
        store.releaseProjectLane(coordinatorThreadId, item.key);
        if (cancelled) throw error;
      }
    }
    if (launched.length > 0) store.setRunState(coordinatorThreadId, "running");
    return launched;
  };

  const launchLocks = new Map<string, Promise<void>>();
  const launchQueued = async (coordinatorThreadId: string, signal?: AbortSignal) => {
    const previous = launchLocks.get(coordinatorThreadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    launchLocks.set(coordinatorThreadId, tail);
    await previous.catch(() => undefined);
    try {
      return await launchQueuedUnlocked(coordinatorThreadId, signal);
    } finally {
      release();
      if (launchLocks.get(coordinatorThreadId) === tail) launchLocks.delete(coordinatorThreadId);
    }
  };

  bb.rpc.register(rpcContract, {
    start: async ({ label, task, projectIds: ids, attachments, ...execution }) => {
      const [{ all, selected }, policy] = await Promise.all([resolveProjects(ids), readPolicy()]);
      const personal = all.find((project) => project.kind === "personal");
      if (personal === undefined) throw new Error("No personal project is available.");
      const thread = await bb.sdk.threads.spawn({
        projectId: personal.id,
        environment: { type: "host", workspace: { type: "personal" } },
        title: `Orchestrator: ${label}`,
        pluginMetadata: { role: "coordinator", label, allowedProjectIds: ids },
        ...execution,
        input: [{ type: "text", text: coordinatorPrompt(label, selected, task, policy), mentions: [] }, ...(attachments ?? [])],
      });
      store.upsertRun({ coordinatorThreadId: thread.id, label, allowedProjectIds: ids, policy });
      return { threadId: thread.id };
    },
    enable,
    thread_orchestration_get: async ({ threadId }) => threadOrchestrationStateFor(threadId),
    thread_orchestration_disable: async ({ threadId }) => {
      const state = await threadOrchestrationStateFor(threadId);
      if (!state.eligible) throw new Error("Only an eligible root thread can change orchestration.");
      await cleanupRun(threadId, "cancelled", "Orchestration was disabled.");
      await bb.sdk.threads.updatePluginMetadata({ threadId, remove: ["role", "label", "allowedProjectIds"] });
      bb.realtime.publish("thread-orchestration-changed", { threadId });
      return null;
    },
    routing_catalog: async () => ({ providers: await providerCatalog() }),
    routing_get: async () => {
      const measured = store.listMetrics();
      const metrics = measured.map((item) => ({
        providerId: item.providerId, model: item.model, profile: item.profile, samples: item.samples,
        successes: item.successes, failures: item.failures,
        averageDurationMs: item.samples === 0 ? 0 : Math.round(item.durationMs / item.samples),
        averageTokens: item.samples === 0 ? 0 : Math.round(item.totalTokens / item.samples),
      }));
      const recommendations = workerProfile.options.flatMap((profileId) => {
        const candidates = metrics.filter((item) => item.profile === profileId && item.samples >= 3).sort((left, right) => {
          const leftRate = left.successes / left.samples; const rightRate = right.successes / right.samples;
          if (leftRate !== rightRate) return rightRate - leftRate;
          if (left.averageTokens !== right.averageTokens) return left.averageTokens - right.averageTokens;
          return left.averageDurationMs - right.averageDurationMs;
        });
        const best = candidates[0];
        return best === undefined ? [] : [{
          profile: profileId, providerId: best.providerId, model: best.model, samples: best.samples,
          successRate: best.successes / best.samples,
          reason: `${best.successes}/${best.samples} successful; ${best.averageTokens.toLocaleString()} average tokens; ${Math.round(best.averageDurationMs / 1000)}s average runtime.`,
        }];
      });
      return { routes: await readRoutes(), policy: await readRoutingPolicy(), metrics, recommendations };
    },
    routing_set_provider: async ({ providerId, routes }) => {
      const provider = (await providerCatalog()).find((candidate) => candidate.id === providerId);
      if (provider === undefined) throw new Error(`Provider ${providerId} is not currently available.`);
      const modelIds = new Set(provider.models.map((model) => model.id));
      for (const [profileId, modelId] of Object.entries(routes)) {
        if (!modelIds.has(modelId)) throw new Error(`Model ${modelId} is not available for ${provider.displayName} (${profileId}).`);
      }
      const next = { ...(await readRoutes()), [providerId]: routes };
      await bb.storage.kv.set(ROUTING_KEY, next);
      bb.realtime.publish("routing-changed", { providerId });
      return { routes: next };
    },
    routing_policy_set: async (input) => {
      const catalog = await providerCatalog();
      const byProvider = new Map(catalog.map((provider) => [provider.id, provider]));
      for (const [profileId, target] of Object.entries(input.profileRoutes)) {
        if (target !== null && !byProvider.get(target.providerId)?.models.some((model) => model.id === target.modelId)) throw new Error(`Selected route ${target.providerId}/${target.modelId} is not available.`);
        if (target !== null) {
          const selected = byProvider.get(target.providerId)?.models.find((model) => model.id === target.modelId);
          const requested = input.profileReasoning[profileId as WorkerProfile];
          const effective = requested === "model-default" ? selected?.defaultReasoningLevel : requested;
          if (selected !== undefined && effective !== undefined && !selected.supportedReasoningLevels.includes(effective)) {
            throw new Error(`Reasoning ${requested} is not supported by ${target.providerId}/${target.modelId} for ${profileId}.`);
          }
        }
      }
      await bb.storage.kv.set(ROUTING_POLICY_KEY, input);
      bb.realtime.publish("routing-changed", { providerId: "*" });
      return input;
    },
    policy_get: async () => readPolicy(),
    policy_set: async (input) => {
      await bb.storage.kv.set(POLICY_KEY, input);
      bb.realtime.publish("policy-changed", {});
      return input;
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_enable",
    description: "Turn the current root project thread into a managed coordinator.",
    instructions: "Use when the user asks this ordinary thread to orchestrate workers. Managed tools attach on the next turn.",
    presentation: { label: { pending: "Enabling orchestration", completed: "Enabled orchestration" } },
    parameters: z.object({ label: z.string().trim().min(1).max(200), projectIds }),
    async execute({ label, projectIds: ids }, { threadId }) {
      return JSON.stringify(await enable({ threadId, label, projectIds: ids }));
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_dispatch",
    description: "Reconcile a coordinator's complete desired managed-workstream set.",
    instructions: "Use stable keys and send the complete desired set. Quick is the cheap default; stronger profiles require a concrete reason.",
    presentation: { label: { pending: "Reconciling workstreams", completed: "Reconciled workstreams" } },
    parameters: z.object({
      assignments: z.array(workerAssignment).max(50).refine((items) => new Set(items.map((item) => item.key)).size === items.length, "Worker keys must be unique."),
    }),
    async execute({ assignments }, { threadId, signal }) {
      const [coordinatorMetadata, coordinator] = await Promise.all([requireCoordinator(threadId), bb.sdk.threads.get({ threadId })]);
      let run = store.getRun(threadId) ?? store.upsertRun({
        coordinatorThreadId: threadId, label: coordinatorMetadata.label,
        allowedProjectIds: coordinatorMetadata.allowedProjectIds, policy: await readPolicy(),
      });
      if (assignments.length > run.policy.maxWorkersPerRun) throw new Error(`This run allows at most ${run.policy.maxWorkersPerRun} workstreams including descendants.`);
      const { selected } = await resolveProjects(coordinatorMetadata.allowedProjectIds);
      const projectsById = new Map(selected.map((project) => [project.id, project]));
      for (const assignment of assignments) {
        if (!projectsById.has(assignment.projectId)) throw new Error(`Project ${assignment.projectId} is not allowed in this run.`);
      }

      const needsApproval = run.policy.approval === "every-dispatch"
        || (run.policy.approval === "first-dispatch" && !run.firstDispatchApproved)
        || (run.policy.approval === "critical" && assignments.some((item) => item.profile === "critical"));
      if (needsApproval) {
        store.setRunState(threadId, "awaiting_approval");
        const answer = await bb.ui.requestInput({
          threadId,
          rendererId: "dispatch-approval",
          title: "Approve worker plan",
          payload: {
            label: run.label,
            assignments: assignments.map(({ key, projectId, title, profile, complexityReason }) => ({
              key, projectId, title: title ?? null, profile, complexityReason: complexityReason ?? null,
            })),
          },
          timeoutMs: 60 * 60_000,
        }, { signal });
        const approved = answer.outcome === "submitted" && typeof answer.value === "object" && answer.value !== null && "approved" in answer.value && answer.value.approved === true;
        if (!approved) {
          store.setRunState(threadId, "blocked", "Worker plan was not approved.");
          return JSON.stringify({ approved: false, workers: [], retired: [] });
        }
        store.approveFirstDispatch(threadId);
        run = store.getRun(threadId)!;
      }

      const stale = store.removeWorkstreamsNotIn(threadId, assignments.map((item) => item.key));
      const retired = stale.flatMap((item) => item.threadId === null ? [] : [item.threadId]);
      for (const item of stale) {
        await cancelDescendants(threadId, item.key, "Ancestor was removed from the coordinator plan.");
      }
      await stopWorkers(retired);
      for (const item of stale) {
        store.setWorkstreamState(threadId, item.key, "cancelled", { error: "Removed from desired workstream set." });
        store.releaseProjectLane(threadId, item.key);
      }

      const kept: Array<Record<string, unknown>> = [];
      const plans = await Promise.all(assignments.map(async (assignment) => ({
        assignment,
        execution: await workerExecution(coordinator.providerId, assignment.profile, assignment.reasoningLevel),
      })));
      const changedThreadIds = plans.flatMap(({ assignment, execution }) => {
        const existing = store.getWorkstream(threadId, assignment.key);
        const unchanged = existing !== null
          && existing.projectId === assignment.projectId
          && existing.assignment === assignment.prompt
          && existing.profile === assignment.profile
          && existing.providerId === execution.providerId
          && existing.model === execution.model
          && existing.requestedReasoningLevel === execution.requestedReasoningLevel
          && existing.reasoningLevel === execution.reasoningLevel;
        return unchanged || existing?.threadId === null || existing?.threadId === undefined ? [] : [existing.threadId];
      });
      await stopWorkers(changedThreadIds);
      retired.push(...changedThreadIds);
      for (const id of changedThreadIds) {
        const changed = store.getWorkstreamByThread(id);
        if (changed !== null) {
          await cancelDescendants(threadId, changed.key, "Ancestor workstream was replaced.");
        }
      }
      for (const { assignment, execution } of plans) {
        const existing = store.getWorkstream(threadId, assignment.key);
        const unchanged = existing !== null
          && existing.projectId === assignment.projectId
          && existing.assignment === assignment.prompt
          && existing.profile === assignment.profile
          && existing.providerId === execution.providerId
          && existing.model === execution.model
          && existing.requestedReasoningLevel === execution.requestedReasoningLevel
          && existing.reasoningLevel === execution.reasoningLevel;
        if (unchanged && existing.threadId !== null && !["failed", "cancelled"].includes(existing.state)) {
          kept.push({
            key: assignment.key, projectId: assignment.projectId, threadId: existing.threadId,
            action: "kept", state: existing.state, profile: assignment.profile,
            environmentId: store.getProjectEnvironment(threadId, assignment.projectId)?.environmentId ?? null,
            ...execution,
          });
          continue;
        }
        store.upsertWorkstream({
          coordinatorThreadId: threadId, key: assignment.key, parentKey: null, depth: 0, accessMode: "mutating", projectId: assignment.projectId,
          title: assignment.title ?? `${coordinatorMetadata.label}: ${projectsById.get(assignment.projectId)!.name} · ${assignment.key}`,
          assignment: assignment.prompt, profile: assignment.profile, complexityReason: assignment.complexityReason ?? null,
          ...execution, state: "queued", threadId: null, attemptCount: 0,
        });
      }
      const activeDesiredRoots = new Set(assignments.map((item) => item.key));
      const retainedCount = store.listWorkstreams(threadId).filter((item) => item.parentKey === null ? activeDesiredRoots.has(item.key) : [...activeDesiredRoots].some((root) => item.key.startsWith(`${root}/`))).length;
      if (retainedCount > run.policy.maxWorkersPerRun) throw new Error(`This plan would retain ${retainedCount} workstreams including descendants; the run cap is ${run.policy.maxWorkersPerRun}.`);
      store.setRunState(threadId, "running");
      const launched = await launchQueued(threadId, signal);
      await archiveWorkers(retired);
      const launchedByKey = new Map(launched.map((item) => [item.key, item]));
      const byKey = new Map(kept.map((item) => [String(item.key), item]));
      for (const assignment of assignments) {
        if (byKey.has(assignment.key)) continue;
        const item = launchedByKey.get(assignment.key) ?? store.getWorkstream(threadId, assignment.key)!;
        const environmentId = store.getProjectEnvironment(threadId, item.projectId)?.environmentId ?? null;
        byKey.set(assignment.key, {
          key: item.key, projectId: item.projectId, threadId: item.threadId,
          action: item.state === "queued" ? "queued" : item.state === "running" ? "spawned" : item.state,
          state: item.state, profile: item.profile,
          providerId: item.providerId, model: item.model, requestedReasoningLevel: item.requestedReasoningLevel,
          reasoningLevel: item.reasoningLevel, environmentId,
        });
      }
      const workers = assignments.map((assignment) => byKey.get(assignment.key)!);
      return JSON.stringify({
        approved: true, workers, retired,
        limits: { maxParallelWorkers: run.policy.maxParallelWorkers, maxAttemptsPerWorkstream: run.policy.maxAttemptsPerWorkstream, tokenBudget: run.policy.tokenBudget },
      });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_delegate",
    description: "Reconcile this managed worker's complete set of bounded read-only child workstreams.",
    instructions: "Use local stable keys. Children are always read-only, root-run-owned, and use quick routing by default. Do not spawn threads directly.",
    presentation: { label: { pending: "Delegating read-only subtasks", completed: "Delegated read-only subtasks" } },
    parameters: z.object({
      assignments: z.array(workerAssignment).max(20).refine((items) => new Set(items.map((item) => item.key)).size === items.length, "Child keys must be unique."),
    }),
    async execute({ assignments }, { threadId, signal }) {
      const meta = await metadata(threadId);
      if (meta?.role !== "worker") throw new Error("Only a managed worker can delegate managed subtasks.");
      const parent = store.getWorkstreamByThread(threadId);
      const run = store.getRun(meta.coordinatorThreadId);
      if (parent === null || run === null || parent.state !== "running") throw new Error("This workstream is no longer live.");
      if (parent.depth >= run.policy.maxDelegationDepth) throw new Error(`Delegation depth limit ${run.policy.maxDelegationDepth} was reached.`);
      if (assignments.length > run.policy.maxChildrenPerWorker) throw new Error(`A worker may have at most ${run.policy.maxChildrenPerWorker} direct children.`);
      const { selected } = await resolveProjects(run.allowedProjectIds);
      const projectsById = new Map(selected.map((project) => [project.id, project]));
      for (const assignment of assignments) {
        if (!projectsById.has(assignment.projectId)) throw new Error(`Project ${assignment.projectId} is not allowed in this run.`);
      }
      const desired = assignments.map((assignment) => `${parent.key}/${assignment.key}`);
      const stale = store.removeWorkstreamsNotIn(meta.coordinatorThreadId, desired, parent.key);
      for (const item of stale) {
        await cancelDescendants(meta.coordinatorThreadId, item.key, "Ancestor delegated subtask was removed.");
        if (item.threadId !== null) await retireWorker(item.threadId);
        store.setWorkstreamState(meta.coordinatorThreadId, item.key, "cancelled", { error: "Removed from delegating worker's desired set." });
        store.releaseProjectLane(meta.coordinatorThreadId, item.key);
      }
      const coordinator = await bb.sdk.threads.get({ threadId: meta.coordinatorThreadId });
      const plans = await Promise.all(assignments.map(async (assignment, index) => ({
        assignment,
        key: desired[index]!,
        execution: await workerExecution(coordinator.providerId, assignment.profile, assignment.reasoningLevel),
      })));
      const additional = plans.filter(({ key }) => store.getWorkstream(meta.coordinatorThreadId, key) === null).length;
      if (store.listWorkstreams(meta.coordinatorThreadId).length + additional > run.policy.maxWorkersPerRun) {
        throw new Error(`Delegation would exceed the run cap of ${run.policy.maxWorkersPerRun} total workstreams.`);
      }
      const retired: string[] = [];
      const kept: Array<Record<string, unknown>> = [];
      for (const { assignment, key, execution } of plans) {
        const existing = store.getWorkstream(meta.coordinatorThreadId, key);
        const unchanged = existing !== null
          && existing.parentKey === parent.key
          && existing.projectId === assignment.projectId
          && existing.assignment === assignment.prompt
          && existing.profile === assignment.profile
          && existing.providerId === execution.providerId
          && existing.model === execution.model
          && existing.requestedReasoningLevel === execution.requestedReasoningLevel
          && existing.reasoningLevel === execution.reasoningLevel;
        if (unchanged && existing.threadId !== null && !["failed", "cancelled"].includes(existing.state)) {
          kept.push({ key, localKey: assignment.key, action: "kept", state: existing.state, threadId: existing.threadId, ...execution });
          continue;
        }
        if (existing !== null) {
          await cancelDescendants(meta.coordinatorThreadId, key, "Ancestor delegated subtask was replaced.");
          if (existing.threadId !== null) { await retireWorker(existing.threadId); retired.push(existing.threadId); }
        }
        store.upsertWorkstream({
          coordinatorThreadId: meta.coordinatorThreadId, key, parentKey: parent.key, depth: parent.depth + 1,
          accessMode: "read-only", projectId: assignment.projectId,
          title: assignment.title ?? `${run.label}: ${assignment.key}`,
          assignment: assignment.prompt, profile: assignment.profile, complexityReason: assignment.complexityReason ?? null,
          ...execution, state: "queued", threadId: null, attemptCount: 0,
        });
      }
      const launched = await launchQueued(meta.coordinatorThreadId, signal);
      const launchedByKey = new Map(launched.map((item) => [item.key, item]));
      const keptByKey = new Map(kept.map((item) => [String(item.key), item]));
      const workers = plans.map(({ assignment, key, execution }) => {
        const retained = keptByKey.get(key);
        if (retained !== undefined) return retained;
        const item = launchedByKey.get(key) ?? store.getWorkstream(meta.coordinatorThreadId, key)!;
        return { key, localKey: assignment.key, action: item.state === "running" ? "spawned" : item.state, state: item.state, threadId: item.threadId, accessMode: item.accessMode, ...execution };
      });
      return JSON.stringify({ workers, retired, parentKey: parent.key, depth: parent.depth + 1, accessMode: "read-only" });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_status",
    description: "Read durable state, structured results, limits, and artifacts for this run.",
    presentation: { label: { pending: "Reading orchestration status", completed: "Read orchestration status" } },
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      const meta = await metadata(threadId);
      if (meta === null) throw new Error("This thread is not in a managed run.");
      const coordinatorThreadId = meta.role === "coordinator" ? threadId : meta.coordinatorThreadId;
      const [routingPolicyValue, configuredRoutes] = await Promise.all([readRoutingPolicy(), readRoutes()]);
      const environments = store.listProjectEnvironments(coordinatorThreadId);
      const environmentByProject = new Map(environments.map((item) => [item.projectId, item.environmentId]));
      const workstreams = store.listWorkstreams(coordinatorThreadId).map((item) => ({
        ...item,
        environmentId: environmentByProject.get(item.projectId) ?? null,
      }));
      return JSON.stringify({
        run: store.getRun(coordinatorThreadId),
        routing: { policy: routingPolicyValue, configuredRoutes },
        environments,
        workstreams,
        artifacts: store.listArtifacts(coordinatorThreadId),
      });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_message",
    description: "Send a message between a coordinator and managed workers in one run.",
    instructions: "Use for questions, blockers, and integration feedback. Publish reusable contracts with orchestrator_publish_artifact.",
    presentation: { label: { pending: "Sending orchestration update", completed: "Sent orchestration update" } },
    parameters: z.object({ targetThreadId: z.string().min(1), message: z.string().trim().min(1).max(50_000) }),
    async execute({ targetThreadId, message }, { threadId }) {
      const senderMetadata = await metadata(threadId);
      if (senderMetadata === null) throw new Error("This thread is not in a managed run.");
      const coordinatorThreadId = senderMetadata.role === "coordinator" ? threadId : senderMetadata.coordinatorThreadId;
      const targetMetadata = await metadata(targetThreadId);
      const valid = targetThreadId === coordinatorThreadId
        ? targetMetadata?.role === "coordinator"
        : targetMetadata?.role === "worker" && targetMetadata.coordinatorThreadId === coordinatorThreadId;
      if (!valid) throw new Error("The target is not in this coordinator's managed worker set.");
      await bb.sdk.threads.send({ threadId: targetThreadId, senderThreadId: threadId, mode: "auto", input: [{ type: "text", text: message, mentions: [] }] });
      store.touchRun(coordinatorThreadId);
      return JSON.stringify({ deliveredTo: targetThreadId });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_publish_artifact",
    description: "Publish a versioned contract or decision and notify its consumers.",
    presentation: { label: { pending: "Publishing handoff artifact", completed: "Published handoff artifact" } },
    parameters: artifactInput,
    async execute(input, { threadId }) {
      const meta = await metadata(threadId);
      if (meta === null) throw new Error("This thread is not in a managed run.");
      const coordinatorThreadId = meta.role === "coordinator" ? threadId : meta.coordinatorThreadId;
      const workstreamKey = meta.role === "worker" ? meta.key : "coordinator";
      const known = new Map(store.listWorkstreams(coordinatorThreadId).map((item) => [item.key, item]));
      for (const consumer of input.consumers) if (!known.has(consumer)) throw new Error(`Unknown consumer workstream ${consumer}.`);
      const id = store.addArtifact({
        coordinatorThreadId, workstreamKey, kind: input.kind, name: input.name, version: input.version ?? null,
        summary: input.summary, content: input.content ?? null, path: input.path ?? null, consumers: input.consumers,
      });
      const notice = `Orchestrator artifact #${id}: ${input.name}${input.version === undefined ? "" : ` (${input.version})`} — ${input.summary}`;
      await notify(coordinatorThreadId, notice, threadId);
      await Promise.all(input.consumers.map(async (key) => {
        const consumer = known.get(key);
        if (consumer?.threadId !== null && consumer?.threadId !== undefined) await notify(consumer.threadId, notice, threadId);
      }));
      return JSON.stringify({ artifactId: id, notified: input.consumers });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_worker_done",
    description: "Persist a structured workstream completion or blocker report.",
    instructions: "Call exactly once before ending a managed worker turn.",
    presentation: { label: { pending: "Recording workstream result", completed: "Recorded workstream result" } },
    parameters: completionResult,
    async execute(result, { threadId }) {
      const meta = await metadata(threadId);
      if (meta?.role !== "worker") throw new Error("Only a managed worker can complete a workstream.");
      const run = store.getRun(meta.coordinatorThreadId);
      const item = store.getWorkstream(meta.coordinatorThreadId, meta.key);
      if (run === null || item === null) throw new Error("The durable workstream record is missing.");
      const liveDescendants = store.listDescendants(meta.coordinatorThreadId, meta.key)
        .filter((child) => !["completed", "failed", "cancelled"].includes(child.state));
      if (liveDescendants.length > 0) throw new Error(`Cannot complete while descendants are live: ${liveDescendants.map((child) => child.key).join(", ")}.`);
      if (item.accessMode === "read-only" && (result.changedFiles.length > 0 || result.commits.length > 0 || result.pushedCommits.length > 0)) {
        throw new Error("Read-only delegated workstreams cannot report file changes, commits, or pushes.");
      }
      const hasVcsAction = result.commits.length > 0 || result.pushedCommits.length > 0;
      if (hasVcsAction && result.branch === undefined) throw new Error("A branch record is required when commits or pushes are reported.");
      if (result.branch !== undefined && effectiveProtectedBranches(run.policy).includes(result.branch.name) && hasVcsAction) {
        throw new Error(`Branch ${result.branch.name} is protected by this run and cannot be committed to or pushed.`);
      }
      if (result.commits.length > 0) {
        if (run.policy.commitMode === "disabled") throw new Error("Commits are disabled by this run's policy.");
        if (result.branch?.ownership === "existing") {
          if (run.policy.commitMode !== "owned-or-approved-existing") throw new Error("This run permits commits only on Orchestrator-owned branches.");
          if (result.commitApproval === undefined) throw new Error("Committing to an existing branch requires explicit user approval evidence.");
        }
      }
      if (result.pushedCommits.length > 0) {
        if (run.policy.pushMode === "disabled") throw new Error("Pushes are disabled by this run's policy.");
        if (result.pushApproval === undefined) throw new Error("Every push requires separate explicit user approval evidence.");
        const commits = new Set(result.commits);
        if (result.pushedCommits.some((sha) => !commits.has(sha))) throw new Error("Pushed commit SHAs must be included in this workstream's ordered commits.");
      }
      const review = result.status === "success" && (run.policy.evaluator === "always" || (run.policy.evaluator === "critical" && item.profile === "critical"));
      const state = result.status === "success" ? (review ? "reviewing" : "completed") : "failed";
      const next = store.setWorkstreamState(meta.coordinatorThreadId, meta.key, state, { result, error: result.status === "success" ? null : result.summary })!;
      if (!review || result.status !== "success") {
        store.recordMetric({ providerId: item.providerId, model: item.model, profile: item.profile, succeeded: result.status === "success", durationMs: Math.max(0, Date.now() - (item.startedAt ?? item.createdAt)), totalTokens: item.totalTokens });
      }
      await notify(meta.coordinatorThreadId, `Workstream ${meta.key} ${review ? "is ready for review" : state}: ${result.summary}`, threadId);
      if (item.parentKey !== null) {
        const parent = store.getWorkstream(meta.coordinatorThreadId, item.parentKey);
        if (parent?.threadId !== null && parent?.threadId !== undefined) {
          await notify(parent.threadId, `Child workstream ${meta.key} ${review ? "is ready for review" : state}: ${result.summary}`, threadId);
        }
      }
      return JSON.stringify({ key: meta.key, state: next.state, reviewRequired: review });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_review",
    description: "Accept or reject a structured workstream result at its evaluator gate.",
    presentation: { label: { pending: "Reviewing workstream", completed: "Reviewed workstream" } },
    parameters: z.object({
      key: z.string().min(1).max(100), decision: z.enum(["accept", "reject"]), feedback: z.string().trim().min(1).max(5_000).optional(),
    }).superRefine((value, ctx) => {
      if (value.decision === "reject" && value.feedback === undefined) ctx.addIssue({ code: "custom", path: ["feedback"], message: "Rejected work needs feedback." });
    }),
    async execute({ key, decision, feedback }, { threadId }) {
      await requireCoordinator(threadId);
      const run = store.getRun(threadId);
      const item = store.getWorkstream(threadId, key);
      if (run === null || item?.state !== "reviewing") throw new Error(`Workstream ${key} is not awaiting review.`);
      if (decision === "accept") {
        store.setWorkstreamState(threadId, key, "completed");
        store.releaseProjectLane(threadId, key);
        store.recordMetric({ providerId: item.providerId, model: item.model, profile: item.profile, succeeded: true, durationMs: Math.max(0, Date.now() - (item.startedAt ?? item.createdAt)), totalTokens: item.totalTokens });
        await launchQueued(threadId);
        if (item.threadId !== null) await retireWorker(item.threadId);
        return JSON.stringify({ key, state: "completed" });
      }
      if (item.attemptCount >= run.policy.maxAttemptsPerWorkstream || item.threadId === null) {
        store.setWorkstreamState(threadId, key, "failed", { error: feedback });
        store.releaseProjectLane(threadId, key);
        store.recordMetric({ providerId: item.providerId, model: item.model, profile: item.profile, succeeded: false, durationMs: Math.max(0, Date.now() - (item.startedAt ?? item.createdAt)), totalTokens: item.totalTokens });
        await launchQueued(threadId);
        if (item.threadId !== null) await retireWorker(item.threadId);
        return JSON.stringify({ key, state: "failed", retry: false });
      }
      store.setWorkstreamState(threadId, key, "running", { incrementAttempt: true, error: feedback });
      await bb.sdk.threads.send({
        threadId: item.threadId, senderThreadId: threadId, mode: "auto", model: item.model,
        reasoningLevel: item.reasoningLevel as z.output<typeof reasoningLevel>,
        input: [{ type: "text", text: `Evaluator rejected the result. Address this feedback, validate again, and call orchestrator_worker_done:\n\n${feedback}`, mentions: [] }],
      });
      return JSON.stringify({ key, state: "running", retry: true });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_finish",
    description: "Complete a run and archive all managed workers without deleting history.",
    instructions: "Call after all structured results and evaluator gates are settled.",
    presentation: { label: { pending: "Completing orchestration run", completed: "Completed orchestration run" } },
    parameters: z.object({ workerThreadIds: z.array(z.string().min(1)).max(50).default([]) }),
    async execute({ workerThreadIds }, { threadId }) {
      await requireCoordinator(threadId);
      const all = store.listWorkstreams(threadId);
      const managed = new Set(all.flatMap((item) => item.threadId === null ? [] : [item.threadId]));
      for (const id of workerThreadIds) if (!managed.has(id)) throw new Error(`Thread ${id} is not a managed worker.`);
      const unsettled = all.filter((item) => !["completed", "failed", "cancelled"].includes(item.state));
      if (unsettled.length > 0) throw new Error(`Cannot finish while workstreams are unsettled: ${unsettled.map((item) => item.key).join(", ")}.`);
      await Promise.allSettled([...managed].map(retireWorker));
      for (const item of all) store.releaseProjectLane(threadId, item.key);
      store.setRunState(threadId, all.some((item) => item.state === "failed") ? "failed" : "completed");
      return JSON.stringify({ retired: [...managed], state: store.getRun(threadId)?.state });
    },
  });

  bb.events.on("thread.active", async ({ thread }) => {
    const item = store.getWorkstreamByThread(thread.id);
    if (item !== null && item.state === "queued") store.setWorkstreamState(item.coordinatorThreadId, item.key, "running");
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (intentionallyStoppingWorkerIds.has(thread.id)) return;
    const item = store.getWorkstreamByThread(thread.id);
    if (item === null) return;
    if (item.state === "completed" || item.state === "failed" || item.state === "cancelled") {
      store.releaseProjectLane(item.coordinatorThreadId, item.key);
      await launchQueued(item.coordinatorThreadId);
      await retireWorker(thread.id);
      return;
    }
    if (item.state !== "running") return;
    const liveDescendants = store.listDescendants(item.coordinatorThreadId, item.key)
      .filter((child) => !["completed", "failed", "cancelled"].includes(child.state));
    if (liveDescendants.length > 0) return;
    store.setWorkstreamState(item.coordinatorThreadId, item.key, "failed", {
      error: "Worker became idle without a structured completion record.",
      result: { status: "failed", summary: lastAssistantText ?? "No worker output was recorded.", changedFiles: [], validation: [], blockers: ["Missing orchestrator_worker_done call."] },
    });
    store.releaseProjectLane(item.coordinatorThreadId, item.key);
    store.recordMetric({ providerId: item.providerId, model: item.model, profile: item.profile, succeeded: false, durationMs: Math.max(0, Date.now() - (item.startedAt ?? item.createdAt)), totalTokens: item.totalTokens });
    await cancelDescendants(item.coordinatorThreadId, item.key, "Parent worker failed its completion contract.");
    await notify(item.coordinatorThreadId, `Workstream ${item.key} failed its completion contract: the worker became idle without orchestrator_worker_done.`, thread.id);
    await launchQueued(item.coordinatorThreadId);
    await retireWorker(thread.id);
  });
  bb.events.on("turn.failed", async (event) => {
    const item = store.getWorkstreamByThread(event.threadId);
    if (item === null || item.state !== "running") return;
    const run = store.getRun(item.coordinatorThreadId);
    if (run === null) return;
    if (item.attemptCount < run.policy.maxAttemptsPerWorkstream) {
      store.setWorkstreamState(item.coordinatorThreadId, item.key, "running", { incrementAttempt: true, error: event.errorInfo === null ? "Provider turn failed." : `${event.errorInfo.category}${event.errorInfo.providerCode === null ? "" : ` (${event.errorInfo.providerCode})`}` });
      await bb.sdk.threads.retry({ threadId: event.threadId, turnRequestId: event.requestId, reason: `Orchestrator retry ${item.attemptCount + 1}/${run.policy.maxAttemptsPerWorkstream}` });
      return;
    }
    store.setWorkstreamState(item.coordinatorThreadId, item.key, "failed", { error: event.errorInfo === null ? "Provider turn failed and retry limit was reached." : `${event.errorInfo.category}${event.errorInfo.providerCode === null ? "" : ` (${event.errorInfo.providerCode})`}` });
    await cancelDescendants(item.coordinatorThreadId, item.key, "Parent worker exhausted its retry limit.");
    store.releaseProjectLane(item.coordinatorThreadId, item.key);
    store.recordMetric({ providerId: item.providerId, model: item.model, profile: item.profile, succeeded: false, durationMs: Math.max(0, Date.now() - (item.startedAt ?? item.createdAt)), totalTokens: item.totalTokens });
    await notify(item.coordinatorThreadId, `Workstream ${item.key} failed after ${item.attemptCount} attempt(s).`, event.threadId);
    await launchQueued(item.coordinatorThreadId);
    await retireWorker(event.threadId);
  });
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    const item = store.getWorkstreamByThread(thread.id);
    if (item === null) return;
    const rows = await bb.sdk.threads.events.list({ threadId: thread.id, afterSeq: String(item.lastEventSeq), limit: "100", types: ["thread/tokenUsage/updated"] });
    if (rows.length === 0) return;
    let tokens = item.totalTokens;
    let seq = item.lastEventSeq;
    for (const row of rows) {
      seq = Math.max(seq, row.seq);
      if (row.type === "thread/tokenUsage/updated") tokens = row.data.tokenUsage.total.totalTokens;
    }
    const total = store.setUsage(item.coordinatorThreadId, item.key, tokens, seq);
    const run = store.getRun(item.coordinatorThreadId);
    if (run !== null && run.policy.tokenBudget > 0 && total > run.policy.tokenBudget) {
      await notify(item.coordinatorThreadId, `Run token budget exceeded (${total}/${run.policy.tokenBudget}). Active workers were stopped.`);
      await cleanupRun(item.coordinatorThreadId, "failed", `Token budget exceeded (${total}/${run.policy.tokenBudget}).`);
    }
  });
  for (const eventName of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(eventName, async ({ thread }) => {
      if (store.getRun(thread.id) !== null) {
        await cleanupRun(thread.id, "cancelled", `Coordinator was ${eventName === "thread.archived" ? "archived" : "deleted"}.`);
        return;
      }
      const item = store.getWorkstreamByThread(thread.id);
      if (intentionallyStoppingWorkerIds.has(thread.id)) return;
      if (item !== null && !["completed", "failed", "cancelled"].includes(item.state)) {
        store.setWorkstreamState(item.coordinatorThreadId, item.key, "cancelled", { error: `Worker was ${eventName === "thread.archived" ? "archived" : "deleted"}.` });
        await cancelDescendants(item.coordinatorThreadId, item.key, `Parent worker was ${eventName === "thread.archived" ? "archived" : "deleted"}.`);
        store.releaseProjectLane(item.coordinatorThreadId, item.key);
        await notify(item.coordinatorThreadId, `Workstream ${item.key} was ${eventName === "thread.archived" ? "archived" : "deleted"} before completion.`);
        await launchQueued(item.coordinatorThreadId);
      }
    });
  }
  bb.background.schedule("cleanup-expired-runs", "*/5 * * * *", async () => {
    const terminal = store.listTerminalWorkstreams().filter((item) => item.threadId !== null && !retiredWorkerIds.has(item.threadId));
    for (const item of terminal) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: item.threadId! });
        if (thread.status === "idle" || thread.status === "error") {
          store.releaseProjectLane(item.coordinatorThreadId, item.key);
          await launchQueued(item.coordinatorThreadId);
          await retireWorker(item.threadId!);
        }
      } catch (error) {
        bb.log.warn(`Could not reconcile terminal worker ${item.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const item of store.listRunningWorkstreams()) {
      if (item.threadId === null) continue;
      try {
        const thread = await bb.sdk.threads.get({ threadId: item.threadId });
        if (thread.status !== "idle" && thread.status !== "error") continue;
        const descendants = store.listDescendants(item.coordinatorThreadId, item.key);
        const liveDescendants = descendants
          .filter((child) => !["completed", "failed", "cancelled"].includes(child.state));
        if (liveDescendants.length > 0) continue;
        if (descendants.length > 0) {
          await notify(item.threadId, `All managed descendants of ${item.key} are terminal. Join their durable results and call orchestrator_worker_done.`, item.coordinatorThreadId);
          continue;
        }
        store.setWorkstreamState(item.coordinatorThreadId, item.key, "failed", {
          error: "Reload reconciliation found an idle worker without a structured completion record.",
          result: { status: "failed", summary: "No structured completion was recorded.", changedFiles: [], validation: [], blockers: ["Missing orchestrator_worker_done call."], commits: [], pushedCommits: [] },
        });
        await cancelDescendants(item.coordinatorThreadId, item.key, "Parent worker failed reload reconciliation.");
        store.releaseProjectLane(item.coordinatorThreadId, item.key);
        await notify(item.coordinatorThreadId, `Workstream ${item.key} failed reload reconciliation without orchestrator_worker_done.`);
        await retireWorker(item.threadId);
      } catch (error) {
        bb.log.warn(`Could not reconcile running worker ${item.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const timedOut = store.listTimedOutWorkstreams(Date.now());
    const timedOutThreadIds = timedOut.flatMap((item) => item.threadId === null ? [] : [item.threadId]);
    await stopWorkers(timedOutThreadIds);
    for (const item of timedOut) {
      store.setWorkstreamState(item.coordinatorThreadId, item.key, "failed", { error: "Worker timeout was reached." });
      await cancelDescendants(item.coordinatorThreadId, item.key, "Parent worker timed out.");
      store.releaseProjectLane(item.coordinatorThreadId, item.key);
      store.recordMetric({ providerId: item.providerId, model: item.model, profile: item.profile, succeeded: false, durationMs: Math.max(0, Date.now() - (item.startedAt ?? item.createdAt)), totalTokens: item.totalTokens });
    }
    await Promise.all(timedOut.map((item) => notify(item.coordinatorThreadId, `Workstream ${item.key} was stopped after reaching its worker timeout.`)));
    await Promise.all([...new Set(timedOut.map((item) => item.coordinatorThreadId))].map((id) => launchQueued(id)));
    await archiveWorkers(timedOutThreadIds);
    await Promise.all(store.listExpiredRuns(Date.now()).map((run) => cleanupRun(run.coordinatorThreadId, "cancelled", "Run expired due to its runtime or inactivity limit.")));
  });

  bb.agents.configure((context) => {
    const parsed = metadataSchema.safeParse(context.pluginMetadata);
    if (parsed.success && parsed.data.role === "coordinator") {
      const run = store.getRun(context.thread.id);
      if (run !== null && ["completed", "failed", "cancelled"].includes(run.state)) {
        return {
          tools: ["orchestrator_enable", "orchestrator_status"],
          skills: [],
          instructions: "This Orchestrator run is terminal. You may call orchestrator_enable when the user asks to reset the run and refresh its allowed projects.",
        };
      }
      return {
        tools: ["orchestrator_dispatch", "orchestrator_status", "orchestrator_message", "orchestrator_publish_artifact", "orchestrator_review", "orchestrator_finish"],
        skills: [],
        instructions: "You are a managed Orchestrator coordinator. The plugin is the single lifecycle writer. Dispatch a complete stable-key workstream set and use the cheapest adequate profile: quick for bounded mechanical work and standard for ordinary implementation. Reserve complex for identified cross-cutting uncertainty and critical for concrete high-cost failure risk. Use durable status and artifacts instead of polling output, evaluate gated results, and finish only when every workstream is terminal.",
      };
    }
    if (parsed.success && parsed.data.role === "worker") {
      const run = store.getRun(parsed.data.coordinatorThreadId);
      const policy = run?.policy ?? DEFAULT_POLICY;
      return {
        tools: ["orchestrator_delegate", "orchestrator_status", "orchestrator_message", "orchestrator_publish_artifact", "orchestrator_worker_done"],
        skills: [],
        instructions: `You are managed workstream ${JSON.stringify(parsed.data.key)} at depth ${parsed.data.depth} with ${parsed.data.accessMode} access. Delegate only bounded read-only children through orchestrator_delegate and never spawn threads directly. Commit mode: ${policy.commitMode}; push mode: ${policy.pushMode}; protected branches: ${JSON.stringify(effectiveProtectedBranches(policy))}. Existing branches require explicit user approval for commits and a separate explicit approval for pushes. Report ordered commit SHAs. Publish contracts early, communicate blockers, and call orchestrator_worker_done exactly once after every descendant is terminal.`,
      };
    }
    if (context.thread.parentThreadId === null) {
      return { tools: ["orchestrator_enable"], skills: [], instructions: "This ordinary root thread can opt into managed orchestration with orchestrator_enable when the user asks. Managed tools become available on its next turn." };
    }
    return { tools: [], skills: [] };
  });
}
