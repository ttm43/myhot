// The home page's folded 雷达. Failure modes: it is fetched before anyone opens it (a cost on every
// home view), its rows look like feed cards to the card scripts (inside <article>, or /items/ links),
// or it shows up on filtered feeds.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { FeedItemSummary, RadarResponse } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

const at = "2026-10-04T08:00:00.000Z";
const item: FeedItemSummary = { id: "feed-card", title: "精选卡片", summary: "固定摘要", reason: null, source: { name: "Fixture" }, publishedAt: at, timelineAt: at, category: "ai-models", tags: [], score: 80, selected: true };
const radar: RadarResponse = { sources: [
  { sourceId: "s135-github-trending", sourceName: "GitHub Trending", items: [
    { title: "acme / rocket", url: "https://github.com/acme/rocket", excerpt: "A tiny rocket engine.", discoveredAt: at },
    { title: "acme / quiet", url: "https://github.com/acme/quiet", excerpt: null, discoveredAt: at },
  ] },
  { sourceId: "hn", sourceName: "Hacker News", items: [{ title: "Show HN: a thing", url: "https://news.ycombinator.com/item?id=1", excerpt: null, discoveredAt: at }] },
] };

let web: WebServer;
let origin: string;
let chrome: Browser;
let radarReads = 0;

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://local");
  const p = url.pathname;
  res.setHeader("Content-Type", "application/json");
  if (p === "/api/health") return res.end("{}");
  if (p === "/api/site/radar") { radarReads++; return res.end(JSON.stringify(radar)); }
  if (p === "/api/site/timeline") {
    return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: url.searchParams.get("tag") }, cards: [{ key: item.id, anchorAt: at, item, group: null }], nextCursor: null, dayCounts: { "2026-10-04": 1 } }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  const started = await Promise.allSettled([
    startWebServer(api).then((w) => { web = w; origin = w.origin; }),
    chromium.launch({ channel: "chromium" }).then((b) => { chrome = b; }),
  ]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});

after(async () => {
  await chrome?.close();
  await web?.stop();
});

test("the radar stays folded and unread until opened, then lists each source's items as outbound links", async () => {
  const context = await chrome.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "精选卡片", exact: true })).toBeVisible();
    const details = page.locator("details", { hasText: "雷达" });
    assert.equal(await details.getAttribute("open"), null, "folded by default");
    assert.equal(radarReads, 0, "nothing is fetched before it is opened");
    await details.locator("summary").click();
    const rocket = page.getByRole("link", { name: "acme / rocket", exact: true });
    await expect(rocket).toBeVisible();
    assert.equal(radarReads, 1);
    assert.equal(await rocket.getAttribute("href"), "https://github.com/acme/rocket");
    assert.equal(await rocket.getAttribute("target"), "_blank");
    await expect(page.getByText("A tiny rocket engine.", { exact: true })).toBeVisible();
    assert.deepEqual(await details.locator("h3").allTextContents(), ["GitHub Trending", "Hacker News"], "sources in the read layer's order");
    assert.equal(await details.locator("article, a[href^='/items/']").count(), 0, "radar rows are never feed cards");
    assert.equal(await page.locator("article a[href^='/items/']").count(), 1, "the feed card is still the only card");
  } finally {
    await context.close();
  }
});

test("filtered feeds have no radar", async () => {
  const context = await chrome.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/?tag=Agent`);
    await expect(page.getByRole("link", { name: "精选卡片", exact: true })).toBeVisible();
    assert.equal(await page.locator("details", { hasText: "雷达" }).count(), 0);
  } finally {
    await context.close();
  }
});
