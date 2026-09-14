import { z } from "zod";

export const workerProfile = z.enum(["quick", "standard", "complex", "critical"]);
export type WorkerProfile = z.infer<typeof workerProfile>;

export const approvalPolicy = z.enum(["never", "first-dispatch", "critical", "every-dispatch"]);
export const evaluatorPolicy = z.enum(["never", "critical", "always"]);
export const providerStrategy = z.enum(["coordinator", "profile"]);

export const orchestrationPolicy = z.object({
  maxParallelWorkers: z.number().int().min(1).max(20),
  maxWorkersPerRun: z.number().int().min(1).max(50),
  maxAttemptsPerWorkstream: z.number().int().min(1).max(5),
  workerTimeoutMinutes: z.number().int().min(5).max(24 * 60),
  runTimeoutMinutes: z.number().int().min(10).max(7 * 24 * 60),
  inactiveCleanupMinutes: z.number().int().min(10).max(30 * 24 * 60),
  tokenBudget: z.number().int().min(0).max(100_000_000),
  approval: approvalPolicy,
  evaluator: evaluatorPolicy,
});
export type OrchestrationPolicy = z.infer<typeof orchestrationPolicy>;

export const DEFAULT_POLICY: OrchestrationPolicy = {
  maxParallelWorkers: 3,
  maxWorkersPerRun: 8,
  maxAttemptsPerWorkstream: 2,
  workerTimeoutMinutes: 45,
  runTimeoutMinutes: 180,
  inactiveCleanupMinutes: 120,
  tokenBudget: 0,
  approval: "critical",
  evaluator: "critical",
};

export const routeTarget = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
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

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  strategy: "coordinator",
  profileRoutes: EMPTY_PROFILE_ROUTES,
};
