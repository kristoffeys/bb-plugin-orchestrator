import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
  useComposerView,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";

const PROFILES = ["quick", "standard", "complex", "critical"] as const;
type Profile = (typeof PROFILES)[number];
type Routes = Record<Profile, string>;
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

function RoutingSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<
    Extract<Catalog, { providers: unknown }> extends { providers: infer T } ? T : never
  >([] as never);
  const [storedRoutes, setStoredRoutes] = useState<Record<string, Routes>>({});
  const [drafts, setDrafts] = useState<Record<string, Routes>>({});
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
          Quick is the default assignment. Reasoning automatically uses the requested
          tier when the selected model supports it, otherwise that model’s default.
        </p>
      </div>

      {error === null ? null : (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
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
    id: "model-routing",
    title: "Worker model routing",
    description: "Map each available provider to cost-aware worker profiles.",
    component: RoutingSettings,
  });
});
