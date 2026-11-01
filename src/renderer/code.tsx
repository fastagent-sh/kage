// Only `code` and `a` are overridden: Streamdown's `pre` marks a fenced block, and replacing it made every block inline.
import { createContext, Suspense, use, useContext, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { ShikiHighlighter, createHighlighterCore, createJavaScriptRegexEngine } from "react-shiki/core";
import { classifyLink, isFilePath, stripPathSuffix } from "../shared/links.ts";
import { useCopy } from "./ui.tsx";

export interface TranscriptActions {
  onOpenLink?: (url: string) => void;
  onOpenPath?: (path: string) => void;
}

export const TranscriptActionsContext = createContext<TranscriptActions>({});

const highlighterReady = createHighlighterCore({
  themes: [import("@shikijs/themes/catppuccin-latte"), import("@shikijs/themes/catppuccin-mocha")],
  langs: [
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/diff"),
    import("@shikijs/langs/go"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/sql"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/yaml"),
  ],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

const THEME = { light: "catppuccin-latte", dark: "catppuccin-mocha" };

const ALIASES: Record<string, string> = {
  console: "bash",
  javascript: "tsx",
  js: "tsx",
  jsx: "tsx",
  md: "markdown",
  mjs: "typescript",
  patch: "diff",
  py: "python",
  rs: "rust",
  scss: "css",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
};

export function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="code-block relative rounded-float bg-surface px-4 pt-3 pb-3.5">
      <div className="flex items-center h-5 font-mono text-[12px] text-muted">{language}</div>
      <CopyButton code={code} />
      {/* The same text in the same place until the grammar lands: no skeleton, no reflow. */}
      <Suspense fallback={<Plain code={code} />}>
        <Highlighted code={code} language={language} />
      </Suspense>
    </div>
  );
}

function Plain({ code }: { code: string }) {
  return <pre className="mt-1.5 overflow-x-auto font-mono text-[12.5px] leading-relaxed">{code}</pre>;
}

function Highlighted({ code, language }: { code: string; language: string }) {
  const lang = ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  const highlighter = use(highlighterReady);
  return (
    <ShikiHighlighter
        language={lang}
        theme={THEME}
        highlighter={highlighter}
        addDefaultStyles={false}
        showLanguage={false}
        // Both themes, resolved by the document's colour-scheme.
        defaultColor="light-dark()"
        // Throttles re-highlighting while tokens stream.
        delay={80}
        className="mt-1.5 block overflow-x-auto font-mono text-[12.5px] leading-relaxed [&_pre]:bg-transparent"
    >
      {code}
    </ShikiHighlighter>
  );
}

function CopyButton({ code }: { code: string }) {
  const { copied, failed, copy } = useCopy(code);
  return (
    <button
      aria-label={failed ? `Could not copy: ${failed}` : copied ? "Copied" : "Copy code"}
      title={failed ? `Could not copy: ${failed}` : copied ? "Copied" : "Copy code"}
      className={`absolute top-2.5 right-3 p-1 text-muted hover:text-text ${failed ? "text-danger" : ""}`}
      onClick={copy}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  const { onOpenLink, onOpenPath } = useContext(TranscriptActionsContext);
  const target = classifyLink(href);
  if (target.kind === "incomplete") {
    return (
      <span data-streamdown="link" className="text-accent underline">
        {children}
      </span>
    );
  }
  if (target.kind === "external") {
    return (
      <a
        href={target.url}
        title={target.url}
        data-streamdown="link"
        className="cursor-pointer text-accent underline"
        onClick={(event) => {
          event.preventDefault();
          onOpenLink?.(target.url);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      href={target.path}
      title={`Show ${target.displayPath} in Finder`}
      data-streamdown="link"
      className="cursor-pointer text-accent underline"
      onClick={(event) => {
        event.preventDefault();
        onOpenPath?.(target.path);
      }}
    >
      {children}
    </a>
  );
}

export function MarkdownCode({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: unknown;
  node?: unknown;
}) {
  const { onOpenPath } = useContext(TranscriptActionsContext);
  const text = typeof children === "string" ? children : String(children ?? "");
  if (!("data-block" in props)) {
    if (isFilePath(text)) {
      return (
        <button
          type="button"
          title={`Show ${stripPathSuffix(text)} in Finder`}
          onClick={() => onOpenPath?.(text)}
          className="inline-code cursor-pointer rounded-[4px] px-[0.3em] py-px font-mono transition-colors hover:bg-surface-2 hover:text-accent"
        >
          {text}
        </button>
      );
    }
    return <code className="inline-code rounded-[4px] px-[0.3em] py-px font-mono">{text}</code>;
  }
  return <CodeBlock code={text.replace(/\n$/, "")} language={/language-(\S+)/.exec(className ?? "")?.[1] ?? "text"} />;
}
