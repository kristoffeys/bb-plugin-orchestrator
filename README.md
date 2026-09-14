# BB Orchestrator

Managed, visible BB worker threads for multi-project and multi-workstream jobs.

## Install

```sh
bb plugin install git:https://github.com/kristoffeys/bb-plugin-orchestrator.git@semver:^0.1.0
```

The plugin owns worker reconciliation, parent/worker messaging, runtime cleanup,
and cost-aware model routing. Callers such as the Sidebar plugin provide a label,
task, and allowed project ids through the `start` RPC; they do not manage worker
threads themselves.

Ordinary root project threads can orchestrate too. Click the workflow icon in
the chat composer or thread header, choose the projects workers may use, and
enable it. The very next ordinary prompt can dispatch workers: no separate
enable message is needed. The same control can update the project scope or disable orchestration.
As an alternative, asking the agent to enable orchestration exposes the
`orchestrator_enable` tool. Opt-in keeps routine threads from acquiring
worker-management tools by default.

Assignments default to the `quick` profile. Higher profiles require a concrete
complexity reason. The default routing is:

| Profile | Claude Code | Codex | Reasoning |
|---|---|---|---|
| quick | Haiku 4.5 | GPT-5.6 Luna | low |
| standard | Sonnet 5 | GPT-5.6 Terra | medium |
| complex | Fable 5.1 | GPT-5.6 Sol | high |
| critical | Opus 5 | GPT-6 Astra | xhigh |

Open **Settings → Installed Plugins → Orchestrator → Worker model routing** to
choose all four models for every provider currently available in BB. The
provider and model lists come from BB's live catalogs, so OpenCode and future
providers appear without an Orchestrator release. Claude Code and Codex retain
the defaults above until explicitly changed. An unfamiliar provider must be
saved once before dispatch; this avoids silently treating an expensive default
model as its cheap tier.

The orchestrator does not use Claude `ultracode` or Codex `ultra` by default;
BB parent/child threads remain the only delegation mechanism.

Disabling Claude Workflows does not automatically switch anything on. This
plugin is provider-neutral and works with any available provider; installing
and enabling it (then starting or opting into a managed run) is the explicit
switch. A coordinator chooses from the routing configured for its provider.
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
