import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { pickRepresentative, representativePriority } from "@aihot/backend/publication/representative";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { moveToFact } from "@aihot/backend/events/corrections";
import { stopBoss } from "@aihot/backend/jobs/queue";

const key = `evidence-${tag()}`;
const now = new Date();
const at = (hours: number) => new Date(+now - hours * 3600_000);
after(async () => { await stopBoss(); await closeDb(); });

async function source(suffix: string, tier: string, owner: string | null = null, role: string | null = null) {
  const id = `${key}-${suffix}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,owner_entity_id,config,first_party,next_fetch_at)
    VALUES (${id},${suffix},'rss',${tier},'editorial',${owner},${sql.json(role ? { publisherRole: role } : {})},${tier !== 'T1'},'2100-01-01')`;
  return id;
}
async function story(title = "OpenAI 发布 Dots") {
  const [s] = await sql`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},${title}) RETURNING id, public_id`;
  const [f] = await sql`INSERT INTO facts (public_id,story_id,title,subject,action,object,conditions)
    VALUES (${`f-${randomUUID()}`},${s!.id},${title},'OpenAI','发布','Dots','自主执行任务消耗额度') RETURNING id, public_id`;
  return { storyId: Number(s!.id), storyPublicId: s!.public_id as string, factId: Number(f!.id), factPublicId: f!.public_id as string };
}
async function report(sourceId: string, group: Awaited<ReturnType<typeof story>>, opts: { title: string; hours: number; selected?: boolean; score?: number; role?: string }) {
  const id = `${key}-${randomUUID()}`;
  const date = at(opts.hours);
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,timeline_at,discovered_at,published_at)
    VALUES (${id},${sourceId},${id},${`https://example.org/${id}`},${opts.title},${date},${date},${date})`;
  const [a] = await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,output)
    VALUES (${id},1,'rule','pass',${opts.title},${opts.title},
      ${sql.json({ fact: { evidence: "Tasks consume usage.", conditions: [{ text: "自主任务消耗额度", quote: "Tasks consume usage." }] } })}) RETURNING id`;
  await sql`INSERT INTO publications (article_id,analysis_id,source_id,title,summary,url,first_party,timeline_at,discovered_at,published_at,sort_at,
    story_id,fact_id,selected,eligible,visible_after,tags,body_mode,score)
    VALUES (${id},${a!.id},${sourceId},${opts.title},${opts.title},${`https://example.org/${id}`},true,${date},${date},${date},${date},
    ${group.storyId},${group.factId},${opts.selected ?? true},true,${date},${[key]},'full',${opts.score ?? 70})`;
  await sql`INSERT INTO fact_articles (fact_id,article_id,role,evidence) VALUES (${group.factId},${id},${opts.role ?? 'report'},'Tasks consume usage.')`;
  return id;
}

test("source tier and event ownership are separate; mentions of an entity do not establish authority", () => {
  const row = { body_mode: "full" as const, score: 70, timeline_at: now, source_tier: "T2", publisher_role: null, owner_entity_id: null, fact_subject: "OpenAI" };
  const org = { ...row, source_tier: "T1_5", publisher_role: "organization", owner_entity_id: "openai", score: 60 };
  const person = { ...org, publisher_role: "person", score: 90 };
  assert.equal(pickRepresentative([person, org]), org);
  const first = { ...row, source_tier: "T1", score: 40, first_party: false };
  assert.equal(pickRepresentative([org, first]), first, "T1 does not depend on the first_party flag");
  for (const subject of [null, "Databricks", "OpenAI合作伙伴", "Sam Altman (@sama)"]) {
    assert.equal(representativePriority({ ...org, fact_subject: subject }), 3, String(subject));
  }
  assert.equal(representativePriority({ ...org, fact_subject: "ChatGPT" }), 1, "exact configured product alias");
  assert.equal(representativePriority({ ...org, fact_subject: "OpenAI / Anthropic" }), 1, "explicit co-subject list");
  assert.equal(representativePriority({ ...org, owner_entity_id: "qwen", fact_subject: "Qwen Team" }), 1, "the company under another of its own names");
  assert.equal(representativePriority({ ...org, owner_entity_id: "world-labs", fact_subject: "AMD + World Labs" }), 1);
  assert.equal(representativePriority({ ...org, fact_subject: "OpenAI + " }), 3, "incomplete subject list is not evidence");
  assert.equal(representativePriority({ ...org, owner_entity_id: null }), 3);
  assert.equal(representativePriority({ ...org, owner_entity_id: "unregistered-org", fact_subject: "unregistered-org" }), 3, "equal unknown strings are not verified identity");
  assert.equal(representativePriority({ ...org, fact_subject: "OpenAI + unregistered-org" }), 3, "an unrecognized co-subject is not silently accepted");
  assert.equal(representativePriority({ ...row, first_party: true } as typeof row), 3, "the first_party flag never elevates a source");
});

test("mentions cannot choose a timeline origin, anchor or representative", async () => {
  const organization = await source("organization", "T1_5", "openai", "organization");
  const media = await source("media", "T2");
  const t1 = await source("t1", "T1");
  const g = await story();
  const official = await report(organization, g, { title: "Dots 正式发布", hours: 3, score: 65 });
  const latest = await report(media, g, { title: "Dots 后续更新", hours: 2, score: 90 });
  const earlyMention = await report(t1, g, { title: "EARLY ROUNDUP", hours: 90, role: "mention" });
  const lateMention = await report(t1, g, { title: "LATEST ROUNDUP", hours: 1, role: "mention" });
  await report(t1, g, { title: "未入选官网稿", hours: 4, selected: false, score: 30 });
  const q = { channel: "all" as const, category: null, tag: key, now };
  const timeline = await loadTimeline(q);
  const card = timeline.cards.find(c => c.key === `f${g.factId}`)!;
  assert.equal(card.item.id, official);
  assert.equal(card.anchorAt, at(3).toISOString());
  assert.ok(timeline.cards.some(c => c.key === `a${earlyMention}`) && timeline.cards.some(c => c.key === `a${lateMention}`), "a stale mention projection stays an independent selected article");
  const group = await loadGroupReports({ factPublicId: g.factPublicId, channel: "all", category: null, tag: key }, now);
  assert.equal(group?.reports.length, 3, "only primary/report members are same-fact reports");
  const firstParty = await loadTimeline({ ...q, channel: "firstParty" });
  assert.ok(!firstParty.cards.some(c => c.item.id === official), "a stale true projection flag cannot put T1_5 into first-party channel");
});

// The detail's group badge and its expanded report list must count the same evidence, even while
// an old projection still points to a fact after a report became a mention or composite.
test("item detail counts the same fact evidence as its expanded group", async () => {
  const s = await source("detail-count", "T1");
  const other = await source("detail-count-other", "T2");
  const g = await story();
  const main = await report(s, g, { title: "事件原始报道", hours: 3 });
  await report(other, g, { title: "事件补充报道", hours: 2 });
  await report(other, g, { title: "只提及该事件", hours: 1, role: "mention" });
  const composite = await report(other, g, { title: "多个事件的综合稿", hours: 1 });
  await sql`UPDATE analyses SET output = output || '{"scope":"composite"}'::jsonb WHERE article_id = ${composite}`;
  const detail = await loadItemDetail(main, now);
  assert.equal(detail.kind, "found");
  if (detail.kind !== "found") return;
  const expanded = (await loadGroupReports({ factPublicId: g.factPublicId, channel: "all", category: null, tag: null }, now))!;
  assert.equal(expanded.reports.length, 2);
  assert.equal(detail.item.group!.reportCount, expanded.reports.length);
  assert.equal(detail.item.group!.additionalSourceCount, 1);
});

test("an editor moves a report into the fact it repeats: no false development remains and the membership is the editor's", async () => {
  const s = await source("move", "T1");
  const g = await story("OpenAI 发布 GPT-6.1 Sol");
  const launch = await report(s, g, { title: "Sol 官网发布", hours: 6 });
  const [dup] = await sql`INSERT INTO facts (public_id,story_id,title,subject) VALUES (${`f-${randomUUID()}`},${g.storyId},'OpenAI发布GPT-6.1 Sol模型','OpenAI') RETURNING id`;
  const repost = await report(s, { ...g, factId: Number(dup!.id) }, { title: "官方线程里的重复发布", hours: 1 });
  // Moving re-derives the publication from its analysis, which carries no test tag: read the unfiltered timeline.
  const cards = async () => (await loadTimeline({ channel: "all", category: null, tag: null, limit: 40, now: new Date() })).cards.filter(c => [launch, repost].includes(c.item.id));
  assert.equal((await cards()).length, 2);
  assert.deepEqual(await moveToFact(repost, g.factPublicId, "同一次发布的官方重复帖", "test"), { fact: g.factId, story: g.storyId, left: 1 });
  const after = await cards();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.item.id, launch);
  assert.equal(after[0]!.group!.reportCount, 2);
  assert.deepEqual([...await sql`SELECT fact_id, role, manual, evidence FROM fact_articles WHERE article_id=${repost}`].map(r => ({ ...r, fact_id: Number(r.fact_id) })),
    [{ fact_id: g.factId, role: "report", manual: true, evidence: "Tasks consume usage." }]);
  await assert.rejects(moveToFact(repost, "f-missing", "x", "test"), /目标事实不存在/);
});
