// 雷达 at /radar. Failure modes: the rows look like feed cards to card scripts (inside <article>, or
// /items/ links); the window or the source filter does not survive in the address; the source chips
// push the phone page sideways; the home page still carries (or fetches) a radar block; the radar is
// missing from the sidebar or the phone tab bar.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { FeedItemSummary, RadarResponse } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

const generatedAt = "2026-10-04T08:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(generatedAt) - h * 3600_000).toISOString();
const row = (title: string, url: string, excerpt: string | null, hours: number) => ({ title, url, excerpt, discoveredAt: hoursAgo(hours), fresh: hours < 24 });
const item: FeedItemSummary = { id: "feed-card", title: "精选卡片", summary: "固定摘要", reason: null, source: { name: "Fixture" }, publishedAt: generatedAt, timelineAt: generatedAt, category: "ai-models", tags: [], score: 80, selected: true };
const longNames = Array.from({ length: 6 }, (_, i) => ({ sourceId: `wide-${i}`, sourceName: `一个名字相当长的只收信源 ${i}`, url: null, items: [row(`Wide ${i}`, `https://example.org/wide/${i}`, null, 30)] }));
const radar = (days: number): RadarResponse => days === 7
  ? { days: 7, sources: [] }
  : { days: 3, sources: [
    { sourceId: "s135-github-trending", sourceName: "GitHub Trending", url: "https://github.com/trending", items: [
      row("acme / rocket", "https://github.com/acme/rocket", "A tiny rocket engine.", 1),
      row("acme / quiet", "https://github.com/acme/quiet", null, 48),
    ] },
    { sourceId: "hn", sourceName: "Hacker News", url: null, items: [row("Show HN: a thing", "https://news.ycombinator.com/item?id=1", null, 5)] },
    ...longNames,
  ] };

let web: WebServer;
let origin: string;
let chrome: Browser;
const radarReads: string[] = [];

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://local");
  const p = url.pathname;
  res.setHeader("Content-Type", "application/json");
  if (p === "/api/health") return res.end("{}");
  if (p === "/api/site/radar") {
    radarReads.push(url.search);
    return res.end(JSON.stringify(radar(Number(url.searchParams.get("days") ?? 3))));
  }
  if (p === "/api/site/timeline") {
    return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: url.searchParams.get("tag") }, cards: [{ key: item.id, anchorAt: generatedAt, item, group: null }], nextCursor: null, dayCounts: { "2026-10-04": 1 } }));
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

test("the radar page lists each source's items as outbound rows, filters by source and keeps the window in the address", async () => {
  const context = await chrome.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/radar`);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "雷达", level: 1 })).toBeVisible();
    await expect(main.getByText("只收不分析的信源，原样列出，不经过模型。").filter({ visible: true })).toBeVisible();
    assert.deepEqual(await main.locator("section h2").evaluateAll((hs) => hs.map((h) => h.firstChild?.textContent)), ["GitHub Trending", "Hacker News", ...longNames.map((s) => s.sourceName)], "sources in the read layer's order");

    const rocket = main.locator("a[href='https://github.com/acme/rocket']");
    assert.equal(await rocket.innerText(), "acme / rocket");
    assert.equal(await rocket.locator(".font-semibold").innerText(), "rocket", "the repository is emphasized");
    assert.equal(await rocket.getAttribute("target"), "_blank");
    assert.match(String(await rocket.getAttribute("rel")), /noopener/);
    await expect(main.getByText("A tiny rocket engine.", { exact: true })).toBeVisible();
    const rows = main.locator("section li");
    assert.equal(await rows.filter({ hasText: "rocket" }).getByText("新", { exact: true }).count(), 1, "discovered within a day");
    assert.equal(await rows.filter({ hasText: "quiet" }).getByText("新", { exact: true }).count(), 0);
    await expect(rows.filter({ hasText: "quiet" }).locator("time")).toHaveText(/前|\d{4}-/);
    assert.equal(await main.locator("section a[href='https://github.com/trending']").count(), 1, "a listing source links to its page");
    assert.equal(await main.locator("article, a[href^='/items/']").count(), 0, "radar rows are never feed cards");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the source chips scroll inside their row, not the page (${overflow}px)`);

    await main.getByRole("link", { name: /Hacker News/ }).first().click();
    await expect(page).toHaveURL(`${origin}/radar?source=hn`);
    await expect(main.locator("section h2")).toHaveCount(1);
    await expect(main.locator("section h2")).toContainText("Hacker News");

    await main.getByRole("link", { name: "7 天", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/radar?days=7&source=hn`);
    await expect(main.getByText("近 7 天没有新条目")).toBeVisible();
    assert.ok(radarReads.includes("?days=7"), "the page asks for the seven-day window");
  } finally {
    await context.close();
  }
});

test("the radar is its own page in the navigation and no longer a block on the home page", async () => {
  const desktop = await chrome.newContext({ viewport: { width: 1280, height: 900 } });
  const phone = await chrome.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const before = radarReads.length;
    const page = await desktop.newPage();
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "精选卡片", exact: true })).toBeVisible();
    assert.equal(await page.locator("details", { hasText: "雷达" }).count(), 0, "no folded radar on the home page");
    assert.equal(await page.locator("main").getByText("只收不分析的信源").count(), 0);
    assert.equal(radarReads.length, before, "the home page does not read the radar");
    const side = page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "雷达" });
    await expect(side).toHaveAttribute("href", "/radar");
    await side.click();
    await expect(page).toHaveURL(`${origin}/radar`);
    await expect(side).toHaveAttribute("aria-current", "page");
    assert.ok(radarReads.length > before, "only the radar page reads the radar");

    const tab = (await phone.newPage());
    await tab.goto(`${origin}/`);
    const bar = tab.getByRole("navigation", { name: "底部导航" });
    await expect(bar.getByRole("link", { name: "雷达" })).toHaveAttribute("href", "/radar");
    await bar.getByRole("link", { name: "雷达" }).click();
    await expect(tab).toHaveURL(`${origin}/radar`);
    await expect(bar.getByRole("link", { name: "雷达" })).toHaveAttribute("aria-current", "page");
  } finally {
    await desktop.close();
    await phone.close();
  }
});
