// 雷达: what the collect-only sources brought in over the last three days, raw and by source, folded
// above the home feed. It loads on first open, so the feed's page and cache stay as they are. Rows
// link out to the originals: no <article> and no /items/ links, so the feed's card scripts never take
// them for cards.
import { useState } from "react";
import type { RadarResponse } from "@aihot/contracts/site";
import { IconChevronDown } from "../../components/icons";

type State = { kind: "idle" | "loading" | "failed" } | { kind: "ready"; data: RadarResponse };

export function Radar() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const load = () => {
    setState({ kind: "loading" });
    fetch("/api/site/radar")
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<RadarResponse>; })
      .then((data) => setState({ kind: "ready", data }), () => setState({ kind: "failed" }));
  };
  return (
    <details
      className="group mb-4 mt-1 rounded-tile border border-line-soft lg:mb-5"
      onToggle={(event) => { if (event.currentTarget.open && (state.kind === "idle" || state.kind === "failed")) load(); }}
    >
      <summary className="flex h-10 cursor-pointer select-none list-none items-center gap-2 px-3.5 text-[13px] [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-ink-2">雷达</span>
        <span className="min-w-0 truncate text-ink-4">只收不分析的信源，近三天原样列出</span>
        <IconChevronDown size={14} className="ml-auto shrink-0 text-ink-4 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="max-h-[60vh] overflow-y-auto border-t border-line-soft px-3.5 pb-3 pt-1 lg:max-h-[420px]">
        {state.kind === "loading" && <p className="py-3 text-[13px] text-ink-4">加载中…</p>}
        {state.kind === "failed" && (
          <button type="button" onClick={load} className="py-3 text-[13px] text-accent">加载失败，点此重试</button>
        )}
        {state.kind === "ready" && state.data.sources.length === 0 && <p className="py-3 text-[13px] text-ink-4">近三天没有新条目</p>}
        {state.kind === "ready" && state.data.sources.map((source) => (
          <section key={source.sourceId} className="pt-2.5">
            <h3 className="text-[12px] font-semibold text-ink-3">{source.sourceName}</h3>
            <ul className="mt-1 divide-y divide-line-soft">
              {source.items.map((item) => (
                <li key={item.url} className="py-1.5">
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="block truncate text-[14px] leading-6 text-ink hover:text-accent">
                    {item.title}
                  </a>
                  {item.excerpt && <p className="truncate text-[12.5px] leading-5 text-ink-4">{item.excerpt}</p>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}
