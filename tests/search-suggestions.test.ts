// Failure cases, written before replacing the search overlay's full-page read:
// - suggestions change the topic order/names;
// - the response carries topic statistics;
// - a cached answer loses its validator.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("search carries exactly the existing topic links", async () => {
  const read = () => app.inject({ method:'GET', url:'/api/site/search/suggestions' });
  const fullTopics = (await app.inject({ method:'GET', url:'/api/site/topics' })).json();
  const first = await read();
  assert.equal(first.statusCode,200);
  const expectedTopics = fullTopics.topics.map((t: {slug:string;name:string;group:string}) => ({slug:t.slug,name:t.name,group:t.group}));
  assert.deepEqual(first.json(),{topics:expectedTopics});
  assert.equal(first.headers['cache-control'],'public, max-age=30, s-maxage=30, must-revalidate');
  assert.ok(first.headers.etag);
  assert.equal((await app.inject({ method:'GET',url:'/api/site/search/suggestions',headers:{'if-none-match':String(first.headers.etag)} })).statusCode,304);
});
