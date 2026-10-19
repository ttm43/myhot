// local patch: the stored text of an article, looked up by its original URL, for the owner's own tools
// (autored's realitycheck) that would otherwise fetch the page again. Token-gated like the push route.
import { sql } from "../db.ts";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";

export interface ArticleText {
  id: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string | null;
  body: string | null;
}

/** The newest article whose URL or identity key matches; null when none does or the URL is not one. */
export async function articleText(input: string): Promise<ArticleText | null> {
  const url = normalizeUrl(input);
  if (!url) return null;
  const keys = [identityKeyForUrl(input), identityKeyForUrl(input, { keepFragment: true })].filter((k): k is string => !!k);
  const [row] = await sql<{ id: string; url: string; title: string; source: string; published_at: Date | null; body_text: string | null }[]>`
    SELECT a.id, a.url, a.title, s.name AS source, a.published_at, a.body_text
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.url IN (${input}, ${url}) ${keys.length ? sql`OR a.identity_key IN ${sql(keys)}` : sql``}
    ORDER BY a.discovered_at DESC, a.id LIMIT 1`;
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    source: row.source,
    publishedAt: row.published_at?.toISOString() ?? null,
    body: row.body_text?.trim() || null,
  };
}
