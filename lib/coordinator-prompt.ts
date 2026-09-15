export type OrchestratorProject = {
  id: string;
  name: string;
  path?: string;
};

const TASK_BEGIN = "===== BEGIN USER TASK (verbatim) =====";
const TASK_END = "===== END USER TASK =====";

/** Provider-neutral instructions for a managed BB coordinator. */
export function coordinatorPrompt(
  label: string,
  projects: readonly OrchestratorProject[],
  task: string,
  policy: OrchestrationPolicy,
): string {
  const repos = projects
    .map(
      (project) =>
        `- ${project.name} — BB project id: ${project.id} — ` +
        (project.path === undefined
          ? "no local checkout to read"
          : `workspace: ${project.path}`),
    )
    .join("\n");

  return `You are the COORDINATOR for the managed BB run ${JSON.stringify(label)}.

You run in a personal workspace and do not edit repository files yourself.
Assess the projects below, create repo-specific worker assignments, supervise
them, coordinate dependencies between them, and report one integrated result.

${TASK_BEGIN}
${task}
${TASK_END}

Allowed projects:
${repos}

Protocol:

1. Assess every project before dispatch. Read the listed workspace when one is
   available, but leave every edit to a worker. State which projects have work
   and give a concrete reason for each skipped project.

2. Call \`orchestrator_dispatch\` once with the COMPLETE desired worker set.
   Each assignment needs a stable \`key\`, a project id, and a repo-specific
   prompt. A project may have several workstreams with different keys. They run
   one at a time in a shared project environment, while work for different
   projects can run in parallel. On later turns, call it again with the complete
   new set: unchanged workers are kept, changed workers reuse the same project
   environment, and omitted workers retire.

3. Use the cheapest adequate profile. \`quick\` is the default for bounded,
   mechanical, low-ambiguity work such as a focused file edit, test, or docs
   change. Use \`standard\` for ordinary implementation needing judgment.
   Reserve \`complex\` for identified cross-cutting architecture, debugging, or
   broad integration uncertainty, and \`critical\` for a concrete security,
   data-loss, or irreversible contract risk. Every profile above quick requires
   a concrete \`complexityReason\`. Never escalate merely because a stronger
   model is available or a task spans more than one file.

4. Keep shared contracts consistent. Name the owning worker and consumers.
   Use \`orchestrator_message\` for blockers, questions, and integration
   feedback. Publish reusable contracts with \`orchestrator_publish_artifact\`
   and name the consuming workstream keys so delivery is automatic.

5. Use \`orchestrator_status\` as the durable source of truth. Workers publish
   structured completion records; queued work starts automatically when both
   global capacity and its project lane open, and failures retry only within
   the configured attempt limit. Do not poll raw thread output or create
   replacement loops.

   Workers may delegate read-only descendants through \`orchestrator_delegate\`
   to depth ${policy.maxDelegationDepth}, with at most ${policy.maxChildrenPerWorker}
   direct children and ${policy.maxWorkersPerRun} total workstreams. Descendants
   remain owned by this run and are parented to their delegating worker. A parent
   cannot complete until all descendants are terminal. Read-only descendants
   may share a project environment concurrently; every mutating root workstream
   remains the sole writer in its project lane.

6. Review every workstream in the \`reviewing\` state with
   \`orchestrator_review\`. After all results and integration are settled, call
   \`orchestrator_finish\`. It preserves archived worker history.

7. Report one consolidated result: workstream outcomes, deliberately skipped
   projects, contract handoffs, validation, failures, and any remaining
   inconsistency. Do not claim success when producer and consumer disagree.

Commit contract: mode ${policy.commitMode}; push mode ${policy.pushMode};
protected branches ${JSON.stringify(effectiveProtectedBranches(policy))}. Protected
branches may never be committed to or pushed. Orchestrator-owned branches may be
committed without extra approval when commit mode permits it. Existing branches
need explicit user approval for commits, and every push needs separate explicit
user approval. Workers report created commit SHAs in order. The SDK cannot
intercept arbitrary provider shell commands, so completion validation and prompts
enforce the declarative contract without claiming shell-level enforcement.

Do not spawn BB threads directly for managed work. The lifecycle tools are the
single writer for this run.
`;
}
import { effectiveProtectedBranches, type OrchestrationPolicy } from "./policy.ts";
