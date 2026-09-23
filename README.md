# BB Orchestrator

Managed, visible BB worker threads for multi-project and multi-workstream jobs.

## Install

```sh
bb plugin install git:https://github.com/kristoffeys/bb-plugin-orchestrator.git@semver:^0.2.0
```

The plugin owns durable run/workstream state, bounded hierarchical worker
reconciliation, event-driven completion and retry handling, parent/worker
messaging, cleanup, approval and evaluator gates, structured artifacts,
configurable commit policy, and cost-aware model and reasoning routing.
Callers such as the Sidebar plugin provide a label, task, and allowed project
ids through the `start` RPC; they do not manage worker threads themselves.
The coordinator thread title is derived from the task prompt, while the label
remains the durable worker-group identity.

Ordinary root project threads can orchestrate too. Click the workflow icon in
the chat composer or thread header to open the Orchestration modal, choose the
projects workers may use, and enable it. The very next ordinary
prompt can dispatch workers: no separate enable message is needed. The compact view shows selected projects only;
expand **Add or remove projects** for the uncommon cross-project case. The
same control can update the project scope or disable orchestration.
As an alternative, asking the agent to enable orchestration exposes the
`orchestrator_enable` tool. Opt-in keeps routine threads from acquiring
worker-management tools by default.

On the New thread screen, use the workflow button beside Send to choose the
worker projects and attach orchestration to the draft. Sending through the
normal composer preserves the selected provider, model, reasoning, permission
mode, environment, attachments, and mentions; the thread is initialized as a
coordinator before its first turn starts.

Before workers start, the coordinator records a durable size decision through
`orchestrator_plan`. The default `auto` mode keeps bounded work fast: a request
is small only when it touches at most one project, needs at most two independent
quick/standard workstreams, and has no dependency chain. Small requests may
record that decision without enumerating steps and dispatch immediately.
Larger work records a versioned global plan whose steps include project,
read-only or mutating access, phase, dependencies, routing profile, and success
criteria. `always` requires explicit steps even for small work; `off` preserves
legacy direct dispatch.

Large uncertain requests can begin with root-level read-only investigations.
Those may run concurrently in one project and delegate bounded read-only
subtrees. After joining their findings, the coordinator calls
`orchestrator_plan_update` with the current version, complete definitions for
only the added or changed steps, and any keys to remove. The server merges and
validates the resulting DAG atomically, then returns a compact change summary.
The coordinator dispatches that durable plan by version, so unchanged worker
prompts are not sent again in the dispatch call.
Mutating steps start only after every `dependsOn` step
succeeds and the project's single-writer lane opens. A failed prerequisite
cancels its dependents with a durable reason. A prerequisite whose worker
reports `blocked` holds them queued with reason `DependencyBlocked` until the
coordinator revises the plan. Workers can report `success` with
`limitations` for caveats that did not stop the assignment. Dispatch must match the
current plan version, so scope or dependency changes require a plan revision.

Each run creates one shared feature branch name, such as
`orchestrator/checkout-flow-mabc123`, across every repository it touches. The
first worker for each project receives a dedicated Git worktree on that branch,
and the environment id is recorded durably. If the configured source checkout
has staged, unstaged, or untracked changes, those changes remain untouched in
the source checkout; the worker starts from its committed `HEAD` in a clean
worktree. Later workstreams, replacements, and retries for that project reuse
the worktree, so they see the same branch and files. Only one mutating
workstream per project runs at a time;
different projects can use the configured parallel capacity concurrently.
Queued and running states remain distinct in dispatch results and durable
status, including after a plugin reload. Status also reports the snapshotted
run policy, configured routing policy, and each workstream's actual provider
and model. Worker cleanup archives and stops threads without deleting a shared
project environment. The cleanup schedule reconciles terminal worker records
after reloads so a missed idle event cannot leave their agent sessions loaded.

Provisioning is asynchronous in BB. After spawning a worker, Orchestrator
boundedly polls the thread until its project environment is attached. A
temporary `environmentId: null` remains healthy provisioning state;
cancellation, a terminal provisioning error, or timeout retires the incomplete
worker.

Managed workers may delegate bounded subtasks only with
`orchestrator_delegate`. Local child keys become namespaced stable keys such as
`api/inspect-contract`; every descendant stays owned by the root run and is
shown under its delegating worker. Defaults allow depth 2, three direct children
per worker, and eight total workstreams. Descendants use the `quick` profile
unless their assignment explicitly selects another profile.

Nested work is read-only. Read-only descendants may inspect the same durable
project environment in parallel, including while their parent owns the
project's single mutating lane. Their completion records reject changed files,
commits, and pushes. This avoids same-project join deadlocks while preserving
one writer and one environment/branch per `(run, project)`. A parent stays live
while children run, and `orchestrator_worker_done` rejects parent completion
until every descendant is terminal. Replacement, failure, timeout, finish,
disable, expiry, and reload reconciliation clean descendants recursively.

Every workstream reports derived conditions beside its state: `DependenciesSatisfied`,
`LaneAvailable`, `WorkspaceReady`, and the summarizing `Ready`. Each carries a
reason such as `WaitingForDependencies`, `ProjectLaneBusy`, `WorkerSlotsExhausted`,
`Provisioning`, or `Suspended`, plus a human message. Conditions are computed from
durable state rather than stored, so they cannot go stale, and the run panel and
`orchestrator_status` show the same reasons the launcher acts on.

The run panel can suspend and resume a whole run or a single workstream. Suspending
stops the worker's agent session but keeps its thread, its worktree, and its
project's single mutating lane, so no other writer can enter that project while the
work is paused. A suspended run does not launch queued work, is skipped by run
inactivity expiry, and rejects dispatch until it resumes. Resuming re-sends the
worker a continuation prompt on its existing thread, and the time spent suspended is
added back to the worker timeout instead of counting against it.

Coordinators created by the older Sidebar group orchestrator are outside this
plugin's lifecycle ownership. Their direct children must be finished or
archived through that coordinator, or the work should be restarted as a
standalone Orchestrator run; this plugin does not adopt or delete those
unmanaged threads.

Assignments default to the `quick` profile. Higher profiles require a concrete
complexity reason. The default routing is:

| Profile | Claude Code | Codex | Reasoning |
|---|---|---|---|
| quick | Haiku 4.5 | GPT-5.6 Luna | low |
| standard | Sonnet 5 | GPT-5.6 Terra | medium |
| complex | Fable 5.1 | GPT-5.6 Sol | high |
| critical | Opus 5 | GPT-6 Astra | xhigh |

Open **Settings → Installed Plugins → Orchestrator → Orchestration policy** to
configure parallelism, per-run workstream and attempt ceilings, worker/run/
inactivity timeouts, an optional observed token budget, dispatch approvals,
evaluator gates, delegation limits, and version-control policy. Each run
snapshots this policy when orchestration is enabled, so changing global defaults
never changes a run already in progress.

Planning mode is configurable as `off`, `auto` (default), or `always`.

Orchestrator keeps a durable learning record after a run ends. Open
**Settings → Installed Plugins → Orchestrator → Orchestrator learning data** to
inspect session completion rates, token totals, feature branches, duration,
and failure categories. The event log also captures plan revisions,
workstream lifecycle and queue timing, provider/model/profile routing, retries,
validation summaries, changed-file evidence, environment base state, and
bounded failure evidence. Raw prompts and full conversations are excluded from
analytics by default.

Commit policy is declarative and persisted in the run snapshot:

| Setting | Values | Default and contract |
|---|---|---|
| `commitMode` | `disabled`, `owned-only`, `owned-or-approved-existing` | `owned-or-approved-existing`; Orchestrator-owned branches need no extra commit approval, while existing branches require explicit user approval |
| `pushMode` | `disabled`, `explicit-approval` | `explicit-approval`; every push requires separate explicit user approval |
| `protectedBranches` | normalized branch-name list | `["main", "develop"]`; any listed branch can never be committed to or pushed; the list is replaceable, so `master` is allowed by default and can be added |

A mutating workstream may create one or several logical atomic commits and
reports their SHAs in order through `orchestrator_worker_done`. No-change and
read-only workstreams report no commits. Completion validation rejects policy
violations and stores approval evidence. BB's plugin SDK does not intercept
arbitrary provider shell commands, so prompts and completion/state validation
enforce the managed contract without claiming shell-level prevention.

Open **Worker model routing** to
choose all four models for every provider currently available in BB. The
provider and model lists come from BB's live catalogs, so OpenCode and future
providers appear without an Orchestrator release. Claude Code and Codex retain
the defaults above until explicitly changed. Select **Route by workload
profile** to send quick, standard, complex, and critical work to different
providers. Completed work records success, duration, and observed tokens;
measured recommendations appear after three samples and never change routing
without an explicit save.

Reasoning is configured beside every exact provider/model route, both in the
provider-local table and cross-provider profile strategy. This means two
models from the same provider can use different reasoning values. Exact levels must appear in the selected model's
`supportedReasoningEfforts`; invalid combinations are rejected and never
silently downgraded. `model-default` resolves to the model's declared default.
Each spawn sends the resolved SDK `reasoningLevel` as an explicit execution
input, while metadata and status keep both the requested choice and effective
level. A worker assignment may override its profile's reasoning; nested
assignments otherwise inherit their parent's resolved provider/model route.

### Routing policy compatibility

Existing saved `profileReasoning` policies are upgraded on their first load.
For cross-provider routes, the old profile choice is attached to that profile's
selected provider/model target. For provider-local routes, it is attached to
the corresponding selected model. The upgraded records are persisted, while
the old `profileReasoning` field is removed. If the selected model no longer
supports that old exact choice, saving or dispatching reports a clear validation
error; selecting `model-default` explicitly uses the model's current default.

Workers publish structured completion records and versioned API/schema/
interface artifacts. Named consumer workstreams receive artifact handoffs
automatically. Successful or failed workers retire on idle while their archived
threads remain available in BB. Disabling, archiving, deleting, timing out, or
exceeding a token budget also cleans up managed workers.

The orchestrator does not use Claude `ultracode` or Codex `ultra` by default.
Managed parent/child threads are created only by Orchestrator lifecycle tools.

After a run reaches `completed`, `failed`, or `cancelled`, its root coordinator
receives `orchestrator_enable` again so it can reset durable state and refresh
the allowed projects. Active coordinators and workers do not receive that tool.

Disabling Claude Workflows does not automatically switch anything on. This
plugin is provider-neutral and works with any available provider; installing
and enabling it (then starting or opting into a managed run) is the explicit
switch. By default a coordinator chooses from the routing configured for its provider.
Models that declare a routed provider are spawned through that route
automatically.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
