import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { markdownPlugins, normalizeMath } from "./markdown.ts";

function renderMarkdown(text: string, open = false): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        caret: "block",
        isAnimating: open,
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
