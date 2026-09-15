import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
  useComposerView,
  type PluginPendingInteractionProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";

const PROFILES = ["quick", "standard", "complex", "critical"] as const;
const REASONING_CHOICES: ReasoningChoice[] = ["model-default", "none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];
type Profile = (typeof PROFILES)[number];
type Routes = Record<Profile, string>;
type RouteTarget = { providerId: string; modelId: string } | null;
type ReasoningChoice = "model-default" | "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "ultracode";
type RoutingPolicy = { strategy: "coordinator" | "profile"; profileRoutes: Record<Profile, RouteTarget>; profileReasoning: Record<Profile, ReasoningChoice> };
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
              <p className="text-xs text-muted-foreground">{String(assignment.projectId ?? "Project")} · {String(assignment.profile ?? "quick")}</p>
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
    <button
      type="button"
      aria-label={state.enabled ? "Configure orchestration" : "Enable orchestration"}
      title={state.enabled ? "Orchestration enabled" : "Enable orchestration"}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ORCHESTRATION_EVENT, {
        detail: { threadId },
      }))}
      className={`relative grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
        state.enabled
          ? "bg-primary/12 text-primary hover:bg-primary/20"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      <Icon name="Workflow" className="size-4" aria-hidden="true" />
      {state.enabled ? (
        <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary ring-1 ring-background" />
      ) : null}
    </button>
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
  const initialRoutingPolicy: RoutingPolicy = { strategy: "coordinator", profileRoutes: { quick: null, standard: null, complex: null, critical: null }, profileReasoning: { quick: "low", standard: "medium", complex: "high", critical: "xhigh" } };
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
          const initial = routing.routes[provider.id] ?? provider.recommendedRoutes;
          if (next[provider.id] === undefined && initial !== null) {
            next[provider.id] = initial;
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
            profileReasoning: routePolicy.profileReasoning,
            profileRoutes: strategy === "profile" && fallback !== undefined
              ? Object.fromEntries(PROFILES.map((profile) => [profile, routePolicy.profileRoutes[profile] ?? { providerId: fallback.id, modelId: fallback.recommendedRoutes?.[profile] ?? fallback.models[0]?.id ?? "" }])) as Record<Profile, RouteTarget>
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
                    <select aria-label={`${PROFILE_COPY[profile].label} provider`} value={provider?.id ?? ""} onChange={(event) => { const nextProvider = providers.find((item) => item.id === event.target.value); const nextModel = nextProvider?.recommendedRoutes?.[profile] ?? nextProvider?.models[0]?.id ?? ""; setRoutePolicy({ ...routePolicy, profileRoutes: { ...routePolicy.profileRoutes, [profile]: nextProvider === undefined ? null : { providerId: nextProvider.id, modelId: nextModel } } }); }} className="h-9 rounded-md border border-input bg-background px-2 text-sm">{providers.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
                    <select aria-label={`${PROFILE_COPY[profile].label} model`} value={target?.modelId ?? provider?.recommendedRoutes?.[profile] ?? provider?.models[0]?.id ?? ""} onChange={(event) => { if (provider !== undefined) setRoutePolicy({ ...routePolicy, profileRoutes: { ...routePolicy.profileRoutes, [profile]: { providerId: provider.id, modelId: event.target.value } } }); }} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm">{provider?.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
                    <select aria-label={`${PROFILE_COPY[profile].label} reasoning`} value={routePolicy.profileReasoning[profile]} onChange={(event) => setRoutePolicy({ ...routePolicy, profileReasoning: { ...routePolicy.profileReasoning, [profile]: event.target.value as ReasoningChoice } })} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm">{REASONING_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {routePolicy.strategy === "coordinator" ? (
        <section className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5">
          <h3 className="text-sm font-semibold text-foreground">Profile reasoning</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Exact levels are checked against the selected model at dispatch. Model-default uses that model’s declared default.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">{PROFILES.map((profile) => <label key={profile}><span className="mb-1 block text-xs font-medium text-foreground">{PROFILE_COPY[profile].label}</span><select value={routePolicy.profileReasoning[profile]} onChange={(event) => setRoutePolicy({ ...routePolicy, profileReasoning: { ...routePolicy.profileReasoning, [profile]: event.target.value as ReasoningChoice } })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">{REASONING_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></label>)}</div>
        </section>
      ) : null}

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
                      const selectedId = routes?.[profile] ?? "";
                      const selected = provider.models.find((model) => model.id === selectedId);
                      return (
                        <div key={profile} className="grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4">
                          <label htmlFor={`${provider.id}-${profile}`}>
                            <span className="block text-sm font-medium text-foreground">{PROFILE_COPY[profile].label}</span>
                            <span className="block text-xs text-muted-foreground">{PROFILE_COPY[profile].description}</span>
                          </label>
                          <div>
                            <select
                              id={`${provider.id}-${profile}`}
                              value={selectedId}
                              onChange={(event) => setDrafts((current) => ({
                                ...current,
                                [provider.id]: {
                                  ...(current[provider.id] ?? provider.recommendedRoutes!),
                                  [profile]: event.target.value,
                                },
                              }))}
                              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {provider.models.map((model) => (
                                <option key={model.id} value={model.id}>{model.displayName}</option>
                              ))}
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

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "dispatch-approval", component: DispatchApproval });
  app.slots.experimental_appOverlay({
    id: "orchestration-dialog",
    component: OrchestrationOverlay,
  });
  app.composer.customize({
    id: "thread-orchestration",
    scopes: ["thread"],
    actions: [{ id: "configure", component: ComposerOrchestrationAction }],
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
});
