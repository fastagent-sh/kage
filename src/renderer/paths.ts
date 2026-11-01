export const home = (dir: string): string => {
  const configured = (globalThis as { duang?: { homeDir?: string } }).duang?.homeDir?.replace(/\/+$/, "");
  if (configured) {
    for (const prefix of configured.startsWith("/var/") ? [`/private${configured}`, configured] : [configured]) {
      if (dir === prefix) return "~";
      if (dir.startsWith(`${prefix}/`)) return `~${dir.slice(prefix.length)}`;
    }
  }
  return dir.replace(/^\/Users\/[^/]+/, "~");
};

export const location = (dir: string): string => {
  const parts = home(dir).split("/").filter(Boolean);
  return parts.length > 1 ? `${parts.at(-1)} · ${parts.at(-2)}` : parts[0] ?? "/";
};

export function agentSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return slug || "agent";
}
