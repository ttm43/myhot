// The judging and writing steps (editorial/analyze.ts): the prefilter decides relevance, a structure
// step gives the category, subjects and fact, and the title/summary prompts write the Chinese copy. 精选
// is not judged here. Material with only a feed summary has its page fetched first.
import { pointModels, stub, tag } from "./setup.ts";
import { analysisStep, type AnalysisStep } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, buildMaterial, loadAnalyzeInput, normalizeStructure, StructureSchema } from "@aihot/backend/editorial/analyze";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { compactAnswerFirstSummary, enforceIdentity, MAX_BODY_CHARS, parseTranslateOutput } from "@aihot/backend/editorial/writing";

const T = tag();
const SOURCE = `test-analyze-${T}`;
const X_SOURCE = `test-analyze-x-${T}`;

interface Req { step: AnalysisStep; marker: string; user: string }
const requests: Req[] = [];
const MARKERS = ["CLEAR", "OFFTOPIC", "BARE", "VAGUE", "THIN", "推文"];

// One stub stands in for DashScope (prefilter, structure) and DeepSeek (summarize).
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = analysisStep(req.body);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, user });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: marker === "OFFTOPIC" || marker === "BARE" ? "BLOCK" : marker === "VAGUE" ? "UNKNOWN" : "PASS", reason: "测试" });
  if (step === "structure") return answer({ category: "ai-models", tags: ["模型发布", "推理"], subjects: ["anthropic", "unknown-co"], scope: "single", fact: { title: `事实 ${marker}`, subject: "某公司", action: "发布", object: "模型", occurredAt: null, evidence: "a lab released a model", conditions: [] } });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
pointModels(provider.url);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Test analyze source', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${X_SOURCE}, 'Test X account', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

// The tag keeps each material unique: identical input would reuse an earlier run's paid answers.
const LONG = "a lab released a model with a benchmark table and pricing details. ".repeat(8);
const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${marker}-${T}`, title: `${marker} model release ${T}`, bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-09-28T01:02:03Z"), ...extra,
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const row = async (id: string) =>
  (await sql<{ selected: boolean; relevance: string; score: string | null; title_zh: string; reason_zh: string | null; category: string | null; tags: string[]; subjects: string[]; receipt_ids: string[]; output: Record<string, any> }[]>`
    SELECT selected, relevance, score, title_zh, reason_zh, category, tags, subjects, receipt_ids, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;

test("a relevant item: the prefilter, the structure and the title/summary writing", async () => {
  const id = await article("CLEAR");
  const res = await analyzeArticle(id);
  assert.equal(res!.output!.titleZh, "翻译标题 CLEAR");
  assert.deepEqual(calls("CLEAR").sort(), ["prefilter", "structure", "summarize"]);
  const r = await row(id);
  assert.deepEqual([r.title_zh, r.reason_zh, r.category, r.receipt_ids.length], ["翻译标题 CLEAR", null, "ai-models", 3]);
  assert.deepEqual([r.selected, r.score], [null, null], "the analysis judges no selection and no score");
  assert.deepEqual(r.tags, ["模型发布", "推理", "Anthropic"], "category and tags come from the same structural judgement, plus the verified subject tag");
  assert.deepEqual(r.subjects, ["anthropic"]);
  assert.deepEqual([r.output.writer, r.output.prefilter.label, r.output.fact.title], ["summarize", "PASS", "事实 CLEAR"]);
  assert.equal(r.output.scope, "single");
  assert.equal(r.output.fact.evidence, "a lab released a model");
});

test("structure retains grounded conditions, rejects invented or unseen quotes, and does not infer missing scope", async () => {
  const input = (await loadAnalyzeInput(await article("CONDITIONS", {
    bodyText: "Preview is free for Pro users until October 10.\n" + "x".repeat(11000) + "\nOnly available in the US. " + "x".repeat(MAX_BODY_CHARS) + "This late detail was not sent.",
  })))!;
  const frame = { title: "预览上线", evidence: "Preview is free for Pro users until October 10.", conditions: [
    { text: "仅Pro用户，免费至10月10日", quote: "Preview is free for Pro users until October 10." },
    { text: "仅限美国", quote: "Only available in the US." },
    { text: "无限免费", quote: "Unlimited free access for everyone." },
    { text: "不在模型输入里的句子", quote: "This late detail was not sent." },
  ] };
  const base = { category: "ai-models", tags: [], subjects: [], fact: frame };
  const out = normalizeStructure(StructureSchema.parse(base), input);
  assert.ok(buildMaterial(input).includes("Only available in the US."), "a condition after the old 7000-character cutoff reaches the model");
  assert.ok(buildMaterial(input).includes("后文未提供"));
  assert.equal(out.scope, "unknown", "an older result with a fact is not proof of single scope");
  assert.deepEqual(out.fact?.conditions, frame.conditions.slice(0, 2));
  assert.equal(out.fact?.evidence, frame.evidence);
  const partial = normalizeStructure(StructureSchema.parse({ ...base, fact: { ...frame, conditions: [
    { quote: "x".repeat(401) },
    { quote: "Preview is free... until October 10." },
    { quote: "Only available in the US." },
  ] } }), input);
  assert.deepEqual(partial.fact?.conditions, [{ text: "Only available in the US.", quote: "Only available in the US." }],
    "an invalid sibling cannot discard a valid original condition; spliced quotes remain rejected");
  const invented = normalizeStructure(StructureSchema.parse({ ...base, fact: { ...frame, evidence: input.source.name, conditions: [{ text: "原文没有的限制", quote: "仅中文译文中出现的限制" }] } }), input);
  assert.equal(invented.fact?.evidence, null, "source metadata is not original evidence");
  assert.deepEqual(invented.fact?.conditions, [], "a quote the original does not contain does not count");
  assert.equal(normalizeStructure(StructureSchema.parse({ ...base, scope: "composite" }), input).fact, null, "composite output cannot also claim one fact");
  const titleOnly = normalizeStructure(StructureSchema.parse({ ...base, scope: "single" }), { ...input, bodyText: null, excerpt: null });
  assert.equal(titleOnly.scope, "unknown", "a confident model cannot supply the missing original material");
  assert.equal(titleOnly.fact, null);
});

test("the prefilter's BLOCK stops everything; UNKNOWN with material goes on like PASS", async () => {
  const off = await analyzeArticle(await article("OFFTOPIC"));
  assert.equal(off!.output!.relevance, "block");
  assert.deepEqual(calls("OFFTOPIC"), ["prefilter"]);
  // An UNKNOWN with material is judged and written like a PASS.
  const vagueId = await article("VAGUE");
  const vague = await analyzeArticle(vagueId);
  assert.deepEqual([vague!.output!.relevance, vague!.output!.titleZh], ["pass", "翻译标题 VAGUE"]);
  assert.equal((await row(vagueId)).output.prefilter.label, "UNKNOWN", "the prefilter's own answer stays on record");
  // Nothing but a title and no page to fetch: the BLOCK counts as UNKNOWN and waits for material.
  const bare = await analyzeArticle(await article("BARE", { bodyText: null, excerpt: null, bodyStatus: "none" }));
  assert.equal(bare!.output!.relevance, "unknown");
  assert.deepEqual(calls("BARE"), ["prefilter"]);
});

test("a feed summary alone: the article page is fetched first, then the whole article is judged", async () => {
  const id = await article("THIN", { bodyText: null, bodyStatus: "pending", excerpt: `THIN: a short feed summary (${T}).` });
  // The queue sends it to extraction although its source does not ask for full text (the sweep does
  // the same after a failed fetch, so extraction failures add up to "unconfirmed" and end).
  await queueProcessing(id);
  const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id}`;
  assert.equal(job?.name, QUEUES.extractBody);
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.needsBody, first!.output], [true, null]);
  assert.deepEqual(calls("THIN"), [], "no model call before the page");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, "nothing committed");
  // What extraction does: the body lands as a new revision.
  await sql`UPDATE articles SET body_text = ${`THIN: ${LONG} (${T}) full page`}, body_status = 'ok', revision = revision + 1 WHERE id = ${id}`;
  const second = await analyzeArticle(id);
  assert.deepEqual([second!.needsBody ?? false, second!.output!.relevance], [false, "pass"]);
});

test("a short post in Chinese is its own copy", async () => {
  // The tag rides as a hashtag, which the language check strips.
  const text = `推文：今天把智能体接进了工作流，效果不错。#t${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: X_SOURCE, url: `https://x.com/test/status/1${Date.now()}`, title: text, via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: `1${Date.now()}`, authorName: "测试", handle: "test", text },
  });
  const post = await analyzeArticle(articleId);
  assert.deepEqual([post!.output!.titleZh, post!.output!.summaryZh], [text, text]);
  assert.ok(!calls("推文").includes("summarize"), "no writing call");
});

test("guards: a company the input does not name is not written in; long summaries are cut at sentences", () => {
  const input = { title: "某实验室发布新模型", text: "某实验室发布了一个新模型，参数规模和价格都有说明。", sourceKind: "rss" };
  const guarded = enforceIdentity(input, { titleZh: "OpenAI 发布新模型", summaryZh: "某实验室发布新模型。" });
  assert.deepEqual([guarded.titleZh, guarded.summaryZh, guarded.identityGuard.outcome], ["某实验室发布新模型", "某实验室发布新模型。", "fallback"]);
  // The identity lexicon: a Chinese rendering of a company the input names in English is no invention.
  const alibaba = { title: "Alibaba ships a new coding model", text: "Alibaba released a coding model with pricing details.", sourceKind: "rss" };
  assert.equal(enforceIdentity(alibaba, { titleZh: "阿里巴巴发布编程模型", summaryZh: "阿里巴巴发布了编程模型并公布价格。" }).identityGuard.outcome, "pass");
  const long = "第一句交代了谁做了什么以及关键结果，这一句本身已经足够说明核心事件的来龙去脉。".repeat(3) + "第二句补充数字。".repeat(20);
  assert.ok(compactAnswerFirstSummary(long).length <= 190);
  assert.deepEqual(parseTranslateOutput("title_zh: 标题\nsummary_zh: 第一句。\n第二句。"), { titleZh: "标题", summaryZh: "第一句。\n第二句。", bodyZh: "" });
  assert.equal(parseTranslateOutput("title_zh: 标题\nbody_zh: 我们懂你。\n\n来源：X：PixVerse (@PixVerse)").bodyZh, "我们懂你。", "a repeated prompt line is dropped");
});

test("analysing the same revision again reuses every paid answer", async () => {
  const id = await article("CLEAR", { url: `https://example.com/CLEAR-again-${T}`, title: `CLEAR model release again ${T}` });
  const first = await analyzeArticle(id);
  assert.equal(first!.reused, false);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(provider.hits(), hits, "no new requests");
  assert.deepEqual([again!.reused, again!.receiptIds], [true, first!.receiptIds]);
});
