/**
 * Why a worker went idle without calling orchestrator_worker_done, judged from its final text.
 * The idea (planned-but-did-nothing and blocked detection) comes from Paperclip's run-liveness classifier.
 * ponytail: regex heuristic over the last output only; add durable evidence (diff, tool events) if misclassification shows up in learning data.
 */
export type IdleClass = "empty" | "blocked" | "plan_only" | "unreported";

const TAIL_CHARS = 600;
const NEGATED_BLOCKER = /\b(?:not blocked|no blockers?|unblocked|nothing (?:is )?blocking)\b/i;
// Blocked must be about the worker itself ("I am blocked", "blocked on X"), not the feature ("requests are blocked").
const BLOCKER = /\b(?:i(?:'m| am)(?: currently)? blocked|blocked (?:on|by|until)|can(?:no|')t (?:proceed|continue)|unable to (?:proceed|continue)|waiting (?:on|for) (?:the |an? )?(?:user|approval|access|credentials?|review|input)|i need .{0,60}\b(?:access|credentials?|api key|secret|token|permission|approval))\b/i;
const FUTURE_INTENT = /\b(?:i(?:'ll| will| am going to|'m going to)|let me(?! know)|next,? i(?:'ll| will)|(?:my|the) next step is|i need to)\s+(?:first\s+)?(?:now\s+)?[a-z]+/i;
const DID_WORK = /\b(?:done|completed?|finished|implemented|fixed|added|updated|created|changed|removed|refactored|wrote|committed|pushed|merged|verified|tests? (?:now )?pass(?:es|ed)?)\b/i;

export function classifyIdleWorker(lastText: string | null): IdleClass {
  const text = lastText?.trim() ?? "";
  if (text.length < 20) return "empty";
  const tail = text.slice(-TAIL_CHARS);
  if (BLOCKER.test(tail) && !NEGATED_BLOCKER.test(tail)) return "blocked";
  if (FUTURE_INTENT.test(tail) && !DID_WORK.test(tail)) return "plan_only";
  return "unreported";
}

const CONTRACT = "call orchestrator_worker_done exactly once with status, summary, changed files, validation, blockers, and commits. Do not make unrelated changes";

export const idleReminder: Record<IdleClass, string> = {
  empty: `Your turn ended without output or a structured completion. Continue the assignment, then ${CONTRACT}.`,
  plan_only: `You described next steps but stopped before carrying them out. Do that work now, then ${CONTRACT}.`,
  blocked: `You appear to be blocked. If you are, call orchestrator_worker_done with status "blocked" and name the exact blocker. Otherwise finish the work, then ${CONTRACT}.`,
  unreported: `Your workstream is still marked running because no structured completion was recorded. Review your work, then ${CONTRACT}.`,
};

/** Reason codes feed the learning data's failure categories. `unreported` keeps the historical code. */
export const idleFailureReason: Record<IdleClass, string> = {
  empty: "completion_missing_empty",
  plan_only: "completion_missing_plan_only",
  blocked: "worker_blocked_unreported",
  unreported: "completion_contract_missing",
};
