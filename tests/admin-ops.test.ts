// Operations that must act on what they were meant for: releasing an unknown receipt of any analysis
// step puts its article back into processing.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-ops-${T}`;
after(async () => {
  await stopBoss();
  await closeDb();
});

let n = 0;
async function article(selected = false) {
  n += 1;
  if (n === 1) await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Ops', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/ops-${T}-${n}`, title: `Ops ${n} ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  if (selected) {
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
              VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, 90, true)`;
  }
  return articleId;
}

test("releasing an unknown receipt of an analysis step puts the article back", async () => {
  const id = await article();
  await sql`UPDATE articles SET processing_state = 'failed', processing_error = 'receipt outcome unknown' WHERE id = ${id}`;
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, subject, status) VALUES (${`test-${T}`}, 'glm', 'score_article', ${`article:${id}@1`}, 'unknown') RETURNING id`;
  const out = await releaseReceipt(r!.id, { billed: false, note: "checked" }, "test");
  assert.equal(out?.requeued, true);
  const [a] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.notEqual(a!.processing_state, "failed");
});
