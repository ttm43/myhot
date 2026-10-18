// First-party site API (/api/site/*). Not a public API: it may evolve with the website,
// but it is served from the same public read layer as MCP.
import type { CategoryKey, ChannelKey } from "./taxonomy.ts";

export interface SourceRef {
  /** The name readers see (publication/rules.ts publicSourceName), as is every source name here. */
  name: string;
}

export interface MediaView {
  kind: "image" | "video";
  url: string;
  /** Full image for an on-demand viewer; list previews stay small. */
  fullUrl?: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  poster: string | null;
  srcSet?: string;
}

export interface XPostView {
  authorName: string;
  handle: string;
  avatarUrl: string | null;
  avatarSrcSet?: string;
  text: string;
  quoted: { authorName: string; handle: string; text: string; url: string } | null;
  media: MediaView[];
}

/** What every site answer about an article carries; a card and a page each add the X post in their own form. */
export interface ItemSummary {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  reason: string | null;
  source: SourceRef;
  links: { original: string };
  publishedAt: string | null;
  discoveredAt: string;
  timelineAt: string;
  category: CategoryKey | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
}

/** The fields rendered by a site feed card; full original text lives in the item detail. */
export interface FeedItemSummary extends Pick<ItemSummary, "id" | "title" | "summary" | "reason" | "source" | "publishedAt" | "timelineAt" | "category" | "tags" | "score" | "selected" | "channel"> {
  x: (Pick<XPostView, "authorName" | "handle" | "avatarUrl" | "avatarSrcSet" | "media"> & {
    quoted: Omit<NonNullable<XPostView["quoted"]>, "url"> | null;
  }) | null;
  /**
   * A selected report whose fact is represented by another report (全部动态 and search): that report,
   * so the card can say "同一新闻，精选展示《…》" instead of claiming a seat of its own.
   */
  sameEvent?: { id: string; title: string } | null;
}

export interface GroupInfo {
  factId: string;
  /** Other public sources reporting this same news fact, under the current filters. */
  additionalSourceCount: number;
  /** Distinct public reports of this fact. */
  reportCount: number;
  /**
   * The selected reports of this fact under the current filters. The timeline's reader-side unread
   * filter keeps a group while any of them is unread; the timeline fills it, other callers omit it.
   */
  memberIds?: string[];
}

export interface TimelineCard {
  key: string;
  anchorAt: string;
  item: FeedItemSummary;
  group: GroupInfo | null;
}

export interface TimelineFilters {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
}

export interface TimelineResponse {
  filters: TimelineFilters;
  cards: TimelineCard[];
  nextCursor: string | null;
  dayCounts: Record<string, number>;
}

export interface PoolResponse {
  filters: TimelineFilters & { q: string | null; tab: "time" | "relevance" };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  total: number;
  todayCount: number;
  freshness: string;
}

export interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

/** An article page (/api/site/items/:id): its body as written, with its outline. */
export interface SiteItemDetail extends ItemSummary {
  /** The post with all its media; its text is the body. */
  x: Omit<XPostView, "text"> | null;
  /** Selected, but its fact's seat is held by this report: marked 同新闻, without a reason of its own. */
  sameEvent?: { id: string; title: string } | null;
  readingMode: "full" | "summary-only";
  author: string | null;
  /** Whitelisted HTML. */
  body: string | null;
  outline: OutlineEntry[];
  markdownAvailable: boolean;
  group: GroupInfo | null;
}

/** A fact's public reports under the list's filters: what "另有 N 家信源报道" opens. */
export interface GroupReport {
  id: string;
  title: string;
  source: SourceRef;
  timelineAt: string;
  originalUrl: string;
}

/** The home page's 雷达 (/api/site/radar): raw recent items of the collect-only sources, by source. */
export interface RadarItem {
  title: string;
  /** The original link. */
  url: string;
  excerpt: string | null;
  discoveredAt: string;
}

export interface RadarResponse {
  sources: Array<{ sourceId: string; sourceName: string; items: RadarItem[] }>;
}

export interface GroupReportsResponse {
  factId: string;
  reports: GroupReport[];
}

