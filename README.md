# BB Orchestrator

Split a job across visible BB worker threads, possibly in several projects, and let one coordinator thread plan, dispatch, track and finish them.

The plugin owns the lifecycle. It keeps durable run and workstream state, gives every project its own git worktree on a shared feature branch, allows one writer per project at a time, routes each workstream to a model by complexity, and records what happened so you can see where runs go wrong. How it works internally is in [docs/how-it-works.md](docs/how-it-works.md).

## Install

```sh
bb plugin install git:https://github.com/kristoffeys/bb-plugin-orchestrator.git@semver:^0.2.0
```

## Using it

There are three ways to start:

- **An existing root thread.** Click the workflow icon in the composer or thread header, pick the projects workers may use, and enable it. Your next prompt can dispatch workers. You can also ask the agent to enable orchestration; it has the `orchestrator_enable` tool.
- **A new thread.** On the New thread screen, use the workflow button beside Send to pick worker projects. The thread becomes a coordinator before its first turn, with your provider, model, reasoning, permission mode, attachments and mentions kept.
- **From another plugin.** Callers such as the Sidebar plugin use the `start` RPC with a label, a task and the allowed project ids. The coordinator's title comes from the task. The label is the run's durable identity and names its branch.

Orchestration is opt-in per thread, so ordinary threads never get worker-management tools.

## What a run looks like

1. **Plan.** The coordinator calls `orchestrator_plan` and says whether the request is small or large.
   - **Small** means at most one project, at most two quick or standard workstreams, and no dependencies. It can dispatch straight away.
   - **Large** work gets a versioned plan. Each step has a project, access mode (`mutating` or `read-only`), phase, dependencies, profile and success criteria, plus an optional one-sentence run `goal` that every worker sees.
   - Planning mode is `auto` by default. `always` requires steps even for small work. `off` skips the plan, unless an assignment has dependencies.
2. **Investigate, then revise.** Large, unclear requests can start with read-only investigation steps that run in parallel. The coordinator then patches the plan with `orchestrator_plan_update`, sending only the changed steps. The server checks the resulting dependency graph before accepting it.
3. **Dispatch.** `orchestrator_dispatch` starts the current plan version. Depending on policy, you approve the worker plan first.
4. **Work.** Each step waits until its dependencies are done. A mutating step also waits until its project's single writer lane is free. A worker's prompt includes the run goal, which parent workstreams delegated it, the results of the steps it depends on, and any artifacts published for it.
5. **Complete.** Each worker ends with `orchestrator_worker_done`: status, summary, changed files, validation, blockers or limitations, and commits. The plugin checks this record against policy and stores evidence with it.
6. **Verify.** For risky changes the coordinator plans a read-only verification step that depends on the implementation. It reviews the diff against the success criteria and runs the tests. Problems become a new fix step in the plan.
7. **Finish.** `orchestrator_finish` settles the run and archives the workers. Their threads stay available in BB.

What happens when steps fail or stop:
- **A failed step** cancels the steps that depend on it.
- **A step reported as `blocked`** holds its dependents in the queue until the coordinator revises the plan.
- **`success` with `limitations`** is for caveats that did not stop the assignment.

## Branches and worktrees

- **One branch per run.** Each run gets one branch name, such as `orchestrator/checkout-flow-mabc123`, used in every repository it touches.
- **One worktree per project.** The first worker in a project gets a clean git worktree on that branch, built from the checkout's committed `HEAD`. Uncommitted changes in your checkout are left alone. Later workers, retries and replacements in that project reuse the same worktree.
- **One writer at a time.** Only one mutating workstream per project runs at once. Different projects run in parallel, up to the parallel limit.
- **Read-only work can share.** Read-only workstreams can inspect the same worktree while the writer runs.

## Delegation

Workers can hand bounded subtasks to child workers with `orchestrator_delegate`.

- **Keys.** A child's key is namespaced under its parent, for example `api/inspect-contract`.
- **Read-only.** Delegated work is always read-only. Reported changes, commits or pushes from a child are rejected, which keeps one writer per project.
- **Limits.** By default: depth 2, three children per worker, eight workstreams per run.
- **Model.** Children run on their parent's provider and model. The profile they are given only changes their action budget.
- **Finishing.** A parent cannot complete while any descendant is still running. Cancelling, failing, timing out or finishing a workstream also cleans up its descendants.

## Watching and steering a run

- **Run panel.** The Orchestrator run panel shows each workstream's state, live worker output, context use, token history and completion evidence.
- **Why is it waiting?** Every workstream reports why it is or isn't ready, for example `WaitingForDependencies`, `ProjectLaneBusy`, `WorkerSlotsExhausted`, `Provisioning`, `DependencyBlocked` or `Suspended`. These are computed from stored state each time, so they cannot go stale.
- **Suspend and resume.** You can pause a whole run or a single workstream.
  - Suspending stops the worker's agent session but keeps its thread, its worktree and its project's writer lane.
  - A suspended run launches nothing and is exempt from the run timeouts.
  - Resuming sends the worker a continuation prompt. Time spent suspended does not count against the worker timeout.
- **Workers that go quiet.** A worker that stops without calling `orchestrator_worker_done` gets one reminder that matches what it appears to have done: nothing, only planned, got blocked, or did the work but didn't report. If it stops again, the workstream fails with that reason. If it still says it's blocked, it is recorded as blocked, so its dependents wait instead of being cancelled. Workers waiting for the coordinator's answer to a question are left alone.

## Models and routing

Assignments default to the `quick` profile. Higher profiles need a stated complexity reason. Built-in routes:

| Profile | Claude Code | Codex |
|---|---|---|
| quick | Haiku 4.5 | GPT-5.6 Luna |
| standard | Sonnet 5 | GPT-5.6 Terra |
| complex | Fable 5.1 | GPT-5.6 Sol |
| critical | Opus 5 (1M) | GPT-6 Astra |

Reasoning is `model-default` unless you configure it.

To change routing, open **Settings → Installed Plugins → Orchestrator → Worker model routing**.
- You can choose the model and reasoning for all four profiles, for every provider BB offers. The model lists come from BB's live catalogs, so new providers appear without a plugin release.
- **Route by workload profile** sends each profile to a different provider.
- A reasoning level must be one the model supports. Invalid combinations are rejected, never silently downgraded.

Older saved `profileReasoning` settings are upgraded to per-route reasoning the first time they load.

The plugin never turns on Claude `ultracode` or Codex `ultra` itself, and workers always run with permission mode `auto`.

## Policy

Open **Settings → Installed Plugins → Orchestrator → Orchestration policy**.

| Setting | Default |
|---|---|
| Parallel workers | 3 |
| Workstreams per run | 8 |
| Attempts per workstream | 2 |
| Delegation depth / children per worker | 2 / 3 |
| Worker timeout | 45 min |
| Run timeout | 180 min |
| Inactivity cleanup | 120 min |
| Token budget per run | 40M (0 disables it; going over fails the run) |
| Planning mode | `auto` |
| Dispatch approval | `critical` (also: `never`, `first-dispatch`, `every-dispatch`) |

A run takes a copy of the policy when it starts. Enabling the same thread again, for example to change its project scope, replaces that copy with the current global policy.

Version control policy:

| Setting | Values | Default |
|---|---|---|
| `commitMode` | `disabled`, `owned-only`, `owned-or-approved-existing` | `owned-or-approved-existing`: commits on the run's own branch need no approval; commits on an existing branch need your explicit approval |
| `pushMode` | `disabled`, `explicit-approval` | `explicit-approval`: every push needs your explicit approval |
| `protectedBranches` | branch names | `["main", "develop"]`: never committed to or pushed |

A mutating workstream reports its commit SHAs in order. The plugin checks them against this policy when the worker completes. BB's plugin SDK cannot intercept shell commands, so these rules are enforced through the worker prompt and completion checks, not at the shell.

## What a completion is checked for

- **No blockers on success.** `success` cannot list blockers.
- **Failing checks need a reason.** `success` with a failed check is rejected unless a limitation explains it, for example that the check already failed before the change.
- **Read-only means read-only.** Read-only workstreams cannot report changes, commits or pushes.
- **Commit and push rules.** Commits must be on the run branch, protected branches cannot be touched, and pushes need your approval.
- **Changes must show in the diff.** If a worker reports changed files but the worktree diff shows none, the result is kept with a warning that the coordinator sees.

## Learning data

**Settings → Installed Plugins → Orchestrator → Orchestrator learning data** shows:

- **Totals:** completion rate, failures, and tokens (fresh, cached, output, reasoning, and the coordinator's share).
- **Failure categories:** only failed outcomes are counted.
- **Recent sessions.**

Sessions that never started a worker (a coordinator thread used as a normal chat) are left out of the totals and shown as a separate count.

Behind that is an event log. It records:
- plan versions and dispatches;
- workstream transitions, with queue time, route, profile and attempt;
- final token usage per workstream;
- retries and completion reminders;
- validation summaries and changed-file evidence;
- environment base state;
- who caused each event (you, the coordinator, a specific worker, or the system).

Prompts and conversations are not written to the event log. A workstream's stored completion evidence does include a bounded excerpt of the worker's final output.

## Cleanup

Workers retire when they finish, and a five-minute background job catches anything missed. It also:
- releases lanes and retires finished workers after a plugin reload;
- reminds or settles idle workers;
- enforces the worker, run and inactivity timeouts.

Disabling orchestration, or archiving or deleting the coordinator, cleans up its workers. Archiving a coordinator whose workstreams all completed records the run as completed. Cleanup archives and stops worker threads. It does not delete the shared project worktree.

Coordinators created by the older Sidebar group orchestrator are not managed by this plugin. Finish or archive their children through that coordinator, or restart the work as an Orchestrator run.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
