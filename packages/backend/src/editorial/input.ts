// What the judging steps read about an article: loaded once per analysis and rendered per step.
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { collapseWhitespace, truncate } from "../lib/text.ts";
import { MAX_BODY_CHARS } from "./writing.ts";

export interface AnalyzeInputArticle {
  id: string;
  revision: number;
  title: string;
  url: string;
  author: string | null;
  publishedAt: Date | null;
  /** When the site first saw it; never evidence of when the source published it. */
  discoveredAt?: Date | null;
  bodyText: string | null;
  excerpt: string | null;
  /** pending: no body fetched yet; ok; unconfirmed: fetching failed; none. */
  bodyStatus?: string;
  media: Array<Record<string, any>>;
  source: {
    name: string;
    kind: string;
    tier: string;
    firstParty: boolean;
    tags?: string[];
    ownerEntityId?: string | null;
    /** The source asks for the article page (fetchPublicContent, detail pages, web listings). */
    fetchesBody?: boolean;
  };
}

export async function loadAnalyzeInput(articleId: string): Promise<AnalyzeInputArticle | null> {
  const [row] = await sql<{
    id: string; revision: number; title: string; url: string; author: string | null; published_at: Date | null; discovered_at: Date;
    body_text: string | null; excerpt: string | null; body_status: string;
    media: Array<Record<string, any>>; source_name: string; source_kind: string; tier: string; first_party: boolean; source_tags: string[]; owner_entity_id: string | null;
    config: Record<string, any>;
  }[]>`
    SELECT a.id, a.revision, a.title, a.url, a.author, a.published_at, a.discovered_at, a.body_text, a.excerpt, a.body_status, a.media,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.first_party, s.tags AS source_tags, s.owner_entity_id, s.config
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.id = ${articleId}`;
  if (!row) return null;
  return {
    id: row.id, revision: row.revision, title: row.title, url: row.url, author: row.author, publishedAt: row.published_at, discoveredAt: row.discovered_at,
    bodyText: row.body_text, excerpt: row.excerpt, bodyStatus: row.body_status, media: row.media,
    source: {
      name: row.source_name, kind: row.source_kind, tier: row.tier, firstParty: row.tier === "T1", tags: row.source_tags, ownerEntityId: row.owner_entity_id,
      fetchesBody: row.config?.fetchPublicContent === true || !!row.config?.detail || row.source_kind === "web_list",
    },
  };
}

const KIND_LABEL: Record<string, string> = {
  rss: "RSS", web_list: "网页", json_list: "网页接口", external: "外部上报",
};

/** The material as the structure step reads it (source facts, text, link). */
export function buildMaterial(a: AnalyzeInputArticle): string {
  // Conditions often occur at the end of an announcement. Use the existing body budget instead of
  // only its lead; beyond it, state the missing tail so it is not mistaken for complete evidence.
  const body = (text: string) => text.length <= MAX_BODY_CHARS ? text : `${text.slice(0, MAX_BODY_CHARS)}\n【原文超过 ${MAX_BODY_CHARS} 字符，后文未提供】`;
  const lines: string[] = [];
  lines.push("<source>");
  lines.push(`名称：${a.source.name}`);
  lines.push(`类型：${KIND_LABEL[a.source.kind] ?? a.source.kind}；分级：${a.source.tier}；一手来源：${a.source.firstParty ? "是" : "否"}`);
  lines.push("</source>");
  lines.push("<material>");
  if (a.publishedAt) lines.push(`发布时间：${beijingDate(a.publishedAt)} ${beijingTime(a.publishedAt)}（北京时间）`);
  if (a.author) lines.push(`作者：${a.author}`);
  lines.push(`标题：${collapseWhitespace(a.title)}`);
  const original = a.bodyText ?? a.excerpt ?? "";
  lines.push(original ? `正文：\n${body(original)}` : "正文：（无）");
  lines.push(`原文链接：${a.url}`);
  lines.push("</material>");
  return lines.join("\n");
}
