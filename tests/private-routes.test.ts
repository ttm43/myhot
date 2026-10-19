import { createHmac } from "node:crypto";
import { config } from "@aihot/backend/config";
// Malformed optional client data must not break admin authentication or drop valid ingest entries.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";

process.env.INGEST_TOKEN = "private-route-test-ingest-token";
const app = await buildApp();
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

test("an unrelated malformed cookie leaves a real admin session usable without admitting invalid sessions", async () => {
  const token = `session-${tag()}`;
  const [user] = await sql<{ id: number }[]>`INSERT INTO admin_users (display_name) VALUES ('Cookie test') RETURNING id`;
  config.adminPassword = "test-admin-password-0123";
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "password", config.adminPassword])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${user!.id}, 'cookie-test-csrf', now() + interval '1 hour', 'password', ${binding}, NULL)`;

  for (const cookie of ["unrelated=%", "aihot_admin=%; unrelated=%E0%A4", "aihot_admin=forged; unrelated=%"]) {
    const denied = await app.inject({ url: "/api/auth/check", headers: { cookie } });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers["cache-control"], "no-store");
  }

  const headers = { cookie: `unrelated=%; aihot_admin=${token}; another=%E0%A4` };
  const check = await app.inject({ url: "/api/auth/check", headers });
  assert.equal(check.statusCode, 204);
  const me = await app.inject({ url: "/api/admin/me", headers });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().name, "Cookie test");
  assert.equal(me.json().csrf, "cookie-test-csrf");
  const write = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {} });
  assert.equal(write.statusCode, 403, "the usable session still needs CSRF for writes");

  const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
  assert.equal(logout.statusCode, 303);
  const ended = await app.inject({ url: "/api/auth/check", headers });
  assert.equal(ended.statusCode, 401);
});

test("ingest skips malformed entries and still accepts and deduplicates the valid entries in their batch", async () => {
  const sourceId = `ingest-${tag()}`;
  const url = `https://example.com/${sourceId}`;
  const payload = {
    sourceId,
    items: [null, false, 7, "invalid", [], {}, { title: "valid", url }, null, { title: "duplicate", url: `${url}?utm_source=duplicate` }],
  };
  const denied = await app.inject({ method: "POST", url: "/api/ingest/items", payload });
  assert.equal(denied.statusCode, 401);
  const headers = { authorization: `Bearer ${process.env.INGEST_TOKEN}` };
  const first = await app.inject({ method: "POST", url: "/api/ingest/items", headers, payload });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { ok: true, created: 1 });
  const again = await app.inject({ method: "POST", url: "/api/ingest/items", headers, payload });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { ok: true, created: 0 });
  const articles = await sql<{ title: string; url: string }[]>`SELECT title, url FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual(articles.map((row) => ({ ...row })), [{ title: "valid", url }]);
  const [source] = await sql<{ participation_mode: string }[]>`SELECT participation_mode FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.participation_mode, "isolated");
});

test("ingest text returns the stored body for a known URL, and only with the token", async () => {
  const sourceId = `text-${tag()}`;
  const url = `https://example.com/${sourceId}`;
  const headers = { authorization: `Bearer ${process.env.INGEST_TOKEN}` };
  const push = await app.inject({ method: "POST", url: "/api/ingest/items", headers, payload: { sourceId, items: [{ title: "post", url, body: "the stored text" }] } });
  assert.equal(push.statusCode, 200);
  const query = (u: string) => `/api/ingest/text?url=${encodeURIComponent(u)}`;

  assert.equal((await app.inject({ url: query(url) })).statusCode, 401);
  const found = await app.inject({ url: query(`${url}?utm_source=x`), headers });
  assert.equal(found.statusCode, 200);
  assert.equal(found.headers["cache-control"], "no-store");
  const { article } = found.json();
  assert.equal(article.url, url);
  assert.equal(article.body, "the stored text");
  assert.equal(article.source, sourceId);
  assert.equal((await app.inject({ url: query(`https://example.com/missing-${sourceId}`), headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/ingest/text?url=ftp%3A%2F%2Fa", headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/ingest/text", headers })).statusCode, 400);
});
