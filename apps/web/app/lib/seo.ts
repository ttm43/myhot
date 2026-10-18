// Page metadata from one place: title template, canonical address, share preview, robots; and list addresses,
// with the feed filters they carry. The site's name and wording come from site/site.ts;
//; its address from SITE_URL.
import type { MetaDescriptor } from "react-router";
import type { TimelineFilters } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { SITE, subjectAfter, withSubject } from "@aihot/site";

/**
 * The site's address: SITE_URL while rendering on the server (what crawlers and share previews read),
 * the page's own origin in the browser.
 */
export function siteUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return (process.env.SITE_URL || SITE.defaultUrl).replace(/\/+$/, "");
}

const HOME_TITLE = SITE.homeTitle;
const SITE_DESCRIPTION = SITE.description;

export interface PageMetaInput {
  title?: string | null;
  /** Use `title` verbatim as the document title (no " · <site>" suffix). */
  rawTitle?: boolean;
  description?: string | null;
  path: string;
  noindex?: boolean;
  nofollow?: boolean;
  type?: "website" | "article";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
}

/**
 * A list's address from the parameters it applied (unset ones left out): a page's own address (canonical,
 * og:url), and the api list it reads. Tracking and unknown parameters (`?from=timeline`, `utm_*`) never
 * become part of it. The page caches keep one copy across such parameters, so the address in that copy
 * must not depend on them either.
 */
export function listPath(path: string, params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The feed filters an address asks for; an unknown channel or category means none. */
export function readFilters(params: URLSearchParams): TimelineFilters {
  const channel = params.get("channel") ?? "all";
  const category = params.get("category");
  return {
    channel: isChannelKey(channel) ? channel : "all",
    category: category && isCategoryKey(category) ? category : null,
    tag: params.get("tag")?.trim() || null,
  };
}

/** Feed filters as list address parameters: the default channel and unset filters are left out. */
export function filterParams(f: TimelineFilters) {
  return { channel: f.channel === "all" ? null : f.channel, category: f.category, tag: f.tag };
}

/** Filter combinations are browsing views; the unfiltered feed and its archive pages remain indexable. */
export function hasFeedFilters(filters: TimelineFilters | undefined): boolean {
  return !!filters && (filters.channel !== "all" || !!filters.category || !!filters.tag);
}

/** "Title · Site". */
export function titled(title: string): string {
  return `${title} · ${SITE.name}`;
}

export function pageMeta(input: PageMetaInput): MetaDescriptor[] {
  const base = siteUrl();
  const title = input.title ? (input.rawTitle ? input.title : titled(input.title)) : HOME_TITLE;
  const description = input.description ?? SITE_DESCRIPTION;
  const url = `${base}${input.path}`;
  // Share previews show the site icon: there are no generated share images.
  const image = `${base}/icon.png`;
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:site_name", content: SITE.name },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: input.title ?? HOME_TITLE },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "512" },
    { property: "og:image:height", content: "512" },
    { property: "og:locale", content: SITE.locale.replace("-", "_") },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: input.title ?? HOME_TITLE },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  if (input.noindex) tags.push({ name: "robots", content: input.nofollow ? "noindex, nofollow" : "noindex, follow" });
  if (input.jsonLd) tags.push({ "script:ld+json": input.jsonLd });
  return tags;
}

export function organizationLd() {
  const base = siteUrl();
  const founder = SITE.organization.founder;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${base}/#organization`,
    name: SITE.organization.name,
    url: base,
    logo: `${base}/icon.png`,
    ...(founder ? {
      founder: {
        "@type": "Person",
        name: founder.name,
        ...(founder.alternateName ? { alternateName: founder.alternateName } : {}),
        ...(founder.jobTitle ? { jobTitle: founder.jobTitle } : {}),
        ...(founder.description ? { description: founder.description } : {}),
        ...(founder.url ? { sameAs: [founder.url] } : {}),
      },
    } : {}),
  };
}

export function breadcrumbLd(items: Array<{ name: string; path: string }>) {
  const base = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: `${base}${it.path}` })),
  };
}

const orgRef = () => ({ "@id": `${siteUrl()}/#organization` });

/**
 * The home page's machine description: the site, and the site as a dataset with its feeds and API.
 * Model-written content never names a person as its author.
 */
export function siteLd() {
  const base = siteUrl();
  return [
    organizationLd(),
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${base}/#website`,
      name: SITE.name,
      url: base,
      description: SITE_DESCRIPTION,
      inLanguage: SITE.locale,
      publisher: orgRef(),
    },
  ];
}

/**
 * A list's entries by their visible titles. No entry URLs: item pages are mostly noindex, and a
 * list item must point at an indexable page; the list itself is the signal.
 */
export function itemListLd(path: string, name: string, titles: string[]) {
  const names = titles.slice(0, 30);
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${SITE.name} · ${name}`,
    url: `${siteUrl()}${path}`,
    numberOfItems: names.length,
    itemListElement: names.map((n, i) => ({ "@type": "ListItem", position: i + 1, name: n })),
  };
}

/** An item page: the site's reading of a third-party report, based on (not claiming) the original. */
export function articleLd(input: { path: string; headline: string; description?: string | null; publishedAt?: string | null; modifiedAt?: string | null; image?: string | null; basedOn?: string | null; section?: string[] }) {
  const base = siteUrl();
  const url = `${base}${input.path}`;
  const description = input.description?.trim();
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "@id": `${url}#article`,
    isPartOf: { "@id": `${base}/#website` },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline: input.headline.slice(0, 110),
    ...(description ? { description: description.slice(0, 300) } : {}),
    inLanguage: SITE.locale,
    ...(input.publishedAt ? { datePublished: input.publishedAt } : {}),
    ...(input.modifiedAt ? { dateModified: input.modifiedAt } : {}),
    ...(input.image ? { image: new URL(input.image, base).href } : {}),
    ...(input.section?.length ? { articleSection: input.section } : {}),
    isAccessibleForFree: true,
    author: orgRef(),
    publisher: orgRef(),
    ...(input.basedOn ? { isBasedOn: input.basedOn } : {}),
  };
}

/** A topic page: the collection, when a report last reached it, and the lists its parts show. */
export function topicLd(input: {
  path: string;
  name: string;
  description: string;
  dateModified: string | null;
  lists: Array<{ name: string; entries: Array<{ title: string; href: string | null }> }>;
}) {
  const base = siteUrl();
  const url = `${base}${input.path}`;
  // Entries name their event page when they have one (event pages are indexable, most article pages are not).
  const lists = input.lists.filter((l) => l.entries.length > 0).map((l) => ({
    "@type": "ItemList",
    name: `${input.name} · ${l.name}`,
    numberOfItems: l.entries.length,
    itemListElement: l.entries.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: e.title,
      ...(e.href?.startsWith("/story/") ? { url: `${base}${e.href}` } : {}),
    })),
  }));
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    url,
    name: input.name,
    description: input.description,
    inLanguage: SITE.locale,
    isPartOf: { "@id": `${base}/#website` },
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    ...(lists.length > 0 ? { mainEntity: lists.length === 1 ? lists[0] : lists } : {}),
  };
}
