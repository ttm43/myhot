import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import { endSession, passwordLogin, SESSION_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { adminHandler, registerAdminAuth } from "../apps/api/src/routes/admin-auth.ts";

const T = tag();
const PASSWORD_A = `test-password-a-${T}`;
const PASSWORD_B = `test-password-b-${T}`;
const SECRET_A = `test-session-secret-a-${T}`;
const SECRET_B = `test-session-secret-b-${T}`;
const original = { password: config.adminPassword, dev: config.devAdmin, environment: config.environmentName };
const envKeys = ["SESSION_SECRET"];
const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const app = Fastify({ logger: false });
registerAdminAuth(app);
let writes = 0;
app.post("/api/admin/session-test", adminHandler(async () => ({ writes: ++writes })));
let base = "";

const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;
async function password(password = PASSWORD_A) {
  return (await passwordLogin(password, "/admin", "synthetic-agent")).token;
}
async function request(path: string, token: string, csrf?: string) {
  return fetch(`${base}${path}`, { method: csrf === undefined ? "GET" : "POST",
    headers: { cookie: cookie(token), ...(csrf === undefined ? {} : { "x-csrf-token": csrf }) }, redirect: "manual" });
}
async function principal(token: string) {
  const response = await request("/api/admin/me", token);
  assert.equal(response.status, 200);
  return await response.json() as { csrf: string; dev: boolean; name: string };
}
async function revoked(token: string, csrf = "old-csrf") {
  const before = writes;
  assert.equal((await request("/api/auth/check", token)).status, 401);
  assert.equal((await request("/api/admin/me", token)).status, 401);
  assert.equal((await request("/api/admin/session-test", token, csrf)).status, 401);
  assert.equal(writes, before);
  assert.equal(await sessionPrincipal(cookie(token)), null);
}
async function exists(token: string) {
  return (await sql`SELECT 1 FROM admin_sessions WHERE id_hash=${sha256(token)}`).length > 0;
}

before(async () => {
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});
beforeEach(() => {
  config.adminPassword = PASSWORD_A;
  config.devAdmin = null;
  config.environmentName = "development";
  process.env.SESSION_SECRET = SECRET_A;
});
after(async () => {
  await app.close();
  config.adminPassword = original.password;
  config.devAdmin = original.dev; config.environmentName = original.environment;
  for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await closeDb();
});

test("effective password replacement revokes old cookies at actual read/write/check guards", async () => {
  const token = await password();
  const me = await principal(token);
  assert.equal((await request("/api/auth/check", token)).status, 204);
  assert.equal((await request("/api/admin/session-test", token, me.csrf)).status, 200);
  config.adminPassword = PASSWORD_B;
  const before = writes;
  assert.equal((await request("/api/admin/session-test", token, me.csrf)).status, 401, "the write guard itself observes credential revocation");
  assert.equal(writes, before);
  await revoked(token, me.csrf);
  assert.equal(await exists(token), false);
  const fresh = await password(PASSWORD_B);
  assert.equal((await request("/api/auth/check", fresh)).status, 204);
  await assert.rejects(passwordLogin(PASSWORD_A, "/admin", undefined));
  config.adminPassword = PASSWORD_A;
  await revoked(token, me.csrf);
});

for (const next of [null, "short"]) test(`password ${next === null ? "removal" : "invalid-short config"} revokes existing sessions`, async () => {
  const token = await password();
  config.adminPassword = next;
  await revoked(token);
  assert.equal(await exists(token), false);
});

test("unchanged sessions preserve CSRF, and neither the password nor the token is stored", async () => {
  const token = await password();
  const me = await principal(token);
  assert.equal((await principal(token)).csrf, me.csrf);
  assert.equal((await request("/api/admin/session-test", token, "wrong")).status, 403);
  assert.equal((await request("/api/admin/session-test", token, me.csrf)).status, 200);
  const rows = await sql`SELECT * FROM admin_sessions`;
  assert.ok(rows.length > 0 && !JSON.stringify(rows).includes(PASSWORD_A) && !JSON.stringify(rows).includes(token));
});

for (const next of [SECRET_B, ""]) test(`session-secret ${next ? "rotation" : "removal"} revokes sessions`, async () => {
  const pw = await password();
  process.env.SESSION_SECRET = next;
  await revoked(pw);
});

test("legacy unbound sessions fail closed and are deleted", async () => {
  const valid = await password();
  const [user] = await sql<{ user_id: number }[]>`SELECT user_id FROM admin_sessions WHERE id_hash=${sha256(valid)}`;
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${user!.user_id},'legacy-csrf',now()+interval '1 day')`;
  await revoked(token, "legacy-csrf");
  assert.equal(await exists(token), false);
  await principal(valid);
});

test("malformed bindings and claims fail closed", async () => {
  for (const binding of [null, "not-a-binding", "0".repeat(64)]) {
    const token = await password();
    await sql`UPDATE admin_sessions SET auth_binding=${binding} WHERE id_hash=${sha256(token)}`;
    await revoked(token); assert.equal(await exists(token), false);
  }
  for (const method of ["feishu", null]) {
    const token = await password();
    await sql`UPDATE admin_sessions SET auth_method=${method} WHERE id_hash=${sha256(token)}`;
    await revoked(token); assert.equal(await exists(token), false);
  }
  const token = await password();
  await sql`UPDATE admin_sessions SET auth_claims=${sql.json({ appId: "x" })} WHERE id_hash=${sha256(token)}`;
  await revoked(token); assert.equal(await exists(token), false);
});

test("expiry, unknown token, logout isolation and explicit development mode retain their guards", async () => {
  const one = await password(); const two = await password();
  await endSession(cookie(one)); await revoked(one); await principal(two);
  await sql`UPDATE admin_sessions SET expires_at=now()-interval '1 second' WHERE id_hash=${sha256(two)}`;
  await revoked(two); await revoked("unknown-test-token");
  config.devAdmin = { displayName: "Synthetic developer" };
  assert.equal((await sessionPrincipal(undefined))!.dev, true);
  assert.equal((await request("/api/auth/check", "unknown")).status, 401);
  config.environmentName = "production";
  assert.equal(await sessionPrincipal(undefined), null);
});
