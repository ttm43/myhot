import { useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/radar";
import type { RadarDays, RadarItem, RadarResponse } from "@aihot/contracts/site";
import { cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { relativeTime } from "../lib/format";
import { PillTabs } from "../components/ui/Tabs";
import { EmptyState } from "../components/ui/Page";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

// 雷达: the collect-only sources' recent items, raw and by source, linking out to the originals. Rows
// are plain list items with outbound links (no <article>, no /items/ links), so the card scripts of
// the feed and of modules never take them for cards.

export const handle: Screen = { tab: "radar", name: "雷达" };
export { pageHeaders as headers } from "../lib/api.server";
// The source chips only filter what is already loaded: one window, one result.
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>((url) => `/radar?days=${daysOf(url.searchParams)}`);

const NOTE = "只收不分析的信源，原样列出，不经过模型。";

function daysOf(params: URLSearchParams): RadarDays {
  return params.get("days") === "7" ? 7 : 3;
}

function radarHref(days: RadarDays, source: string | null): string {
  const sp = new URLSearchParams();
  if (days !== 3) sp.set("days", String(days));
  if (source) sp.set("source", source);
  const s = sp.toString();
  return s ? `/radar?${s}` : "/radar";
}

export async function loader({ request }: Route.LoaderArgs) {
  const days = daysOf(new URL(request.url).searchParams);
  const data = await loadOr404<RadarResponse>(`/api/site/radar?days=${days}`, { signal: request.signal });
  return cachedPage(60, { data });
}

export function meta({ location }: Route.MetaArgs) {
  const filtered = new URLSearchParams(location.search).size > 0;
  return pageMeta({ title: "雷达", description: NOTE, path: "/radar", noindex: filtered });
}

/** A GitHub repository as owner / repo, the repository emphasized; anything else by its own title. */
function RowTitle({ item }: { item: RadarItem }) {
  let repo: [string, string] | null = null;
  try {
    const u = new URL(item.url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (u.hostname === "github.com" && parts.length === 2) repo = [parts[0]!, parts[1]!];
  } catch { /* the title stands */ }
  if (!repo) return <>{item.title}</>;
  return (
    <>
      <span className="text-ink-3">{repo[0]} / </span>
      <span className="font-semibold">{repo[1]}</span>
    </>
  );
}

function Row({ item }: { item: RadarItem }) {
  return (
    <li className="py-2.5 lg:py-3">
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 text-[15px] leading-6 text-ink [overflow-wrap:anywhere] hover:text-accent">
        <RowTitle item={item} />
      </a>
      {item.excerpt && <p className="mt-0.5 line-clamp-1 text-[13px] leading-5 text-ink-4 [overflow-wrap:anywhere] lg:line-clamp-2">{item.excerpt}</p>}
      <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-4">
        {item.fresh && <span className="rounded-full bg-accent/10 px-1.5 text-[11px] font-semibold leading-[18px] text-accent">新</span>}
        <time dateTime={item.discoveredAt} suppressHydrationWarning>{relativeTime(item.discoveredAt)}</time>
      </div>
    </li>
  );
}

export default function RadarPage() {
  const { data } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const days = data.days;
  const requested = params.get("source");
  const source = data.sources.some((s) => s.sourceId === requested) ? requested : null;
  const shown = source ? data.sources.filter((s) => s.sourceId === source) : data.sources;
  const total = data.sources.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="pb-6">
      <PhoneBar title="雷达" large sub={NOTE} />
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">雷达</h1>
        <p className="mt-1 text-[13px] text-ink-4">{NOTE}</p>
      </div>

      <div className="flex min-w-0 flex-col gap-2.5 lg:mt-4 lg:flex-row-reverse lg:items-center lg:justify-between lg:gap-4">
        <PillTabs
          size="sm"
          layoutId="radar-days"
          label="时间范围"
          className="shrink-0"
          active={String(days)}
          items={([3, 7] as const).map((d) => ({ key: String(d), label: `${d} 天`, to: radarHref(d, source) }))}
        />
        {data.sources.length > 0 && (
          <PillTabs
            size="sm"
            layoutId="radar-sources"
            label="信源"
            className="min-w-0"
            active={source ?? "all"}
            items={[
              { key: "all", label: "全部", count: total, to: radarHref(days, null) },
              ...data.sources.map((s) => ({ key: s.sourceId, label: s.sourceName, count: s.items.length, to: radarHref(days, s.sourceId) })),
            ]}
          />
        )}
      </div>

      {shown.length === 0 ? (
        <div className="mt-4 lg:card">
          <EmptyState title={`近 ${days} 天没有新条目`}>
            {days === 3 ? "换成 7 天看看。" : "只收不分析的信源这段时间没有收到新内容。"}
          </EmptyState>
        </div>
      ) : (
        shown.map((s) => (
          <section key={s.sourceId} className="mt-5 lg:card lg:mt-4 lg:px-5 lg:pb-1.5 lg:pt-4">
            <h2 className="flex items-baseline gap-2 text-[15px] font-semibold text-ink">
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{s.sourceName}</a>
              ) : (
                s.sourceName
              )}
              <span className="num text-[12px] font-normal text-ink-4">{s.items.length}</span>
            </h2>
            <ul className="mt-1 divide-y divide-line-soft">
              {s.items.map((item) => <Row key={item.url} item={item} />)}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
