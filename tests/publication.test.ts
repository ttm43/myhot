// Public scope through the real api routes: a licence revocation or a withdrawal reaches every exit,
// the hot board drops a withdrawn item at once, and item pages follow one rule.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { marked } from "marked";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { overrideFields, setVisibility } from "@aihot/backend/admin/content";
import { updateSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { latestHotRanking } from "@aihot/backend/publication/hot";
import { v1Items } from "@aihot/backend/publication/v1";
import { loadItemShare } from "@aihot/backend/publication/og";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-publication-${T}`;
const BODY = `FULLTEXT-${T} `.repeat(40);
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test publication', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A selected article with full text and a summary. */
async function article(): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${n}`, title: `Test ${n}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${`标题${n}-${T}`}, ${`SUMMARY-${n}-${T}`}, '理由', 90, true)`;
  return articleId;
}

async function storyFor(id: string, role: "report" | "mention" = "report"): Promise<string> {
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`STORY-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${publicId}`}, ${story!.id}, ${`FACT-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, ${role})`;
  return publicId;
}

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.body, etag: res.headers.etag as string | undefined };
}

// Failure modes: a revoked score falls back to the erroneous model score, zero is treated as
// missing, republishing loses a correction, invalid scores or stale edits alter public state,
// or removing a correction cannot restore the saved model result without paying again.
test("manual score corrections, including no score, survive every public projection and rebuild", async () => {
  const id = await article();
  await sql`UPDATE articles SET grouping_status = 'complete' WHERE id = ${id}`;
  await publishArticle(id, released());
  assert.equal(JSON.parse((await get(`/api/site/items/${id}`)).body).score, 90);
  for (const score of [-1, 101, "0", Number.NaN]) {
    await assert.rejects(overrideFields(id, { fields: { score }, reason: "invalid score", version: 0 }, "test"));
  }
  await overrideFields(id, { fields: { score: null, selected: false }, reason: "unsupported launch revoked", version: 0 }, "test");
  await publishArticle(id);
  const detail = JSON.parse((await get(`/api/site/items/${id}`)).body);
  assert.equal(detail.score, null);
  assert.equal(detail.selected, false);
  const items = (await v1Items({ mode: "all", window: "24h", by: "timeline", category: null, q: detail.title, limit: 10, cursor: null })).items;
  assert.equal(items.find((i) => i.id === id)?.score, null);
  assert.equal((await loadItemShare(id))?.score, null);
  assert.equal(Number((await sql`SELECT score FROM analyses WHERE article_id = ${id}`)[0]!.score), 90, "the paid result stays intact");
  await assert.rejects(overrideFields(id, { fields: { score: 99 }, reason: "stale correction", version: 0 }, "test"));
  await overrideFields(id, { fields: { score: 0 }, reason: "verified zero score", version: 1 }, "test");
  assert.equal(JSON.parse((await get(`/api/site/items/${id}`)).body).score, 0);
  await overrideFields(id, { fields: {}, clear: ["score"], reason: "restore saved scoring", version: 2 }, "test");
  assert.equal(JSON.parse((await get(`/api/site/items/${id}`)).body).score, 90);
});

// Export failures to guard before changing conversion: flattened table relationships, invented
// headings/merged cells, lost numeric units, and full text leaking after a licence reduction.
test("Markdown preserves a table's headings, caption, links, alignment and multiline cells in both languages", async () => {
  const id = await article();
  const table = '<table><caption>Benchmark results</caption><thead><tr><th>Model</th><th align="right">Score</th></tr></thead><tbody><tr><td><a href="https://example.com/model">A|B</a></td><td>90<br>±1</td></tr></tbody></table>';
  await sql`UPDATE articles SET language = 'en', body_html = ${table} WHERE id = ${id}`;
  await sql`INSERT INTO translations (article_id, revision, body_html, body_text, origin) VALUES (${id}, 1, ${table.replace('Benchmark results', '基准结果').replace('Model', '模型').replace('Score', '分数')}, '基准结果', 'source')`;
  await publishArticle(id, released());
  const response = await get(`/items/${id}/markdown`);
  assert.equal(response.status, 200);
  const $ = cheerio.load(marked.parse(response.body, { async: false, gfm: true }));
  assert.equal($('table').length, 2, 'both original and translated tables survive export');
  assert.deepEqual($('table th').toArray().map((node) => $(node).text()), ['模型', '分数', 'Model', 'Score']);
  assert.equal($('table th').last().attr('align'), 'right');
  assert.equal($('table td a').last().text(), 'A|B');
  assert.equal($('table td a').last().attr('href'), 'https://example.com/model');
  assert.equal($('table td').last().find('br').length, 1);
  assert.ok($.text().includes('基准结果') && $.text().includes('Benchmark results'));
});

test("Markdown retains tables that cannot be represented without changing their meaning", async () => {
  const id = await article();
  const html = '<table><tr><td>Region</td><td>Value</td></tr><tr><td>CN</td><td>1</td></tr></table><table><tr><th colspan="2">Merged</th></tr><tr><td rowspan="2">A</td><td>2</td></tr><tr><td>3</td></tr></table><table><tr><th>Example</th></tr><tr><td><pre><code class="language-python">print(1)\nprint(2)</code></pre></td></tr></table>';
  await sql`UPDATE articles SET language = 'zh', body_html = ${html} WHERE id = ${id}`;
  await publishArticle(id, released());
  const $ = cheerio.load(marked.parse((await get(`/items/${id}/markdown`)).body, { async: false, gfm: true }));
  assert.equal($('table').length, 3);
  assert.equal($('table').first().find('th').length, 0, 'a data row must not become an invented heading');
  assert.equal($('th[colspan="2"]').text(), 'Merged');
  assert.equal($('td[rowspan="2"]').text(), 'A');
  assert.equal($('table pre code').text(), 'print(1)\nprint(2)');
});

test("Markdown retains numeric superscripts, subscripts and fenced code while respecting full-text permission", async () => {
  const id = await article();
  const html = '<p>Compute 10<sup>24</sup> FLOP; H<sub>2</sub>O.</p><pre><code class="language-python">print(2 ** 3)\n</code></pre>';
  await sql`UPDATE articles SET language = 'zh', body_html = ${html} WHERE id = ${id}`;
  await publishArticle(id, released());
  const response = await get(`/items/${id}/markdown`);
  const $ = cheerio.load(marked.parse(response.body, { async: false, gfm: true }));
  assert.equal($('sup').text(), '24');
  assert.equal($('sub').text(), '2');
  assert.equal($('pre code').attr('class'), 'language-python');
  assert.equal($('pre code').text(), 'print(2 ** 3)\n');
  await sql`UPDATE sources SET site_fulltext = false WHERE id = ${SOURCE}`;
  await publishArticle(id, released());
  const limited = await get(`/items/${id}/markdown`);
  assert.equal(limited.status, 200);
  assert.ok(limited.body.includes('SUMMARY-'));
  assert.ok(!limited.body.includes('FLOP') && !limited.body.includes('print(2'));
  await sql`UPDATE sources SET site_fulltext = true WHERE id = ${SOURCE}`;
});

test("site reading sends one language while exports retain both, including after withdrawal", async () => {
  const id = await article();
  await sql`UPDATE articles SET language = 'en', body_html = '<h2>Original heading</h2><p>Original full body</p>' WHERE id = ${id}`;
  await sql`INSERT INTO translations (article_id, revision, body_html, body_text, origin) VALUES (${id}, 1, '<h2>译文标题</h2><p>中文完整正文</p>', '中文完整正文', 'source')`;
  await publishArticle(id, released());
  const normal = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const original = JSON.parse((await get(`/api/site/items/${id}/original`)).body);
  assert.equal(normal.bodyLanguage, 'zh');
  assert.equal(normal.hasTranslation, true);
  assert.equal(normal.body.original, null);
  assert.ok(normal.body.zh.includes('中文完整正文'));
  assert.equal(normal.outline[0].text, '译文标题');
  assert.equal(original.bodyLanguage, 'original');
  assert.equal(original.body.zh, null);
  assert.ok(original.body.original.includes('Original full body'));
  assert.equal(original.outline[0].text, 'Original heading');
  const md = (await get(`/items/${id}/markdown`)).body;
  assert.ok(md.includes('Original full body') && md.includes('中文完整正文'));
  await setVisibility(id, { visibility: 'withdrawn', reason: 'test', version: 0 }, 'test');
  assert.equal((await get(`/api/site/items/${id}/original`)).status, 404);
});

test("revoking a source's licence takes its articles off every exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const story = await storyFor(id);
  assert.equal((await get(`/api/site/items/${id}`)).status, 200);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 200);

  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${SOURCE}`;
  const patch = { participation_mode: "isolated", site_fulltext: false };
  await updateSource(SOURCE, { patch, version: source!.updated_at.toISOString(), reason: "test" }, "test");
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${`republish.source:${SOURCE}`}`;
  assert.equal(queued?.value.status, "queued", "the admin change queues a background republish");

  const result = await republishSource(SOURCE); // what the queued job runs
  assert.ok(result.reduced >= 1);
  assert.equal((await get(`/api/site/items/${id}`)).status, 404);
  assert.equal((await get(`/items/${id}/markdown`)).status, 404);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 404, "the story drops an isolated source's last report");

  await sql`UPDATE sources SET participation_mode = 'editorial', site_fulltext = true WHERE id = ${SOURCE}`;
});

test("story changes refresh share images and a withdrawal takes down only the stories citing it", async () => {
  const id = await article();
  await publishArticle(id, released());
  const stories = [await storyFor(id), await storyFor(id, "mention")];
  const other = await article();
  await publishArticle(other, released());
  const unrelated = await storyFor(other);
  const imageUrl = `/og/stories/${stories[0]}.png`;
  const image = await app.inject({ method: "GET", url: imageUrl });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  const cachedImage = await app.inject({ method: "GET", url: imageUrl, headers: { "if-none-match": String(image.headers.etag) } });
  assert.equal(cachedImage.statusCode, 304);
  for (const response of [image, cachedImage]) {
    assert.equal(response.headers["cache-control"], "public, max-age=300, s-maxage=3600, must-revalidate");
  }
  await sql`UPDATE stories SET title = 'Corrected event identity' WHERE public_id = ${stories[0]!}`;
  const corrected = await app.inject({ method: "GET", url: imageUrl, headers: { "if-none-match": String(image.headers.etag) } });
  assert.equal(corrected.statusCode, 200);
  assert.notEqual(corrected.headers.etag, image.headers.etag, "the earlier image validator cannot retain a corrected title");
  assert.notDeepEqual(corrected.rawPayload, image.rawPayload);
  for (const [index, story] of stories.entries()) {
    for (const prefix of ["/api/site/stories/"]) {
      const response = await get(`${prefix}${story}`);
      assert.equal(response.status, index === 0 ? 200 : 404, "mention-only links do not make a factual public event");
      if (index === 0) assert.ok(response.body.includes(id));
    }
  }

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  assert.equal((await get(imageUrl, { "if-none-match": String(corrected.headers.etag) })).status, 404, "the old image validator cannot bypass withdrawal");
  for (const story of stories) {
    assert.equal((await get(`/api/site/stories/${story}`)).status, 404);
  }
  assert.equal((await get(`/api/site/stories/${unrelated}`)).status, 200);
});

test("a withdrawn item leaves the hot board and the hot APIs at once, not at the next ranking", async () => {
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`HOT-${T}`}, now() - interval '2 hours', now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${T}`}, ${story!.id}, ${`HOT-${T}`}) RETURNING id`;
  // Two independent participants (heat counts sources, not reports).
  const second = `${SOURCE}-hot-b`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${second}, 'Test publication B', 'rss', 'T1', 'editorial', '2100-01-01')`;
  for (const [i, id] of [await article(), await article()].entries()) {
    if (i) await sql`UPDATE articles SET source_id = ${second} WHERE id = ${id}`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${story!.id}, ${id}, ${`participant-${id}`}, ${i ? second : SOURCE}, 'editorial', now() - interval '1 hour')`;
    await publishArticle(id, released());
  }
  await computeHotRanking();
  const rep = (await latestHotRanking())!.entries.find((e) => e.storyId === story!.id)?.representativeItemId;
  assert.ok(rep, "the story is on the board with a representative item");
  // The hot board names the event the item stands for.
  assert.ok((await get("/api/site/hot")).body.includes(publicId), "/api/site/hot shows the event before");

  await setVisibility(rep!, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  assert.ok(!(await get("/api/site/hot")).body.includes(publicId), "/api/site/hot still shows the event of the withdrawn item");
});

test("item pages follow one rule: unsummarised editorial items keep one, hot_signal items have none", async () => {
  const SIGNAL = `${SOURCE}-signal`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${SIGNAL}, 'Test signal', 'rss', 'T1', 'hot_signal', true, '2100-01-01')`;
  const material = (sourceId: string, name: string) =>
    upsertMaterial({ sourceId, url: `https://example.com/${T}-${name}`, title: `${name} ${T}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  // An editorial item the model never summarised, and a hot_signal item carrying an imported summary.
  const { articleId: plain } = await material(SOURCE, "plain");
  await publishArticle(plain);
  const { articleId: signal } = await material(SIGNAL, "signal");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${signal}, 1, 'replay', 'pass', 'industry', ${`信号-${T}`}, ${`SIGNAL-SUMMARY-${T}`}, 80, false)`;
  await publishArticle(signal);

  const page = await get(`/api/site/items/${plain}`);
  assert.equal(page.status, 200, "an unsummarised editorial item keeps its page");
  const detail = JSON.parse(page.body) as { summary: string | null; markdownAvailable: boolean };
  assert.deepEqual([detail.summary, detail.markdownAvailable], [null, true], "with its body for export");
  assert.equal((await get(`/items/${plain}/markdown`)).status, 200);
  assert.equal((await get(`/api/site/items/${signal}`)).status, 404, "hot_signal material has no page");
  assert.equal((await get(`/items/${signal}/markdown`)).status, 404);

  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`事件-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${story!.id}, ${`事实-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${plain}, 'report'), (${fact!.id}, ${signal}, 'report')`;
  const storyPage = await get(`/api/site/stories/${publicId}`);
  assert.equal(storyPage.status, 200, "a story whose only page is unsummarised still has a page");
  assert.ok(storyPage.body.includes(plain), "it lists the unsummarised editorial report");
  assert.ok(!storyPage.body.includes(signal) && !storyPage.body.includes(`SIGNAL-SUMMARY-${T}`), "and not the hot_signal one");
});

test('event neighbors disappear when their last readable evidence is withdrawn', async () => {
  const id = await article();
  const neighborId = await article();
  await publishArticle(id, released());
  await publishArticle(neighborId, released());
  const current = await storyFor(id);
  const neighbor = await storyFor(neighborId);
  await sql`INSERT INTO story_links (story_id, other_id, relation)
    SELECT s.id, n.id, 'related' FROM stories s, stories n WHERE s.public_id = ${current} AND n.public_id = ${neighbor}`;
  const exits = [`/api/site/stories/${current}`];
  for (const url of exits) assert.ok((await get(url)).body.includes(neighbor), 'public neighbor is linked');
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${neighborId}`;
  for (const url of exits) assert.ok(!(await get(url)).body.includes(neighbor), `${url} must not advertise an unreadable neighbor`);
});

test("unchanged republishing preserves freshness, while URL-only changes still reach the projection", async () => {
  const id = await article();
  await publishArticle(id, released());
  const state = async () => (await sql`SELECT updated_at, revision, url FROM publications WHERE article_id = ${id}`)[0]!;
  const before = await state();
  const unchanged = await publishArticle(id);
  assert.equal(unchanged!.changed, false);
  assert.deepEqual({ ...await state() }, { ...before }, "no new freshness timestamp or revision for identical content");

  const url = `https://example.com/${T}-corrected`;
  await sql`UPDATE articles SET url = ${url} WHERE id = ${id}`;
  const result = await publishArticle(id);
  assert.equal(result!.changed, true, "URL changes are public changes and refresh dependent exits");
  const changed = await state();
  assert.equal(changed.url, url);
  assert.ok(changed.updated_at >= before.updated_at);
  assert.equal(changed.revision, before.revision + 1);
});

test("a cached share-image validator never outlives the selected verdict or a withdrawal", async () => {
  const id = await article();
  await publishArticle(id, released());
  const paths: Array<[string, string]> = [];
  for (const path of [`/og/items/${id}.png`, `/og/posters/${id}.png`]) paths.push([path, String((await app.inject({ method: "GET", url: path })).headers.etag)]);
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${id}`;
  assert.equal((await get(paths[0]![0], { "if-none-match": paths[0]![1] })).status, 200, "summary-only images remove the former selected verdict");
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  for (const [path, etag] of paths) assert.equal((await get(path, { "if-none-match": etag })).status, 404, "cached ETags never bypass current visibility");
});

// Restricting a selected item to a neutral summary must also remove its selected badge, score,
// classification and story links from the detail and both share-image projections.
test("summary-only detail and sharing keep neutral metadata without a selected verdict", async () => {
  const id = await article();
  await storyFor(id);
  await publishArticle(id, released());
  const before = JSON.parse((await get(`/api/site/items/${id}`)).body);
  assert.equal(before.selected, true);
  assert.ok(before.story);
  await setVisibility(id, { visibility: "summary-only", reason: "neutral summary", version: 0 }, "test");
  for (const suffix of ["", "/original"]) {
    const item = JSON.parse((await get(`/api/site/items/${id}${suffix}`)).body);
    assert.equal(item.title, before.title);
    assert.equal(item.summary, before.summary);
    assert.equal(item.links.original, before.links.original);
    assert.equal(item.selected, false);
    for (const field of ["score", "reason", "category", "story", "body", "x"]) assert.equal(item[field], null, field);
    assert.deepEqual(item.tags, []);
    assert.deepEqual(item.topics, []);
    assert.equal(item.markdownAvailable, false);
  }
  const share = (await loadItemShare(id))!;
  assert.equal(share.selected, false);
  assert.equal(share.score, null);
  assert.equal(share.category, null);
  assert.equal(share.summary, before.summary);
});
