import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { coordinatorPrompt, type OrchestratorProject } from "./lib/coordinator-prompt.ts";

const reasoningLevel = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
const permissionMode = z.enum(["auto", "accept-edits", "full"]);
const serviceTier = z.enum(["default", "fast"]);
const executionInputSource = z.enum(["explicit", "client-preference"]);
const attachment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), url: z.string().min(1) }),
  z.object({ type: z.literal("localImage"), path: z.string().min(1) }),
  z.object({ type: z.literal("localFile"), path: z.string().min(1), mimeType: z.string().optional(), name: z.string().optional(), sizeBytes: z.number().optional() }),
]);
const projectIds = z.array(z.string().min(1)).min(1).max(50).refine(
  (ids) => new Set(ids).size === ids.length,
  "Project ids must be unique.",
);
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
    providerId: executionInputSource.optional(),
    model: executionInputSource.optional(),
    reasoningLevel: executionInputSource.optional(),
    permissionMode: executionInputSource.optional(),
    serviceTier: executionInputSource.optional(),
  }).optional(),
  attachments: z.array(attachment).optional(),
});
const enableInput = z.object({
  threadId: z.string().min(1),
  label: z.string().trim().min(1).max(200),
  projectIds,
});
const threadOrchestrationProject = z.object({
  id: z.string(),
  name: z.string(),
  current: z.boolean(),
});
const threadOrchestrationState = z.object({
  eligible: z.boolean(),
  enabled: z.boolean(),
  label: z.string(),
  allowedProjectIds: z.array(z.string()),
  projects: z.array(threadOrchestrationProject),
});
const profile = z.enum(["quick", "standard", "complex", "critical"]);
const providerRoutes = z.object({
  quick: z.string().min(1),
  standard: z.string().min(1),
  complex: z.string().min(1),
  critical: z.string().min(1),
});
type WorkerProfile = z.infer<typeof profile>;
const BUILTIN_ROUTE_MODELS: Record<string, Record<WorkerProfile, string>> = {
  "claude-code": {
    quick: "claude-haiku-4-5-20251001",
    standard: "claude-sonnet-5",
    complex: "claude-fable-5-1",
    critical: "claude-opus-5[1m]",
  },
  codex: {
    quick: "gpt-5.6-luna",
    standard: "gpt-5.6-terra",
    complex: "gpt-5.6-sol",
    critical: "gpt-6-astra",
  },
};
const routingMap = z.record(z.string().min(1), providerRoutes);
const catalogModel = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  defaultReasoningLevel: reasoningLevel,
  supportedReasoningLevels: z.array(reasoningLevel),
});
const catalogProvider = z.object({
  id: z.string(),
  displayName: z.string(),
  models: z.array(catalogModel),
  modelLoadError: z.string().nullable(),
  recommendedRoutes: providerRoutes.nullable(),
});

export const rpcContract = defineRpcContract({
  start: { input: startInput, output: z.object({ threadId: z.string() }) },
  enable: { input: enableInput, output: z.object({ threadId: z.string() }) },
  thread_orchestration_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: threadOrchestrationState,
  },
  thread_orchestration_disable: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.null(),
  },
  routing_catalog: {
    input: z.null(),
    output: z.object({ providers: z.array(catalogProvider) }),
  },
  routing_get: {
    input: z.null(),
    output: z.object({ routes: routingMap }),
  },
  routing_set_provider: {
    input: z.object({ providerId: z.string().min(1), routes: providerRoutes }),
    output: z.object({ routes: routingMap }),
  },
});

const workerAssignment = z.object({
  key: z.string().trim().min(1).max(100),
  projectId: z.string().min(1),
  prompt: z.string().trim().min(1).max(50_000),
  title: z.string().trim().min(1).max(200).optional(),
  profile: profile.default("quick"),
  complexityReason: z.string().trim().min(1).max(500).optional(),
}).superRefine((assignment, ctx) => {
  if (assignment.profile !== "quick" && assignment.complexityReason === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["complexityReason"],
      message: `The ${assignment.profile} profile needs a complexity reason.`,
    });
  }
});
const PROFILE_REASONING = {
  quick: "low",
  standard: "medium",
  complex: "high",
  critical: "xhigh",
} as const;
const metadataSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("coordinator"),
    label: z.string().min(1),
    allowedProjectIds: z.array(z.string().min(1)),
  }),
  z.object({
    role: z.literal("worker"),
    coordinatorThreadId: z.string().min(1),
    key: z.string().min(1),
    projectId: z.string().min(1),
    assignment: z.string(),
    profile,
    complexityReason: z.string().optional(),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel,
  }),
]);
type OrchestratorMetadata = z.infer<typeof metadataSchema>;

export default async function plugin(bb: BbPluginApi) {
  const ROUTING_KEY = "provider-routes";
  const readRoutes = async () => {
    const parsed = routingMap.safeParse(await bb.storage.kv.get(ROUTING_KEY));
    return parsed.success ? parsed.data : {};
  };

  const providerCatalog = async () => {
    const providers = (await bb.sdk.providers.list()).filter(
      (provider) => provider.available,
    );
    return Promise.all(
      providers.map(async (provider) => {
        try {
          const result = await bb.sdk.providers.models({ providerId: provider.id });
          return {
            id: provider.id,
            displayName: provider.displayName,
            models: result.models.map((model) => ({
              id: model.id,
              model: model.model,
              displayName: model.displayName,
              description: model.description,
              isDefault: model.isDefault,
              defaultReasoningLevel: model.defaultReasoningEffort,
              supportedReasoningLevels: model.supportedReasoningEfforts.map(
                (effort) => effort.reasoningEffort,
              ),
            })),
            modelLoadError:
              result.modelLoadError === null ? null : result.modelLoadError.code,
            recommendedRoutes: (() => {
              const preferred = BUILTIN_ROUTE_MODELS[provider.id];
              const fallback = result.models.find((model) => model.isDefault) ?? result.models[0];
              if (fallback === undefined) return null;
              return Object.fromEntries(
                profile.options.map((profileId) => {
                  const requested = preferred?.[profileId];
                  const match = result.models.find(
                    (model) => model.id === requested || model.model === requested,
                  );
                  return [profileId, (match ?? fallback).id];
                }),
              ) as z.output<typeof providerRoutes>;
            })(),
          };
        } catch (error) {
          return {
            id: provider.id,
            displayName: provider.displayName,
            models: [],
            modelLoadError:
              error instanceof Error ? error.message : "Could not load models.",
            recommendedRoutes: null,
          };
        }
      }),
    );
  };

  const metadata = async (threadId: string): Promise<OrchestratorMetadata | null> => {
    const parsed = metadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }));
    return parsed.success ? parsed.data : null;
  };

  const resolveProjects = async (ids: readonly string[]) => {
    const all = await bb.sdk.projects.list({ includePersonal: true });
    const byId = new Map(all.map((project) => [project.id, project]));
    const selected: OrchestratorProject[] = ids.map((id) => {
      const project = byId.get(id);
      if (project === undefined || project.kind === "personal") {
        throw new Error(`No orchestratable project with id ${id}.`);
      }
      const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
      return { id: project.id, name: project.name, ...(source === undefined ? {} : { path: source.path }) };
    });
    return { all, selected };
  };

  const enable = async (input: z.output<typeof enableInput>) => {
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    if (thread.parentThreadId !== null) throw new Error("Only a root thread can become an orchestrator.");
    await resolveProjects(input.projectIds);
    await bb.sdk.threads.updatePluginMetadata({
      threadId: input.threadId,
      set: { role: "coordinator", label: input.label, allowedProjectIds: input.projectIds },
    });
    bb.realtime.publish("thread-orchestration-changed", { threadId: input.threadId });
    return { threadId: input.threadId };
  };

  const threadOrchestrationStateFor = async (threadId: string) => {
    const [thread, allProjects, value] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.projects.list({ includePersonal: true }),
      metadata(threadId),
    ]);
    const projects = allProjects
      .filter((project) => project.kind !== "personal")
      .map((project) => ({
        id: project.id,
        name: project.name,
        current: project.id === thread.projectId,
      }));
    const currentProject = projects.find((project) => project.current);
    const enabled = value?.role === "coordinator";
    return {
      eligible: thread.parentThreadId === null && value?.role !== "worker",
      enabled,
      label: enabled
        ? value.label
        : thread.title ?? thread.titleFallback ?? currentProject?.name ?? "Orchestrated work",
      allowedProjectIds: enabled
        ? value.allowedProjectIds
        : currentProject === undefined ? [] : [currentProject.id],
      projects,
    };
  };

  bb.rpc.register(rpcContract, {
    start: async ({ label, task, projectIds: ids, attachments, ...execution }) => {
      const { all, selected } = await resolveProjects(ids);
      const personal = all.find((project) => project.kind === "personal");
      if (personal === undefined) throw new Error("No personal project is available.");
      const thread = await bb.sdk.threads.spawn({
        projectId: personal.id,
        environment: { type: "host", workspace: { type: "personal" } },
        title: `Orchestrator: ${label}`,
        pluginMetadata: { role: "coordinator", label, allowedProjectIds: ids },
        ...execution,
        input: [
          { type: "text", text: coordinatorPrompt(label, selected, task), mentions: [] },
          ...(attachments ?? []),
        ],
      });
      return { threadId: thread.id };
    },
    enable,
    thread_orchestration_get: async ({ threadId }) => threadOrchestrationStateFor(threadId),
    thread_orchestration_disable: async ({ threadId }) => {
      const state = await threadOrchestrationStateFor(threadId);
      if (!state.eligible) throw new Error("Only an eligible root thread can change orchestration.");
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: ["role", "label", "allowedProjectIds"],
      });
      bb.realtime.publish("thread-orchestration-changed", { threadId });
      return null;
    },
    routing_catalog: async () => ({ providers: await providerCatalog() }),
    routing_get: async () => ({ routes: await readRoutes() }),
    routing_set_provider: async ({ providerId, routes }) => {
      const provider = (await providerCatalog()).find(
        (candidate) => candidate.id === providerId,
      );
      if (provider === undefined) {
        throw new Error(`Provider ${providerId} is not currently available.`);
      }
      const modelIds = new Set(provider.models.map((model) => model.id));
      for (const [profileId, modelId] of Object.entries(routes)) {
        if (!modelIds.has(modelId)) {
          throw new Error(
            `Model ${modelId} is not available for ${provider.displayName} (${profileId}).`,
          );
        }
      }
      const next = { ...(await readRoutes()), [providerId]: routes };
      await bb.storage.kv.set(ROUTING_KEY, next);
      bb.realtime.publish("routing-changed", { providerId });
      return { routes: next };
    },
  });

  const workerExecution = async (providerId: string, workerProfile: WorkerProfile) => {
    const result = await bb.sdk.providers.models({ providerId });
    if (result.modelLoadError !== null) {
      throw new Error(
        `Could not load ${providerId} models: ${result.modelLoadError.code}.`,
      );
    }
    const configuredModelId =
      (await readRoutes())[providerId]?.[workerProfile] ??
      BUILTIN_ROUTE_MODELS[providerId]?.[workerProfile];
    if (configuredModelId === undefined) {
      throw new Error(
        `No ${workerProfile} worker model is configured for provider ${providerId}. Open Orchestrator in Installed Plugins and save its routing.`,
      );
    }
    const selected = result.models.find(
      (model) =>
        model.id === configuredModelId || model.model === configuredModelId,
    );
    if (selected === undefined) {
      throw new Error(
        `Configured ${workerProfile} model ${configuredModelId} is no longer available for provider ${providerId}. Update Orchestrator routing.`,
      );
    }
    const supported = selected.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    );
    const requested = PROFILE_REASONING[workerProfile];
    const selectedReasoning = supported.includes(requested)
      ? requested
      : supported.includes(selected.defaultReasoningEffort)
        ? selected.defaultReasoningEffort
        : supported[0] ?? selected.defaultReasoningEffort;
    return {
      providerId: selected.routeProviderId ?? providerId,
      model: selected.model,
      reasoningLevel: selectedReasoning,
    };
  };

  const requireCoordinator = async (threadId: string) => {
    const value = await metadata(threadId);
    if (value?.role !== "coordinator") throw new Error("This tool is only available to an Orchestrator coordinator.");
    return value;
  };
  const directChildren = (coordinatorThreadId: string) => bb.sdk.threads.list({
    parentThreadId: coordinatorThreadId,
    includeHidden: true,
    limit: 500,
  });
  const retireWorker = async (threadId: string) => {
    let archiveError: unknown;
    try { await bb.sdk.threads.archive({ threadId }); } catch (error) { archiveError = error; }
    await bb.sdk.threads.stop({ threadId });
    if (archiveError !== undefined) throw archiveError;
  };

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
    description: "Reconcile a coordinator's complete desired managed-worker set.",
    instructions: "Use stable keys and send the complete desired set. Quick is the cheap default; stronger profiles require a concrete reason.",
    presentation: { label: { pending: "Reconciling workers", completed: "Reconciled workers" } },
    parameters: z.object({
      assignments: z.array(workerAssignment).max(50).refine(
        (items) => new Set(items.map((item) => item.key)).size === items.length,
        "Worker keys must be unique.",
      ),
    }),
    async execute({ assignments }, { threadId }) {
      const [coordinatorMetadata, coordinator] = await Promise.all([
        requireCoordinator(threadId),
        bb.sdk.threads.get({ threadId }),
      ]);
      const { selected } = await resolveProjects(
        coordinatorMetadata.allowedProjectIds,
      );
      const projectsById = new Map(selected.map((project) => [project.id, project]));
      for (const assignment of assignments) {
        if (!projectsById.has(assignment.projectId)) throw new Error(`Project ${assignment.projectId} is not allowed in this run.`);
      }

      const desiredByKey = new Map(assignments.map((assignment) => [assignment.key, assignment]));
      const children = (await directChildren(threadId)).sort((left, right) => right.updatedAt - left.updatedAt);
      const retained = new Map<string, (typeof children)[number]>();
      const retired: string[] = [];
      const staleWorkerIds: string[] = [];
      const childrenWithMetadata = await Promise.all(
        children.map(async (child) => ({ child, metadata: await metadata(child.id) })),
      );
      for (const { child, metadata: childMetadata } of childrenWithMetadata) {
        if (childMetadata?.role !== "worker" || childMetadata.coordinatorThreadId !== threadId) continue;
        if (!desiredByKey.has(childMetadata.key) || retained.has(childMetadata.key) || child.status === "error" || child.status === "stopping") {
          staleWorkerIds.push(child.id);
          continue;
        }
        retained.set(childMetadata.key, child);
      }
      await Promise.all(staleWorkerIds.map(retireWorker));
      retired.push(...staleWorkerIds);

      const workers: Array<{
        key: string; projectId: string; threadId: string;
        action: "kept" | "updated" | "spawned"; profile: WorkerProfile;
        providerId: string; model: string; reasoningLevel: z.output<typeof reasoningLevel>;
      }> = [];
      const executionByProfile = new Map(
        await Promise.all(
          [...new Set(assignments.map((assignment) => assignment.profile))].map(
            async (workerProfile) => [
              workerProfile,
              await workerExecution(coordinator.providerId, workerProfile),
            ] as const,
          ),
        ),
      );
      for (const assignment of assignments) {
        const execution = executionByProfile.get(assignment.profile)!;
        let existing = retained.get(assignment.key);
        const existingMetadata = existing === undefined ? null : await metadata(existing.id);
        if (existing !== undefined && (existing.providerId !== execution.providerId || existing.projectId !== assignment.projectId)) {
          await retireWorker(existing.id);
          retired.push(existing.id);
          existing = undefined;
        }
        const project = projectsById.get(assignment.projectId)!;
        const workerMetadata = {
          role: "worker" as const,
          coordinatorThreadId: threadId,
          key: assignment.key,
          projectId: assignment.projectId,
          assignment: assignment.prompt,
          profile: assignment.profile,
          ...(assignment.complexityReason === undefined ? {} : { complexityReason: assignment.complexityReason }),
          ...execution,
        };
        if (existing === undefined) {
          const spawned = await bb.sdk.threads.spawn({
            projectId: assignment.projectId,
            environment: { type: "project-default" },
            parentThreadId: threadId,
            visibility: "visible",
            title: assignment.title ?? `${coordinatorMetadata.label}: ${project.name} · ${assignment.key}`,
            prompt: assignment.prompt,
            ...execution,
            pluginMetadata: workerMetadata,
          });
          workers.push({ key: assignment.key, projectId: assignment.projectId, threadId: spawned.id, action: "spawned", profile: assignment.profile, ...execution });
          continue;
        }

        if (existing.visibility !== "visible") await bb.sdk.threads.update({ threadId: existing.id, visibility: "visible" });
        if (
          existingMetadata?.role === "worker" && existingMetadata.coordinatorThreadId === threadId &&
          existingMetadata.key === assignment.key && existingMetadata.projectId === assignment.projectId &&
          existingMetadata.assignment === assignment.prompt && existingMetadata.profile === assignment.profile &&
          existingMetadata.complexityReason === assignment.complexityReason && existingMetadata.providerId === execution.providerId &&
          existingMetadata.model === execution.model && existingMetadata.reasoningLevel === execution.reasoningLevel
        ) {
          workers.push({ key: assignment.key, projectId: assignment.projectId, threadId: existing.id, action: "kept", profile: assignment.profile, ...execution });
          continue;
        }

        await bb.sdk.threads.updatePluginMetadata({
          threadId: existing.id,
          set: { ...workerMetadata, complexityReason: assignment.complexityReason ?? null },
        });
        await bb.sdk.threads.update({ threadId: existing.id, visibility: "visible", model: execution.model, reasoningLevel: execution.reasoningLevel });
        await bb.sdk.threads.send({
          threadId: existing.id,
          senderThreadId: threadId,
          mode: "queue-if-active",
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          input: [{ type: "text", text: assignment.prompt, mentions: [] }],
        });
        workers.push({ key: assignment.key, projectId: assignment.projectId, threadId: existing.id, action: "updated", profile: assignment.profile, ...execution });
      }
      return JSON.stringify({ workers, retired });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_message",
    description: "Send a message between a coordinator and managed workers in one run.",
    instructions: "Use for contracts, questions, blockers, dependency handoffs, and integration feedback.",
    presentation: { label: { pending: "Sending orchestration update", completed: "Sent orchestration update" } },
    parameters: z.object({ targetThreadId: z.string().min(1), message: z.string().trim().min(1).max(50_000) }),
    async execute({ targetThreadId, message }, { threadId }) {
      const senderMetadata = await metadata(threadId);
      if (senderMetadata === null) throw new Error("This thread is not in a managed run.");
      const sender = await bb.sdk.threads.get({ threadId });
      const coordinatorThreadId = senderMetadata.role === "coordinator" ? threadId : senderMetadata.coordinatorThreadId;
      if (senderMetadata.role === "worker" && sender.parentThreadId !== coordinatorThreadId) throw new Error("This worker is no longer attached to its coordinator.");
      const [target, targetMetadata] = await Promise.all([
        bb.sdk.threads.get({ threadId: targetThreadId }),
        metadata(targetThreadId),
      ]);
      const isCoordinator = senderMetadata.role === "worker" && targetThreadId === coordinatorThreadId && targetMetadata?.role === "coordinator";
      const isWorker = target.parentThreadId === coordinatorThreadId && targetMetadata?.role === "worker" && targetMetadata.coordinatorThreadId === coordinatorThreadId;
      if (!isCoordinator && !isWorker) throw new Error("The target is not in this coordinator's managed worker set.");
      await bb.sdk.threads.send({
        threadId: targetThreadId,
        senderThreadId: threadId,
        mode: "auto",
        input: [{ type: "text", text: message, mentions: [] }],
      });
      return JSON.stringify({ deliveredTo: targetThreadId });
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_finish",
    description: "Archive and stop completed managed workers without deleting history.",
    instructions: "Call after reading worker outputs and completing cross-worker handoffs.",
    presentation: { label: { pending: "Retiring workers", completed: "Retired workers" } },
    parameters: z.object({
      workerThreadIds: z.array(z.string().min(1)).min(1).max(50).refine(
        (ids) => new Set(ids).size === ids.length,
        "Worker ids must be unique.",
      ),
    }),
    async execute({ workerThreadIds }, { threadId }) {
      await requireCoordinator(threadId);
      const children = await directChildren(threadId);
      const managed = new Set<string>();
      const childrenWithMetadata = await Promise.all(
        children.map(async (child) => ({ child, metadata: await metadata(child.id) })),
      );
      for (const { child, metadata: childMetadata } of childrenWithMetadata) {
        if (childMetadata?.role === "worker" && childMetadata.coordinatorThreadId === threadId) managed.add(child.id);
      }
      for (const workerThreadId of workerThreadIds) {
        if (!managed.has(workerThreadId)) throw new Error(`Thread ${workerThreadId} is not a live managed worker.`);
      }
      await Promise.all(workerThreadIds.map(retireWorker));
      return JSON.stringify({ retired: workerThreadIds });
    },
  });

  bb.agents.configure((context) => {
    const parsed = metadataSchema.safeParse(context.pluginMetadata);
    if (parsed.success && parsed.data.role === "coordinator") {
      return {
        tools: ["orchestrator_dispatch", "orchestrator_message", "orchestrator_finish"],
        skills: [],
        instructions: "You are a managed Orchestrator coordinator. Use orchestrator tools as the single writer for worker lifecycle and communication; do not spawn workers directly.",
      };
    }
    if (parsed.success && parsed.data.role === "worker") {
      return {
        tools: ["orchestrator_message"],
        skills: [],
        instructions: `You are managed worker ${JSON.stringify(parsed.data.key)}. Report blockers and exact interface changes to coordinator ${JSON.stringify(parsed.data.coordinatorThreadId)} with orchestrator_message. You may message sibling workers for direct handoffs. Do not spawn threads.`,
      };
    }
    if (context.thread.parentThreadId === null) {
      return {
        tools: ["orchestrator_enable"],
        skills: [],
        instructions: "This ordinary root thread can opt into managed orchestration with orchestrator_enable when the user asks. Managed tools become available on its next turn.",
      };
    }
    return { tools: [], skills: [] };
  });
}
