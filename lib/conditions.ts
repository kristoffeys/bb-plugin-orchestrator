import type { WorkstreamRecord } from "./state.ts";

export type ConditionType = "DependenciesSatisfied" | "LaneAvailable" | "WorkspaceReady" | "Ready";
export interface WorkstreamCondition {
  type: ConditionType;
  status: boolean;
  reason: string;
  message: string | null;
}

const TERMINAL_REASON: Record<string, string> = { completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

/** Projects whose single mutating lane is taken. The launcher and the reported conditions must agree on this. */
export const mutatingLaneHolders = (workstreams: readonly WorkstreamRecord[]) => new Set(workstreams
  .filter((item) => item.accessMode === "mutating" && (
    item.state === "running"
    || item.state === "reviewing"
    || item.state === "suspended"
    || (item.threadId !== null && item.laneReleasedAt === null && ["completed", "failed", "cancelled"].includes(item.state))))
  .map((item) => item.projectId));

/** Why each workstream is or is not ready, keyed by workstream key. Derived, never stored. */
export const runConditions = (input: {
  workstreams: readonly WorkstreamRecord[];
  dependencies: (key: string) => readonly string[];
  environmentAttached: (projectId: string) => boolean;
  maxParallelWorkers: number;
}) => {
  const stateOf = new Map(input.workstreams.map((item) => [item.key, item.state]));
  const holders = mutatingLaneHolders(input.workstreams);
  const slotsAvailable = input.workstreams.filter((item) => item.state === "running").length < input.maxParallelWorkers;
  return new Map(input.workstreams.map((item): [string, WorkstreamCondition[]] => {
    const terminal = TERMINAL_REASON[item.state];
    if (terminal !== undefined) return [item.key, [{ type: "Ready", status: false, reason: terminal, message: item.error }]];
    if (item.state === "suspended") return [item.key, [{ type: "Ready", status: false, reason: "Suspended", message: "Resume this workstream to continue it." }]];
    const conditions: WorkstreamCondition[] = [];
    const unmet = input.dependencies(item.key).filter((key) => stateOf.get(key) !== "completed");
    conditions.push(unmet.length === 0
      ? { type: "DependenciesSatisfied", status: true, reason: "Satisfied", message: null }
      : { type: "DependenciesSatisfied", status: false, reason: "WaitingForDependencies", message: `Waiting for ${unmet.join(", ")}` });
    if (item.state === "planned" || item.state === "queued") {
      conditions.push(item.accessMode === "mutating" && holders.has(item.projectId)
        ? { type: "LaneAvailable", status: false, reason: "ProjectLaneBusy", message: `Another ${item.projectId} workstream holds the single mutating lane` }
        : !slotsAvailable
          ? { type: "LaneAvailable", status: false, reason: "WorkerSlotsExhausted", message: `All ${input.maxParallelWorkers} worker slots are busy` }
          : { type: "LaneAvailable", status: true, reason: "Available", message: null });
    }
    const workspaceReady = item.threadId !== null && input.environmentAttached(item.projectId);
    conditions.push(workspaceReady
      ? { type: "WorkspaceReady", status: true, reason: "Attached", message: null }
      : { type: "WorkspaceReady", status: false, reason: "Provisioning", message: "The project worktree is not attached yet" });
    const blocking = conditions.find((condition) => !condition.status) ?? null;
    conditions.push(
      item.state === "running" && workspaceReady ? { type: "Ready", status: true, reason: "Running", message: null }
      : item.state === "reviewing" ? { type: "Ready", status: false, reason: "AwaitingReview", message: "Waiting for coordinator review" }
      : item.state === "awaiting_approval" ? { type: "Ready", status: false, reason: "AwaitingApproval", message: "Waiting for dispatch approval" }
      : blocking !== null ? { type: "Ready", status: false, reason: blocking.reason, message: blocking.message }
      : { type: "Ready", status: false, reason: "Queued", message: "Waiting for a launch slot" },
    );
    return [item.key, conditions];
  }));
};
