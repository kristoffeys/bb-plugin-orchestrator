import type Database from "better-sqlite3";
import { parseOrchestrationPolicy, type OrchestrationPolicy, type WorkerProfile } from "./policy.ts";

export type RunState = "configured" | "running" | "awaiting_approval" | "blocked" | "completed" | "failed" | "cancelled";
export type WorkstreamState = "planned" | "awaiting_approval" | "queued" | "running" | "reviewing" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  coordinatorThreadId: string;
  sessionId: string;
  featureBranch: string;
  label: string;
  allowedProjectIds: string[];
  state: RunState;
  policy: OrchestrationPolicy;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  totalTokens: number;
  coordinatorLastEventSeq: number;
  coordinatorTotalTokens: number;
  coordinatorInputTokens: number;
  coordinatorCachedInputTokens: number;
  coordinatorOutputTokens: number;
  coordinatorReasoningOutputTokens: number;
  coordinatorBaselineTotalTokens: number;
  coordinatorBaselineInputTokens: number;
  coordinatorBaselineCachedInputTokens: number;
  coordinatorBaselineOutputTokens: number;
  coordinatorBaselineReasoningOutputTokens: number;
  firstDispatchApproved: boolean;
  error: string | null;
}

export interface WorkstreamRecord {
  coordinatorThreadId: string;
  key: string;
  parentKey: string | null;
  depth: number;
  accessMode: "mutating" | "read-only";
  projectId: string;
  title: string | null;
  assignment: string;
  profile: WorkerProfile;
  complexityReason: string | null;
  providerId: string;
  model: string;
  configuredReasoningLevel: string;
  requestedReasoningLevel: string;
  reasoningLevel: string;
  state: WorkstreamState;
  threadId: string | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  laneReleasedAt: number | null;
  lastEventSeq: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  result: unknown | null;
  error: string | null;
}

export interface ArtifactRecord {
  id: number;
  coordinatorThreadId: string;
  workstreamKey: string;
  kind: string;
  name: string;
  version: string | null;
  summary: string;
  content: string | null;
  path: string | null;
  consumers: string[];
  createdAt: number;
}

export interface ProjectEnvironmentRecord {
  coordinatorThreadId: string;
  projectId: string;
  environmentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanStepRecord {
  key: string;
  projectId: string;
  prompt: string;
  title?: string;
  profile: WorkerProfile;
  complexityReason?: string;
  reasoningLevel?: string;
  accessMode: "mutating" | "read-only";
  dependsOn: string[];
  phase?: string;
  successCriteria?: string[];
}

export interface PlanRecord {
  coordinatorThreadId: string;
  version: number;
  scale: "small" | "large";
  rationale: string;
  steps: PlanStepRecord[];
  createdAt: number;
  updatedAt: number;
}

type RunRow = Omit<RunRecord, "allowedProjectIds" | "policy" | "firstDispatchApproved"> & {
  allowedProjectIdsJson: string;
  policyJson: string;
  firstDispatchApproved: number;
};
type WorkstreamRow = Omit<WorkstreamRecord, "result"> & { resultJson: string | null };
type ArtifactRow = Omit<ArtifactRecord, "consumers"> & { consumersJson: string };

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const branchSlug = (label: string) => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "feature";
const telemetryResult = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value === undefined ? null : { recorded: true };
  const result = value as Record<string, unknown>;
  const evidence = typeof result.evidence === "object" && result.evidence !== null ? result.evidence as Record<string, unknown> : null;
  const diff = evidence !== null && typeof evidence.environmentDiff === "object" && evidence.environmentDiff !== null ? evidence.environmentDiff as Record<string, unknown> : null;
  return {
    status: typeof result.status === "string" ? result.status : null,
    changedFileCount: Array.isArray(result.changedFiles) ? result.changedFiles.length : 0,
    validation: Array.isArray(result.validation) ? result.validation.slice(0, 50).map((entry) => {
      const item = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
      return { command: typeof item.command === "string" ? item.command.slice(0, 300) : null, status: typeof item.status === "string" ? item.status : null };
    }) : [],
    blockerCount: Array.isArray(result.blockers) ? result.blockers.length : 0,
    commitCount: Array.isArray(result.commits) ? result.commits.length : 0,
    pushedCommitCount: Array.isArray(result.pushedCommits) ? result.pushedCommits.length : 0,
    evidence: evidence === null ? null : {
      warningCount: Array.isArray(evidence.warnings) ? evidence.warnings.length : 0,
      environmentDiff: diff === null ? null : { outcome: diff.outcome ?? null, shortstat: diff.shortstat ?? null, fileCount: Array.isArray(diff.files) ? diff.files.length : 0, truncated: diff.truncated ?? false },
    },
  };
};

export class OrchestratorStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsertRun(input: { coordinatorThreadId: string; label: string; allowedProjectIds: string[]; policy: OrchestrationPolicy }, coordinatorBaseline?: { lastEventSeq: number; totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }) {
    const now = Date.now();
    const current = this.getRun(input.coordinatorThreadId);
    const sessionId = current?.sessionId ?? `${input.coordinatorThreadId}:${now.toString(36)}`;
    const featureBranch = current?.featureBranch ?? `orchestrator/${branchSlug(input.label)}-${now.toString(36).slice(-7)}`;
    this.db.prepare(`
      INSERT INTO runs (coordinator_thread_id, session_id, feature_branch, label, allowed_project_ids_json, state, policy_json, created_at, updated_at, last_activity_at, coordinator_last_event_seq, coordinator_baseline_total_tokens, coordinator_baseline_input_tokens, coordinator_baseline_cached_input_tokens, coordinator_baseline_output_tokens, coordinator_baseline_reasoning_output_tokens)
      VALUES (?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coordinator_thread_id) DO UPDATE SET
        label = excluded.label,
        allowed_project_ids_json = excluded.allowed_project_ids_json,
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        state = CASE WHEN runs.state IN ('completed', 'failed', 'cancelled') THEN 'configured' ELSE runs.state END,
        error = NULL
    `).run(input.coordinatorThreadId, sessionId, featureBranch, input.label, JSON.stringify(input.allowedProjectIds), JSON.stringify(input.policy), now, now, now, coordinatorBaseline?.lastEventSeq ?? 0, coordinatorBaseline?.totalTokens ?? 0, coordinatorBaseline?.inputTokens ?? 0, coordinatorBaseline?.cachedInputTokens ?? 0, coordinatorBaseline?.outputTokens ?? 0, coordinatorBaseline?.reasoningOutputTokens ?? 0);
    this.db.prepare(`INSERT OR IGNORE INTO orchestration_sessions (session_id, coordinator_thread_id, label, feature_branch, allowed_project_ids_json, state, policy_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?, 'configured', ?, ?, ?)`)
      .run(sessionId, input.coordinatorThreadId, input.label, featureBranch, JSON.stringify(input.allowedProjectIds), JSON.stringify(input.policy), now, now);
    this.recordEvent({ coordinatorThreadId: input.coordinatorThreadId, type: current === null ? "session.started" : "session.configured", details: { featureBranch, projectCount: input.allowedProjectIds.length } });
    return this.getRun(input.coordinatorThreadId)!;
  }

  resetRun(coordinatorThreadId: string) {
    const current = this.getRun(coordinatorThreadId);
    const coordinatorBaseline = current === null ? undefined : {
      lastEventSeq: current.coordinatorLastEventSeq,
      totalTokens: current.coordinatorBaselineTotalTokens + current.coordinatorTotalTokens,
      inputTokens: current.coordinatorBaselineInputTokens + current.coordinatorInputTokens,
      cachedInputTokens: current.coordinatorBaselineCachedInputTokens + current.coordinatorCachedInputTokens,
      outputTokens: current.coordinatorBaselineOutputTokens + current.coordinatorOutputTokens,
      reasoningOutputTokens: current.coordinatorBaselineReasoningOutputTokens + current.coordinatorReasoningOutputTokens,
    };
    const reset = this.db.transaction(() => {
      this.db.prepare("DELETE FROM artifacts WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM plans WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM workstreams WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM run_project_environments WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM runs WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
    });
    reset();
    return coordinatorBaseline;
  }

  getRun(coordinatorThreadId: string): RunRecord | null {
    const row = this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, label,
        session_id AS sessionId, feature_branch AS featureBranch,
        allowed_project_ids_json AS allowedProjectIdsJson, state,
        policy_json AS policyJson, created_at AS createdAt, updated_at AS updatedAt,
        last_activity_at AS lastActivityAt, total_tokens AS totalTokens,
        coordinator_last_event_seq AS coordinatorLastEventSeq, coordinator_total_tokens AS coordinatorTotalTokens,
        coordinator_input_tokens AS coordinatorInputTokens, coordinator_cached_input_tokens AS coordinatorCachedInputTokens,
        coordinator_output_tokens AS coordinatorOutputTokens, coordinator_reasoning_output_tokens AS coordinatorReasoningOutputTokens,
        coordinator_baseline_total_tokens AS coordinatorBaselineTotalTokens, coordinator_baseline_input_tokens AS coordinatorBaselineInputTokens,
        coordinator_baseline_cached_input_tokens AS coordinatorBaselineCachedInputTokens, coordinator_baseline_output_tokens AS coordinatorBaselineOutputTokens,
        coordinator_baseline_reasoning_output_tokens AS coordinatorBaselineReasoningOutputTokens,
        first_dispatch_approved AS firstDispatchApproved, error
      FROM runs WHERE coordinator_thread_id = ?
    `).get(coordinatorThreadId) as RunRow | undefined;
    return row === undefined ? null : {
      ...row,
      allowedProjectIds: parseJson<string[]>(row.allowedProjectIdsJson),
      policy: parseOrchestrationPolicy({ planningMode: "off", ...parseJson<Record<string, unknown>>(row.policyJson) }),
      firstDispatchApproved: row.firstDispatchApproved === 1,
    };
  }

  setRunState(coordinatorThreadId: string, state: RunState, error: string | null = null) {
    const now = Date.now();
    this.db.prepare("UPDATE runs SET state = ?, error = ?, updated_at = ?, last_activity_at = ? WHERE coordinator_thread_id = ?")
      .run(state, error, now, now, coordinatorThreadId);
    const run = this.getRun(coordinatorThreadId);
    if (run !== null) {
      this.db.prepare("UPDATE orchestration_sessions SET state = ?, error = ?, total_tokens = ?, updated_at = ?, completed_at = ? WHERE session_id = ?")
        .run(state, error, run.totalTokens, now, ["completed", "failed", "cancelled"].includes(state) ? now : null, run.sessionId);
      this.recordEvent({ coordinatorThreadId, type: "run.state", outcome: state, reasonCode: error === null ? null : "run_error", details: error === null ? {} : { error } });
    }
  }

  touchRun(coordinatorThreadId: string) {
    const now = Date.now();
    this.db.prepare("UPDATE runs SET updated_at = ?, last_activity_at = ? WHERE coordinator_thread_id = ?").run(now, now, coordinatorThreadId);
  }

  approveFirstDispatch(coordinatorThreadId: string) {
    this.db.prepare("UPDATE runs SET first_dispatch_approved = 1, updated_at = ? WHERE coordinator_thread_id = ?")
      .run(Date.now(), coordinatorThreadId);
  }

  setPlan(input: Omit<PlanRecord, "version" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO plans (coordinator_thread_id, version, scale, rationale, steps_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(coordinator_thread_id) DO UPDATE SET
        version = plans.version + 1,
        scale = excluded.scale,
        rationale = excluded.rationale,
        steps_json = excluded.steps_json,
        updated_at = excluded.updated_at
    `).run(input.coordinatorThreadId, input.scale, input.rationale, JSON.stringify(input.steps), now, now);
    this.touchRun(input.coordinatorThreadId);
    return this.getPlan(input.coordinatorThreadId)!;
  }

  getPlan(coordinatorThreadId: string): PlanRecord | null {
    const row = this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, version, scale, rationale,
        steps_json AS stepsJson, created_at AS createdAt, updated_at AS updatedAt
      FROM plans WHERE coordinator_thread_id = ?
    `).get(coordinatorThreadId) as (Omit<PlanRecord, "steps"> & { stepsJson: string }) | undefined;
    return row === undefined ? null : { ...row, steps: parseJson<PlanStepRecord[]>(row.stepsJson) };
  }

  listExpiredRuns(now: number) {
    const rows = this.db.prepare("SELECT coordinator_thread_id AS coordinatorThreadId FROM runs WHERE state NOT IN ('completed','failed','cancelled')").all() as Array<{ coordinatorThreadId: string }>;
    return rows.map(({ coordinatorThreadId }) => this.getRun(coordinatorThreadId)!).filter((run) => {
      const runDeadline = run.createdAt + run.policy.runTimeoutMinutes * 60_000;
      const idleDeadline = run.lastActivityAt + run.policy.inactiveCleanupMinutes * 60_000;
      return now >= Math.min(runDeadline, idleDeadline);
    });
  }

  listRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT coordinator_thread_id AS coordinatorThreadId FROM runs ORDER BY created_at DESC").all() as Array<{ coordinatorThreadId: string }>;
    return rows.map(({ coordinatorThreadId }) => this.getRun(coordinatorThreadId)!);
  }

  upsertWorkstream(input: Omit<WorkstreamRecord, "createdAt" | "updatedAt" | "startedAt" | "completedAt" | "laneReleasedAt" | "lastEventSeq" | "totalTokens" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens" | "result" | "error">) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO workstreams (
        coordinator_thread_id, key, parent_key, depth, access_mode, project_id, title, assignment, profile, complexity_reason,
        provider_id, model, configured_reasoning_level, requested_reasoning_level, reasoning_level, state, thread_id, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coordinator_thread_id, key) DO UPDATE SET
        parent_key = excluded.parent_key, depth = excluded.depth, access_mode = excluded.access_mode,
        project_id = excluded.project_id, title = excluded.title, assignment = excluded.assignment,
        profile = excluded.profile, complexity_reason = excluded.complexity_reason,
        provider_id = excluded.provider_id, model = excluded.model,
        configured_reasoning_level = excluded.configured_reasoning_level, requested_reasoning_level = excluded.requested_reasoning_level,
        reasoning_level = excluded.reasoning_level, state = excluded.state,
        thread_id = excluded.thread_id, attempt_count = excluded.attempt_count,
        updated_at = excluded.updated_at, started_at = NULL, completed_at = NULL,
        lane_released_at = NULL, last_event_seq = 0, total_tokens = 0,
        input_tokens = 0, cached_input_tokens = 0, output_tokens = 0, reasoning_output_tokens = 0,
        result_json = NULL, error = NULL
    `).run(
      input.coordinatorThreadId, input.key, input.parentKey, input.depth, input.accessMode, input.projectId, input.title, input.assignment,
      input.profile, input.complexityReason, input.providerId, input.model, input.configuredReasoningLevel, input.requestedReasoningLevel, input.reasoningLevel,
      input.state, input.threadId, input.attemptCount, now, now,
    );
    return this.getWorkstream(input.coordinatorThreadId, input.key)!;
  }

  getWorkstream(coordinatorThreadId: string, key: string): WorkstreamRecord | null {
    const row = this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, key, parent_key AS parentKey,
        depth, access_mode AS accessMode, project_id AS projectId, title,
        assignment, profile, complexity_reason AS complexityReason, provider_id AS providerId,
        model, configured_reasoning_level AS configuredReasoningLevel, requested_reasoning_level AS requestedReasoningLevel,
        reasoning_level AS reasoningLevel, state, thread_id AS threadId,
        attempt_count AS attemptCount, created_at AS createdAt, updated_at AS updatedAt,
        started_at AS startedAt, completed_at AS completedAt, lane_released_at AS laneReleasedAt,
        last_event_seq AS lastEventSeq,
        total_tokens AS totalTokens, input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens,
        output_tokens AS outputTokens, reasoning_output_tokens AS reasoningOutputTokens,
        result_json AS resultJson, error
      FROM workstreams WHERE coordinator_thread_id = ? AND key = ?
    `).get(coordinatorThreadId, key) as WorkstreamRow | undefined;
    return row === undefined ? null : { ...row, result: row.resultJson === null ? null : parseJson(row.resultJson) };
  }

  getWorkstreamByThread(threadId: string): WorkstreamRecord | null {
    const row = this.db.prepare("SELECT coordinator_thread_id AS coordinatorThreadId, key FROM workstreams WHERE thread_id = ?").get(threadId) as { coordinatorThreadId: string; key: string } | undefined;
    return row === undefined ? null : this.getWorkstream(row.coordinatorThreadId, row.key);
  }

  listWorkstreams(coordinatorThreadId: string): WorkstreamRecord[] {
    const keys = this.db.prepare("SELECT key FROM workstreams WHERE coordinator_thread_id = ? ORDER BY created_at, key").all(coordinatorThreadId) as Array<{ key: string }>;
    return keys.map(({ key }) => this.getWorkstream(coordinatorThreadId, key)!);
  }

  listChildren(coordinatorThreadId: string, parentKey: string): WorkstreamRecord[] {
    const keys = this.db.prepare("SELECT key FROM workstreams WHERE coordinator_thread_id = ? AND parent_key = ? ORDER BY created_at, key")
      .all(coordinatorThreadId, parentKey) as Array<{ key: string }>;
    return keys.map(({ key }) => this.getWorkstream(coordinatorThreadId, key)!);
  }

  listDescendants(coordinatorThreadId: string, parentKey: string): WorkstreamRecord[] {
    const descendants: WorkstreamRecord[] = [];
    const visit = (key: string) => {
      for (const child of this.listChildren(coordinatorThreadId, key)) {
        descendants.push(child);
        visit(child.key);
      }
    };
    visit(parentKey);
    return descendants;
  }

  listTerminalWorkstreams(): WorkstreamRecord[] {
    const rows = this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, key
      FROM workstreams
      WHERE thread_id IS NOT NULL AND state IN ('completed', 'failed', 'cancelled')
      ORDER BY updated_at, coordinator_thread_id, key
    `).all() as Array<{ coordinatorThreadId: string; key: string }>;
    return rows.map(({ coordinatorThreadId, key }) => this.getWorkstream(coordinatorThreadId, key)!);
  }

  listRunningWorkstreams(): WorkstreamRecord[] {
    const rows = this.db.prepare("SELECT coordinator_thread_id AS coordinatorThreadId, key FROM workstreams WHERE state = 'running' ORDER BY updated_at")
      .all() as Array<{ coordinatorThreadId: string; key: string }>;
    return rows.map(({ coordinatorThreadId, key }) => this.getWorkstream(coordinatorThreadId, key)!);
  }

  listTimedOutWorkstreams(now: number) {
    const rows = this.db.prepare("SELECT coordinator_thread_id AS coordinatorThreadId, key FROM workstreams WHERE state = 'running' AND started_at IS NOT NULL").all() as Array<{ coordinatorThreadId: string; key: string }>;
    return rows.map(({ coordinatorThreadId, key }) => this.getWorkstream(coordinatorThreadId, key)!).filter((item) => {
      const run = this.getRun(item.coordinatorThreadId);
      return run !== null && item.startedAt !== null && now >= item.startedAt + run.policy.workerTimeoutMinutes * 60_000;
    });
  }

  setWorkstreamState(coordinatorThreadId: string, key: string, state: WorkstreamState, options: { threadId?: string | null; result?: unknown; error?: string | null; reasonCode?: string | null; incrementAttempt?: boolean } = {}) {
    const current = this.getWorkstream(coordinatorThreadId, key);
    if (current === null) return null;
    const now = Date.now();
    const terminal = state === "completed" || state === "failed" || state === "cancelled";
    this.db.prepare(`
      UPDATE workstreams SET state = ?, thread_id = ?, result_json = ?, error = ?,
        attempt_count = ?, updated_at = ?, started_at = ?, completed_at = ?
      WHERE coordinator_thread_id = ? AND key = ?
    `).run(
      state,
      options.threadId === undefined ? current.threadId : options.threadId,
      options.result === undefined ? (current.result === null ? null : JSON.stringify(current.result)) : JSON.stringify(options.result),
      options.error === undefined ? current.error : options.error,
      current.attemptCount + (options.incrementAttempt ? 1 : 0),
      now,
      state === "running" ? current.startedAt ?? now : current.startedAt,
      terminal ? now : null,
      coordinatorThreadId,
      key,
    );
    this.touchRun(coordinatorThreadId);
    const updated = this.getWorkstream(coordinatorThreadId, key);
    if (updated !== null) this.recordEvent({
      coordinatorThreadId, type: "workstream.state", workstreamKey: key, workerThreadId: updated.threadId,
      outcome: state, reasonCode: options.reasonCode ?? (options.error === undefined || options.error === null ? null : state === "failed" ? "worker_failed" : "worker_feedback"),
      durationMs: updated.startedAt === null ? null : Math.max(0, now - updated.startedAt), tokens: updated.totalTokens,
      details: { from: current.state, attempt: updated.attemptCount, queueMs: state === "running" ? Math.max(0, now - current.createdAt) : null, providerId: updated.providerId, model: updated.model, profile: updated.profile, configuredReasoningLevel: updated.configuredReasoningLevel, requestedReasoningLevel: updated.requestedReasoningLevel, reasoningLevel: updated.reasoningLevel, accessMode: updated.accessMode, error: options.error ?? null, result: telemetryResult(options.result) },
    });
    return updated;
  }

  releaseProjectLane(coordinatorThreadId: string, key: string) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE workstreams SET lane_released_at = ?, updated_at = ?
      WHERE coordinator_thread_id = ? AND key = ?
    `).run(now, now, coordinatorThreadId, key);
    this.touchRun(coordinatorThreadId);
    return this.getWorkstream(coordinatorThreadId, key);
  }

  removeWorkstreamsNotIn(coordinatorThreadId: string, keys: readonly string[], parentKey: string | null = null) {
    const desired = new Set(keys);
    return this.listWorkstreams(coordinatorThreadId).filter((item) => item.parentKey === parentKey && !desired.has(item.key));
  }

  getProjectEnvironment(coordinatorThreadId: string, projectId: string): ProjectEnvironmentRecord | null {
    return (this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, project_id AS projectId,
        environment_id AS environmentId, created_at AS createdAt, updated_at AS updatedAt
      FROM run_project_environments
      WHERE coordinator_thread_id = ? AND project_id = ?
    `).get(coordinatorThreadId, projectId) as ProjectEnvironmentRecord | undefined) ?? null;
  }

  setProjectEnvironment(coordinatorThreadId: string, projectId: string, environmentId: string) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO run_project_environments (
        coordinator_thread_id, project_id, environment_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(coordinator_thread_id, project_id) DO UPDATE SET
        environment_id = excluded.environment_id, updated_at = excluded.updated_at
    `).run(coordinatorThreadId, projectId, environmentId, now, now);
    return this.getProjectEnvironment(coordinatorThreadId, projectId)!;
  }

  clearProjectEnvironment(coordinatorThreadId: string, projectId: string) {
    this.db.prepare("DELETE FROM run_project_environments WHERE coordinator_thread_id = ? AND project_id = ?")
      .run(coordinatorThreadId, projectId);
  }

  listProjectEnvironments(coordinatorThreadId: string): ProjectEnvironmentRecord[] {
    return this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, project_id AS projectId,
        environment_id AS environmentId, created_at AS createdAt, updated_at AS updatedAt
      FROM run_project_environments
      WHERE coordinator_thread_id = ? ORDER BY created_at, project_id
    `).all(coordinatorThreadId) as ProjectEnvironmentRecord[];
  }

  setUsage(coordinatorThreadId: string, key: string, usage: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }, lastEventSeq: number) {
    this.db.prepare("UPDATE workstreams SET total_tokens = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?, reasoning_output_tokens = ?, last_event_seq = ?, updated_at = ? WHERE coordinator_thread_id = ? AND key = ?")
      .run(usage.totalTokens, usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens, lastEventSeq, Date.now(), coordinatorThreadId, key);
    return this.updateAggregatedUsage(coordinatorThreadId);
  }

  setCoordinatorUsage(coordinatorThreadId: string, usage: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }, lastEventSeq: number) {
    const run = this.getRun(coordinatorThreadId);
    if (run === null) return 0;
    this.db.prepare("UPDATE runs SET coordinator_total_tokens = ?, coordinator_input_tokens = ?, coordinator_cached_input_tokens = ?, coordinator_output_tokens = ?, coordinator_reasoning_output_tokens = ?, coordinator_last_event_seq = ?, updated_at = ? WHERE coordinator_thread_id = ?")
      .run(Math.max(0, usage.totalTokens - run.coordinatorBaselineTotalTokens), Math.max(0, usage.inputTokens - run.coordinatorBaselineInputTokens), Math.max(0, usage.cachedInputTokens - run.coordinatorBaselineCachedInputTokens), Math.max(0, usage.outputTokens - run.coordinatorBaselineOutputTokens), Math.max(0, usage.reasoningOutputTokens - run.coordinatorBaselineReasoningOutputTokens), lastEventSeq, Date.now(), coordinatorThreadId);
    return this.updateAggregatedUsage(coordinatorThreadId);
  }

  private updateAggregatedUsage(coordinatorThreadId: string) {
    const workers = this.db.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(cached_input_tokens), 0) AS cached, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning FROM workstreams WHERE coordinator_thread_id = ?")
      .get(coordinatorThreadId) as { total: number; input: number; cached: number; output: number; reasoning: number };
    const coordinator = this.db.prepare("SELECT coordinator_total_tokens AS total, coordinator_input_tokens AS input, coordinator_cached_input_tokens AS cached, coordinator_output_tokens AS output, coordinator_reasoning_output_tokens AS reasoning FROM runs WHERE coordinator_thread_id = ?")
      .get(coordinatorThreadId) as { total: number; input: number; cached: number; output: number; reasoning: number } | undefined;
    const aggregate = {
      total: workers.total + (coordinator?.total ?? 0), input: workers.input + (coordinator?.input ?? 0),
      cached: workers.cached + (coordinator?.cached ?? 0), output: workers.output + (coordinator?.output ?? 0),
      reasoning: workers.reasoning + (coordinator?.reasoning ?? 0),
    };
    this.db.prepare("UPDATE runs SET total_tokens = ?, updated_at = ? WHERE coordinator_thread_id = ?")
      .run(aggregate.total, Date.now(), coordinatorThreadId);
    const run = this.getRun(coordinatorThreadId);
    if (run !== null) this.db.prepare("UPDATE orchestration_sessions SET total_tokens = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?, reasoning_output_tokens = ?, updated_at = ? WHERE session_id = ?")
      .run(aggregate.total, aggregate.input, aggregate.cached, aggregate.output, aggregate.reasoning, Date.now(), run.sessionId);
    return aggregate.total;
  }

  recordEvent(input: { coordinatorThreadId: string; type: string; workstreamKey?: string | null; workerThreadId?: string | null; outcome?: string | null; reasonCode?: string | null; durationMs?: number | null; tokens?: number | null; details?: unknown }) {
    const run = this.getRun(input.coordinatorThreadId);
    if (run === null) return;
    const details = JSON.stringify(input.details ?? {});
    this.db.prepare(`INSERT INTO orchestration_events (session_id, coordinator_thread_id, workstream_key, worker_thread_id, event_type, outcome, reason_code, duration_ms, tokens, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.sessionId, input.coordinatorThreadId, input.workstreamKey ?? null, input.workerThreadId ?? null, input.type, input.outcome ?? null, input.reasonCode ?? null, input.durationMs ?? null, input.tokens ?? null, details.length > 100_000 ? JSON.stringify({ truncated: true }) : details, Date.now());
  }

  analytics() {
    const sessions = this.db.prepare(`SELECT session_id AS sessionId, coordinator_thread_id AS coordinatorThreadId, label, feature_branch AS featureBranch, state, total_tokens AS totalTokens, input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens, output_tokens AS outputTokens, reasoning_output_tokens AS reasoningOutputTokens, started_at AS startedAt, updated_at AS updatedAt, completed_at AS completedAt, error FROM orchestration_sessions ORDER BY started_at DESC LIMIT 100`).all() as Array<{ sessionId: string; coordinatorThreadId: string; label: string; featureBranch: string; state: string; totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; startedAt: number; updatedAt: number; completedAt: number | null; error: string | null }>;
    const failures = this.db.prepare(`SELECT COALESCE(reason_code, 'uncategorized') AS reasonCode, COUNT(*) AS count FROM orchestration_events WHERE outcome = 'failed' OR reason_code IS NOT NULL GROUP BY COALESCE(reason_code, 'uncategorized') ORDER BY count DESC`).all() as Array<{ reasonCode: string; count: number }>;
    const row = this.db.prepare(`SELECT COUNT(*) AS sessions, SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens FROM orchestration_sessions`).get() as { sessions: number; completed: number | null; failed: number | null; totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
    return { totals: { sessions: row.sessions, completed: row.completed ?? 0, failed: row.failed ?? 0, totalTokens: row.totalTokens, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens, reasoningOutputTokens: row.reasoningOutputTokens }, failures, sessions };
  }

  addArtifact(input: Omit<ArtifactRecord, "id" | "createdAt">) {
    const result = this.db.prepare(`
      INSERT INTO artifacts (coordinator_thread_id, workstream_key, kind, name, version, summary, content, path, consumers_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.coordinatorThreadId, input.workstreamKey, input.kind, input.name, input.version, input.summary, input.content, input.path, JSON.stringify(input.consumers), Date.now());
    return Number(result.lastInsertRowid);
  }

  listArtifacts(coordinatorThreadId: string): ArtifactRecord[] {
    const rows = this.db.prepare(`
      SELECT id, coordinator_thread_id AS coordinatorThreadId, workstream_key AS workstreamKey,
        kind, name, version, summary, content, path, consumers_json AS consumersJson, created_at AS createdAt
      FROM artifacts WHERE coordinator_thread_id = ? ORDER BY created_at, id
    `).all(coordinatorThreadId) as ArtifactRow[];
    return rows.map((row) => ({ ...row, consumers: parseJson<string[]>(row.consumersJson) }));
  }

  recordMetric(input: { providerId: string; model: string; profile: WorkerProfile; succeeded: boolean; durationMs: number; totalTokens: number }) {
    this.db.prepare(`
      INSERT INTO route_metrics (provider_id, model, profile, samples, successes, failures, duration_ms, total_tokens)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model, profile) DO UPDATE SET
        samples = samples + 1, successes = successes + excluded.successes,
        failures = failures + excluded.failures, duration_ms = duration_ms + excluded.duration_ms,
        total_tokens = total_tokens + excluded.total_tokens
    `).run(input.providerId, input.model, input.profile, input.succeeded ? 1 : 0, input.succeeded ? 0 : 1, input.durationMs, input.totalTokens);
  }

  listMetrics() {
    return this.db.prepare(`
      SELECT provider_id AS providerId, model, profile, samples, successes, failures,
        duration_ms AS durationMs, total_tokens AS totalTokens
      FROM route_metrics ORDER BY profile, provider_id, model
    `).all() as Array<{ providerId: string; model: string; profile: WorkerProfile; samples: number; successes: number; failures: number; durationMs: number; totalTokens: number }>;
  }
}
