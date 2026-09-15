import { z } from "zod";

export const workerProfile = z.enum(["quick", "standard", "complex", "critical"]);
export type WorkerProfile = z.infer<typeof workerProfile>;

export const approvalPolicy = z.enum(["never", "first-dispatch", "critical", "every-dispatch"]);
export const evaluatorPolicy = z.enum(["never", "critical", "always"]);
export const providerStrategy = z.enum(["coordinator", "profile"]);
export const reasoningChoice = z.enum(["model-default", "none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
export const commitMode = z.enum(["disabled", "owned-only", "owned-or-approved-existing"]);
export const pushMode = z.enum(["disabled", "explicit-approval"]);

export const orchestrationPolicy = z.object({
  maxParallelWorkers: z.number().int().min(1).max(20),
  maxWorkersPerRun: z.number().int().min(1).max(50),
  maxAttemptsPerWorkstream: z.number().int().min(1).max(5),
  maxDelegationDepth: z.number().int().min(0).max(5).default(2),
  maxChildrenPerWorker: z.number().int().min(1).max(20).default(3),
  workerTimeoutMinutes: z.number().int().min(5).max(24 * 60),
  runTimeoutMinutes: z.number().int().min(10).max(7 * 24 * 60),
  inactiveCleanupMinutes: z.number().int().min(10).max(30 * 24 * 60),
  tokenBudget: z.number().int().min(0).max(100_000_000),
  approval: approvalPolicy,
  evaluator: evaluatorPolicy,
  commitMode: commitMode.default("owned-or-approved-existing"),
  pushMode: pushMode.default("explicit-approval"),
  protectedBranches: z.array(z.string().trim().min(1).max(200)).max(50).default(["main", "develop"])
    .transform((branches) => [...new Set(branches)]),
});
export type OrchestrationPolicy = z.infer<typeof orchestrationPolicy>;

export const DEFAULT_POLICY: OrchestrationPolicy = {
  maxParallelWorkers: 3,
  maxWorkersPerRun: 8,
  maxAttemptsPerWorkstream: 2,
  maxDelegationDepth: 2,
  maxChildrenPerWorker: 3,
  workerTimeoutMinutes: 45,
  runTimeoutMinutes: 180,
  inactiveCleanupMinutes: 120,
  tokenBudget: 0,
  approval: "critical",
  evaluator: "critical",
  commitMode: "owned-or-approved-existing",
  pushMode: "explicit-approval",
  protectedBranches: ["main", "develop"],
};

export function parseOrchestrationPolicy(value: unknown): OrchestrationPolicy {
  return orchestrationPolicy.parse(value);
}

export function effectiveProtectedBranches(policy: Pick<OrchestrationPolicy, "protectedBranches">): string[] {
  return policy.protectedBranches;
}

export const routeTarget = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  reasoningLevel: reasoningChoice.default("model-default"),
});
export const profileRouteTargets = z.object({
  quick: routeTarget.nullable(),
  standard: routeTarget.nullable(),
  complex: routeTarget.nullable(),
  critical: routeTarget.nullable(),
});
export type ProfileRouteTargets = z.infer<typeof profileRouteTargets>;

export const EMPTY_PROFILE_ROUTES: ProfileRouteTargets = {
  quick: null,
  standard: null,
  complex: null,
  critical: null,
};

export const routingPolicy = z.object({
  strategy: providerStrategy,
  profileRoutes: profileRouteTargets,
});
export type RoutingPolicy = z.infer<typeof routingPolicy>;

/** The pre-0.3 policy is accepted only while loading persisted settings. */
export const legacyRoutingPolicy = z.object({
  strategy: providerStrategy,
  profileRoutes: z.object({ quick: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).nullable(), standard: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).nullable(), complex: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).nullable(), critical: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).nullable() }),
  profileReasoning: z.object({ quick: reasoningChoice, standard: reasoningChoice, complex: reasoningChoice, critical: reasoningChoice }),
});

export const providerRouteTarget = z.object({ modelId: z.string().min(1), reasoningLevel: reasoningChoice.default("model-default") });
export const providerProfileRoutes = z.object({ quick: providerRouteTarget, standard: providerRouteTarget, complex: providerRouteTarget, critical: providerRouteTarget });
export type ProviderProfileRoutes = z.infer<typeof providerProfileRoutes>;
export const legacyProviderProfileRoutes = z.object({ quick: z.string().min(1), standard: z.string().min(1), complex: z.string().min(1), critical: z.string().min(1) });

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  strategy: "coordinator",
  profileRoutes: EMPTY_PROFILE_ROUTES,
};
