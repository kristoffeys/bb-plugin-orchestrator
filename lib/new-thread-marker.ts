export type NewThreadOrchestrationMarker = {
  label: string;
  projectIds: string[];
};

const VERSION_PREFIX = "v1.";
const PROVIDER_PREFIX = "orchestration:";

export function encodeNewThreadOrchestrationMarker(marker: NewThreadOrchestrationMarker): string {
  return `${VERSION_PREFIX}${encodeURIComponent(JSON.stringify(marker))}`;
}

export function parseNewThreadOrchestrationMarker(value: string): NewThreadOrchestrationMarker | null {
  const ownId = value.startsWith(PROVIDER_PREFIX) ? value.slice(PROVIDER_PREFIX.length) : value;
  if (!ownId.startsWith(VERSION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(ownId.slice(VERSION_PREFIX.length))) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const label = "label" in parsed && typeof parsed.label === "string" ? parsed.label.trim() : "";
    const projectIds = "projectIds" in parsed && Array.isArray(parsed.projectIds)
      ? parsed.projectIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (label.length === 0 || label.length > 200 || projectIds.length === 0 || projectIds.length > 50) return null;
    if (new Set(projectIds).size !== projectIds.length) return null;
    return { label, projectIds };
  } catch {
    return null;
  }
}
