// Public read layer, item level. Every exit (site API, MCP) reads
// items through these columns and views; which rows are public is decided by scope.ts.
import { CATEGORY_KEYS, toPublicApiCategory, type CategoryKey, type ChannelKey, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import type { FeedItemSummary, ItemSummary } from "@aihot/contracts/site";
import { sql, type Db } from "../db.ts";
import { displayTags, publicSourceName } from "./rules.ts";
import { foldableSelectionCondition, seatedCondition } from "./scope.ts";

export interface ItemRow {
  id: string;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  /** Holds its fact's selected seat (publish.ts settleSeats). */
  seat: boolean;
  visibility: string;
  body_mode: "full" | "summary";
  fact_id: number | null;
  source_name: string;
  /** Participation mode of the source now (editorial, hot_signal, isolated). */
  source_mode: string;
  author: string | null;
}

/** Columns every item listing selects. Internal judgement details never leave this layer. */
export const ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, p.reason, p.category, p.tags, p.score,
  p.selected, p.seat, p.url, p.published_at, p.discovered_at, p.timeline_at, p.visibility,
  p.body_mode, p.fact_id, s.name AS source_name, s.participation_mode AS source_mode,
  a.author`;

/** MCP listings never render article bodies or story metadata. */
export type ApiItemRow = Pick<ItemRow, "id" | "title" | "original_title" | "summary" | "source_name" | "url" | "published_at" | "discovered_at" | "category" | "score" | "selected" | "reason">;
/** `selected` is the machine meaning: the report holds its fact's selected seat (scope.ts seatedCondition). */
export const API_ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, s.name AS source_name, p.url,
  p.published_at, p.discovered_at, p.category, p.score, (p.selected AND p.seat) AS selected, p.reason`;
export const API_ITEM_FROM = sql`FROM publications p JOIN sources s ON s.id = p.source_id`;

export const ITEM_FROM = sql`
  FROM publications p
  JOIN sources s ON s.id = p.source_id
  JOIN articles a ON a.id = p.article_id`;

export function channelCondition(channel: ChannelKey | null | undefined) {
  if (!channel || channel === "all") return sql``;
  if (channel === "firstParty") return sql`AND p.source_id IN (SELECT id FROM sources WHERE tier = 'T1')`;
  return sql`AND p.channel = ${channel}`;
}

/** The website's filter: one of its own categories. */
export function categoryCondition(category: CategoryKey | null | undefined) {
  if (!category) return sql``;
  return sql`AND p.category = ${category}`;
}

/** MCP's filter: every category the site publishes as this one (PUBLIC_CATEGORIES). */
export function publicCategoryCondition(category: PublicApiCategoryKey | null | undefined) {
  if (!category) return sql``;
  return sql`AND p.category IN ${sql(CATEGORY_KEYS.filter((k) => toPublicApiCategory(k) === category))}`;
}

export function tagCondition(tag: string | null | undefined) {
  if (!tag) return sql``;
  return sql`AND p.tags @> ${[tag]}::text[]`;
}

/** The shared public article. */
export function toItemSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    reason: row.selected ? row.reason : null,
    source: { name: publicSourceName(row.source_name) },
    links: { original: row.url },
    publishedAt: row.published_at?.toISOString() ?? null,
    discoveredAt: row.discovered_at.toISOString(),
    timelineAt: row.timeline_at.toISOString(),
    category: (row.category as CategoryKey | null) ?? null,
    tags: displayTags(row.tags),
    score: row.score === null ? null : Math.round(Number(row.score)),
    selected: row.selected,
  };
}

/** Project the shared public article into the exact fields a site card renders. */
export function toFeedItemSummary(row: ItemRow): FeedItemSummary {
  const item = toItemSummary(row);
  return {
    id: item.id, title: item.title, summary: item.summary, reason: item.reason,
    source: item.source, publishedAt: item.publishedAt, timelineAt: item.timelineAt,
    category: item.category, tags: item.tags, score: item.score, selected: item.selected,
  };
}

/**
 * For listed rows that are selected but yield their fact's seat: the report holding it, by row id.
 * (The home timeline folds these into reading groups; flat lists say which report stands for them.)
 */
export async function seatHolders(rows: ItemRow[], now: Date, db: Db = sql): Promise<Map<string, { id: string; title: string }>> {
  const yielding = rows.filter((r) => r.selected && !r.seat && r.fact_id !== null);
  if (!yielding.length) return new Map();
  const holders = await db<{ fact_id: number; id: string; title: string }[]>`
    SELECT p.fact_id, p.article_id AS id, p.title FROM publications p
    WHERE p.fact_id IN ${db([...new Set(yielding.map((r) => r.fact_id!))])} AND ${seatedCondition(now)} AND ${foldableSelectionCondition()}`;
  const byFact = new Map(holders.map((h) => [Number(h.fact_id), { id: h.id, title: h.title }]));
  return new Map(yielding.flatMap((r) => (byFact.has(Number(r.fact_id)) ? [[r.id, byFact.get(Number(r.fact_id))!] as const] : [])));
}
