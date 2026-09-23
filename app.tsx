import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
  useBbNavigate,
  useComposer,
  useComposerView,
  type PluginPendingInteractionProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { encodeNewThreadOrchestrationMarker } from "./lib/new-thread-marker.ts";

const PROFILES = ["quick", "standard", "complex", "critical"] as const;
type Profile = (typeof PROFILES)[number];
type Routes = Record<Profile, { modelId: string; reasoningLevel: ReasoningChoice }>;
type RouteTarget = { providerId: string; modelId: string; reasoningLevel: ReasoningChoice } | null;
type ReasoningChoice = "model-default" | "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "ultracode";
type RoutingPolicy = { strategy: "coordinator" | "profile"; profileRoutes: Record<Profile, RouteTarget> };
type OrchestrationPolicy = {
  maxParallelWorkers: number;
  maxWorkersPerRun: number;
  maxAttemptsPerWorkstream: number;
  maxDelegationDepth: number;
  maxChildrenPerWorker: number;
  workerTimeoutMinutes: number;
  runTimeoutMinutes: number;
  inactiveCleanupMinutes: number;
  tokenBudget: number;
  planningMode: "off" | "auto" | "always";
  approval: "never" | "first-dispatch" | "critical" | "every-dispatch";
  evaluator: "never" | "critical" | "always";
  commitMode: "disabled" | "owned-only" | "owned-or-approved-existing";
  pushMode: "disabled" | "explicit-approval";
  protectedBranches: string[];
};
type Catalog = Awaited<
  ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>
>;

const PROFILE_COPY: Record<Profile, { label: string; description: string }> = {
  quick: { label: "Quick", description: "Bounded and mechanical" },
  standard: { label: "Standard", description: "Ordinary implementation" },
  complex: { label: "Complex", description: "Architecture and difficult debugging" },
  critical: { label: "Critical", description: "Highest-risk decisions" },
};

type ThreadOrchestrationState = {
  eligible: boolean;
  enabled: boolean;
  label: string;
  allowedProjectIds: string[];
  projects: Array<{ id: string; name: string; current: boolean }>;
};
type DashboardEvidence = {
  capturedAt: number;
  output: string | null;
  conversation: Array<{ id: string; role: "assistant" | "user"; preview: string }>;
  context: { usedTokens: number; modelContextWindow: number; estimated: boolean } | null;
  timeline: { maxSeq: number; rowCount: number; pendingTodos: Array<{ id: string; status: "completed" | "in_progress" | "pending"; text: string }> } | null;
  storage: { rootPath: string; files: Array<{ name: string; path: string }>; truncated: boolean } | null;
  environmentDiff: { environmentId: string; outcome: string; shortstat: string | null; mergeBaseRef: string | null; truncated: boolean; files: Array<{ path: string; changeKind: string; additions: number; deletions: number; binary: boolean }>; message: string | null } | null;
  warnings: string[];
};
type DashboardResult = { status?: string; summary?: string; changedFiles?: string[]; blockers?: string[]; validation?: Array<{ command: string; status: string; summary: string }>; evidence?: DashboardEvidence };
type DashboardWorkstream = {
  key: string; title: string | null; projectId: string; parentKey: string | null; depth: number; accessMode: "mutating" | "read-only";
  profile: Profile; providerId: string; model: string; state: string; threadId: string | null; attemptCount: number; totalTokens: number;
  createdAt: number; updatedAt: number; startedAt: number | null; completedAt: number | null; error: string | null; result: unknown | null;
  evidence: DashboardEvidence | null; live: { status: string | null; displayStatus: string | null; queuedMessageCount: number; outputPreview: string | null; context: { usedTokens: number; modelContextWindow: number; estimated: boolean } | null; pendingTodos: Array<{ id: string; status: "completed" | "in_progress" | "pending"; text: string }>; tokenHistory: Array<{ at: number; tokens: number }> } | null;
  dependencies: string[]; nextAction: string | null;
  conditions: Array<{ type: "DependenciesSatisfied" | "LaneAvailable" | "WorkspaceReady" | "Ready"; status: boolean; reason: string; message: string | null }>;
};
type DashboardData = {
  available: boolean; coordinatorThreadId: string | null;
  run: { label: string; sessionId: string; featureBranch: string; state: string; createdAt: number; updatedAt: number; lastActivityAt: number; totalTokens: number; tokenBudget: number; error: string | null } | null;
  counts: { total: number; active: number; queued: number; completed: number; failed: number; reviewing: number };
  workstreams: DashboardWorkstream[];
  artifacts: Array<{ id: number; workstreamKey: string; kind: string; name: string; version: string | null; summary: string; path: string | null; createdAt: number }>;
};
const OPEN_ORCHESTRATION_EVENT = "bb-orchestrator:open";

function DispatchApproval({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = typeof interaction.payload === "object" && interaction.payload !== null ? interaction.payload as Record<string, unknown> : {};
  const assignments = Array.isArray(payload.assignments) ? payload.assignments.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
  const [busy, setBusy] = useState(false);
  const decide = async (approved: boolean) => {
    setBusy(true);
    try { if (approved) await submit({ approved: true }); else await cancel(); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">Approve this worker plan?</p>
        <p className="mt-1 text-xs text-muted-foreground">The coordinator is paused until you decide.</p>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {assignments.map((assignment) => (
          <div key={`${String(assignment.projectId ?? "project")}:${String(assignment.key ?? assignment.title ?? "workstream")}`} className="flex items-center gap-3 px-3 py-2.5">
            <Icon name="Workflow" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{String(assignment.title ?? assignment.key ?? "Workstream")}</p>
              <p className="text-xs text-muted-foreground">{String(assignment.projectId ?? "Project")} · {String(assignment.profile ?? "quick")} · {String(assignment.accessMode ?? "mutating")}</p>
              {Array.isArray(assignment.dependsOn) && assignment.dependsOn.length > 0 ? <p className="truncate text-[11px] text-muted-foreground">After {assignment.dependsOn.map(String).join(", ")}</p> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void decide(false)} className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50">Reject</button>
        <button type="button" disabled={busy} onClick={() => void decide(true)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">Approve workers</button>
      </div>
    </div>
  );
}

function ProjectPicker({
  projects,
  selectedProjects,
  expanded,
  onExpandedChange,
  onToggle,
}: {
  projects: ThreadOrchestrationState["projects"];
  selectedProjects: ReadonlySet<string>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onToggle: (projectId: string) => void;
}) {
  const visibleProjects = expanded
    ? projects
    : projects.filter((project) => selectedProjects.has(project.id));
  return (
    <fieldset className="mt-4">
      <legend className="text-xs font-medium text-foreground">Worker projects</legend>
      <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-1">
        {visibleProjects.map((project) => (
          <label key={project.id} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-sm hover:bg-accent">
            <input
              type="checkbox"
              checked={selectedProjects.has(project.id)}
              onChange={() => onToggle(project.id)}
              className="size-4 rounded border-input accent-primary"
            />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.current ? <span className="text-[11px] text-muted-foreground">Current</span> : null}
          </label>
        ))}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        className="mt-1.5 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{expanded ? "Show selected projects only" : "Add or remove projects"}</span>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3.5" aria-hidden="true" />
      </button>
    </fieldset>
  );
}

function ThreadOrchestrationLauncher({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<ThreadOrchestrationState | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("thread_orchestration_get", { threadId });
      setState(result);
    } catch {
      setState(null);
    }
  }, [rpc, threadId]);

  useEffect(() => void load(), [load]);
  useRealtime("thread-orchestration-changed", load);

  if (state === null || !state.eligible) return null;

  return (
    <div className="flex items-center gap-0.5">
      {state.enabled ? (
        <button
          type="button"
          aria-label="Open orchestration run dashboard"
          title="Open run dashboard"
          onClick={() => navigate.openThreadPanel({ actionId: "run-command-center", title: state.label })}
          className="grid size-7 place-items-center rounded-md text-primary outline-none transition-colors hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="Activity" className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={state.enabled ? "Configure orchestration" : "Enable orchestration"}
        title={state.enabled ? "Configure orchestration" : "Enable orchestration"}
        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ORCHESTRATION_EVENT, { detail: { threadId } }))}
        className={`relative grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
          state.enabled ? "bg-primary/12 text-primary hover:bg-primary/20" : "text-muted-foreground hover:bg-accent hover:text-foreground"
        }`}
      >
        <Icon name="Workflow" className="size-4" aria-hidden="true" />
        {state.enabled ? <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary ring-1 ring-background" /> : null}
      </button>
    </div>
  );
}

function OrchestrationForm({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ThreadOrchestrationState | null>(null);
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [showAllProjects, setShowAllProjects] = useState(false);

  const load = useCallback(async () => {
    const result = await rpc.call("thread_orchestration_get", { threadId });
    setState(result);
    setLabel(result.label);
    setSelected(result.allowedProjectIds);
  }, [rpc, threadId]);

  useEffect(() => { void load().catch((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : "Could not load orchestration.");
  }); }, [load]);
  useRealtime("thread-orchestration-changed", load);
  const selectedProjects = useMemo(() => new Set(selected), [selected]);

  if (state === null) {
    return <p className="text-sm text-muted-foreground">Loading orchestration…</p>;
  }
  if (!state.eligible) {
    return <p className="text-sm text-muted-foreground">This thread cannot manage workers.</p>;
  }

  const toggleProject = (projectId: string) => {
    setSelected((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId]);
    setConfirmation(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await rpc.call("enable", { threadId, label: label.trim(), projectIds: selected });
      setConfirmation("Ready — your next prompt can dispatch workers.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable orchestration.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await rpc.call("thread_orchestration_disable", { threadId });
      setConfirmation("Orchestration is off for this thread.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disable orchestration.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-lg">
      <div className="mb-5 flex items-start gap-3">
        <span className={`mt-1 size-2 rounded-full ${state.enabled ? "bg-primary" : "bg-muted-foreground/35"}`} />
        <div>
          <p className="text-sm font-medium text-foreground">
            {state.enabled ? "Orchestration is enabled" : "Orchestrate this thread"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Create visible, managed workers in the selected projects.
          </p>
        </div>
      </div>

      <label className="block text-xs font-medium text-foreground" htmlFor={`orchestrator-label-${threadId}`}>
        Worker group label
      </label>
      <input
        id={`orchestrator-label-${threadId}`}
        value={label}
        maxLength={200}
        onChange={(event) => { setLabel(event.target.value); setConfirmation(null); }}
        className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <ProjectPicker
        projects={state.projects}
        selectedProjects={selectedProjects}
        expanded={showAllProjects}
        onExpandedChange={setShowAllProjects}
        onToggle={toggleProject}
      />

      {error === null ? null : <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      {confirmation === null ? null : <p role="status" className="mt-3 text-xs text-primary">{confirmation}</p>}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        {state.enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void disable()}
            className="rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Disable
          </button>
        ) : <span />}
        <button
          type="button"
          disabled={busy || label.trim().length === 0 || selected.length === 0}
          onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? "Saving…" : state.enabled ? "Save projects" : "Enable orchestration"}
        </button>
      </div>
    </div>
  );
}

function OrchestrationOverlay() {
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        typeof detail === "object" && detail !== null &&
        "threadId" in detail && typeof detail.threadId === "string"
      ) {
        setThreadId(detail.threadId);
      }
    };
    window.addEventListener(OPEN_ORCHESTRATION_EVENT, open);
    return () => window.removeEventListener(OPEN_ORCHESTRATION_EVENT, open);
  }, []);

  return (
    <Dialog.Root open={threadId !== null} onOpenChange={(open) => {
      if (!open) setThreadId(null);
    }}>
      {threadId === null ? null : (
        <>
          <Dialog.Overlay className="fixed inset-0 z-[2147483646] bg-background/70 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[2147483647] max-h-[min(42rem,calc(100dvh-2rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-base font-semibold text-foreground">
                  Orchestrate this thread
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Choose where this thread may create managed workers.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close orchestration settings"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="X" className="size-4" aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <OrchestrationForm threadId={threadId} />
          </Dialog.Content>
        </>
      )}
    </Dialog.Root>
  );
}

const STATE_STYLE: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  reviewing: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  queued: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  suspended: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  awaiting_approval: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  blocked: "bg-destructive/15 text-destructive",
};
const formatCount = (value: number) => new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
const formatDuration = (start: number | null, end: number | null) => {
  if (start === null) return "Not started";
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const dashboardResult = (value: unknown): DashboardResult | null => typeof value === "object" && value !== null ? value as DashboardResult : null;

type ResultItem = { key: string; text: string };
type ResultBlock =
  | { key: string; kind: "heading"; text: string }
  | { key: string; kind: "paragraph"; text: string }
  | { key: string; kind: "bullets"; items: ResultItem[] }
  | { key: string; kind: "numbers"; items: ResultItem[] }
  | { key: string; kind: "checks"; items: Array<ResultItem & { checked: boolean }> }
  | { key: string; kind: "code"; text: string };

function parseResultBlocks(text: string): ResultBlock[] {
  const blocks: ResultBlock[] = [];
  const lines = text.trim().split(/\r?\n/);
  let paragraph: string[] = [];
  let paragraphStart = 0;
  let code: string[] | null = null;
  let codeStart = 0;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ key: `paragraph:${paragraphStart}`, kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd();
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      if (code === null) { code = []; codeStart = lineIndex; }
      else { blocks.push({ key: `code:${codeStart}`, kind: "code", text: code.join("\n") }); code = null; }
      continue;
    }
    if (code !== null) { code.push(rawLine); continue; }
    if (line.trim() === "") { flushParagraph(); continue; }
    const heading = line.match(/^#{1,4}\s+(.+)/);
    if (heading?.[1] !== undefined) { flushParagraph(); blocks.push({ key: `heading:${lineIndex}`, kind: "heading", text: heading[1] }); continue; }
    const check = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
    if (check?.[2] !== undefined) {
      flushParagraph();
      const previous = blocks.at(-1);
      const item = { key: `check:${lineIndex}`, checked: check[1]?.toLowerCase() === "x", text: check[2] };
      if (previous?.kind === "checks") previous.items.push(item); else blocks.push({ key: item.key, kind: "checks", items: [item] });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet?.[1] !== undefined) {
      flushParagraph();
      const previous = blocks.at(-1);
      const item = { key: `bullet:${lineIndex}`, text: bullet[1] };
      if (previous?.kind === "bullets") previous.items.push(item); else blocks.push({ key: item.key, kind: "bullets", items: [item] });
      continue;
    }
    const number = line.match(/^\d+[.)]\s+(.+)/);
    if (number?.[1] !== undefined) {
      flushParagraph();
      const previous = blocks.at(-1);
      const item = { key: `number:${lineIndex}`, text: number[1] };
      if (previous?.kind === "numbers") previous.items.push(item); else blocks.push({ key: item.key, kind: "numbers", items: [item] });
      continue;
    }
    if (paragraph.length === 0) paragraphStart = lineIndex;
    paragraph.push(line.trim());
  }
  flushParagraph();
  if (code !== null && code.length > 0) blocks.push({ key: `code:${codeStart}`, kind: "code", text: code.join("\n") });
  return blocks;
}

function InlineResultText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  let offset = 0;
  return <>{parts.map((part) => { const key = `${offset}:${part}`; offset += part.length; return part.startsWith("`") && part.endsWith("`") ? <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.92em] text-foreground">{part.slice(1, -1)}</code> : part.startsWith("**") && part.endsWith("**") ? <strong key={key} className="font-semibold text-foreground">{part.slice(2, -2)}</strong> : <span key={key}>{part}</span>; })}</>;
}

function FormattedResult({ text }: { text: string }) {
  const blocks = parseResultBlocks(text);
  const renderItems = (items: ResultItem[]) => items.map((item) => <li key={item.key}><InlineResultText text={item.text} /></li>);
  return (
    <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      {blocks.map((block): ReactNode => {
        if (block.kind === "heading") return <h5 key={block.key} className="pt-1 text-xs font-semibold text-foreground">{block.text}</h5>;
        if (block.kind === "paragraph") return <p key={block.key}><InlineResultText text={block.text} /></p>;
        if (block.kind === "bullets") return <ul key={block.key} className="space-y-1 pl-4 marker:text-muted-foreground/70" style={{ listStyleType: "disc" }}>{renderItems(block.items)}</ul>;
        if (block.kind === "numbers") return <ol key={block.key} className="space-y-1 pl-4 marker:font-medium marker:text-foreground" style={{ listStyleType: "decimal" }}>{renderItems(block.items)}</ol>;
        if (block.kind === "checks") return <ul key={block.key} className="space-y-1">{block.items.map((item) => <li key={item.key} className="flex gap-2"><span className={item.checked ? "text-emerald-600" : "text-muted-foreground"}>{item.checked ? "✓" : "○"}</span><span><InlineResultText text={item.text} /></span></li>)}</ul>;
        return <pre key={block.key} className="max-h-56 overflow-auto rounded-md bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-foreground"><code>{block.text}</code></pre>;
      })}
    </div>
  );
}

type ResultDigest = { outcome: string; changes: string[]; assumptions: string[]; validation: string[] };

function splitDigestItems(text: string) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z`])|;\s+(?=[A-Z`])/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function digestResultSummary(text: string): ResultDigest {
  const markers = [...text.matchAll(/\b(assumptions(?:\/deviations)?(?: from the artifact)?|caveats?|validation|tests?):\s*/gi)];
  const mainEnd = markers[0]?.index ?? text.length;
  const mainItems = splitDigestItems(text.slice(0, mainEnd).trim());
  const digest: ResultDigest = { outcome: mainItems[0] ?? text.trim(), changes: mainItems.slice(1), assumptions: [], validation: [] };
  for (const [index, marker] of markers.entries()) {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? text.length;
    const items = splitDigestItems(text.slice(start, end).trim());
    if (marker[1]?.toLowerCase().startsWith("assumption") || marker[1]?.toLowerCase().startsWith("caveat")) digest.assumptions.push(...items);
    else digest.validation.push(...items);
  }
  return digest;
}

function ResultChecks({ checks }: { checks: NonNullable<DashboardResult["validation"]> }) {
  if (checks.length === 0) return null;
  return <section><h5 className="text-[11px] font-semibold text-foreground">Checks</h5><ul className="mt-1.5 space-y-1.5">{checks.map((check) => <li key={`${check.command}:${check.summary}`} className="flex items-start gap-2 text-xs"><span className={check.status === "passed" ? "text-emerald-600" : check.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{check.status === "passed" ? "✓" : check.status === "failed" ? "×" : "○"}</span><span className="min-w-0"><code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">{check.command}</code>{check.summary === "" ? null : <span className="ml-1.5 text-muted-foreground">{check.summary}</span>}</span></li>)}</ul></section>;
}

function ResultPanel({ result }: { result: DashboardResult }) {
  const summary = result.summary ?? "";
  const hasAuthoredStructure = /(^|\n)\s*(#{1,4}\s|[-*]\s|\d+[.)]\s)/m.test(summary);
  const digest = digestResultSummary(summary);
  const structuredChecks = result.validation ?? [];
  const inferredChecks = structuredChecks.length === 0 ? digest.validation.map((text) => ({ command: text.match(/`([^`]+)`/)?.[1] ?? "Validation", status: "passed" as const, summary: text.replace(/`[^`]+`\s*(?:→|:)?\s*/, "") })) : [];
  if (summary.length < 280 || hasAuthoredStructure) {
    return <div className="space-y-3"><FormattedResult text={summary} /><ResultChecks checks={structuredChecks} />{result.changedFiles?.length ? <ChangedFiles files={result.changedFiles} /> : null}</div>;
  }
  const visibleChanges = digest.changes.slice(0, 5);
  const hiddenChanges = digest.changes.slice(5);
  return (
    <div className="space-y-3">
      <p className="border-l-2 border-emerald-500 pl-2.5 text-xs font-medium leading-relaxed text-foreground"><InlineResultText text={digest.outcome} /></p>
      {visibleChanges.length === 0 ? null : <section><h5 className="text-[11px] font-semibold text-foreground">What changed</h5><ul className="mt-1.5 space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground marker:text-muted-foreground/70" style={{ listStyleType: "disc" }}>{visibleChanges.map((item) => <li key={item}><InlineResultText text={item} /></li>)}</ul>{hiddenChanges.length === 0 ? null : <details className="mt-1.5"><summary className="cursor-pointer list-none text-[11px] font-medium text-primary">Show {hiddenChanges.length} more detail{hiddenChanges.length === 1 ? "" : "s"}</summary><ul className="mt-1.5 space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground" style={{ listStyleType: "disc" }}>{hiddenChanges.map((item) => <li key={item}><InlineResultText text={item} /></li>)}</ul></details>}</section>}
      {digest.assumptions.length === 0 ? null : <section className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2"><h5 className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">Assumptions and deviations</h5><ul className="mt-1 space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground" style={{ listStyleType: "disc" }}>{digest.assumptions.map((item) => <li key={item}><InlineResultText text={item} /></li>)}</ul></section>}
      <ResultChecks checks={[...structuredChecks, ...inferredChecks]} />
      {result.changedFiles?.length ? <ChangedFiles files={result.changedFiles} /> : null}
    </div>
  );
}

function ChangedFiles({ files }: { files: string[] }) {
  return <details><summary className="cursor-pointer list-none text-[11px] font-medium text-primary">{files.length} changed file{files.length === 1 ? "" : "s"}</summary><ul className="mt-1.5 max-h-36 space-y-1 overflow-y-auto rounded-md bg-muted/25 p-2 text-[11px] text-muted-foreground">{files.map((file) => <li key={file} className="truncate font-mono" title={file}>{file}</li>)}</ul></details>;
}

function TokenSparkline({ samples }: { samples: Array<{ at: number; tokens: number }> }) {
  if (samples.length < 2) return <span className="text-[11px] text-muted-foreground">Collecting trajectory…</span>;
  const values = samples.map((sample) => sample.tokens);
  const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(1, max - min);
  const points = samples.map((sample, index) => `${(index / (samples.length - 1)) * 116 + 2},${26 - ((sample.tokens - min) / spread) * 22}`).join(" ");
  return <svg viewBox="0 0 120 30" className="h-7 w-28" role="img" aria-label={`Token usage rose from ${min} to ${max}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="text-primary" /></svg>;
}

function EvidenceOutput({ output }: { output: string | null }) {
  if (output === null) return null;
  return <div><p className="font-medium text-foreground">Final worker output</p><div className="mt-1 max-h-64 overflow-y-auto pr-1"><FormattedResult text={output} /></div></div>;
}

function EvidenceConversation({ items }: { items: DashboardEvidence["conversation"] }) {
  if (items.length === 0) return null;
  return <div><p className="font-medium text-foreground">Recent turn outline</p><div className="mt-1 space-y-1">{items.map((item) => <p key={item.id} className="line-clamp-2 text-muted-foreground"><span className="font-medium capitalize text-foreground">{item.role}:</span> {item.preview}</p>)}</div></div>;
}

function EvidenceContext({ context }: { context: DashboardEvidence["context"] }) {
  if (context === null) return null;
  return <div><p className="font-medium text-foreground">Context snapshot</p><p className="mt-1 text-muted-foreground">{formatCount(context.usedTokens)} / {formatCount(context.modelContextWindow)} tokens ({Math.round(context.usedTokens / Math.max(1, context.modelContextWindow) * 100)}%){context.estimated ? " · estimated" : ""}</p></div>;
}

function EvidenceStorage({ storage }: { storage: DashboardEvidence["storage"] }) {
  if (storage === null || storage.files.length === 0) return null;
  return <div><p className="font-medium text-foreground">Thread storage files</p><ul className="mt-1 space-y-1 text-muted-foreground">{storage.files.map((file) => <li key={file.path} className="truncate" title={file.path}>{file.name}</li>)}</ul>{storage.truncated ? <p className="mt-1 text-muted-foreground">Additional files were omitted.</p> : null}</div>;
}

function EvidenceDiff({ diff }: { diff: DashboardEvidence["environmentDiff"] }) {
  if (diff === null) return null;
  return <div><p className="font-medium text-foreground">Shared project environment</p><p className="mt-1 text-muted-foreground">{diff.shortstat ?? diff.message ?? diff.outcome}{diff.mergeBaseRef === null ? "" : ` · base ${diff.mergeBaseRef}`}</p>{diff.files.length === 0 ? null : <div className="mt-2 max-h-40 overflow-y-auto rounded border border-border bg-background"><table className="w-full text-left"><tbody>{diff.files.map((file) => <tr key={`${file.path}-${file.changeKind}`} className="border-b border-border last:border-0"><td className="max-w-0 truncate px-2 py-1.5" title={file.path}>{file.path}</td><td className="whitespace-nowrap px-2 py-1.5 text-emerald-600">+{file.additions}</td><td className="whitespace-nowrap px-2 py-1.5 text-destructive">−{file.deletions}</td></tr>)}</tbody></table></div>}</div>;
}

function EvidenceWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return <div><p className="font-medium text-amber-700 dark:text-amber-300">Partial evidence</p><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>;
}

function EvidenceBundle({ evidence }: { evidence: DashboardEvidence }) {
  return (
    <details className="group mt-3 rounded-md border border-border bg-muted/15">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-foreground">
        <span>Completion evidence · {new Date(evidence.capturedAt).toLocaleString()}</span>
        <Icon name="ChevronDown" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3 text-xs">
        <EvidenceOutput output={evidence.output} />
        <EvidenceConversation items={evidence.conversation} />
        <EvidenceContext context={evidence.context} />
        <EvidenceStorage storage={evidence.storage} />
        <EvidenceDiff diff={evidence.environmentDiff} />
        <EvidenceWarnings warnings={evidence.warnings} />
      </div>
    </details>
  );
}

type RunControl = (action: "suspend" | "resume", workstreamKey: string | null) => Promise<void>;
const ATTENTION_STATES = new Set(["failed", "blocked", "awaiting_approval"]);
const ACTIVE_STATES = new Set(["running", "reviewing"]);

function WorkstreamDetail({ item, result, evidence }: { item: DashboardWorkstream; result: DashboardResult | null; evidence: DashboardEvidence | null }) {
  const context = item.live?.context ?? evidence?.context ?? null;
  const contextPercent = context === null ? null : Math.min(100, Math.round(context.usedTokens / Math.max(1, context.modelContextWindow) * 100));
  const blockers = [...(result?.blockers ?? []), ...(item.error === null ? [] : [item.error])];
  return (
    <div className="border-t border-border px-3 pb-3 pt-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>{item.projectId}</span><span>{item.profile}</span><span>{item.providerId}/{item.model}</span><span>attempt {item.attemptCount}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 divide-x divide-border rounded-md bg-muted/25 py-2 text-center">
        <div><p className="text-xs font-semibold text-foreground">{formatDuration(item.startedAt, item.completedAt)}</p><p className="text-[10px] text-muted-foreground">Runtime</p></div>
        <div><p className="text-xs font-semibold text-foreground">{formatCount(item.totalTokens)}</p><p className="text-[10px] text-muted-foreground">Tokens</p></div>
        <div><p className="text-xs font-semibold text-foreground">{contextPercent === null ? "—" : `${contextPercent}%`}</p><p className="text-[10px] text-muted-foreground">Context</p></div>
      </div>
      {item.live === null ? null : <div className="mt-3 flex items-center justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{item.nextAction ?? "Worker is active"}</p>{item.live.queuedMessageCount > 0 ? <p className="text-[11px] text-muted-foreground">{item.live.queuedMessageCount} queued message{item.live.queuedMessageCount === 1 ? "" : "s"}</p> : null}</div><TokenSparkline samples={item.live.tokenHistory} /></div>}
      {item.live?.pendingTodos.length ? <div className="mt-3"><p className="text-[11px] font-medium text-foreground">Current checklist</p><ul className="mt-1 space-y-1">{item.live.pendingTodos.slice(0, 4).map((todo) => <li key={todo.id} className="flex gap-2 text-xs text-muted-foreground"><span className={todo.status === "completed" ? "text-emerald-600" : todo.status === "in_progress" ? "text-primary" : "text-muted-foreground"}>{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"}</span><span>{todo.text}</span></li>)}</ul></div> : null}
      {item.live?.outputPreview === null || item.live?.outputPreview === undefined ? null : <details className="group mt-3"><summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground">Show live output</summary><div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-muted/20 p-2.5"><FormattedResult text={item.live.outputPreview} /></div></details>}
      {item.conditions.length === 0 ? null : <ul className="mt-3 space-y-1">{item.conditions.map((condition) => <li key={condition.type} className="flex items-start gap-2 text-[11px]"><span className={condition.status ? "text-emerald-600" : "text-muted-foreground"} aria-hidden="true">{condition.status ? "✓" : "○"}</span><span className="text-muted-foreground"><span className="font-medium text-foreground">{condition.type}</span> · {condition.reason}{condition.message === null ? "" : ` — ${condition.message}`}</span></li>)}</ul>}
      {result?.summary === undefined ? null : <div className="mt-3"><p className="mb-1.5 text-[11px] font-semibold text-foreground">Result</p><ResultPanel result={result} /></div>}
      {blockers.length === 0 ? null : <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">{blockers.join(" · ")}</div>}
      {evidence === null ? null : <EvidenceBundle evidence={evidence} />}
    </div>
  );
}

function WorkstreamRow({ item, onControl }: { item: DashboardWorkstream; onControl: RunControl }) {
  const navigate = useBbNavigate();
  const result = dashboardResult(item.result);
  const evidence = item.evidence ?? result?.evidence ?? null;
  const blockers = [...(result?.blockers ?? []), ...(item.error === null ? [] : [item.error])];
  const headline = blockers[0] ?? item.nextAction ?? result?.summary ?? item.live?.outputPreview ?? null;
  return (
    <details className="group border-b border-border last:border-0">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className={`size-2 shrink-0 rounded-full ${item.state === "completed" ? "bg-emerald-500" : ATTENTION_STATES.has(item.state) ? "bg-destructive" : ACTIVE_STATES.has(item.state) ? "bg-blue-500" : "bg-muted-foreground/50"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h4 className="truncate text-xs font-semibold text-foreground">{item.title ?? item.key}</h4><span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${STATE_STYLE[item.state] ?? "bg-muted text-muted-foreground"}`}>{item.state.replaceAll("_", " ")}</span></div>
          {headline === null ? null : <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{headline}</p>}
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatCount(item.totalTokens)}</span>
        <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <WorkstreamDetail item={item} result={result} evidence={evidence} />
      <div className="mx-3 mb-3 flex items-center gap-4">
        {item.threadId === null ? null : <button type="button" onClick={() => navigate.toThread(item.threadId!)} className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"><Icon name="ArrowUpRight" className="size-3.5" aria-hidden="true" />Open worker thread</button>}
        {item.state === "suspended" ? <button type="button" onClick={() => void onControl("resume", item.key)} className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"><Icon name="Play" className="size-3.5" aria-hidden="true" />Resume</button>
          : ["queued", "running"].includes(item.state) ? <button type="button" onClick={() => void onControl("suspend", item.key)} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"><Icon name="Pause" className="size-3.5" aria-hidden="true" />Suspend</button>
          : null}
      </div>
    </details>
  );
}

function WorkstreamGroup({ title, items, onControl, tone = "default" }: { title: string; items: DashboardWorkstream[]; onControl: RunControl; tone?: "default" | "attention" }) {
  if (items.length === 0) return null;
  return <section><div className="mb-1.5 flex items-center gap-2"><h3 className={`text-xs font-semibold ${tone === "attention" ? "text-destructive" : "text-foreground"}`}>{title}</h3><span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{items.length}</span></div><div className={`overflow-hidden rounded-md border bg-card ${tone === "attention" ? "border-destructive/35" : "border-border"}`}>{items.map((item) => <WorkstreamRow key={item.key} item={item} onControl={onControl} />)}</div></section>;
}

function RunCommandCenter({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    try { setData(await rpc.call("run_dashboard_get", { threadId }) as DashboardData); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load this run."); }
    finally { setRefreshing(false); }
  }, [rpc, threadId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useRealtime("run-changed", load);
  const control = useCallback<RunControl>(async (action, workstreamKey) => {
    try { await rpc.call("run_control", { threadId, action, workstreamKey }); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${action} this run.`); }
    finally { await load(); }
  }, [rpc, threadId, load]);

  if (data === null && error === null) return <div className="p-4 text-sm text-muted-foreground">Loading live run…</div>;
  if (error !== null && data === null) return <div role="alert" className="p-4 text-sm text-destructive">{error}</div>;
  if (data === null || !data.available || data.run === null) return <div className="p-4 text-sm text-muted-foreground">This thread is not part of a managed Orchestrator run.</div>;
  const attention = data.workstreams.filter((item) => ATTENTION_STATES.has(item.state));
  const active = data.workstreams.filter((item) => ACTIVE_STATES.has(item.state));
  const waiting = data.workstreams.filter((item) => !ATTENTION_STATES.has(item.state) && !ACTIVE_STATES.has(item.state) && item.state !== "completed");
  const completed = data.workstreams.filter((item) => item.state === "completed");
  const budgetPercent = data.run.tokenBudget === 0 ? null : Math.min(100, Math.round(data.run.totalTokens / data.run.tokenBudget * 100));
  const pulse = attention.length > 0
    ? `${attention.length} need${attention.length === 1 ? "s" : ""} attention`
    : active.length > 0
      ? `${active.length} moving now`
      : completed.length === data.counts.total && data.counts.total > 0
        ? "All workstreams complete"
        : "Waiting to begin";
  return (
    <div className="space-y-4 pb-6">
      <header className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-start justify-between gap-3 px-3 pb-3 pt-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATE_STYLE[data.run.state] ?? "bg-muted text-muted-foreground"}`}>{data.run.state.replaceAll("_", " ")}</span><span className="truncate text-[10px] text-muted-foreground">{new Date(data.run.updatedAt).toLocaleTimeString()}</span></div><h2 className="mt-1 truncate text-base font-semibold text-foreground">{data.run.label}</h2><p className={`mt-0.5 text-xs font-medium ${attention.length > 0 ? "text-destructive" : "text-muted-foreground"}`}>{pulse}</p></div><div className="flex items-center gap-1">{data.run.state === "suspended"
          ? <button type="button" onClick={() => void control("resume", null)} className="grid size-7 place-items-center rounded-md text-primary hover:bg-accent" aria-label="Resume run"><Icon name="Play" className="size-3.5" aria-hidden="true" /></button>
          : ["running", "configured", "blocked"].includes(data.run.state) ? <button type="button" onClick={() => void control("suspend", null)} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Suspend run"><Icon name="Pause" className="size-3.5" aria-hidden="true" /></button> : null}
          <button type="button" onClick={() => void load()} disabled={refreshing} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" aria-label="Refresh run"><Icon name="RefreshCw" className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" /></button></div></div>
        <div className="grid grid-cols-4 border-t border-border bg-muted/15">{([['Moving', active.length], ['Waiting', waiting.length], ['Done', completed.length], ['Issues', attention.length]] as const).map(([label, value]) => <div key={label} className="border-r border-border px-2 py-2 text-center last:border-r-0"><p className={`text-sm font-semibold ${label === "Issues" && value > 0 ? "text-destructive" : "text-foreground"}`}>{value}</p><p className="text-[10px] text-muted-foreground">{label}</p></div>)}</div>
        <div className="border-t border-border px-3 py-2"><p className="mb-1.5 truncate font-mono text-[10px] text-muted-foreground" title={data.run.featureBranch}>{data.run.featureBranch}</p><div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>{formatCount(data.run.totalTokens)} tokens</span><span>{budgetPercent === null ? "No budget" : `${budgetPercent}% of ${formatCount(data.run.tokenBudget)}`}</span></div>{budgetPercent === null ? null : <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${budgetPercent >= 90 ? "bg-destructive" : budgetPercent >= 70 ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${budgetPercent}%` }} /></div>}</div>
        {data.run.error === null ? null : <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{data.run.error}</p>}
      </header>
      {data.workstreams.length === 0 ? <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No workstreams have been dispatched.</p> : <div className="space-y-4"><WorkstreamGroup title="Needs attention" items={attention} onControl={control} tone="attention" /><WorkstreamGroup title="In progress" items={active} onControl={control} /><WorkstreamGroup title="Waiting" items={waiting} onControl={control} /><WorkstreamGroup title="Completed" items={completed} onControl={control} /></div>}
      {data.artifacts.length === 0 ? null : <details className="group rounded-md border border-border bg-card"><summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold text-foreground"><span>Artifacts <span className="ml-1 font-normal text-muted-foreground">{data.artifacts.length}</span></span><Icon name="ChevronDown" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" /></summary><div className="divide-y divide-border border-t border-border">{data.artifacts.map((artifact) => <div key={artifact.id} className="px-3 py-2"><p className="truncate text-xs font-medium text-foreground">{artifact.name}{artifact.version === null ? "" : ` · ${artifact.version}`}</p><p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{artifact.workstreamKey} · {artifact.summary}</p></div>)}</div></details>}
    </div>
  );
}

function ComposerOrchestrationAction() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return (
    <ThreadOrchestrationLauncher
      threadId={view.scope.threadId}
      projectId=""
      isCompactViewport={view.layout === "compact"}
    />
  );
}

function NewThreadOrchestrationAction() {
  const view = useComposerView();
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ThreadOrchestrationState["projects"]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(true);
  const [error, setError] = useState<string | null>(null);

  if (view.scope.kind !== "new-thread") return null;
  const currentProjectId = view.scope.projectId;
  const selectedProjects = new Set(selected);

  const showConfiguration = async () => {
    setOpen(true);
    if (projects.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("orchestration_projects", { currentProjectId });
      setProjects(result.projects);
      setSelected(result.selectedProjectIds);
      setLabel(result.label);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load projects.");
    } finally {
      setLoading(false);
    }
  };

  const toggleProject = (projectId: string) => setSelected((current) => current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId]);

  const configure = () => {
    if (view.draft.isEmpty) {
      setError("Add the task to the composer before enabling orchestration.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      composer.insertMention({
        provider: "orchestration",
        id: encodeNewThreadOrchestrationMarker({ label: label.trim(), projectIds: selected }),
        label: `Orchestrate · ${label.trim()}`,
      });
      setConfigured(true);
      setOpen(false);
      composer.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not configure orchestration.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={configured ? "Orchestration configured" : "Start with orchestration"}
          title={configured ? "Orchestration configured" : "Start with orchestration"}
          onClick={() => void showConfiguration()}
          className={`relative grid size-9 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${configured ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
        >
          <Icon name="Workflow" className="size-4" aria-hidden="true" />
          {configured ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary ring-1 ring-background" /> : null}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[2147483646] bg-background/70 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[2147483647] max-h-[min(42rem,calc(100dvh-2rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-foreground">Start with orchestration</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">The new thread starts as a coordinator and can create managed workers in the selected projects.</Dialog.Description>
            </div>
            <Dialog.Close asChild><button type="button" aria-label="Close orchestration settings" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Icon name="X" className="size-4" aria-hidden="true" /></button></Dialog.Close>
          </div>
          {loading ? <p className="mt-5 text-sm text-muted-foreground">Loading projects…</p> : configured ? (
            <div className="mt-5 rounded-md border border-primary/25 bg-primary/5 px-3 py-3 text-sm text-foreground">Orchestration is attached to this draft. Send it normally to create the coordinator.</div>
          ) : (
            <>
              <label className="mt-5 block text-xs font-medium text-foreground" htmlFor="new-thread-orchestrator-label">Worker group label</label>
              <input id="new-thread-orchestrator-label" value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <ProjectPicker projects={projects} selectedProjects={selectedProjects} expanded={showAllProjects} onExpandedChange={setShowAllProjects} onToggle={toggleProject} />
              {error === null ? null : <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
              <div className="mt-5 flex justify-end border-t border-border pt-4">
                <button type="button" disabled={busy || label.trim().length === 0 || selected.length === 0} onClick={configure} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45">{busy ? "Configuring…" : "Use orchestration"}</button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const NUMBER_POLICY_FIELDS: Array<{ key: keyof Pick<OrchestrationPolicy, "maxParallelWorkers" | "maxWorkersPerRun" | "maxAttemptsPerWorkstream" | "maxDelegationDepth" | "maxChildrenPerWorker" | "workerTimeoutMinutes" | "runTimeoutMinutes" | "inactiveCleanupMinutes" | "tokenBudget">; label: string; description: string; min: number; max: number }> = [
  { key: "maxParallelWorkers", label: "Parallel workers", description: "Extra workstreams wait in a durable queue.", min: 1, max: 20 },
  { key: "maxWorkersPerRun", label: "Workstreams per run", description: "Reject plans larger than this limit.", min: 1, max: 50 },
  { key: "maxAttemptsPerWorkstream", label: "Attempts per workstream", description: "Includes the first attempt and automatic retries.", min: 1, max: 5 },
  { key: "maxDelegationDepth", label: "Delegation depth", description: "Maximum managed descendant levels; 0 disables delegation.", min: 0, max: 5 },
  { key: "maxChildrenPerWorker", label: "Children per worker", description: "Maximum direct read-only children per worker.", min: 1, max: 20 },
  { key: "workerTimeoutMinutes", label: "Worker timeout", description: "Minutes before a running worker is considered stale.", min: 5, max: 1440 },
  { key: "runTimeoutMinutes", label: "Run timeout", description: "Maximum wall-clock lifetime in minutes.", min: 10, max: 10080 },
  { key: "inactiveCleanupMinutes", label: "Inactive cleanup", description: "Minutes without run activity before cleanup.", min: 10, max: 43200 },
  { key: "tokenBudget", label: "Token budget", description: "Stop the run when observed usage exceeds this; 0 disables it.", min: 0, max: 100000000 },
];

function PolicySettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<OrchestrationPolicy | null>(null);
  const [saved, setSaved] = useState<OrchestrationPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const value = await rpc.call("policy_get", null);
    setDraft(value); setSaved(value);
  }, [rpc]);
  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load policy.")); }, [load]);
  useRealtime("policy-changed", load);
  if (draft === null) return <p className="text-sm text-muted-foreground">Loading orchestration policy…</p>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    setBusy(true); setError(null);
    try { const value = await rpc.call("policy_set", draft); setDraft(value); setSaved(value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save policy."); }
    finally { setBusy(false); }
  };
  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-3">
        <p className="text-sm font-medium text-foreground">{draft.maxParallelWorkers} parallel · {draft.maxAttemptsPerWorkstream} attempts · {draft.approval.replace("-", " ")} approval</p>
        <button type="button" disabled={busy || !dirty} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-45">{busy ? "Saving…" : "Save policy"}</button>
      </div>
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {NUMBER_POLICY_FIELDS.map((field) => (
          <label key={field.key} className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
            <span><span className="block text-sm font-medium text-foreground">{field.label}</span><span className="block text-xs leading-relaxed text-muted-foreground">{field.description}</span></span>
            <input type="number" min={field.min} max={field.max} value={draft[field.key]} onChange={(event) => { const parsed = event.target.valueAsNumber; if (Number.isFinite(parsed)) setDraft({ ...draft, [field.key]: Math.min(field.max, Math.max(field.min, parsed)) }); }} className="h-9 rounded-md border border-input bg-background px-3 text-sm" />
          </label>
        ))}
      </div>
      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <label><span className="block text-sm font-medium text-foreground">Planning mode</span><span className="mb-1.5 block text-xs text-muted-foreground">Auto keeps small requests fast and requires durable plans for larger work.</span><select value={draft.planningMode} onChange={(event) => setDraft({ ...draft, planningMode: event.target.value as OrchestrationPolicy["planningMode"] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="off">Off</option><option value="auto">Auto</option><option value="always">Always plan</option></select></label>
        <label><span className="block text-sm font-medium text-foreground">Dispatch approval</span><span className="mb-1.5 block text-xs text-muted-foreground">Pause before workers are created.</span><select value={draft.approval} onChange={(event) => setDraft({ ...draft, approval: event.target.value as OrchestrationPolicy["approval"] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="never">Never</option><option value="first-dispatch">First dispatch</option><option value="critical">Critical work only</option><option value="every-dispatch">Every dispatch</option></select></label>
        <label><span className="block text-sm font-medium text-foreground">Evaluator gate</span><span className="mb-1.5 block text-xs text-muted-foreground">Require coordinator review before completion.</span><select value={draft.evaluator} onChange={(event) => setDraft({ ...draft, evaluator: event.target.value as OrchestrationPolicy["evaluator"] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="never">Never</option><option value="critical">Critical work only</option><option value="always">Every successful result</option></select></label>
        <label><span className="block text-sm font-medium text-foreground">Commit mode</span><span className="mb-1.5 block text-xs text-muted-foreground">Existing branches always need explicit user approval.</span><select value={draft.commitMode} onChange={(event) => setDraft({ ...draft, commitMode: event.target.value as OrchestrationPolicy["commitMode"] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="disabled">Disabled</option><option value="owned-only">Orchestrator-owned only</option><option value="owned-or-approved-existing">Owned or approved existing</option></select></label>
        <label><span className="block text-sm font-medium text-foreground">Push mode</span><span className="mb-1.5 block text-xs text-muted-foreground">Every permitted push still needs explicit user approval.</span><select value={draft.pushMode} onChange={(event) => setDraft({ ...draft, pushMode: event.target.value as OrchestrationPolicy["pushMode"] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="disabled">Disabled</option><option value="explicit-approval">Explicit approval</option></select></label>
        <label className="sm:col-span-2"><span className="block text-sm font-medium text-foreground">Protected branches</span><span className="mb-1.5 block text-xs text-muted-foreground">Comma-separated branch names that workers may never commit to or push.</span><input value={draft.protectedBranches.join(", ")} onChange={(event) => setDraft({ ...draft, protectedBranches: [...new Set(event.target.value.split(",").map((value) => value.trim()).filter(Boolean))] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" /></label>
      </div>
    </div>
  );
}

function RoutingSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<
    Extract<Catalog, { providers: unknown }> extends { providers: infer T } ? T : never
  >([] as never);
  const [storedRoutes, setStoredRoutes] = useState<Record<string, Routes>>({});
  const [drafts, setDrafts] = useState<Record<string, Routes>>({});
  const initialRoutingPolicy: RoutingPolicy = { strategy: "coordinator", profileRoutes: { quick: null, standard: null, complex: null, critical: null } };
  const [routePolicy, setRoutePolicy] = useState<RoutingPolicy>(initialRoutingPolicy);
  const [savedRoutePolicy, setSavedRoutePolicy] = useState<RoutingPolicy>(initialRoutingPolicy);
  const [metrics, setMetrics] = useState<Array<{ providerId: string; model: string; profile: Profile; samples: number; successes: number; failures: number; averageDurationMs: number; averageTokens: number }>>([]);
  const [recommendations, setRecommendations] = useState<Array<{ profile: Profile; providerId: string; model: string; samples: number; successRate: number; reason: string }>>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [catalog, routing] = await Promise.all([
        rpc.call("routing_catalog", null),
        rpc.call("routing_get", null),
      ]);
      setProviders(catalog.providers as never);
      setStoredRoutes(routing.routes);
      setRoutePolicy(routing.policy);
      setSavedRoutePolicy(routing.policy);
      setMetrics(routing.metrics);
      setRecommendations(routing.recommendations);
      setDrafts((current) => {
        const next = { ...current };
        for (const provider of catalog.providers) {
          const savedRoutes = routing.routes[provider.id];
          if (next[provider.id] === undefined && savedRoutes !== undefined) {
            next[provider.id] = savedRoutes;
          } else if (next[provider.id] === undefined && provider.recommendedRoutes !== null) {
            next[provider.id] = Object.fromEntries(PROFILES.map((profile) => [profile, { modelId: provider.recommendedRoutes![profile], reasoningLevel: "model-default" }])) as Routes;
          }
        }
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load provider routing.");
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => void load(), [load]);
  useRealtime("routing-changed", load);

  const dirty = useMemo(() => {
    const result = new Set<string>();
    for (const [providerId, routes] of Object.entries(drafts)) {
      if (JSON.stringify(routes) !== JSON.stringify(storedRoutes[providerId])) {
        result.add(providerId);
      }
    }
    return result;
  }, [drafts, storedRoutes]);

  const save = async (providerId: string) => {
    const routes = drafts[providerId];
    if (routes === undefined) return;
    setSaving(providerId);
    setSaved(null);
    setError(null);
    try {
      const result = await rpc.call("routing_set_provider", { providerId, routes });
      setStoredRoutes(result.routes);
      setSaved(providerId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save routing.");
    } finally {
      setSaving(null);
    }
  };

  const saveRoutePolicy = async () => {
    setSaving("cross-provider"); setSaved(null); setError(null);
    try { const result = await rpc.call("routing_policy_set", routePolicy); setRoutePolicy(result); setSavedRoutePolicy(result); setSaved("cross-provider"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save cross-provider routing."); }
    finally { setSaving(null); }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading provider models…</p>;
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="max-w-2xl space-y-1">
        <p className="text-sm text-foreground">
          Choose the model each provider uses as work becomes more demanding.
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Quick is the default assignment. Exact reasoning levels must be supported by
          the selected model; choose model-default to use the model’s declared default.
        </p>
      </div>

      {error === null ? null : (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Provider strategy</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Use the coordinator’s provider, or route each workload profile across any active provider.</p>
          </div>
          <button type="button" disabled={saving === "cross-provider" || JSON.stringify(routePolicy) === JSON.stringify(savedRoutePolicy)} onClick={() => void saveRoutePolicy()} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-45">{saving === "cross-provider" ? "Saving…" : saved === "cross-provider" ? "Saved" : "Save strategy"}</button>
        </div>
        <select aria-label="Worker provider strategy" value={routePolicy.strategy} onChange={(event) => {
          const strategy = event.target.value as RoutingPolicy["strategy"];
          const fallback = providers[0];
          setRoutePolicy({
            strategy,
            profileRoutes: strategy === "profile" && fallback !== undefined
              ? Object.fromEntries(PROFILES.map((profile) => [profile, routePolicy.profileRoutes[profile] ?? { providerId: fallback.id, modelId: fallback.recommendedRoutes?.[profile] ?? fallback.models[0]?.id ?? "", reasoningLevel: "model-default" }])) as Record<Profile, RouteTarget>
              : routePolicy.profileRoutes,
          });
        }} className="mt-3 h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-64"><option value="coordinator">Stay with coordinator provider</option><option value="profile">Route by workload profile</option></select>
        {routePolicy.strategy === "profile" ? (
          <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            {PROFILES.map((profile) => {
              const target = routePolicy.profileRoutes[profile];
              const provider = providers.find((item) => item.id === target?.providerId) ?? providers[0];
              return (
                <div key={profile} className="grid gap-1.5">
                  <span className="text-sm font-medium text-foreground">{PROFILE_COPY[profile].label}</span>
                  <div className="grid grid-cols-3 gap-2">
                    <select aria-label={`${PROFILE_COPY[profile].label} provider`} value={provider?.id ?? ""} onChange={(event) => { const nextProvider = providers.find((item) => item.id === event.target.value); const nextModel = nextProvider?.recommendedRoutes?.[profile] ?? nextProvider?.models[0]?.id ?? ""; setRoutePolicy({ ...routePolicy, profileRoutes: { ...routePolicy.profileRoutes, [profile]: nextProvider === undefined ? null : { providerId: nextProvider.id, modelId: nextModel, reasoningLevel: "model-default" } } }); }} className="h-9 rounded-md border border-input bg-background px-2 text-sm">{providers.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
                    <select aria-label={`${PROFILE_COPY[profile].label} model`} value={target?.modelId ?? provider?.recommendedRoutes?.[profile] ?? provider?.models[0]?.id ?? ""} onChange={(event) => { if (provider !== undefined) setRoutePolicy({ ...routePolicy, profileRoutes: { ...routePolicy.profileRoutes, [profile]: { providerId: provider.id, modelId: event.target.value, reasoningLevel: "model-default" } } }); }} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm">{provider?.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
                    <select aria-label={`${PROFILE_COPY[profile].label} reasoning`} value={target?.reasoningLevel ?? "model-default"} onChange={(event) => setRoutePolicy({ ...routePolicy, profileRoutes: { ...routePolicy.profileRoutes, [profile]: target === null ? null : { ...target, reasoningLevel: event.target.value as ReasoningChoice } } })} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"><option value="model-default">model-default</option>{provider?.models.find((model) => model.id === target?.modelId)?.supportedReasoningLevels.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>


      {recommendations.length === 0 ? (
        <p className="text-xs text-muted-foreground">Measured recommendations appear after three completed samples for a profile and model. Routes never change automatically.</p>
      ) : (
        <div className="rounded-md border border-border bg-muted/25 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Measured recommendations</p>
          <div className="mt-2 space-y-1.5">
            {recommendations.map((item) => <p key={item.profile} className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{PROFILE_COPY[item.profile].label}:</span> {item.providerId} / {item.model} — {item.reason}</p>)}
          </div>
        </div>
      )}

      {providers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          No agent providers are currently available. Enable a provider in BB, then return here.
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {providers.map((provider) => {
            const routes = drafts[provider.id];
            const canSave = routes !== undefined && provider.models.length > 0;
            return (
              <section key={provider.id} className="px-4 py-4 sm:px-5">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{provider.displayName}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{provider.id}</p>
                  </div>
                  <button
                    type="button"
                    disabled={!canSave || saving === provider.id || !dirty.has(provider.id)}
                    onClick={() => void save(provider.id)}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {saving === provider.id ? "Saving…" : saved === provider.id ? "Saved" : "Save routing"}
                  </button>
                </div>

                {provider.modelLoadError !== null ? (
                  <p className="text-sm text-destructive">
                    Models could not be loaded: {provider.modelLoadError}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {PROFILES.map((profile) => {
                      const route = routes?.[profile];
                      const selectedId = route?.modelId ?? "";
                      const selected = provider.models.find((model) => model.id === selectedId);
                      return (
                        <div key={profile} className="grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4">
                          <label htmlFor={`${provider.id}-${profile}`}>
                            <span className="block text-sm font-medium text-foreground">{PROFILE_COPY[profile].label}</span>
                            <span className="block text-xs text-muted-foreground">{PROFILE_COPY[profile].description}</span>
                          </label>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <select
                              id={`${provider.id}-${profile}`}
                              value={selectedId}
                              onChange={(event) => setDrafts((current) => ({
                                ...current,
                                [provider.id]: {
                                  ...(current[provider.id] ?? Object.fromEntries(PROFILES.map((item) => [item, { modelId: provider.recommendedRoutes?.[item] ?? provider.models[0]?.id ?? "", reasoningLevel: "model-default" }])) as Routes),
                                  [profile]: { modelId: event.target.value, reasoningLevel: "model-default" },
                                },
                              }))}
                              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {provider.models.map((model) => (
                                <option key={model.id} value={model.id}>{model.displayName}</option>
                              ))}
                            </select>
                            <select aria-label={`${provider.displayName} ${PROFILE_COPY[profile].label} reasoning`} value={route?.reasoningLevel ?? "model-default"} onChange={(event) => setDrafts((current) => ({ ...current, [provider.id]: { ...(current[provider.id]!), [profile]: { modelId: selectedId, reasoningLevel: event.target.value as ReasoningChoice } } }))} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <option value="model-default">model-default</option>{selected?.supportedReasoningLevels.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                            </select>
                            {selected === undefined ? null : (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Default reasoning: {selected.defaultReasoningLevel}
                                {(() => { const evidence = metrics.find((item) => item.providerId === provider.id && item.model === selected.model && item.profile === profile); return evidence === undefined ? " · no measured runs yet" : ` · ${evidence.successes}/${evidence.samples} successful · ${Math.round(evidence.averageDurationMs / 1000)}s avg · ${evidence.averageTokens.toLocaleString()} tokens avg`; })()}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

type AnalyticsData = {
  totals: { sessions: number; completed: number; failed: number; totalTokens: number; coordinatorTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  failures: Array<{ reasonCode: string; count: number }>;
  sessions: Array<{ sessionId: string; coordinatorThreadId: string; label: string; featureBranch: string; state: string; totalTokens: number; coordinatorTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; startedAt: number; updatedAt: number; completedAt: number | null; error: string | null }>;
};

function LearningDataSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await rpc.call("analytics_get", null) as AnalyticsData); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load orchestration history."); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  if (error !== null) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (data === null) return <p className="text-sm text-muted-foreground">Loading orchestration history…</p>;
  const completionRate = data.totals.sessions === 0 ? 0 : Math.round(data.totals.completed / data.totals.sessions * 100);
  const categorizedTokens = data.totals.inputTokens + data.totals.cachedInputTokens + data.totals.outputTokens;
  const inputTokens = data.totals.inputTokens + data.totals.cachedInputTokens;
  const cachedPercent = inputTokens === 0 ? 0 : Math.round(data.totals.cachedInputTokens / inputTokens * 1000) / 10;
  const breakdownCoverage = data.totals.totalTokens === 0 ? 0 : Math.min(100, Math.round(categorizedTokens / data.totals.totalTokens * 1000) / 10);
  const coordinatorPercent = data.totals.totalTokens === 0 ? 0 : Math.round(data.totals.coordinatorTokens / data.totals.totalTokens * 1000) / 10;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([['Sessions', data.totals.sessions], ['Completed', `${completionRate}%`], ['Failed', data.totals.failed], ['Tokens', formatCount(data.totals.totalTokens)]] as const).map(([label, value]) => <div key={label} className="rounded-md border border-border bg-card p-3"><p className="text-lg font-semibold text-foreground">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div>)}
      </div>
      <div className="rounded-md border border-border bg-card p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">Token composition</p><p className="mt-0.5 text-xs text-muted-foreground">Provider-reported totals; cached input is cheaper than fresh input but still signals repeated context processing. Breakdown coverage: {breakdownCoverage}%.</p></div><div className="text-right text-sm font-semibold text-foreground"><div>{cachedPercent}% cached</div><div>{coordinatorPercent}% coordinator</div></div></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><span>Fresh input <strong>{formatCount(data.totals.inputTokens)}</strong></span><span>Cached input <strong>{formatCount(data.totals.cachedInputTokens)}</strong></span><span>Output <strong>{formatCount(data.totals.outputTokens)}</strong></span><span>Reasoning <strong>{formatCount(data.totals.reasoningOutputTokens)}</strong></span></div></div>
      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Failure categories</h3>
        {data.failures.length === 0 ? <p className="text-xs text-muted-foreground">No failures recorded.</p> : <div className="overflow-hidden rounded-md border border-border">{data.failures.map((item) => <div key={item.reasonCode} className="flex justify-between border-b border-border px-3 py-2 text-xs last:border-b-0"><span className="text-foreground">{item.reasonCode.replaceAll('_', ' ')}</span><span className="tabular-nums text-muted-foreground">{item.count}</span></div>)}</div>}
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold text-foreground">Recent sessions</h3><button type="button" onClick={() => void load()} className="text-xs font-medium text-primary">Refresh</button></div>
        {data.sessions.length === 0 ? <p className="text-xs text-muted-foreground">No orchestration sessions recorded.</p> : <div className="overflow-hidden rounded-md border border-border">{data.sessions.slice(0, 25).map((session) => <div key={session.sessionId} className="border-b border-border px-3 py-2.5 last:border-b-0"><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-medium text-foreground">{session.label}</p><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATE_STYLE[session.state] ?? 'bg-muted text-muted-foreground'}`}>{session.state.replaceAll('_', ' ')}</span></div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={session.featureBranch}>{session.featureBranch}</p><p className="mt-1 text-[10px] text-muted-foreground">{new Date(session.startedAt).toLocaleString()} · {formatCount(session.totalTokens)} tokens{session.completedAt === null ? '' : ` · ${Math.max(0, Math.round((session.completedAt - session.startedAt) / 1000))}s`}</p>{session.error === null ? null : <p className="mt-1 line-clamp-2 text-xs text-destructive">{session.error}</p>}</div>)}</div>}
      </section>
      <p className="text-xs text-muted-foreground">History stores lifecycle metadata, routing, timing, token counts, validation summaries, changed-file evidence, and bounded failure details. Raw prompts and full conversations are excluded.</p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "dispatch-approval", component: DispatchApproval });
  app.slots.threadPanelAction({
    id: "run-command-center",
    title: "Orchestrator run",
    icon: "Activity",
    component: RunCommandCenter,
  });
  app.slots.experimental_appOverlay({
    id: "orchestration-dialog",
    component: OrchestrationOverlay,
  });
  app.composer.customize({
    id: "thread-orchestration",
    scopes: ["thread", "new-thread"],
    actions: [
      { id: "configure", component: ComposerOrchestrationAction },
      { id: "start-orchestrated", component: NewThreadOrchestrationAction },
    ],
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-orchestration",
    title: "Thread orchestration",
    component: ThreadOrchestrationLauncher,
  });
  app.slots.settingsSection({
    id: "orchestration-policy",
    title: "Orchestration policy",
    description: "Set lifecycle, delegation, commit, push, approval, and evaluator limits.",
    component: PolicySettings,
  });
  app.slots.settingsSection({
    id: "model-routing",
    title: "Worker model routing",
    description: "Map providers, models, and exact reasoning to cost-aware worker profiles.",
    component: RoutingSettings,
  });
  app.slots.settingsSection({
    id: "learning-data",
    title: "Orchestrator learning data",
    description: "Inspect session outcomes, token usage, branches, and failure categories captured for improvement.",
    component: LearningDataSettings,
  });
});
