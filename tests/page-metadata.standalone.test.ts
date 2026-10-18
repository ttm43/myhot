/// <reference lib="dom" />
// Failure modes recorded before the metadata change:
// - filtered/search feeds compete with their parent or canonicalize to different content;
// - tracking and obsolete positioning parameters leak into canonical, or ordinary archives become noindex;
// - an article invents a modification date from its source's publication date;
// - a story has no machine-readable subject, or claims its first report is its own publication date.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import type { FeedItemSummary, SiteItemDetail, StoryDetail } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { articleLd, readFilters } from "../apps/web/app/lib/seo.ts";
import { startWebServer, type WebServer } from "../apps/web/tests/web-server.ts";

const at = "2026-10-04T08:00:00.000Z";
const item: FeedItemSummary = { id: "metadata-fixture", title: "可核实的测试报道", summary: "报道摘要", reason: null, source: { name: "Fixture" }, publishedAt: at, timelineAt: at, category: "ai-models", tags: [], score: 80, selected: true, channel: "news", x: null };
const detail: SiteItemDetail = { ...item, x: null, originalTitle: null, links: { original: "https://example.org/report" }, discoveredAt: at, story: null, readingMode: "full", author: null, body: { zh: "<p>可核实的测试正文。</p>", original: null, zhKind: "original", complete: true }, outline: [], relatedStories: [], topics: [], markdownAvailable: true, group: null, hasTranslation: false, bodyLanguage: "zh" };
const story: StoryDetail = { publicId: "metadata-story", title: "测试事件的最新进展", status: "settled", reportCount: 1, sourceCount: 1, firstReportAt: at, latestAt: at, digest: "当前可核实的事件综述。", digestUpdatedAt: "2026-10-04T09:00:00.000Z", summary: null, excerpt: null, latest: null, latestReport: null, whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null }, developments: [], officialReports: [], timeline: [{ id: item.id, title: item.title, summary: item.summary, source: { name: item.source.name, firstParty: true }, publishedAt: at, selected: true }], heat: [], related: [], topics: [] };
let web: WebServer;
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://local");
  const path = url.pathname;
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (path === "/api/site/timeline") return send({ filters: readFilters(url.searchParams), cards: [{ key: item.id, anchorAt: at, item, group: null }], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 1 } });
  if (path === "/api/site/pool") return send({ filters: { ...readFilters(url.searchParams), q: url.searchParams.get("q"), tab: url.searchParams.get("tab") ?? "time" }, items: [item], page: Number(url.searchParams.get("page") ?? 1), pageCount: 3, total: 100, todayCount: 1, freshness: at });
  if (path === `/api/site/items/${item.id}`) return send(detail);
  if (path === `/api/site/stories/${story.publicId}`) return send(story);
  res.statusCode = 404;
  send({ code: "not_found" });
});
before(async () => { web = await startWebServer(api); });
after(async () => { await web?.stop(); });

async function page(path: string) {
  const response = await fetch(`${web.origin}${path}`);
  assert.equal(response.status, 200, web.logs());
  return cheerio.load(await response.text());
}
function structured($: cheerio.CheerioAPI): Array<Record<string, unknown>> {
  return $("script[type='application/ld+json']").toArray().flatMap((node) => JSON.parse($(node).text()));
}

test("filtered feeds keep their exact content address but leave indexing to the public landing pages", async () => {
  for (const base of ["/", "/all"]) for (const query of ["channel=news", "category=ai-models", "tag=Agent", "channel=x&category=paper&tag=Agent"]) {
    const $ = await page(`${base}?${query}&utm_source=fixture&anchorAt=old&deep=1`);
    assert.equal($("meta[name=robots]").attr("content"), "noindex, follow", `${base}?${query}`);
    assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}${base}?${query}`);
    assert.ok($("main").text().includes(item.title));
  }
  const $ = await page("/all?q=Claude&tab=relevance&page=2&anchorAt=old");
  assert.equal($("meta[name=robots]").attr("content"), "noindex, follow");
  assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}/all?q=Claude&tab=relevance&page=2`);
});

test("ordinary feed pages remain indexable and normalize ignored parameters", async () => {
  for (const [requested, canonical] of [["/?channel=invalid&category=invalid&tag=%20&utm_source=fixture", "/"], ["/all?channel=all&tab=relevance&anchorAt=old&page=2&utm_source=fixture", "/all?page=2"]]) {
    const $ = await page(requested!);
    assert.equal($("meta[name=robots]").attr("content"), undefined);
    assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}${canonical}`);
    if (canonical?.includes("page=2")) assert.match($("title").text(), /第 2 页/);
  }
});

test("article metadata does not invent an update timestamp", async () => {
  const $ = await page(`/items/${item.id}`);
  const article = structured($).find((entry) => entry["@type"] === "NewsArticle")!;
  assert.equal(article.datePublished, at);
  assert.equal("dateModified" in article, false);
  assert.equal(article.isBasedOn, detail.links.original);
  assert.deepEqual(article.author, { "@id": `${web.origin}/#organization` });
  const modified = "2026-10-04T10:00:00.000Z";
  assert.equal(articleLd({ path: "/items/test", headline: "更正", modifiedAt: modified }).dateModified, modified);
});

test("story metadata describes the visible collection, current summary and report list", async () => {
  const $ = await page(`/story/${story.publicId}`);
  const collection = structured($).find((entry) => entry["@type"] === "CollectionPage")!;
  assert.ok(collection);
  assert.equal(collection.name, story.title);
  assert.equal(collection.description, story.digest);
  assert.equal(collection.dateModified, story.digestUpdatedAt);
  assert.equal("datePublished" in collection, false);
  const list = collection.mainEntity as { itemListElement: Array<{ name: string }> };
  assert.deepEqual(list.itemListElement.map((entry) => entry.name), [item.title]);
  assert.ok($("main").text().includes(story.digest!));
});
