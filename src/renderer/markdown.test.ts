import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { classifyLink, externalUrl, isFilePath, stripPathSuffix } from "../shared/links.ts";
import { markdownPlugins, normalizeMath } from "./markdown.ts";

const linkSafety = { enabled: false };

function renderMarkdown(text: string, open = false): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        caret: "block",
        isAnimating: open,
        linkSafety,
        parseIncompleteMarkdown: open,
        plugins: markdownPlugins,
      },
      normalizeMath(text),
    ),
  );
}

test("inline and display math render through KaTeX in both dollar and LaTeX notations", () => {
  const html = renderMarkdown("Inline $E = mc^2$ and \\(a^2 + b^2 = c^2\\).\n\n$$\\sum_{i=1}^n i$$\n\n\\[\\int_0^1 x^2 dx\\]");
  assert.match(html, /<span class="katex">/);
  assert.match(html, /E = mc\^2/);
  assert.match(html, /a\^2 \+ b\^2 = c\^2/);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
});

test("currency amounts, shell variables, and code spans are not mistaken for math", () => {
  const prose = "Costs $100 and $200 today, range $10-$20, vars $HOME/$PATH, and `$x + $y` in code.";
  assert.equal(normalizeMath(prose), prose);
  const html = renderMarkdown(prose);
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /Costs \$100 and \$200 today/);

  const unclosedFence = "```ts\nconst price = \"$a + $b\";";
  assert.equal(normalizeMath(unclosedFence), unclosedFence);
});

test("CJK emphasis with punctuation and autolinks followed by Chinese text split cleanly", () => {
  const html = renderMarkdown("**1. 缺少翻译键（重要）**紧接中文，详见 https://fastagent.sh/docs，继续阅读。");
  assert.match(html, /<span[^>]*data-streamdown="strong"[^>]*>1\. 缺少翻译键（重要）<\/span>紧接中文/);
  assert.doesNotMatch(html, /https:\/\/fastagent\.sh\/docs，/);
});

test("the streaming caret is CSS-driven rather than appended to the markdown text", () => {
  const streaming = renderMarkdown("Visit https://fastagent.sh", true);
  assert.match(streaming, /--streamdown-caret/);
  assert.doesNotMatch(streaming, /fastagent\.sh▍/);
});

test("only http, https, and mailto links are treated as external URLs", () => {
  assert.equal(externalUrl("https://fastagent.sh/docs"), "https://fastagent.sh/docs");
  assert.equal(externalUrl("http://localhost:3000/api"), "http://localhost:3000/api");
  assert.equal(externalUrl("mailto:team@fastagent.sh"), "mailto:team@fastagent.sh");
  assert.equal(externalUrl("file:///etc/passwd"), undefined);
  assert.equal(externalUrl("javascript:alert(1)"), undefined);
  assert.equal(externalUrl("src/main/index.ts"), undefined);
});

test("file paths are distinguished from model specs, slash commands, and code expressions", () => {
  for (const path of [
    "src/main/index.ts",
    "src/main/index.ts:61:5",
    "src/renderer/App.tsx#L120-L135",
    "./package.json",
    "~/Library/Application Support/duang/agents.json",
    "/Users/someone/research/video-research",
    "fastagent.config.ts",
    "README.md",
    ".gitignore",
  ]) {
    assert.equal(isFilePath(path), true, `expected ${path} to be recognised as a file path`);
  }
  for (const nonPath of [
    "openai/gpt-5.5",
    "provider/model",
    "/compact",
    "/skill:review",
    "npm run build",
    "https://fastagent.sh/docs.md",
    "sectionsGenerated",
    "res.json",
    'import "./foo.ts"',
  ]) {
    assert.equal(isFilePath(nonPath), false, `expected ${nonPath} not to be recognised as a file path`);
  }
  assert.equal(stripPathSuffix("src/main/index.ts:61:5"), "src/main/index.ts");
  assert.equal(stripPathSuffix("src/renderer/App.tsx#L12-L20"), "src/renderer/App.tsx");
});

test("markdown links classify into external URLs, local paths, and incomplete streaming targets", () => {
  assert.deepEqual(classifyLink("https://fastagent.sh/docs"), {
    kind: "external",
    url: "https://fastagent.sh/docs",
  });
  assert.deepEqual(classifyLink("src/main/agents.ts#L10"), {
    kind: "path",
    path: "src/main/agents.ts#L10",
    displayPath: "src/main/agents.ts",
  });
  assert.deepEqual(classifyLink("streamdown:incomplete-link"), { kind: "incomplete" });
  assert.deepEqual(classifyLink("#section"), { kind: "incomplete" });
});
