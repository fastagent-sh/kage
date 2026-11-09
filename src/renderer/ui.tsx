// Tailwind's later rule wins regardless of class order, so anything a call site might change is a prop here.
import { Component, useEffect, useRef, useState, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode, type Ref } from "react";
import { copyToClipboard } from "./copy.ts";

/**
 * Copies text and says so for a moment. A refused clipboard is said on the control, never swallowed: a button
 * that does nothing when the click landed reads as broken.
 */
export function useCopy(text: string, resetAfter = 1500) {
  const [said, setSaid] = useState<"idle" | "copied" | { failed: string }>("idle");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () =>
    void copyToClipboard(text).then((result) => {
      setSaid(result.ok ? "copied" : { failed: result.error });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSaid("idle"), result.ok ? resetAfter : 4000);
    });
  return { copied: said === "copied", failed: typeof said === "object" ? said.failed : undefined, copy };
}

// `aria-disabled`, not `disabled`: a natively disabled button cannot be focused, so its reason could not be
// reached (WAI-ARIA APG). Activation is dropped here instead.
export function Button({
  kind = "secondary",
  size = 32,
  loud,
  icon,
  disabled,
  title,
  onClick,
  children,
  className = "",
  ref,
  ...rest
}: {
  ref?: Ref<HTMLButtonElement>;
  kind?: "primary" | "secondary" | "ghost" | "danger";
  size?: 28 | 32 | 40;
  loud?: boolean;
  icon?: ReactNode;
  disabled?: string | false;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "children">) {
  // A disabled button keeps its resting look but must not light up under the pointer.
  const kinds = {
    primary: ["bg-accent-fill text-fill-fg", "hover:bg-accent-fill/85"],
    secondary: ["border border-stroke", "hover:bg-hover"],
    ghost: ["text-muted", "hover:bg-hover hover:text-text"],
    danger: ["text-muted", "hover:bg-danger/12 hover:text-danger"],
  };
  const filled = { primary: "bg-accent-fill text-fill-fg", danger: "bg-danger-fill text-fill-fg" };
  const [rest_, hover] = loud && kind in filled ? [filled[kind as "primary" | "danger"], ""] : kinds[kind];
  const box =
    size === 40
      ? "size-10 rounded-full"
      : `rounded-card ${children ? `${size === 28 ? "h-7 px-2.5" : "h-8 px-3"} gap-1.5` : size === 28 ? "size-7" : "size-8"}`;
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      aria-disabled={disabled ? true : undefined}
      onClick={disabled ? undefined : onClick}
      title={disabled || title}
      className={`inline-flex shrink-0 items-center justify-center transition-colors ${
        size === 28 ? "text-[11px]" : "text-[12px]"
      } ${box} ${rest_} ${disabled ? "opacity-40 cursor-default" : hover} ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

export function Pill({ tone, children }: { tone: "accent" | "danger"; children: ReactNode }) {
  const fills = { accent: "bg-accent-fill text-fill-fg", danger: "bg-danger-fill text-fill-fg" };
  return (
    <span
      className={`shrink-0 min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-4 font-semibold tabular-nums ${fills[tone]}`}
    >
      {children}
    </span>
  );
}

export type Tone = "accent" | "success" | "warning" | "danger" | "muted";

const dot: Record<Tone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-muted",
};

const words: Record<Tone, string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted",
};

export function Badge({
  tone,
  icon,
  pulse,
  className = "",
  title,
  children,
}: {
  tone: Tone;
  icon?: ReactNode;
  pulse?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 text-[11px] ${words[tone]} ${className}`}>
      {icon ?? <span className={`size-1.5 shrink-0 rounded-full ${dot[tone]} ${pulse ? "animate-pulse" : ""}`} />}
      {children}
    </span>
  );
}

// `reset` changes with the place it guards (another conversation), which clears the error.
export class Boundary extends Component<
  { reset?: unknown; children: ReactNode; fallback: (error: Error) => ReactNode },
  { error?: Error; reset?: unknown }
> {
  state: { error?: Error; reset?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  static getDerivedStateFromProps(props: { reset?: unknown }, state: { error?: Error; reset?: unknown }) {
    return props.reset === state.reset ? null : { error: undefined, reset: props.reset };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("kage: drawing failed", error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    return error ? this.props.fallback(error) : this.props.children;
  }
}
