import type Database from "better-sqlite3";
import { parseOrchestrationPolicy, type OrchestrationPolicy, type WorkerProfile } from "./policy.ts";

export type RunState = "configured" | "running" | "awaiting_approval" | "blocked" | "completed" | "failed" | "cancelled";
export type WorkstreamState = "planned" | "awaiting_approval" | "queued" | "running" | "reviewing" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  coordinatorThreadId: string;
  label: string;
  allowedProjectIds: string[];
  state: RunState;
  policy: OrchestrationPolicy;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  totalTokens: number;
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

type RunRow = Omit<RunRecord, "allowedProjectIds" | "policy" | "firstDispatchApproved"> & {
  allowedProjectIdsJson: string;
  policyJson: string;
  firstDispatchApproved: number;
};
type WorkstreamRow = Omit<WorkstreamRecord, "result"> & { resultJson: string | null };
type ArtifactRow = Omit<ArtifactRecord, "consumers"> & { consumersJson: string };

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export class OrchestratorStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsertRun(input: { coordinatorThreadId: string; label: string; allowedProjectIds: string[]; policy: OrchestrationPolicy }) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runs (coordinator_thread_id, label, allowed_project_ids_json, state, policy_json, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, 'configured', ?, ?, ?, ?)
      ON CONFLICT(coordinator_thread_id) DO UPDATE SET
        label = excluded.label,
        allowed_project_ids_json = excluded.allowed_project_ids_json,
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        state = CASE WHEN runs.state IN ('completed', 'failed', 'cancelled') THEN 'configured' ELSE runs.state END,
        error = NULL
    `).run(input.coordinatorThreadId, input.label, JSON.stringify(input.allowedProjectIds), JSON.stringify(input.policy), now, now, now);
    return this.getRun(input.coordinatorThreadId)!;
  }

  resetRun(coordinatorThreadId: string) {
    const reset = this.db.transaction(() => {
      this.db.prepare("DELETE FROM artifacts WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM workstreams WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM run_project_environments WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
      this.db.prepare("DELETE FROM runs WHERE coordinator_thread_id = ?").run(coordinatorThreadId);
    });
    reset();
  }

  getRun(coordinatorThreadId: string): RunRecord | null {
    const row = this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, label,
        allowed_project_ids_json AS allowedProjectIdsJson, state,
        policy_json AS policyJson, created_at AS createdAt, updated_at AS updatedAt,
        last_activity_at AS lastActivityAt, total_tokens AS totalTokens,
        first_dispatch_approved AS firstDispatchApproved, error
      FROM runs WHERE coordinator_thread_id = ?
    `).get(coordinatorThreadId) as RunRow | undefined;
    return row === undefined ? null : {
      ...row,
      allowedProjectIds: parseJson<string[]>(row.allowedProjectIdsJson),
      policy: parseOrchestrationPolicy(parseJson(row.policyJson)),
      firstDispatchApproved: row.firstDispatchApproved === 1,
    };
  }

  setRunState(coordinatorThreadId: string, state: RunState, error: string | null = null) {
    const now = Date.now();
    this.db.prepare("UPDATE runs SET state = ?, error = ?, updated_at = ?, last_activity_at = ? WHERE coordinator_thread_id = ?")
      .run(state, error, now, now, coordinatorThreadId);
  }

  touchRun(coordinatorThreadId: string) {
    const now = Date.now();
    this.db.prepare("UPDATE runs SET updated_at = ?, last_activity_at = ? WHERE coordinator_thread_id = ?").run(now, now, coordinatorThreadId);
  }

  approveFirstDispatch(coordinatorThreadId: string) {
    this.db.prepare("UPDATE runs SET first_dispatch_approved = 1, updated_at = ? WHERE coordinator_thread_id = ?")
      .run(Date.now(), coordinatorThreadId);
  }

  listExpiredRuns(now: number) {
    const rows = this.db.prepare("SELECT coordinator_thread_id AS coordinatorThreadId FROM runs WHERE state NOT IN ('completed','failed','cancelled')").all() as Array<{ coordinatorThreadId: string }>;
    return rows.map(({ coordinatorThreadId }) => this.getRun(coordinatorThreadId)!).filter((run) => {
      const runDeadline = run.createdAt + run.policy.runTimeoutMinutes * 60_000;
      const idleDeadline = run.lastActivityAt + run.policy.inactiveCleanupMinutes * 60_000;
      return now >= Math.min(runDeadline, idleDeadline);
    });
  }

  upsertWorkstream(input: Omit<WorkstreamRecord, "createdAt" | "updatedAt" | "startedAt" | "completedAt" | "laneReleasedAt" | "lastEventSeq" | "totalTokens" | "result" | "error">) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO workstreams (
        coordinator_thread_id, key, parent_key, depth, access_mode, project_id, title, assignment, profile, complexity_reason,
        provider_id, model, requested_reasoning_level, reasoning_level, state, thread_id, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coordinator_thread_id, key) DO UPDATE SET
        parent_key = excluded.parent_key, depth = excluded.depth, access_mode = excluded.access_mode,
        project_id = excluded.project_id, title = excluded.title, assignment = excluded.assignment,
        profile = excluded.profile, complexity_reason = excluded.complexity_reason,
        provider_id = excluded.provider_id, model = excluded.model,
        requested_reasoning_level = excluded.requested_reasoning_level,
        reasoning_level = excluded.reasoning_level, state = excluded.state,
        thread_id = excluded.thread_id, attempt_count = excluded.attempt_count,
        updated_at = excluded.updated_at, started_at = NULL, completed_at = NULL,
        lane_released_at = NULL, last_event_seq = 0, total_tokens = 0,
        result_json = NULL, error = NULL
    `).run(
      input.coordinatorThreadId, input.key, input.parentKey, input.depth, input.accessMode, input.projectId, input.title, input.assignment,
      input.profile, input.complexityReason, input.providerId, input.model, input.requestedReasoningLevel, input.reasoningLevel,
      input.state, input.threadId, input.attemptCount, now, now,
    );
    return this.getWorkstream(input.coordinatorThreadId, input.key)!;
  }

  getWorkstream(coordinatorThreadId: string, key: string): WorkstreamRecord | null {
    const row = this.db.prepare(`
      SELECT coordinator_thread_id AS coordinatorThreadId, key, parent_key AS parentKey,
        depth, access_mode AS accessMode, project_id AS projectId, title,
        assignment, profile, complexity_reason AS complexityReason, provider_id AS providerId,
        model, requested_reasoning_level AS requestedReasoningLevel,
        reasoning_level AS reasoningLevel, state, thread_id AS threadId,
        attempt_count AS attemptCount, created_at AS createdAt, updated_at AS updatedAt,
        started_at AS startedAt, completed_at AS completedAt, lane_released_at AS laneReleasedAt,
        last_event_seq AS lastEventSeq,
        total_tokens AS totalTokens, result_json AS resultJson, error
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

  setWorkstreamState(coordinatorThreadId: string, key: string, state: WorkstreamState, options: { threadId?: string | null; result?: unknown; error?: string | null; incrementAttempt?: boolean } = {}) {
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
    return this.getWorkstream(coordinatorThreadId, key);
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

  setUsage(coordinatorThreadId: string, key: string, totalTokens: number, lastEventSeq: number) {
    this.db.prepare("UPDATE workstreams SET total_tokens = ?, last_event_seq = ?, updated_at = ? WHERE coordinator_thread_id = ? AND key = ?")
      .run(totalTokens, lastEventSeq, Date.now(), coordinatorThreadId, key);
    const aggregate = this.db.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total FROM workstreams WHERE coordinator_thread_id = ?")
      .get(coordinatorThreadId) as { total: number };
    this.db.prepare("UPDATE runs SET total_tokens = ?, updated_at = ? WHERE coordinator_thread_id = ?")
      .run(aggregate.total, Date.now(), coordinatorThreadId);
    return aggregate.total;
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
