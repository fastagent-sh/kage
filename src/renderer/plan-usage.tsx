// A provider's plan windows and the conversation's context: read in main, drawn here beside the header and on
// the providers page.
import { Fragment } from "react";
import type { ProviderUsage } from "../preload/index.ts";
import { pace, paceLabel, resetLabel, tokens } from "./usage.ts";
import { ago } from "./time.ts";

function Bar({ percent }: { percent: number }) {
  return (
    <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-stroke">
      <span className="block h-full rounded-full bg-muted" style={{ width: `${Math.min(100, percent)}%` }} />
    </span>
  );
}

export function PlanUsage({
  plan,
  onPage,
}: {
  plan?: { data?: ProviderUsage; error?: string };
  onPage?: (provider: string) => void;
}) {
  const data = plan?.data;
  if (data?.page && onPage) return <PageLink provider={data.provider} plan={data.page} onPage={onPage} />;
  const windows = data?.windows;
  if (!windows?.length) return null;
  const detail = [
    ...windows.map((w) => {
      const reset = w.resetsAt === undefined ? "" : `, resets ${new Date(w.resetsAt).toLocaleString()}`;
      return `${w.label}: ${w.percent.toFixed(1)}% used${reset}`;
    }),
    `${plan!.data!.provider} · updated ${ago(plan!.data!.fetchedAt)}`,
  ].join("\n");
  return (
    <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted tabular-nums" title={detail}>
      {windows.map((w) => {
        const reset = resetLabel(w);
        return (
          <span key={w.label} className="flex items-center gap-1.5">
            {w.label}
            <Bar percent={w.percent} />
            <span className="min-w-[4ch] text-right">{w.percent.toFixed(0)}%</span>
            {reset && <span>~ {reset}</span>}
          </span>
        );
      })}
    </span>
  );
}

function PageLink({ provider, plan, onPage }: { provider: string; plan: string; onPage: (provider: string) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
      {plan} plan ·
      <button
        onClick={() => onPage(provider)}
        title="Open the plan's usage page in the browser"
        className="pointer-events-auto underline hover:text-text"
      >
        View usage
      </button>
    </span>
  );
}

type Usage = {
  plan?: { data?: ProviderUsage; error?: string };
  context?: { used: number; window: number };
  now?: number;
  onPage?: (provider: string) => void;
};

export function UsageDetail({ plan, context, now = Date.now(), onPage }: Usage) {
  const data = plan?.data;
  const windows = data?.windows ?? [];
  return (
    <div className="usage-detail grid grid-cols-[auto_auto_auto_auto] items-center gap-x-2 gap-y-1.5 px-2 py-1.5 text-[11px] whitespace-nowrap text-muted tabular-nums">
      {windows.map((w) => {
        const reset = resetLabel(w);
        const diff = pace(w, now);
        return (
          <Fragment key={w.label}>
            <span>{w.label}</span>
            <Bar percent={w.percent} />
            <span className="text-right text-text">{w.percent.toFixed(0)}%</span>
            <span>
              {reset && `resets ${reset}`}
              {diff !== undefined && (
                <span className={`ml-2 ${diff > 0 ? "text-danger" : "text-success"}`}>{paceLabel(diff)}</span>
              )}
            </span>
          </Fragment>
        );
      })}
      {context && (
        <>
          <span>context</span>
          <Bar percent={(context.used / context.window) * 100} />
          <span className="text-right text-text">{((context.used / context.window) * 100).toFixed(0)}%</span>
          <span>of {tokens(context.window)}</span>
        </>
      )}
      {data && windows.length > 0 && (
        <span className="col-span-4 mt-0.5 border-t border-stroke pt-1.5">
          {data.provider} · updated {ago(data.fetchedAt)}
        </span>
      )}
      {data?.page && onPage && (
        <span className={`col-span-4 ${context ? "mt-0.5 border-t border-stroke pt-1.5" : ""}`}>
          <PageLink provider={data.provider} plan={data.page} onPage={onPage} />
        </span>
      )}
    </div>
  );
}

export function UsageMeter({ plan, context, now, onPage }: Usage) {
  const percent = context ? (context.used / context.window) * 100 : undefined;
  const hasTable = context !== undefined || (plan?.data?.windows ?? []).length > 0 || (!!plan?.data?.page && !!onPage);
  return (
    // A click focuses it too, so the table opens only on `:focus-visible`, never pinned by a click.
    <div
      tabIndex={hasTable ? 0 : undefined}
      aria-label="Usage"
      className="usage-meter group pointer-events-auto relative shrink-0 text-[11px] text-muted tabular-nums"
    >
      <span className="flex items-center gap-1.5">
        context
        <Bar percent={percent ?? 0} />
        {percent === undefined ? "–" : `${percent.toFixed(0)}%`}
      </span>
      {hasTable && (
        // Padding, not margin, so the pointer can reach the link. Opacity, not `display: none`: a link in a hidden
        // box cannot take focus when Tab leaves the meter.
        <div className="usage-details pointer-events-none absolute top-full right-0 pt-3 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100">
          <div className="popover">
            <UsageDetail plan={plan} context={context} now={now} onPage={onPage} />
          </div>
        </div>
      )}
    </div>
  );
}
