# BB Orchestrator

Managed, visible BB worker threads for multi-project and multi-workstream jobs.

## Install

```sh
bb plugin install git:https://github.com/kristoffeys/bb-plugin-orchestrator.git@semver:^0.2.0
```

The plugin owns durable run/workstream state, bounded worker reconciliation,
event-driven completion and retry handling, parent/worker messaging, cleanup,
approval and evaluator gates, structured artifacts, and cost-aware routing.
Callers such as the Sidebar plugin provide a label, task, and allowed project
ids through the `start` RPC; they do not manage worker threads themselves.

Ordinary root project threads can orchestrate too. Click the workflow icon in
the chat composer or thread header to open the Orchestration modal, choose the
projects workers may use, and enable it. The very next ordinary
prompt can dispatch workers: no separate enable message is needed. The compact view shows selected projects only;
expand **Add or remove projects** for the uncommon cross-project case. The
same control can update the project scope or disable orchestration.
As an alternative, asking the agent to enable orchestration exposes the
`orchestrator_enable` tool. Opt-in keeps routine threads from acquiring
worker-management tools by default.

Each run provisions one project-default environment for every project it
touches and records the environment id durably. Later workstreams,
replacements, and retries for that project reuse it, so they see the same
branch and working tree. Only one workstream per project runs at a time;
different projects can use the configured parallel capacity concurrently.
Queued and running states remain distinct in dispatch results and durable
status, including after a plugin reload. Status also reports the snapshotted
run policy, configured routing policy, and each workstream's actual provider
and model. Worker cleanup archives and stops threads without deleting a shared
project environment. The cleanup schedule reconciles terminal worker records
after reloads so a missed idle event cannot leave their agent sessions loaded.

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
inactivity timeouts, an optional observed token budget, dispatch approvals, and
evaluator gates. Each run snapshots this policy when orchestration is enabled,
so changing global defaults never changes a run already in progress.

Open **Worker model routing** to
choose all four models for every provider currently available in BB. The
provider and model lists come from BB's live catalogs, so OpenCode and future
providers appear without an Orchestrator release. Claude Code and Codex retain
the defaults above until explicitly changed. Select **Route by workload
profile** to send quick, standard, complex, and critical work to different
providers. Completed work records success, duration, and observed tokens;
measured recommendations appear after three samples and never change routing
without an explicit save.

Workers publish structured completion records and versioned API/schema/
interface artifacts. Named consumer workstreams receive artifact handoffs
automatically. Successful or failed workers retire on idle while their archived
threads remain available in BB. Disabling, archiving, deleting, timing out, or
exceeding a token budget also cleans up managed workers.

The orchestrator does not use Claude `ultracode` or Codex `ultra` by default;
BB parent/child threads remain the only delegation mechanism.

Disabling Claude Workflows does not automatically switch anything on. This
plugin is provider-neutral and works with any available provider; installing
and enabling it (then starting or opting into a managed run) is the explicit
switch. By default a coordinator chooses from the routing configured for its provider.
Models that declare a routed provider are spawned through that route
automatically. Reasoning uses the profile's requested tier when supported and
otherwise the model's declared default.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
