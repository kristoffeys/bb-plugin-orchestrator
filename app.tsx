import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
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
  app.slots.settingsSection({
    id: "model-routing",
    title: "Worker model routing",
    description: "Map each available provider to cost-aware worker profiles.",
    component: RoutingSettings,
  });
});
