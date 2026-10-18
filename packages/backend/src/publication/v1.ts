// The items the MCP tools return, in the former public API's v1 item format, read from the same public
// read layer as the site.
import { toPublicApiCategory, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { sql, type Db } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { publicCategoryCondition, API_ITEM_COLUMNS, API_ITEM_FROM, type ApiItemRow } from "./items.ts";
import { listedCondition, seatedCondition } from "./scope.ts";
import { publicMatchCondition, searchTerms, withSearchCapacity } from "./pool.ts";
import { sharedSearch } from "../lib/cache.ts";
import { itemUrl } from "./links.ts";

export interface V1ItemPayload {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string };
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
  attribution: { name: string; url: string };
}

function v1Payload(p: {
  articleId: string; title: string; originalTitle: string | null; summary: string | null; sourceName: string; url: string;
  publishedAt: Date | null; discoveredAt: Date; category: string | null; score: number | null; selected: boolean; reason: string | null;
}): V1ItemPayload {
  const aihot = itemUrl(p.articleId);
  return {
    id: p.articleId,
    title: p.title,
    originalTitle: p.originalTitle,
    summary: p.summary,
    source: { name: p.sourceName },
    links: { aihot, original: p.url },
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    discoveredAt: p.discoveredAt.toISOString(),
    category: toPublicApiCategory(p.category),
    score: p.score === null ? null : Math.round(p.score),
    selected: p.selected,
    reason: p.selected ? p.reason : null,
    attribution: { name: SITE.name, url: aihot },
  };
}

export interface V1ItemsQuery {
  mode: "selected" | "all";
  window: "24h" | "7d";
  by: "timeline" | "published";
  category: PublicApiCategoryKey | null;
  q: string | null;
  limit: number;
  cursor: string | null;
}

export interface V1ItemsResult {
  schemaVersion: 1;
  query: { mode: string; category: string | null; window: string; q: string | null; by: string; ordering: string };
  items: V1ItemPayload[];
  page: { count: number; hasMore: boolean; nextCursor: string | null };
}

export function rowToV1(row: ApiItemRow): V1ItemPayload {
  return v1Payload({
    articleId: row.id, title: row.title, originalTitle: row.original_title, summary: row.summary, sourceName: row.source_name,
    url: row.url, publishedAt: row.published_at, discoveredAt: row.discovered_at, category: row.category,
    score: row.score === null ? null : Number(row.score), selected: row.selected, reason: row.reason,
  });
}

/** Search callers across HTTP and tools share one read. */
export const v1Items = sharedSearch(
  (q: V1ItemsQuery) => JSON.stringify([q.mode, q.window, q.by, q.category, q.q, q.limit, q.cursor]),
  queryItems, (q) => !!q.q?.trim(),
);

async function queryItems(query: V1ItemsQuery, now: Date): Promise<V1ItemsResult> {
  const windowMs = query.window === "24h" ? 86400000 : 7 * 86400000;
  const windowStart = new Date(now.getTime() - windowMs);
  const binding = queryBinding({ m: query.mode, w: query.window, b: query.by, c: query.category, q: query.q });
  // by=timeline is the site's own order: a selected item at its reading-group anchor, anything else at its timeline time.
  const sortCol = query.by === "published" ? sql`coalesce(p.published_at, p.discovered_at)` : query.mode === "selected" ? sql`p.sort_at` : sql`p.timeline_at`;
  let after: { a: number; i: string } | null = null;
  if (query.cursor) {
    const c = decodeCursor<{ a: number; i: string; c: string }>("it3", query.cursor);
    if (c.c !== binding || !Number.isSafeInteger(c.a) || !Number.isFinite(new Date(c.a).getTime())
      || typeof c.i !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.i)) throw new InvalidCursorError("cursor does not belong to this query");
    // The rolling window slid past the anchor: tell the client instead of returning an empty page.
    if (c.a < windowStart.getTime()) throw new InvalidCursorError("the rolling window moved past this cursor");
    after = { a: c.a, i: c.i };
  }
  const scope = query.mode === "selected" ? seatedCondition(now) : listedCondition(now);
  const terms = query.q ? searchTerms(query.q) : [];

  const run = (db: Db) => db<(ApiItemRow & { sort_at: Date })[]>`
    SELECT ${API_ITEM_COLUMNS}, ${sortCol} AS sort_at ${API_ITEM_FROM}
    WHERE ${scope} ${publicCategoryCondition(query.category)} ${publicMatchCondition(terms)}
      AND ${sortCol} >= ${windowStart} AND ${sortCol} <= ${now}
      ${after ? sql`AND (${sortCol}, p.article_id) < (${new Date(after.a)}, ${after.i})` : sql``}
    ORDER BY ${sortCol} DESC, p.article_id DESC
    LIMIT ${query.limit + 1}`;
  const rows = terms.length ? await withSearchCapacity(run) : await run(sql);

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = page[page.length - 1];
  return {
    schemaVersion: 1,
    query: {
      mode: query.mode, category: query.category, window: query.window, q: query.q, by: query.by,
      ordering: query.by === "published" ? "publishedAtDesc" : "timelineDesc",
    },
    items: page.map(rowToV1),
    page: {
      count: page.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor("it3", { a: last.sort_at.getTime(), i: last.id, c: binding }) : null,
    },
  };
}
