# Best-of-class orchestrator research

Research date: 2026-09-15

## Executive assessment

BB Orchestrator is already a solid **managed worker lifecycle plugin**. It has durable run and workstream records, bounded hierarchical delegation, project-level write serialization, environment reuse, structured completion records, approval and evaluator gates, token ceilings, provider-neutral model routing, artifact notifications, dependency-aware planning, completion evidence, a live run command center, and reload cleanup. The 45 existing tests cover these contracts and pass.

The main gap is that it is not yet a complete **workflow runtime**. It now has the first useful layer of a task graph and run observability, but it still lacks append-only execution history, durable scheduling claims, deterministic verification, enforced worker isolation, global admission control, full graph semantics, and operator recovery controls. Several important guarantees are currently instructions to models or checks against model-reported data after work has happened.

The best product direction is to make the plugin a dependable control plane around coding agents:

1. Add an event-backed state machine and idempotent scheduler.
2. Extend the task DAG with explicit runtime states, richer dependency conditions, priorities, and failure rules.
3. Verify outcomes and repository state independently of worker claims.
4. Enforce isolation and policy before actions where BB exposes the necessary hooks.
5. Add an execution graph, timeline, controls, and a real evaluation loop.

This would distinguish BB Orchestrator from prompt-centric agent teams. The aim should be reliable execution and evidence, rather than maximizing agent count or free-form agent conversation.

## Implementation status audit — 2026-09-15

The recommendation list is no longer entirely open. Recent work completed useful parts of six areas, although none of the twelve broad recommendations has met its full acceptance bar yet.

| Recommendation | Status | Implemented now | Still open |
|---|---|---|---|
| 1. Event-backed state machine | Open | Plans carry a monotonically increasing version. | Append-only run events, legal transition enforcement, idempotency keys, durable scheduler claims/leases, replayable projections, and crash-point recovery. The current plan row is overwritten when revised, and queue locking remains process-local. |
| 2. Dynamic task DAG | **Substantial partial** | Plan steps now have `dependsOn`, `phase`, `accessMode`, and `successCriteria`; unknown dependencies and cycles are rejected; dependent work waits for successful prerequisites; failed prerequisites cancel blocked consumers; dispatch must match the current plan revision. | Explicit `ready`/`blocked` states, priority, configurable failure policy, artifact/version conditions, critical-path calculation, and persisted plan revision history. |
| 3. Evidence-based verification | **Partial** | Completion now captures worker output, conversation outline, context use, timeline/TODO state, storage files, and actual environment diff metadata. The dashboard exposes this evidence. | Trusted test execution, criterion-by-criterion grading, actual VCS/approval reconciliation, independent verifier workers, grader identity/version, and evidence-driven repair routing. Captured evidence is currently informative and does not gate success. |
| 4. Least privilege and isolated writes | **Small partial** | Coordinator plans can designate root workstreams as read-only, allowing parallel investigation before mutation. Reported writes from read-only work still fail completion validation. | Read-only filesystem enforcement, per-worker tool allowlists, pre-tool policy hooks, credentials outside sandboxes, isolated writer worktrees, and deterministic integration. |
| 5. Run controls and recovery | Open | Existing replacement, timeout, cleanup, and same-thread evaluator retry behavior remains. | Pause/resume, node cancel/retry/edit, durable user-input waits, checkpoints, subtree/run forks, clean-environment retry, and preservation of terminal run history. |
| 6. Operator console | **Substantial partial** | A thread-panel command center now shows live run counts, grouped workstreams, state, dependencies/next action, provider/model, attempts, tokens/context, TODOs, output, completion evidence, diffs, artifacts, and worker links. It refreshes from realtime events and a five-second fallback poll. | Actual DAG visualization, append-only event timeline, attempt history, critical path, failure propagation view, and operator controls such as pause/cancel/retry/edit/message/approve. |
| 7. Global scheduler | Open | Per-run parallel and project-lane limits remain. | Cross-run/host/provider pools, durable shared reservations, fair queuing, priorities/deadlines, and provider backpressure. |
| 8. Adaptive retry | Open | Provider retries, evaluator repair turns, stale-environment fallback, and timeout handling remain. | Failure taxonomy, backoff/jitter, scheduled retries, circuit breakers, alternate-provider/model escalation, clean-context recovery, and dead-letter handling. |
| 9. Typed artifact registry | Open | Existing categorized artifacts and named-consumer notifications remain and are visible in the dashboard. | Schema validation, immutable hashed versions, lineage/supersession, delivery acknowledgement, launch-time delivery, artifact-conditioned dependencies, and compatibility grading. |
| 10. Quality/cost-aware routing | **Partial** | Existing provider/model/reasoning profiles and aggregate success/token/duration recommendations remain. New small-versus-large planning creates a fast path and requires structured decomposition for larger work. | Monetary cost, task-family normalization, evaluator scores, confidence intervals, Pareto comparison, escalation ladders, and measured topology/single-worker selection. |
| 11. Durable context and decisions | **Partial** | The current global plan persists its rationale, scale, steps, dependencies, phases, and success criteria. Workers receive relevant plan context, and completion evidence preserves selected runtime context. | Immutable plan revisions, decision/assumption/question records, repository facts tied to revisions, durable compact summaries, and queryable original event history. |
| 12. Reusable roles/workflows | Open | The coordinator prompt now guides investigation and implementation phases. | Versioned role definitions with scoped tools/skills/MCP/routes/hooks and reusable workflow templates. |

The completed slices are covered by four new tests: small-request planning, dashboard evidence, dependency-gated parallel investigation, and cycle/failure propagation. The suite now has 45 passing tests, and TypeScript checking passes.

## What exists today

### Control plane

- A root thread opts in or is created as a coordinator. The coordinator receives a fixed managed tool set ([server.ts](../server.ts#L567)).
- `orchestrator_dispatch` reconciles a complete desired set using stable keys, retires omitted or changed workers, and queues replacements ([server.ts](../server.ts#L578)).
- Policy is snapshotted into each run, including worker limits, timeouts, token budget, approval/evaluator behavior, and VCS rules ([lib/policy.ts](../lib/policy.ts#L13)).
- Workers can create bounded, namespaced descendants. Descendants are labeled read-only, while root workstreams are mutating.

### Scheduling and execution

- Each run has its own parallel worker ceiling.
- Mutating workstreams in one project are serialized and reuse one durable project environment. Work in different projects can run concurrently ([server.ts](../server.ts#L377)).
- Queue launch is guarded by a process-local promise chain per coordinator ([server.ts](../server.ts#L459)).
- Provisioning polls for environment attachment and retries once with a fresh project-default environment when a saved environment lease is stale.

### Lifecycle and recovery

- SQLite stores current run, workstream, environment, artifact, and aggregate routing metric state ([lib/state.ts](../lib/state.ts#L1)).
- Provider turn failures retry up to the configured attempt ceiling ([server.ts](../server.ts#L1016)).
- Idle workers without `orchestrator_worker_done` fail the completion contract.
- A five-minute reconciliation task releases lanes, retires terminal threads, detects idle workers missed during reload, applies worker/run timeouts, and cleans expired runs ([server.ts](../server.ts#L1069)).

### Handoffs, quality, and policy

- Messages are restricted to members of one managed run.
- Typed artifact categories can be persisted and announced to named consumers ([server.ts](../server.ts#L848)).
- Completion is structured: summary, changed files, validation claims, blockers, branch, commits, pushes, and approval evidence ([server.ts](../server.ts#L874)).
- Critical or all work can enter a coordinator-operated evaluator gate ([server.ts](../server.ts#L927)).
- Profile routes select provider, model, and exact reasoning effort. Aggregate metrics track success, duration, and tokens.

## Comparative landscape

| System | Strong ideas relevant to BB | Where BB is already stronger or more specific |
|---|---|---|
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | Shared task list, dependency-aware claiming, direct teammate steering, reusable teammate definitions, completion hooks | Claude teams remain experimental and document limitations around resumption, coordination, and shutdown. BB has durable plugin-owned lifecycle state, cross-provider routing, project scoping, and explicit cleanup. |
| [Claude Code subagents](https://code.claude.com/docs/en/subagents) | Per-agent tools, permissions, hooks, skills, persistent memory, turn limits, background execution, and optional worktree isolation | BB owns multi-project worker environments and durable run-wide policy. |
| [GitHub Copilot custom agents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents) | Reusable specialist definitions, scoped tools and MCP servers, isolated contexts, automatic delegation, streamed lifecycle events | BB supports long-lived visible worker threads, hierarchical run ownership, and exact provider/model routing. |
| [GitHub Copilot hooks](https://docs.github.com/en/copilot/concepts/agents/hooks) | Deterministic pre/post tool policy, lifecycle audit points, secret scanning, and stop/subagent-stop enforcement | BB has central run policy but currently validates most worker behavior at completion. |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | Explicit graph execution, checkpoints, interrupts, pause/resume, state editing, fault recovery, and time travel | BB is directly integrated with coding environments and human-visible agent threads. |
| [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints) | Superstep checkpoints including pending messages/requests/shared state, replay, graph workflows, and resumable HITL | BB is lighter and already fits the IDE's provider and environment model. |
| [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) | Event routing, parallel starts, typed state, persistence, resume/fork, HITL, streaming, and flow visualization | BB's worker lifecycle, environment reuse, and VCS policy are more coding-specific. |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | Input/output/tool guardrails, sessions, handoffs, MCP, lifecycle hooks, structured output, and built-in traces | BB is provider-neutral and manages independent IDE threads and repository environments. |
| [Temporal](https://docs.temporal.io/) | Event history, durable timers, activity retry policies, crash recovery, and idempotent workflow design | Introducing Temporal would add substantial operational weight; its principles can be implemented in SQLite first. |
| [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) | Separation of session log, harness, and sandbox; append-only events; replaceable harness/sandbox; credentials outside execution sandboxes | BB already provides separate thread and environment abstractions, making this design attainable inside the host platform. |

## Gap analysis

### P0: correctness and control

#### 1. Append-only run events and a validated state machine

Today, `runs` and `workstreams` are mutable snapshots. `setRunState` and `setWorkstreamState` accept any target state, and the launch mutex exists only in process memory ([lib/state.ts](../lib/state.ts#L134), [lib/state.ts](../lib/state.ts#L253)). After a crash, current state survives, but the reason and exact sequence of transitions do not. Concurrent callbacks or plugin instances have no durable claim protocol.

Add:

- `run_events(id, run_id, workstream_key, type, payload_json, causation_id, correlation_id, actor, created_at)` as an append-only journal.
- A transition function that rejects illegal state edges and writes the event and projection update in one transaction.
- Stable operation IDs for dispatch, spawn, completion, review, message delivery, and cleanup so repeated callbacks are harmless.
- Durable queue claims with lease owner, lease expiry, and compare-and-swap version. A scheduler should atomically move one item from ready to provisioning.
- Rebuildable projections for current status and a repair command that derives expected state from events plus actual BB thread/environment state.
- Explicit `provisioning`, `ready`, `paused`, and `waiting_for_input` states instead of overloading `queued` or `running`.

Temporal's event history and Microsoft Agent Framework's checkpoints show the reliability target. Anthropic's Managed Agents design makes the same separation: session as an append-only log, harness as replaceable control logic, and sandbox as replaceable execution infrastructure.

Acceptance bar:

- Replaying any run produces the same projection.
- Duplicate delivery of every supported lifecycle event has no effect.
- Two scheduler instances cannot spawn the same logical attempt.
- Restarting during every state transition either completes or safely retries that transition.

#### 2. First-class dynamic task DAG

Dispatch currently supplies a flat desired list. The only scheduler constraints are run capacity, project write lane, parent liveness, and insertion order. Contract dependencies exist in prose, artifacts, and coordinator reasoning. A consumer can start before its producer has published or validated the needed contract.

Extend assignments with:

```ts
{
  key: string;
  dependsOn?: Array<{
    key: string;
    condition: "completed" | "artifact";
    artifact?: { kind: string; name: string; versionRange?: string };
  }>;
  priority?: number;
  failurePolicy?: "block" | "continue" | "cancel-descendants";
  acceptanceCriteria: AcceptanceCriterion[];
  expectedOutputs?: ArtifactContract[];
}
```

The runtime should validate cycles and unknown references, derive `blocked -> ready`, unblock consumers transactionally, and show the critical path. A worker may propose new nodes, but the control plane should validate and insert them. Dependencies should be semantic, while project write lanes remain resource constraints.

This matches dependency-aware task lists in Claude teams, graph execution in LangGraph and Microsoft Agent Framework, and research showing that graph topology affects multi-agent results. MultiAgentBench found graph coordination strongest for its research scenario, and MacNet uses DAGs to organize interaction ([MultiAgentBench](https://aclanthology.org/2025.acl-long.421/), [MacNet, ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/66a026c0d17040889b50f0dfa650e5e0-Abstract-Conference.html)).

#### 3. Independent, evidence-based verification

Completion validation currently checks the shape and internal consistency of what a worker reports. It does not confirm that changed files, commits, pushes, branch ownership, approvals, or test results match the repository and BB event history. The evaluator is the coordinator model that planned and supervised the work, so it shares context and can share the producer's blind spots.

Add three grader types:

- **Code graders:** trusted commands, exit status, test reports, lint/static/security results, and repository state inspection.
- **Policy graders:** compare actual diff/branch/commit/push events and approvals with run policy.
- **Model graders:** independent verifier threads with a fixed rubric, isolated context, read-only tools, and a different model/provider when configured.

Store each criterion, evidence, grader identity/version, score, and decision. A workstream becomes complete only when its required criteria pass. Failed criteria should route to a repair attempt with the evidence attached. Reserve human review for ambiguity or policy decisions.

Anthropic recommends grading both the transcript and actual environment outcome and combining code, model, and human graders ([agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). The MAST study identifies task verification and termination as one of three major multi-agent failure categories ([NeurIPS 2025](https://papers.nips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html)).

#### 4. Enforced least privilege and isolated writes

The worker prompt says descendants are read-only and VCS actions obey policy. `orchestrator_worker_done` rejects a conflicting report only after the action could have occurred ([server.ts](../server.ts#L889)). The README correctly acknowledges that the SDK cannot intercept arbitrary provider shell commands.

Use host capabilities as they become available:

- Spawn every worker with an explicit tool allowlist and permission ceiling.
- Give read-only workers an actually read-only filesystem or snapshot.
- Add pre-tool policy hooks for shell, write, VCS, network, and external side effects.
- Keep credentials outside worker environments and proxy authenticated operations.
- Prefer a temporary worktree per mutating workstream when independent same-project work is possible. Merge through a deterministic integration node after verification.
- Retain the shared-project lane mode for intentionally sequential work that must see prior uncommitted state.
- Record policy decisions and denied actions in the run event journal.

Claude subagents already expose tool restrictions, permission modes, hooks, and worktree isolation. Copilot hooks can block tools before execution. OpenAI's tool guardrails execute checks around each custom function call ([guardrails](https://openai.github.io/openai-agents-python/guardrails/)). These are now baseline control-plane capabilities.

### P1: workflow operations

#### 5. Run controls and recovery

Add user and coordinator operations for:

- Pause and resume a run without treating it as failure or inactivity.
- Cancel, retry, replace, or continue one node.
- Retry from a clean environment, from the prior environment, or from a named checkpoint.
- Edit a blocked node's prompt, route, dependencies, or acceptance criteria with a new revision.
- Fork a run or subtree for an alternative approach.
- Request free-form user input and resume durably after hours or days.
- Continue a failed run after remediation without deleting its history.

Current terminal re-enable calls `resetRun`, which deletes workstreams, artifacts, environments, and the run record ([lib/state.ts](../lib/state.ts#L107)). Historical runs should be immutable and a new attempt/run should link to its predecessor.

#### 6. Execution graph, timeline, and operator console

The app currently provides opt-in controls plus policy and routing settings. Add a run UI with:

- DAG view colored by state, project, access mode, model, and critical path.
- Append-only timeline with prompts, state transitions, messages, artifacts, approvals, retries, evaluator decisions, resource use, and cleanup.
- Node drawer showing attempt history, current thread, actual environment, diff summary, test evidence, and blockers.
- Controls for pause, cancel, retry, edit, message, approve, and open worker.
- Live global capacity, per-project lanes, queue wait time, remaining token/cost budget, and predicted completion.
- Failure attribution: the first failed criterion or event and all downstream nodes it affected.

OpenAI Agents SDK traces agent, generation, function, guardrail, and handoff spans by default ([tracing](https://openai.github.io/openai-agents-python/tracing/)). Claude teams expose a shared task list and direct teammate steering. A best-in-class BB experience should combine those ideas with durable repository evidence.

#### 7. Global scheduler and admission control

`maxParallelWorkers` is per run, so several coordinators can collectively exceed sensible host or provider capacity. Introduce:

- Global, host, project, provider, and model concurrency pools.
- Weighted fair queuing across users/runs so one large run cannot starve others.
- Priority, deadline, estimated tokens/cost, and resource labels on nodes.
- Provider rate-limit awareness and backpressure.
- Separate limits for provisioning, active model turns, read-only jobs, and mutating jobs.
- A reservation/lease system shared across plugin instances.

#### 8. Failure taxonomy and adaptive retry

Current automatic retry handles provider turn failures on the same thread. Provisioning failure is retried with a new environment only when a saved lease was used. Add policies by failure class:

| Failure | Default response |
|---|---|
| Transient provider/rate limit/network | Exponential backoff with jitter; same logical attempt and idempotency key |
| Context exhausted or corrupted | Fresh thread with structured checkpoint and prior evidence |
| Verification failure | Repair attempt with failed criteria and diff |
| Repeated model failure | Escalate model/reasoning or configured alternate provider |
| Environment failure | Reprovision from recipe; preserve session/event history |
| Policy violation | Stop immediately; require human decision |
| Dependency contract mismatch | Block consumers; reopen producer or spawn integration node |

Add circuit breakers, retry budgets, `next_attempt_at`, and dead-letter state. Never retry non-idempotent external actions without a receipt or compensation plan.

#### 9. Typed artifact registry and delivery acknowledgements

Artifacts have useful categories, but `content` and `path` remain arbitrary strings. Notifications are best-effort and a queued consumer may never receive an artifact directly.

Add:

- Schema IDs and validation for OpenAPI, JSON Schema, migration plans, interface manifests, decisions, diffs, and test reports.
- Immutable artifact versions with hashes, producer attempt, repository revision, lineage, and supersession links.
- Consumer subscriptions and delivery/acknowledgement state, including delivery when a queued consumer launches.
- Artifact dependencies that unblock DAG nodes only after the required version validates.
- Compatibility graders that compare producer and consumer contracts.

### P2: intelligence and extensibility

#### 10. Routing based on quality, cost, and uncertainty

Current metrics aggregate binary success, duration, and tokens by provider/model/profile ([lib/state.ts](../lib/state.ts#L355)). Recommendations begin after three samples, which is too little for stochastic comparisons and does not control for task mix.

Record:

- Task family, repository/language, risk, acceptance criteria, route revision, actual monetary cost, latency, retries, evaluator scores, human overrides, and failure class.
- Multiple trials in an offline scenario suite; show uncertainty intervals instead of a winner after three observations.
- Pareto frontiers for quality, latency, and cost.
- Escalation ladders: cheap route first, then stronger route only after specified evidence.
- An explicit single-agent/one-worker gate when decomposition has no clear parallel or isolation benefit.

Anthropic reports multi-agent research used roughly 15 times the tokens of chat and warns that coding often has fewer parallelizable tasks ([multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). Routing should decide whether to orchestrate at all, then choose topology and models.

#### 11. Durable context and decision memory

Persist separately from model context:

- User objective and accepted clarifications.
- Current plan and plan revisions.
- Decisions with rationale and affected nodes.
- Repository facts with source paths and revision hashes.
- Open questions, assumptions, and risks.
- Structured compact summaries per attempt.

Workers should receive the smallest context bundle that satisfies their dependencies. They should be able to query the event/artifact store for details instead of receiving ever-growing prompt text. Keep original events so compaction is reversible.

#### 12. Reusable role and workflow definitions

Add versioned project/user/plugin definitions for roles such as explorer, implementer, test runner, integration reviewer, security reviewer, and release verifier. Each definition should specify prompt, tools, skills, MCP servers, access mode, route constraints, acceptance templates, and hooks. Add reusable workflow templates for common shapes such as parallel review, producer-consumer integration, competing hypotheses, and implement-review-repair.

## Research-driven design rules

1. **Use multiple workers only for decomposable work, context isolation, fault isolation, or independent verification.** Anthropic found strong gains for breadth-first research but also high token cost and weaker fit for tightly dependent coding work.
2. **Make coordination data structured.** The MAST taxonomy groups observed failures into specification/system design, inter-agent misalignment, and verification/termination. Each group requires runtime structures, not just a longer coordinator prompt.
3. **Keep the coordinator in control of synthesis; let workers communicate through typed artifacts and targeted messages.** Unbounded group chat increases noise and makes causality hard to audit.
4. **Separate deterministic workflow logic from model judgment.** Readiness, budgets, retries, permissions, transitions, and completion criteria belong in code. Models propose plans, perform work, interpret ambiguous evidence, and write synthesis.
5. **Verify the environment outcome.** A success message is evidence about agent intent, not proof that the repository is correct.
6. **Preserve history.** Every dispatch revision, handoff, approval, retry, and grading result should remain inspectable.
7. **Design for replacement.** Sessions, model routes, harness logic, and environments should fail or change independently, following the session/harness/sandbox separation described by Anthropic Managed Agents.

## Recommended implementation sequence

### Milestone 1: reliable kernel

- Add event journal, legal transition tables, idempotency keys, optimistic versions, and durable scheduler leases.
- Introduce `provisioning`, `ready`, `paused`, and `waiting_for_input` states.
- Preserve terminal runs instead of deleting them on restart.
- Add crash-point and duplicate-event tests.

This is the prerequisite for every later capability.

### Milestone 2: task graph and artifacts

- Add dependencies, priorities, failure policies, acceptance criteria, and expected artifacts.
- Validate DAG revisions and calculate readiness transactionally.
- Add immutable typed artifacts, hashes, lineage, and acknowledgements.
- Deliver relevant artifacts at worker launch.

### Milestone 3: verification and isolation

- Add trusted code/policy graders and optional independent model verifier workers.
- Reconcile reported files, commits, branch, and validations against actual state.
- Add tool/permission profiles and pre-action policy hooks supported by BB.
- Add optional worktree-isolated writers plus an integration node.

### Milestone 4: operator experience

- Ship graph and timeline views with node controls.
- Add pause/resume/cancel/retry/fork and durable user-input waits.
- Add failure attribution and complete attempt history.

### Milestone 5: adaptive operations

- Add global fair scheduling and provider-aware backpressure.
- Add cost accounting, uncertainty-aware route comparison, escalation ladders, and single-worker selection.
- Build a regression suite and run controlled routing/topology experiments.

## Evaluation plan

Unit tests are strong for the current deterministic contracts, but they do not measure the orchestrator as a stochastic system. Build a versioned evaluation suite with repeated trials.

### Scenario families

- One-repository sequential change where orchestration should choose one worker.
- Independent multi-repository changes that should parallelize.
- Producer/consumer API change where the consumer must wait for a validated artifact.
- Same-repository independent modules using isolated worktrees and deterministic integration.
- Ambiguous task that must request clarification.
- Worker false-positive success: claimed tests pass but command fails.
- Contract mismatch between two locally successful workers.
- Provider outage, rate limit, context exhaustion, environment loss, duplicate event, and plugin restart at every transition.
- Policy violation attempts from shell and VCS tools.
- Human approval delayed beyond process restart.

### Metrics

- End-to-end task success across repeated trials.
- Pass-to-pass and fail-to-pass test results.
- Policy violations prevented before execution.
- Coordination failures by MAST category.
- Recovery rate after injected faults.
- Duplicate or orphaned threads/environments.
- Critical-path latency, queue latency, tokens, actual cost, and success per unit cost.
- Artifact mismatch rate and downstream rework.
- Human interventions and incorrect approval requests.

Use code graders first, model graders with fixed rubrics second, and periodic blinded human calibration. Store full trajectories and actual environment outcomes, following Anthropic's evaluation guidance.

## What not to prioritize

- More agent personas without distinct tools, context, or acceptance criteria.
- Default all-to-all chat or autonomous self-claiming before the event log and DAG exist.
- Very deep delegation; it compounds context loss and makes failure attribution harder.
- Automatic routing changes from a handful of production samples.
- Adopting a heavyweight external workflow service before SQLite-backed idempotency, transitions, and leases have reached their limits.
- UI polish around current states before the underlying execution history and graph model are correct.

## Current risks ranked by severity

| Rank | Risk | Impact | Evidence in current design |
|---:|---|---|---|
| 1 | Worker claims are treated as proof | Incorrect or policy-violating changes can be accepted | Completion validates submitted fields, not repository reality |
| 2 | No explicit dependency graph | Consumers can run on missing or stale contracts | Flat dispatch plus incidental project serialization |
| 3 | No durable scheduler claim/idempotency layer | Duplicate spawn or inconsistent state under concurrency/restart | Process-local `launchLocks` and mutable projections |
| 4 | Read-only/VCS policy is post-hoc | Damage can occur before rejection | Prompt contract plus completion report checks |
| 5 | No event timeline or attempt ledger | Weak debugging, audit, replay, and failure attribution | Current-state tables and aggregate metrics only |
| 6 | Per-run capacity only | Host/provider overload and cross-run starvation | `maxParallelWorkers` calculated inside one run |
| 7 | Evaluator lacks independence and criteria | Confirmation bias and inconsistent review | Coordinator accepts/rejects self-reported result |
| 8 | Coarse retry behavior | Transient, semantic, policy, and environment failures receive poor recovery strategies | Same-thread provider retry plus limited provisioning fallback |
| 9 | Terminal history is reset | Learning and audit continuity are lost | `resetRun` deletes run-owned records |
| 10 | Routing data is under-specified | Recommendations can be misleading | Three-sample threshold and task-unadjusted binary aggregates |

## Overall conclusion

The current plugin has the right product boundary: BB owns threads and environments; Orchestrator owns run lifecycle and coordination; models do the cognitive work. Its strongest qualities are provider neutrality, durable visible workers, project-aware serialization, bounded delegation, and explicit cleanup.

The next leap should be from **managed threads** to **verified durable workflows**. Event history, task DAGs, independent verification, enforced isolation, and operator observability will improve reliability more than adding extra conversational patterns. Those capabilities also create the data needed to make routing, topology, and cost optimization scientifically credible.
