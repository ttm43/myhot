// Machines receive one selected seat per fact: several selected reports of one fact give MCP only the
// representative, and a better report taking over removes the old one.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { ITEM_COPY } from "@aihot/site";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { v1Items } from "@aihot/backend/publication/v1";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const MEDIA = `test-seats-media-${T}`;
const OFFICIAL = `test-seats-official-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
async function report(source: string, fact: number) {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/seats-${T}-${n}`, title: `Seat ${n} ${T}`, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, ${`理由${n}`}, 80, true, ${[`t-${T}`]})`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact}, ${articleId}, 'report')`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const mcpItems = async (mode: "selected" | "all") =>
  (await v1Items({ mode, window: "24h", by: "timeline", category: null, q: T, limit: 100, cursor: null })).items;

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  const json = /json/.test(String(res.headers["content-type"] ?? "")) ? JSON.parse(res.body) : null;
  return { status: res.statusCode, json, body: res.body };
};

test("one fact holds one selected seat on MCP", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, ${`S-${T}`}) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`seat-${T}`}, ${story!.id}, 'Acquisition') RETURNING id`;

  const first = await report(MEDIA, fact!.id);
  const second = await report(MEDIA, fact!.id);
  const official = await report(OFFICIAL, fact!.id);

  // This test's reports only.
  const items = await mcpItems("selected");
  const ours = items.map((i) => i.id).filter((id) => [first, second, official].includes(id));
  assert.deepEqual(ours, [official], "only the first-party representative");
  const all = await mcpItems("all");
  assert.deepEqual(all.filter((i) => [first, second].includes(i.id)).map((i) => i.selected), [false, false], "the others are public but not in the seat");

  // 全部动态 and the item page list every report; the ones that yield the seat say which report stands
  // for the fact, and the recommendation reason goes with the seat.
  const pool = (await get(`/api/site/pool?q=${T}`)).json.items as Array<{ id: string; reason: string | null; sameEvent?: { id: string } | null }>;
  assert.equal(pool.find((i) => i.id === first)?.sameEvent?.id, official);
  assert.equal(pool.find((i) => i.id === first)?.reason, null);
  assert.equal(pool.find((i) => i.id === official)?.sameEvent ?? null, null);
  const detail = (await get(`/api/site/items/${first}`)).json as { reason: string | null; sameEvent?: { id: string } | null };
  assert.equal(detail.sameEvent?.id, official);
  assert.equal(detail.reason, null);
  assert.ok(!(await get(`/items/${first}/markdown`)).body.includes(ITEM_COPY.reasonLabel));
  assert.ok((await get(`/items/${official}/markdown`)).body.includes(ITEM_COPY.reasonLabel));
  // The website still folds every report of the fact into the reading group.
  const home = (await get(`/api/site/timeline?limit=40&tag=${encodeURIComponent(`t-${T}`)}`)).json.cards as Array<{ item: { id: string }; group: { reportCount: number } | null }>;
  const card = home.find((c) => c.item.id === official);
  assert.equal(card?.group?.reportCount, 3);

  // A later evaluation of the same product is another news item in every selected outlet.
  // It must not replace the launch, inherit its copy, or lift its original timeline position.
  const timelineQuery = { channel: "all" as const, category: null, tag: `t-${T}`, now: new Date() };
  const before = await loadTimeline(timelineQuery);
  const [evaluation] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`evaluation-${T}`}, ${story!.id}, 'New evaluation') RETURNING id`;
  const evaluated = await report(MEDIA, evaluation!.id);
  const after = await loadTimeline({ ...timelineQuery, now: new Date() });
  assert.deepEqual(after.cards.map(c => c.item.id), [evaluated, official]);
  assert.equal(after.cards.find(c => c.item.id === official)!.anchorAt, before.cards[0]!.anchorAt);
  assert.equal(after.cards[0]!.item.source.name, 'Media');
  assert.equal(after.cards[0]!.group, null, 'one report needs no duplicate-report expansion');
  const selected = await mcpItems("selected");
  assert.deepEqual(selected.map(i => i.id), [evaluated, official]);
});
