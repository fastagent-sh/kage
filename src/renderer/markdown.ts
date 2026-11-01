import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import type { PluginConfig } from "streamdown";

export const markdownPlugins: PluginConfig = {
  cjk,
  math: createMathPlugin({
    singleDollarTextMath: false,
    errorColor: "var(--color-muted)",
  }),
};

const CODE_SEGMENT = /(`{3,}[\s\S]*?(?:`{3,}|$)|`[^`\n]+`)/g;

/**
 * Rewrites LaTeX `\[...\]`, `\(...\)`, single-line block `$$...$$`, and unambiguous Pandoc `$...$`
 * into the `$$` delimiters `remark-math` expects, while leaving code spans, currency, and variables untouched.
 */
export function normalizeMath(markdown: string): string {
  if (!markdown.includes("$") && !markdown.includes("\\")) return markdown;
  return markdown
    .split(CODE_SEGMENT)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
        .replace(/^[ \t]*\$\$([^\n$]+?)\$\$[ \t]*$/gm, (_, body: string) => `$$\n${body.trim()}\n$$`)
        .replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$$${body.trim()}$$`)
        .replace(
          /(?<![\\$0-9A-Za-z])\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?![0-9A-Za-z$])/g,
          (match, body: string) => (/^\d[\d,._]*$/.test(body) ? match : `$$${body}$$`),
        );
    })
    .join("");
}
