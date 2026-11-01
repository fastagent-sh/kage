import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type HTMLAttributes } from "react";

export function useNarrowWindow(width: number): boolean {
  const media = useMemo(() => window.matchMedia(`(max-width: ${width}px)`), [width]);
  const subscribe = useCallback((notify: () => void) => {
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, [media]);
  return useSyncExternalStore(subscribe, () => media.matches);
}

export function ResponsivePanel({
  overlay,
  open = true,
  onClose,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { overlay: boolean; open?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current!;
    const focused = panel.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    if (overlay) {
      panel.setAttribute("popover", "auto");
      if (open && !panel.matches(":popover-open")) {
        panel.showPopover();
        (focused ?? panel.querySelector<HTMLElement>('[aria-current="true"]') ?? panel.querySelector("button") ?? panel).focus({ preventScroll: true });
      } else if (!open) {
        panel.hidePopover();
      }
    } else {
      panel.removeAttribute("popover");
      focused?.focus({ preventScroll: true });
    }
  }, [overlay, open]);
  useLayoutEffect(() => {
    const panel = ref.current!;
    return () => {
      if (panel.hasAttribute("popover")) panel.hidePopover();
    };
  }, []);

  return (
    <aside
      {...props}
      ref={ref}
      role={overlay ? "dialog" : undefined}
      tabIndex={overlay ? -1 : undefined}
      className={`responsive-panel ${className ?? ""}`}
      onToggle={(event) => {
        if (overlay && open && event.newState === "closed" && event.currentTarget.hasAttribute("popover")) onClose();
      }}
      onBlur={(event) => {
        if (overlay && open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      {children}
    </aside>
  );
}
