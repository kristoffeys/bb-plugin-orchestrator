# What to borrow from Paperclip

Research date: 2026-09-29. Source: [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip), shallow clone at `81a52eb` (2026-09-29). Paperclip paths below are relative to that repo: schema under `packages/db/src/schema/`, services under `server/src/`.

**License:** Paperclip is MIT (`LICENSE`, "Copyright (c) 2025 Paperclip AI"), and so is this plugin. Copying code is allowed if we keep the MIT notice. Nothing below needs copied code. Every item is a small idea that is faster to write in our own SQLite/BB idiom than to port from their Postgres/Drizzle code.

## TL;DR

Paperclip is a whole control plane for long-lived agent "companies". Its main parts are persistent agents with an org chart, timer heartbeats, a ticket system, monthly budgets in cents, and board approvals. Most of that duplicates what BB already provides (threads, automations, providers) or doesn't apply to a single-user IDE. What is worth taking is a handful of small **runtime-safety patterns**. They fit our existing run → workstream model without a rewrite.

Paperclip enforces less than its docs claim. The CEO strategy approval, the "at 80% budget, focus on critical work" rule and chain-of-command escalation exist only as prompt text (`skills/paperclip/SKILL.md`). The server does not enforce them. Only borrow the parts that are actually implemented in code.

## Concept map

| Paperclip concept | Where in Paperclip | Our plugin | Verdict |
|---|---|---|---|
| Org chart (`agents.reportsTo`, `role`, CEO) | `agents.ts:16-50`, `services/agents.ts:455-473` | Dynamic delegation tree (`parentKey`, `depth`) per run | Not relevant (skip) |
| Goals → projects → issues, goal fallback | `goals.ts`, `issues.ts:25-91`, `services/issue-goal-fallback.ts` | Run → plan steps → workstreams → delegated children | Have the tree; **worth adopting: ancestry in prompts** (#2) |
| Heartbeat timers, wake inbox, coalescing | `agent_wakeup_requests.ts`, `heartbeat.ts:29936-30012` | Event-driven (`thread.idle`, `turn.failed`) + 5-min reconcile | Have the equivalent; skip timers |
| Compare-and-set claims (timer, checkout, approval) | `heartbeat.ts:16848`, `services/issues.ts:11405-11431`, `services/approvals.ts:144` | In-process launch mutex (`server.ts:823`) | **Worth adopting** (#5) |
| Run liveness classification (`plan_only`, `empty_response`, `blocked`) | `services/run-liveness.ts:57-73` | One completion reminder, then fail (`server.ts:1818-1834`) | **Worth adopting** (#3) |
| Budget policies, soft/hard incidents, override approval | `budget_policies.ts`, `budget_incidents.ts`, `services/budgets.ts:649-958` | Per-run hard token cap that fails the run (`server.ts:1869`) | **Worth adopting** (#1, #7) |
| Cost ledger in cents per model/run | `cost_events.ts`, `services/costs.ts:56-104` | Tokens per workstream/coordinator + `route_metrics` | Have tokens; skip cents |
| Board approvals (`approvals` table, hire/strategy/budget) | `approvals.ts`, `routes/approvals.ts:319-345` | `bb.ui.requestInput` dispatch approval (`server.ts:1331`) | Have it |
| Execution policy: review stage by a *different* participant | `services/issue-execution-policy.ts`, `issue_execution_decisions` | Evaluator gate reviewed by the coordinator itself (`server.ts:1700`, `1717`) | **Worth adopting** (#4) |
| Activity log with actor + runId | `activity_log.ts:9-20` | `orchestration_events` (no actor column, `server.ts:157`) | **Worth adopting, small** (#6) |
| Mandatory comment per run | `heartbeat_runs.issueCommentStatus` | Mandatory `orchestrator_worker_done` | Have it |
| Session per task key | `agent_task_sessions.ts:40` | Worker thread reused on retry/review | Have it |
| Subtree pause holds | `issue_tree_holds` | Run/workstream suspend (`run_control`) | Have it |
| Work products (PRs, previews) | `issue_work_products.ts` | Artifacts + commits in completion record | Have it |
| Stranded-work recovery → board-owned recovery action | `reconcileStrandedAssignedIssues`, `issue_recovery_actions` | Reconcile fails the workstream (`server.ts:1920-1935`) | Fold into #3 |
| Multi-company isolation (`company_id` everywhere, 404 not 403) | `routes/authz.ts:75-195` | `allowedProjectIds` + run-member message scoping | Not relevant (skip) |
| Adapters (claude-local, codex-local, …) | `packages/adapters/*` | BB providers + routing profiles | Have it (via BB) |
| Company templates, export/import | `services/company-portability.ts` | — | Skip (YAGNI) |
| Task watchdog with stop fingerprint | `doc/TASK-WATCHDOG.md`, `issue_watchdogs` | 5-min reconcile | Skip (overkill) |

## Ranked shortlist

### 1. Budget soft warning, then suspend and ask instead of failing — ~4 h

**Paperclip:** `budget_policies.warnPercent` (default 80) opens a soft incident. At the hard cap it pauses the scope and auto-creates a `budget_override_required` approval. Raising the budget un-pauses the scope, but only if the pause reason was `budget` (`services/budgets.ts:649-716, 866-958`).

**Us today:** at `server.ts:1869` we call `cleanupRun(..., "failed")`. A run that is 95% done and goes 1 token over the cap loses its workers and has to start over.

**Adopt:**
- Add `budgetWarnPercent` (default 80) to `lib/policy.ts`. When usage crosses it, notify the coordinator once and record a `budget.warned` event.
- At the hard cap, **suspend** the run with the existing `run_control` suspend path. It keeps the threads, worktrees and lanes.
- Then `bb.ui.requestInput` with two options: "raise budget to X" or "cancel". Raise updates the snapshotted `run.policy.tokenBudget` and resumes. Cancel runs today's `cleanupRun`.
- Record the pause reason so a resume only lifts a budget pause.

**Where:** `lib/policy.ts`, the `experimental_thread.events` handler in `server.ts:1869`, a small renderer in `app.tsx` (copy the `dispatch-approval` renderer), and `setRunState` in `lib/state.ts`.

### 2. Goal ancestry in worker prompts — ~1-2 h

**Paperclip:** `GET /issues/:id/heartbeat-context` sends the ancestor chain, trimmed to title/status only, plus the resolved goal (`routes/issues.ts:8409-8560`, trimming at `:8531`). Every task can see why it exists without receiving its ancestors' full prompts.

**Us today:** `workerPrompt` (`server.ts:713-722`) sends the assignment plus the step's phase, dependencies and success criteria. A worker never sees the run's overall goal. A delegated child never sees what its parent is trying to do.

**Adopt:**
- Add a "Why this exists" block with the run goal: `plan.rationale`, or a new short `goal` field on `orchestrator_plan`.
- Add the ancestor chain as `key: title` lines. Walk `parentKey` using `store.getWorkstream`.
- Titles only, capped at a few lines, so token cost stays small.

**Where:** `workerPrompt` in `server.ts`, and optionally `PlanRecord` in `lib/state.ts` plus the `orchestrator_plan` schema.

### 3. Classify why an idle worker stopped — ~½ day

**Paperclip:** `services/run-liveness.ts` combines durable evidence counts with regexes over the final text (`PLANNING_ONLY_RE`, `BLOCKER_RE`, `APPROVAL_REQUIRED_RE`) and labels each run `plan_only`, `empty_response`, `blocked` or `advanced`. Only `plan_only` and `empty_response` get bounded continuation wakes. Stranded work that still doesn't move is escalated to a human-owned recovery action and never silently reassigned.

**Us today:** `thread.idle` sends one generic completion reminder, then fails with `completion_contract_missing` (`server.ts:1818-1834`). The reload reconcile at `server.ts:1920` fails immediately.

**Adopt:**
- Classify `lastAssistantText` plus the evidence we already capture (environment diff, artifacts) into `plan_only`, `empty`, `blocked` or `did_work_no_record`.
- Send a reminder tailored to the class:
  - "you only planned, now execute";
  - "you did work, just call `worker_done`";
  - for `blocked`, auto-record `worker_done` with `status: blocked` and the text as the blocker. That lands in the existing `DependencyBlocked` flow instead of a hard fail.
- Use the class as the `reasonCode`, so the learning data shows *why* workers fail, not just that they did.

**Where:** the `thread.idle` handler and the reconcile loop in `server.ts`. Put the classifier in a new `lib/liveness.ts`. It is a pure function, so it gets one small test in `test/orchestrator.test.ts`.

### 4. Evaluator gate reviewed by someone other than the executor — ~1 day

**Paperclip:** an issue's `executionPolicy` hands a `done` issue to the next review participant and excludes the executor. Every decision is stored with a required comment (`issue_execution_decisions`).

**Us today:** the evaluator gate (`server.ts:1700`) asks the *coordinator* to `orchestrator_review`. The coordinator has the whole run in context and tends to rubber-stamp. The 2026-09-15 research doc also lists "independent verifier workers" as open.

**Adopt:**
- Add a policy option `evaluator: "coordinator" | "verifier"`.
- In `verifier` mode, entering `reviewing` spawns a read-only `quick`/`standard` child workstream. Its prompt is the step's `successCriteria` plus the worker's completion record, and its `worker_done` result drives the existing accept/reject branch.
- This reuses delegation, read-only access and the review retry loop. No new states are needed.

**Where:** `lib/policy.ts` (`evaluatorPolicy`), `orchestrator_worker_done` and `orchestrator_review` in `server.ts`, and the spawn helper around `server.ts:763`.

### 5. Durable compare-and-set claims instead of an in-process mutex — ~2-3 h

**Paperclip:** every contended transition is a single conditional `UPDATE … WHERE <expected state>` that checks the affected row count:
- timer claims (`heartbeat.ts:16848-16876`);
- issue checkout (`services/issues.ts:11405-11431`);
- approval resolution (`status IN (pending, revision_requested)`).

Its takeover rule adopts a lock only when the holding run is terminal (`adoptStaleCheckoutRun`, `:7452`).

**Us today:** `launchQueued` serializes through an in-process lock (`server.ts:823`). A plugin reload during launch, or two event handlers in different processes, can double-spawn. This is the smallest useful slice of P0 #1 in [the 2026-09-15 research doc](../BEST_OF_CLASS_ORCHESTRATOR_RESEARCH.md).

**Adopt:**
- Add a `store.claimWorkstream(run, key, from, to)` that runs `UPDATE workstreams SET state=? WHERE … AND state=?` and returns `changes === 1`.
- Use it before spawn, before accept/reject in review, and on approval resolution.

**Where:** `lib/state.ts`, plus the call sites in `launchQueuedUnlocked` and `orchestrator_review` in `server.ts`.

### 6. Actor on every event — ~2 h

**Paperclip:** `activity_log` records `actorType` (agent/user/system/plugin), `actorId` and `runId` on every entry, and decision notes on approvals and reviews.

**Us today:** `orchestration_events` (`server.ts:157`) has no actor. After the fact, you can't tell whether a suspend, an approval or a review reject came from the user, the coordinator or the reconcile loop.

**Adopt:**
- Add an `actor TEXT` column (`user`, `coordinator`, `worker:<key>` or `system`) with an idempotent `ALTER TABLE`.
- Set it at the existing `recordEvent` call sites, and show it in the run panel timeline.

**Where:** `recordEvent` in `lib/state.ts:534`, the migration list in `server.ts:140-190`, and `app.tsx`.

### 7. Cross-run token cap per day — ~3 h (lowest priority)

**Paperclip:** budgets are scoped to company, agent or project and to a time window (`windowKind: calendar_month_utc`). Per-agent `maxDailyRuns` and `maxDailyCostCents` also exist (`heartbeat.ts:16651`).

**Us today:** the cap is per run only. Five parallel runs can each stay under 40M tokens and together still burn a subscription window.

**Adopt:**
- Add an optional `dailyTokenBudget` to the global policy.
- Check `SUM(tokens)` over `orchestration_sessions` updated today in `orchestrator_dispatch`, and reject new dispatches once it's exceeded. Running work is not stopped.

**Where:** `lib/policy.ts`, a query in `lib/state.ts`, and the dispatch guard in `server.ts`.

Only build this if you actually hit the limit. #1 covers the per-run case.

## Explicitly skip

- **Org chart, roles, CEO, hiring approvals.** Our agents are short-lived workers spawned per run, not persistent employees. Delegation depth and child limits already give us the hierarchy. Paperclip barely uses its org chart at runtime anyway: assignment is open company-wide (`authorization.ts:2146-2172`).
- **Timer heartbeats and routines.** Workers are event-driven BB threads, and recurring runs belong in BB automations. A timer loop would duplicate both.
- **Multi-company isolation.** BB is single-user. Run scoping (`allowedProjectIds`, run-member-only messaging) already covers the isolation we need.
- **Cost in cents / cost ledger.** BB reports tokens. A per-model price table goes stale and adds nothing for subscription users. Revisit only if API-key billing matters.
- **Adapters and session persistence per task.** BB providers and persistent threads already do this. Retries and review loops reuse the same worker thread.
- **Company templates / export-import.** No demand. If reusable plans become useful, a saved `orchestrator_plan` JSON would cover it, without a spec.
- **Task watchdog with stop fingerprints, rewake throttle.** Built for Paperclip's always-on autonomous loops. Our 5-minute reconcile plus #3 covers stuck workers, and the recent token-loop fix (`5c5a53b`) already covers runaway notifies.
- **Wake inbox with coalescing.** `bb.sdk.threads.send` queues messages on the thread already.

## Implementation status — 2026-09-29

Items #2, #3, #5 and #6 are implemented (uncommitted):

| Item | What shipped | Where |
|---|---|---|
| #2 Goal ancestry | `orchestrator_plan` takes an optional one-sentence `goal` (new `plans.goal` column). Every worker prompt now carries a "Why this exists" block with the run goal and, for delegated work, the ancestor chain as `key: title` lines. | `workerPrompt` in `server.ts`, `setPlan`/`updatePlan` in `lib/state.ts` |
| #3 Idle classification | An idle worker without `worker_done` is classified as `empty`, `plan_only`, `blocked` or `unreported`, and gets one reminder written for that case. On the second idle it fails with a reason code for its class (`completion_missing_plan_only`, …). A worker still saying it is blocked settles as `status: blocked`, so dependents wait (`DependencyBlocked`) instead of being cancelled. The reload reconcile loop now takes the same path, so it reminds before failing. | `lib/liveness.ts`, `settleUnreportedWorker` in `server.ts` |
| #5 Compare-and-set | `setWorkstreamState` only writes if the row is still in the state it read, and takes an optional `from`. `claimLaunch` reserves a queued workstream (5-min lease) before spawning. Review accept/reject uses `from: "reviewing"`. | `lib/state.ts`, `launchQueuedUnlocked` and `orchestrator_review` in `server.ts` |
| #6 Actor | `orchestration_events.actor` is `user` (UI RPCs), `coordinator`, `worker:<key>` (agent tools) or `system` (events, schedules), set through `AsyncLocalStorage`. Dispatch approvals are now logged as `dispatch.approval` events. | `eventActor` in `lib/state.ts`, the `registerTool` wrapper in `server.ts` |

Not done: the run panel has no event timeline, so the actor is only in the data for now. The launch claim prevents double spawns, but parallelism and lane limits are still counted per plugin process (see the `ponytail:` comment in `launchQueuedUnlocked`).

## Investigation: org chart, roles and hiring

Goal: named agents you manage and assign to specific kinds of work, for example "API engineer, owns contracts in `api`, uses Sonnet". This is research only; nothing below is built.

### What Paperclip actually does

- **An agent is a durable row.** Fields: `name`, `role` (free text, default `general`), `title`, `capabilities` (free text), `reportsTo` (points at another agent), adapter/model config, `status` (`active`/`paused`/`pending_approval`/`terminated`, …), monthly budget, and `permissions` (`packages/db/src/schema/agents.ts:16-50`).
- **The org chart does little at runtime.** The server enforces three things:
  - no reporting cycles, and managers must be in the same company (`services/agents.ts:455-473`);
  - a manager may take over its reports' checked-out tasks (`authorization.ts:2291`);
  - a broken or terminated manager chain stops the whole subtree from running (`agent-invokability.ts:13-24`).
- **Assignment is open company-wide.** Any active agent can assign work to any other (`authorization.ts:2146-2172`). "Escalate up the chain" and "managers delegate to their reports" exist only in the prompt/skill text.
- **"CEO" is just `role === "ceo"`.** That string grants agent creation and permission management.
- **Hiring.** With `requireBoardApprovalForNewAgents`, a hired agent is created as `pending_approval` and cannot run. Approving it activates the agent and creates its budget policy from the request; rejecting terminates it (`services/approvals.ts:144-229`).
- **Portable definitions.** Agents are exported and imported as `agents/<name>/AGENT.md` inside a company package (`services/company-portability.ts`).

So the useful ideas are a **named, durable agent definition**, **capabilities text the planner matches against**, and **hiring behind an approval**. The org tree itself is mostly decoration in Paperclip.

### How it fits our model

Workers stay one thread per workstream, created for a run. The durable thing is a **role**: a template a workstream is assigned to. No heartbeats, and no always-on agents.

Proposed `agent_roles` table:

| Column | Purpose |
|---|---|
| `slug` (PK), `name`, `title` | Identity; the coordinator refers to the role by slug |
| `capabilities` | Short text the coordinator matches work against (Paperclip's field) |
| `project_ids_json` | Projects this role may work in; empty means any allowed project |
| `route_json` | `{ providerId, modelId, reasoningLevel }`, or `null` to use the step's profile routing |
| `instructions` | Appended to the worker prompt, like an `AGENT.md` / `.claude/agents/*.md` body |
| `default_access_mode` | `read-only` for reviewer/researcher roles |
| `reports_to` | Optional parent slug, the org chart |
| `status` | `active`, `paused`, `pending_approval` |
| `created_by`, `created_at`, `updated_at` | `user` or `coordinator` (hired) |

Where each piece slots in:

1. **Assign work to a role.** Add an optional `role` to `workerAssignment`/`PlanStepRecord` (`server.ts`, `lib/state.ts`) and a `role` column on `workstreams`. `workerExecution` (`server.ts:692`) uses the role's route before the profile route. `workerPrompt` appends the role's instructions. Dispatch rejects a role outside its `project_ids`.
2. **Coordinator knows the roster.** `coordinatorPrompt` (`lib/coordinator-prompt.ts`) and the coordinator `instructions` in `bb.agents.configure` list active roles as `slug: capabilities (projects)`.
3. **The org chart as a delegation rule, enforced in code.** In `orchestrator_delegate`, a worker whose role has reports may delegate only to those reports. Without a role, today's rules apply. This is stricter than Paperclip, which only asks nicely in the prompt.
4. **Hiring.** A coordinator tool `orchestrator_propose_role` inserts a `pending_approval` row and calls `bb.ui.requestInput` with a `hire-approval` renderer, reusing the `dispatch-approval` pattern in `server.ts` and `app.tsx`. Approve activates the role; reject deletes it. A policy switch `roleCreation: "user-only" | "approval"` sits in `lib/policy.ts`.
5. **Per-role track record.** Record `role` on `workstream.state` events and add it to `route_metrics`. The learning-data panel can then show success rate and tokens per role. This is the "manage agents" part that gets better over time.
6. **UI.** A new "Agent roster" `app.slots.settingsSection` (`app.tsx:1215`) with a list, edit form and an indented `reports_to` tree. The run panel shows each workstream's role.
7. **Portability, later.** Import/export roles as markdown with frontmatter, the same shape as Claude Code subagent files. Wait until you actually want to share rosters.

### Effort

| Slice | Effort |
|---|---|
| Table + role on assignments + routing/prompt + roster in coordinator prompt | ~1 day |
| Settings roster UI | ~1 day |
| `reports_to` delegation rule | ~½ day |
| Hire-approval tool + renderer | ~½ day |
| Per-role metrics | ~2-3 h |

The first slice is usable on its own if you edit roles through an RPC or a seeded JSON file.

### Skip

- CEO as a privileged role string.
- Per-agent heartbeats and always-on agents.
- Monthly budgets in cents per agent. A per-role token cap can come later, on top of #1.
- Chain-of-command escalation. Our workers already escalate to their parent or the coordinator.
- Multi-company rosters.

### Open questions

1. Roles global or per project? Global with a `project_ids` filter is the simpler default.
2. May the coordinator hire, with approval, or only you?
3. Should a role keep notes or memory between runs (Paperclip's roadmap item), or stay a stateless template?
4. Should a role pin a provider/model, or only a profile (quick/standard/…) so routing keeps working?
