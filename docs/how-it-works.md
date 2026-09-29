# How the Orchestrator works

This is the internal view: the moving parts, the data, and where each piece lives. For what the plugin does and how to use it, see the [README](../README.md).

## Files

| File | Role |
|---|---|
| `server.ts` | Plugin backend. Covers migrations, RPCs, agent tools, event handlers, the launcher, the cleanup schedule, and the worktree environment provider. |
| `lib/state.ts` | `OrchestratorStore`: every SQLite read and write, plus the `eventActor` context. |
| `lib/policy.ts` | Zod schemas and defaults for the orchestration and routing policy. |
| `lib/conditions.ts` | Readiness conditions per workstream, computed from state and never stored. Also the writer-lane rule. |
| `lib/liveness.ts` | Classifies why an idle worker stopped without a completion record. |
| `lib/coordinator-prompt.ts` | The coordinator's operating instructions. |
| `lib/worktree.ts`, `host.ts` | Host-side git worktree creation and removal. |
| `app.tsx` | UI: run panel, approval dialog, composer and header actions, settings sections. |

## Roles

Plugin metadata on a thread decides what it is.

- **Coordinator** (`role: "coordinator"`, label, allowed project ids). A root thread that plans and dispatches. Tools: `orchestrator_plan`, `orchestrator_plan_update`, `orchestrator_dispatch`, `orchestrator_status`, `orchestrator_message`, `orchestrator_publish_artifact`, `orchestrator_finish`, `orchestrator_enable`.
- **Worker** (`role: "worker"`, coordinator id, key, parent key, depth, access mode, route). A thread spawned by the launcher. Tools: `orchestrator_delegate`, `orchestrator_status`, `orchestrator_message`, `orchestrator_publish_artifact`, `orchestrator_worker_done`.
- **Ordinary root thread.** Gets only `orchestrator_enable`.

`bb.agents.configure` assigns these tool sets at the end of `server.ts`.

## Lifecycle

### Enable

A thread becomes a coordinator in one of three ways:
- the `start` RPC, which spawns a coordinator in the personal project;
- the `enable` RPC or the `orchestrator_enable` tool, for root threads only;
- the new-thread marker, handled by the `message.dispatch` hook.

Each path writes the coordinator metadata and calls `upsertRun`. That creates:
- the run row;
- a session id;
- the feature branch `orchestrator/<label-slug>-<suffix>`;
- a copy of the current policy;
- a `session.started` or `session.configured` event.

Enabling the same thread again replaces the policy copy with the current global policy.

### Plan

`orchestrator_plan` validates the plan:
- every step's project is allowed;
- the per-run workstream limit;
- no dependency cycles;
- the small-request rule;
- `always` mode has steps.

Calling it on a finished run resets that run first. `resetRun` deletes the run, workstreams, plan, artifacts and environment leases, but keeps the sessions and events.

`orchestrator_plan_update` patches steps against `expectedVersion`. The version check is a compare-and-set in `updatePlan`. It does not change the plan's `goal`.

### Dispatch

`orchestrator_dispatch` works in this order:
1. It rejects the call if the run is finished or suspended.
2. The assignments must exactly match the current plan version.
3. The approval gate: the run moves to `awaiting_approval`, and `bb.ui.requestInput` shows the `dispatch-approval` dialog for up to an hour. Your decision is logged as a `dispatch.approval` event. A rejection sets the run to `blocked`.
4. Workers that were removed or changed are cancelled, together with their descendants.
5. Each assignment gets a route: provider, model and reasoning (`workerExecution`).
6. Changed workstreams are upserted as `queued`, and the launcher runs.

### Launch

`launchQueued` runs once at a time per run, using an in-process lock. A queued workstream starts only if all of these hold:
- it has attempts left;
- a parallel slot is free;
- its dependencies completed. A failed or cancelled dependency cancels it, unless that dependency reported `blocked`;
- for mutating work, the project's writer lane is free;
- for children, the parent is still running.

Before spawning, the launcher claims the row: `claimLaunch` sets `launch_claimed_at` only if the row is still `queued` and unclaimed, or its claim is older than 5 minutes. A second process, or the same one after a reload, cannot then spawn the same workstream twice. Parallel slots and writer lanes are still counted per process.

Spawning works like this:
- The launcher reuses the project's recorded environment, or asks the `orchestrator-worktree` environment provider for a new git worktree on the run branch from `HEAD`.
- If reusing fails, it clears the lease and creates a new worktree.
- It then waits up to 60 s for the environment to attach. A failed provisioning includes BB's latest `system/error` message.
- Finally it moves the row from `queued` to `running` with `from: "queued"`. If the row was cancelled in the meantime, the new thread is retired and the workstream stays cancelled.

### The worker prompt

`workerPrompt` builds the prompt from:
1. the assignment;
2. **Why this exists**: the plan `goal`, and the titles of the workstreams that delegated this one;
3. **Plan context**: phase, dependencies, success criteria;
4. **Upstream results**: each dependency's summary, limitations and changed files;
5. **Artifacts**: those named for this worker or published by its dependencies. The full content is included only for named consumers;
6. **The contract**: branch, access mode, action budget (quick 20, standard 40, complex 60, critical 80), commit and push policy, delegation, asking questions, and how to call `orchestrator_worker_done`.

### Completion

`orchestrator_worker_done` checks, in order:
- no live descendants;
- read-only work reports no changes, commits or pushes;
- the protected-branch, commit-mode and push-approval rules. Pushed SHAs must be among the commits, and orchestrator-owned commits must be on the run branch;
- the schema rules: `success` has no blockers, and `success` with a failed check has at least one limitation.

It then:
- captures evidence: output, conversation outline, context, timeline, storage and the environment diff;
- adds a warning (and a `worker.evidence_mismatch` event) when changed files are claimed but the diff is empty;
- stores the result. `success` becomes `completed`; `blocked` and `failed` become `failed`, and dependents of a blocked step wait with `DependencyBlocked`.

Verification is not a gate in code. The coordinator prompt asks for a read-only verification step, planned after risky implementation steps.

### Idle workers

`thread.idle` does one of these:
- **Worker finished:** records final usage, releases the lane, launches queued work, and retires the thread.
- **Worker still running**, with no live descendants, not waiting for a reply, and still idle after a short settle delay: goes to `settleUnreportedWorker`.

`settleUnreportedWorker` classifies the last output with `classifyIdleWorker` as `empty`, `plan_only`, `blocked` or `unreported`.
- **First time:** sends the matching reminder.
- **Second time:** fails the workstream with the matching reason code. `blocked` becomes a reported blocker.

The five-minute reconcile uses the same path, taking the worker's output from `threads.output`.

A worker that asked the coordinator a question (`orchestrator_message` with `expectsReply`) carries the `AWAITING_REPLY` marker. Idle handling skips it until the coordinator replies.

### Retries, timeouts, and cleanup

- **Provider turn failures.** `turn.failed` retries on the same thread while attempts remain.
- **The `cleanup-expired-runs` schedule** (every 5 minutes):
  - refreshes coordinator usage;
  - retires finished workers and records their final usage;
  - reminds or settles idle workers;
  - nudges parents whose children are all finished;
  - fails workers past their timeout;
  - cancels runs past their runtime or inactivity limit. Suspended runs are skipped.
- **Budget.** Going over the token budget fails the run.
- **`cleanupRun`** is used for disable, archive or delete of the coordinator, budget, and expiry. It stops and archives workers and cancels unfinished work. Archiving a coordinator whose workstreams all completed records the run as completed.

## States

- **Run:** `configured`, `running`, `awaiting_approval`, `blocked`, `suspended`, `completed`, `failed`, `cancelled`.
- **Workstream:** `queued`, `running`, `suspended`, `completed`, `failed`, `cancelled`. The schema also allows `planned` and `awaiting_approval`, but nothing writes them today.

`setWorkstreamState` only writes if the row is still in the state it just read. Callers that awaited since reading pass `from` to make the write conditional on that earlier state.

## Data

SQLite through `bb.storage.database()`. Migrations are append-only, in `ORCHESTRATOR_MIGRATIONS`.

| Table | Holds | Survives `resetRun` |
|---|---|---|
| `runs` | One row per coordinator: state, policy copy, session id, feature branch, first-dispatch approval, coordinator token usage and baselines | no |
| `workstreams` | One row per coordinator and key: parent, depth, access mode, project, assignment, profile, route and reasoning, state, thread, attempts, timestamps, lane release, launch claim, tokens, result, error | no |
| `plans` | Version, scale, rationale, goal, steps | no |
| `artifacts` | Versioned handoffs with their consumers | no |
| `run_project_environments` | Environment lease per run and project | no |
| `orchestration_sessions` | One row per session: label, branch, state, tokens, timing, error | yes |
| `orchestration_events` | The event log, including `actor` | yes |
| `route_metrics` | Unused leftover from the removed route recommendations | — |

### Events

Every event carries the session, the coordinator, an optional workstream and worker, the type, an outcome, a reason code, a duration, tokens, JSON details, and the actor. The actor is `user` for UI RPCs, `coordinator` or `worker:<key>` for agent tools, and `system` for event handlers and schedules. It comes from an `AsyncLocalStorage` set by the `registerTool` wrapper and the user-facing RPCs.

| Type | When |
|---|---|
| `session.started`, `session.configured` | A run is created or re-enabled |
| `run.state` | The run state changes (repeats are not logged) |
| `run.suspend`, `run.resume` | Suspend or resume from the run panel |
| `plan.recorded`, `plan.updated` | Plan written or patched |
| `dispatch.approval`, `coordinator.dispatch` | Approval decision; dispatch summary |
| `coordinator.status` | Coordinator read its status |
| `environment.created` | A worktree was created, with its base state |
| `workstream.state` | Workstream transition, with from-state, attempt, queue time, route, access mode, and a result summary |
| `workstream.usage` | Final token usage once a finished worker is idle. `worker_done` runs before the provider reports that turn's tokens, so the transition event often records 0. |
| `worker.completion_reminder`, `worker.retry`, `worker.evidence_mismatch` | Idle reminder; provider retry; claimed changes missing from the diff |
| `usage.regression_ignored` | The provider reported a lower token total than before |

### Learning data

`OrchestratorStore.analytics()` feeds the settings panel.

- **Sessions without workers.** A session counts as having workers if it logged a `workstream.state` event. Sessions without one are excluded from the totals and reported as `withoutWorkers`. This also excludes sessions from before event logging began (2026-09-17).
- **Failure categories.** These group events with `outcome = 'failed'` by reason code.

Prompts and conversations never go into events. `workstreams.result_json` holds the completion evidence, which includes a bounded excerpt of worker output.

## Known gaps

- Parallel slots and writer lanes are counted per plugin process; only double launches are prevented across processes.
- Idle classification is keyword matching on the last output.
- A run cannot target an existing PR branch. Workers must stay on the run branch, so "fix this PR's conflicts" tasks get reported as blocked.
- Delegated children always use their parent's model; the profile only changes their action budget.
- Nothing records whether a finished run's result was accepted or merged.
