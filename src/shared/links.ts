const EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonl",
  "md",
  "mdx",
  "txt",
  "rst",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "svg",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "lock",
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "sql",
  "graphql",
  "proto",
  "patch",
  "diff",
  "log",
  "csv",
  "tsv",
  "xml",
  "plist",
  "sqlite",
]);

const BARE_IDENTIFIERS = new Set(["req.json", "res.json", "response.json"]);

/** Returns the trimmed URL when its scheme is safe to hand to `shell.openExternal` (`https:`, `http:`, `mailto:`). */
export function externalUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Strips trailing `#L10` line anchors and `:line(:col)` suffixes from a file reference. */
export function stripPathSuffix(raw: string): string {
  return raw
    .trim()
    .replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

export type LinkTarget =
  | { kind: "incomplete" }
  | { kind: "external"; url: string }
  | { kind: "path"; path: string; displayPath: string };

export function classifyLink(href: string | undefined): LinkTarget {
  const trimmed = href?.trim() ?? "";
  if (!trimmed || trimmed === "streamdown:incomplete-link" || trimmed.startsWith("#")) return { kind: "incomplete" };
  const external = externalUrl(trimmed);
  if (external) return { kind: "external", url: external };
  if (!isFilePath(trimmed)) return { kind: "incomplete" };
  return { kind: "path", path: trimmed, displayPath: stripPathSuffix(trimmed) };
}

/** Whether an inline code span names a local file or directory path rather than a command, model spec, or identifier. */
export function isFilePath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n\t"'`()[\]{}<>;,=!?*|$&]/.test(trimmed)) return false;
  const clean = stripPathSuffix(trimmed);
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return /^file:\/\//i.test(clean);
  if (!clean || clean === "/" || clean === "~" || clean === "." || clean === "..") return false;
  if (/\s/.test(clean) && !/^(~\/|\/(Users|tmp|var|opt|etc|Volumes)\/)/.test(clean)) return false;
  if (/^(~\/|\.\.?\/)/.test(clean)) return true;
  if (clean.startsWith("/")) {
    const parts = clean.split("/").filter(Boolean);
    if (parts.length >= 2) return true;
    const base = parts[0] ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 && EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
  }
  if (!clean.includes("/") && BARE_IDENTIFIERS.has(clean.toLowerCase())) return false;
  const base = clean.split("/").pop() ?? "";
  if (
    base === "Dockerfile" ||
    base === "Makefile" ||
    base === "LICENSE" ||
    base === ".gitignore" ||
    base.startsWith(".env")
  )
    return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}
