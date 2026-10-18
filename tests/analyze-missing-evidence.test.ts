// A title cannot supply the missing article: no writing or public eligibility until material
// arrives. Feed excerpts keep their path.
import { pointModels, stub, tag } from "./setup.ts";
import { analysisStep } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { normalizeAnalysis, runAnalysis, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { isPoolEligible } from "@aihot/backend/publication/rules";

let label = "PASS";
const steps: string[] = [];
const provider = await stub((_hit, request) => {
  const step = analysisStep(request.body);
  steps.push(step);
  const output = step === "prefilter" ? { label, reason: "fixture" }
    : step === "structure" ? { scope: "unknown", category: "model", tags: [], subjects: [], fact: null }
    : "title_zh: 模型发布\nsummary_zh: 来源确认模型发布。";
  return { choices: [{ message: { content: typeof output === "string" ? output : JSON.stringify(output) } }] };
});
pointModels(provider.url);
after(async () => { await provider.close(); await closeDb(); });

const article = (changes: Partial<AnalyzeInputArticle> = {}): AnalyzeInputArticle => ({
  id: `missing-${tag()}`, revision: 1, title: "模型发布", url: "https://example.org/news", author: null,
  publishedAt: new Date("2026-10-02T00:00:00Z"), bodyStatus: "unconfirmed", bodyText: null,
  excerpt: null, media: [],
  source: { name: "Fixture", kind: "rss", tier: "T1", firstParty: true }, ...changes,
});
const runFresh = (input: AnalyzeInputArticle) => runAnalysis(input, { attemptTag: tag() });
// Long enough to be written up (a shorter text keeps its title and waits).
const BODY = "来源确认模型发布，并公布了评测结果与价格，开发者可以通过接口使用。";

test("title-only articles wait for evidence regardless of the prefilter label", async (t) => {
  for (const candidate of ["PASS", "UNKNOWN", "BLOCK"]) await t.test(candidate, async () => {
    label = candidate;
    steps.length = 0;
    const run = await runFresh(article({ bodyText: " \n", excerpt: " " }));
    const out = normalizeAnalysis(run);
    assert.deepEqual(steps, ["prefilter"]);
    assert.equal(out.relevance, "unknown");
    assert.equal(out.titleZh, "");
    assert.equal(out.summaryZh, "");
    assert.equal(isPoolEligible({ participationMode: "editorial", relevance: out.relevance, title: out.titleZh, summary: out.summaryZh }), false);
  });
});

test("real body and feed excerpt still receive the structure and the writing", async (t) => {
  label = "PASS";
  for (const changes of [{ bodyText: BODY }, { excerpt: BODY }]) await t.test(JSON.stringify(changes), async () => {
    steps.length = 0;
    const out = normalizeAnalysis(await runFresh(article(changes)));
    assert.ok(steps.includes("structure"));
    assert.equal(out.relevance, "pass");
    assert.ok(out.titleZh && out.summaryZh);
  });
});

test("a later material revision is judged after the title-only revision waits", async () => {
  label = "PASS";
  const input = article();
  assert.equal(normalizeAnalysis(await runFresh(input)).relevance, "unknown");
  steps.length = 0;
  const out = normalizeAnalysis(await runFresh({ ...input, revision: 2, bodyStatus: "ok", bodyText: BODY }));
  assert.deepEqual(steps.slice().sort(), ["prefilter", "structure", "summarize"]);
  assert.equal(out.relevance, "pass");
});
