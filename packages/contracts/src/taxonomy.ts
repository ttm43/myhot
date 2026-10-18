// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, MCP) and never change.
// How MCP differs from the website is the site's (site/site.ts PUBLIC_CATEGORIES).
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { PUBLIC_CATEGORIES } from "@aihot/site";

type Category = (typeof CATEGORIES)[number];

export type CategoryKey = Category["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Website tab labels. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

const MERGE: Partial<Record<string, string>> = PUBLIC_CATEGORIES.merge;

/** The categories MCP knows: a merged category is published as the one it joins. */
export type PublicApiCategoryKey = Exclude<CategoryKey, keyof typeof PUBLIC_CATEGORIES.merge>;
export const PUBLIC_API_CATEGORY_KEYS = CATEGORIES.filter((c) => !Object.hasOwn(MERGE, c.key)).map((c) => c.key) as unknown as readonly [PublicApiCategoryKey, ...PublicApiCategoryKey[]];

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  const c = CATEGORIES.find((x) => x.key === category);
  if (!c) return null;
  return (MERGE[c.key] ?? c.key) as PublicApiCategoryKey;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部",
  news: "资讯",
  x: "X",
  firstParty: "一手",
};

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
