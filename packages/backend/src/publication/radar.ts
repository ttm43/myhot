// 雷达 (/radar): what the collect-only (hot_signal) sources brought in lately, raw. These items are
// never analysed or grouped, so the titles and excerpts are the sources' own; nothing here calls a
// model. Withdrawn material stays out.
import type { RadarDays, RadarResponse } from "@aihot/contracts/site";
import { RADAR } from "@aihot/site";
import { sql } from "../db.ts";
import { publicSourceName } from "./rules.ts";

const PER_SOURCE = 30;

interface RadarRow {
  source_id: string;
  source_name: string;
  title: string;
  url: string;
  excerpt: string | null;
  discovered_at: Date;
}

/** A web listing's configured page is the page readers know; feeds and APIs have no such address. */
function sourcePage(kind: string, config: Record<string, unknown>): string | null {
  if (kind !== "web_list" || typeof config.url !== "string") return null;
  try {
    const url = new URL(config.url);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Enabled hot_signal sources with material discovered in the last `days` days, at most thirty items
 * each, newest first; one item per URL within a source (its latest discovery). Sources pinned in
 * site.ts RADAR come first in that order, the others by their latest item.
 */
export async function loadRadar(days: RadarDays = 3, now = new Date()): Promise<RadarResponse> {
  const since = new Date(now.getTime() - days * 86400_000);
  const rows = await sql<(RadarRow & { source_kind: string; source_config: Record<string, unknown> })[]>`
    WITH recent AS (
      SELECT DISTINCT ON (a.source_id, a.url) a.id, a.source_id, a.url, a.title, a.excerpt, a.discovered_at
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      LEFT JOIN publications p ON p.article_id = a.id
      WHERE s.enabled AND s.participation_mode = 'hot_signal'
        AND a.discovered_at > ${since} AND a.discovered_at <= ${now}
        AND coalesce(p.visibility, 'public') <> 'withdrawn'
      ORDER BY a.source_id, a.url, a.discovered_at DESC, a.id
    ), ranked AS (
      SELECT r.*, row_number() OVER (PARTITION BY r.source_id ORDER BY r.discovered_at DESC, r.id) AS n FROM recent r
    )
    SELECT r.source_id, s.name AS source_name, s.kind AS source_kind, s.config AS source_config,
      r.title, r.url, r.excerpt, r.discovered_at
    FROM ranked r JOIN sources s ON s.id = r.source_id
    WHERE r.n <= ${PER_SOURCE}
    ORDER BY r.source_id, r.discovered_at DESC, r.id`;
  const bySource = new Map<string, RadarResponse["sources"][number]>();
  for (const r of rows) {
    let group = bySource.get(r.source_id);
    if (!group) {
      group = { sourceId: r.source_id, sourceName: publicSourceName(r.source_name), url: sourcePage(r.source_kind, r.source_config ?? {}), items: [] };
      bySource.set(r.source_id, group);
    }
    group.items.push({
      title: r.title, url: r.url, excerpt: r.excerpt?.trim() || null, discoveredAt: r.discovered_at.toISOString(),
      fresh: now.getTime() - r.discovered_at.getTime() < 86400_000,
    });
  }
  const pinned = (id: string) => {
    const at = (RADAR.pinned as readonly string[]).indexOf(id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const sources = [...bySource.values()].sort((a, b) =>
    pinned(a.sourceId) - pinned(b.sourceId) || b.items[0]!.discoveredAt.localeCompare(a.items[0]!.discoveredAt) || a.sourceId.localeCompare(b.sourceId));
  return { days, sources };
}
