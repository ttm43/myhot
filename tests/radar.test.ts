// The home page's 雷达 reads the collect-only sources raw. Failure cases: editorial, paused or old
// material leaks in; a listing that repeats a URL shows it twice; a withdrawn item stays; one busy
// source crowds out the rest; the pinned source is not first.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadRadar } from "@aihot/backend/publication/radar";
import { RADAR } from "@aihot/site";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const app = await buildApp();
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000);
const PINNED = RADAR.pinned[0]!;
const busy = `radar-busy-${T}`, quiet = `radar-quiet-${T}`, paused = `radar-paused-${T}`, editorial = `radar-editorial-${T}`;
let n = 0;

async function item(sourceId: string, hours: number, url = `https://example.org/${T}/${++n}`, extra: { excerpt?: string; withdrawn?: boolean } = {}) {
  const id = `radar-${T}-${++n}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, excerpt, timeline_at, discovered_at)
    VALUES (${id}, ${sourceId}, ${id}, ${url}, ${`Item ${n}`}, ${extra.excerpt ?? null}, ${ago(hours)}, ${ago(hours)})`;
  if (extra.withdrawn) {
    await sql`INSERT INTO publications (article_id, source_id, title, url, timeline_at, discovered_at, sort_at, visibility, body_mode)
      VALUES (${id}, ${sourceId}, ${`Item ${n}`}, ${url}, ${ago(hours)}, ${ago(hours)}, ${ago(hours)}, 'withdrawn', 'summary')`;
  }
  return { id, url };
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
    (${busy}, 'Busy signal（备注）', 'rss', 'T2', 'hot_signal', true, '2100-01-01'),
    (${quiet}, 'Quiet signal', 'rss', 'T2', 'hot_signal', true, '2100-01-01'),
    (${paused}, 'Paused signal', 'rss', 'T2', 'hot_signal', false, '2100-01-01'),
    (${editorial}, 'Editorial', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${PINNED}, 'Pinned signal', 'web_list', 'T2', 'hot_signal', true, '2100-01-01')
    ON CONFLICT (id) DO NOTHING`;
  for (let i = 0; i < 12; i++) await item(busy, 1 + i);
  await item(quiet, 0.5, undefined, { excerpt: "  A short description.  " });
  const repeated = `https://example.org/${T}/repeated`;
  await item(quiet, 30, repeated);
  await item(quiet, 2, repeated);
  await item(quiet, 3, undefined, { withdrawn: true });
  await item(quiet, 80);
  await item(paused, 1);
  await item(editorial, 1);
  await item(PINNED, 50, `https://example.org/${T}/pinned`);
});
after(async () => { await app.close(); await closeDb(); });

test("radar lists recent items of enabled collect-only sources, by source, deduplicated and capped", async () => {
  const { sources } = await loadRadar(now);
  const ids = sources.map((s) => s.sourceId);
  assert.equal(ids[0], PINNED, "the pinned source comes first even with older items");
  assert.ok(!ids.includes(paused) && !ids.includes(editorial), "paused and editorial sources stay out");
  assert.ok(ids.indexOf(quiet) < ids.indexOf(busy), "the others follow their latest item");
  const busyGroup = sources.find((s) => s.sourceId === busy)!;
  assert.equal(busyGroup.sourceName, "Busy signal", "readers see the public source name");
  assert.equal(busyGroup.items.length, 10);
  assert.deepEqual(busyGroup.items.map((i) => i.title), Array.from({ length: 10 }, (_, i) => `Item ${2 * i + 2}`), "newest first");
  const quietGroup = sources.find((s) => s.sourceId === quiet)!;
  assert.deepEqual(quietGroup.items.map((i) => [i.url.endsWith("/repeated") ? "repeated" : i.title, i.excerpt]), [
    ["Item 26", "A short description."],
    ["repeated", null],
  ], "one row per URL (its latest discovery); withdrawn and older than three days are left out");
  assert.equal(quietGroup.items[1]!.discoveredAt, ago(2).toISOString());
});

test("the site route answers the radar with the site routes' caching", async () => {
  const first = await app.inject({ method: "GET", url: "/api/site/radar" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["cache-control"], "public, max-age=60, s-maxage=60");
  assert.ok(first.headers.etag);
  assert.ok((first.json() as { sources: Array<{ sourceId: string }> }).sources.some((s) => s.sourceId === quiet));
  const again = await app.inject({ method: "GET", url: "/api/site/radar", headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(again.statusCode, 304);
});
