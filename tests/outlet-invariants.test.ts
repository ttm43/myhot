// Cross-outlet failure: matching source notes readers cannot see.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const key = tag();
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function fixture(name: string) {
  const source = `outlet-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, ${name}, 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`,
    title: "Source article", bodyText: "Confirmed material", bodyStatus: "ok", publishedAt: new Date(), via: "fetch" });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, category, selected, score)
    VALUES (${id}, 1, 'rule', 'pass', '对外标题', '对外摘要', 'ai-models', true, 90)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  return id;
}

test("every search matches the source name readers see and excludes its internal notes", async () => {
  const visible = `Visible${key}`;
  const internal = `Internal${key}`;
  const id = await fixture(`${visible}（${internal}）`);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "outlet-search", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp`)));
  try {
    for (const [query, expected] of [[visible, true], [internal, false]] as const) {
      for (const prefix of ["/api/site/pool?q="]) {
        const res = await app.inject(`${prefix}${encodeURIComponent(query)}`);
        assert.equal(res.statusCode, 200, prefix);
        assert.equal(res.body.includes(id), expected, `${prefix}${query}`);
      }
      const result = await client.callTool({ name: MCP_TOOL_NAMES.search, arguments: { q: query } });
      assert.equal(result.isError, undefined);
      assert.equal(JSON.stringify(result.structuredContent).includes(id), expected, `MCP ${query}`);
    }
  } finally { await client.close(); }
});
