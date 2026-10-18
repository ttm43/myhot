// Failure cases: two workers finish the same extraction; a report revises the article while a page
// is in flight; an obsolete empty response marks new input unconfirmed; an admin repeats extraction of
// unchanged HTML. Neither content nor revision history may go backwards.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";

const sourceId = `extract-consistency-${tag()}`;
const body = "This is the original article, with enough substantive text to extract its paragraphs. ".repeat(12);
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>>; count: number; empty: boolean };
const page = http.createServer(async (_req, res) => {
  if (--hold.count === 0) hold.entered.open();
  await hold.release.promise;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(hold.empty ? "<html><body>Empty</body></html>" : `<html><head><title>Original</title></head><body><article><h1>Original</h1><p>${body}</p></article></body></html>`);
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Extraction consistency','rss')`;
});
after(async () => { page.close(); await stopBoss(); await closeDb(); });
const reset = (count = 1, empty = false) => { hold = { entered: gate(), release: gate(), count, empty }; };
const state = async (id: string) => ({ ...(await sql`SELECT title,body_text,body_status,revision,content_hash FROM articles WHERE id=${id}`)[0] });

for (const empty of [false, true]) {
  test(`a stale page ${empty ? "empty" : "successful"} response cannot change newer material`, async () => {
    reset(1, empty);
    const material = { sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" as const };
    const { articleId } = await upsertMaterial(material);
    const pending = extractArticleBody(articleId);
    await hold.entered.promise;
    let expected;
    try {
      await upsertMaterial({ ...material, title: "Corrected report", ...(empty ? {} : { bodyText: "The corrected body supplied by the publisher." }) });
      expected = await state(articleId);
    } finally { hold.release.open(); }
    const result = await pending;
    assert.deepEqual(await state(articleId), expected, "old network results must not touch the new revision or its pending status");
    assert.equal(result, "skipped");
  });
}

test("overlapping page extractions and an unchanged admin retry create only one body revision", async () => {
  reset(2);
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" });
  const pending = [extractArticleBody(articleId), extractArticleBody(articleId)];
  await hold.entered.promise;
  hold.release.open();
  await Promise.all(pending);
  const saved = await state(articleId);
  assert.equal(saved.revision, 2, "concurrent workers must not revise identical content twice");
  reset();
  hold.release.open();
  await sql`UPDATE articles SET body_status='pending' WHERE id=${articleId}`;
  assert.equal(await extractArticleBody(articleId), "ok");
  assert.deepEqual(await state(articleId), saved);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 2);
});
