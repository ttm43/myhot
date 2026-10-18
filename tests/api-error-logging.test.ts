// Failure cases: an API restart emits a deprecated-options warning; a failing request has only a
// request id and cannot be located; query strings or authentication headers enter the journal;
// changing logging also changes the established Problem JSON or its headers; suppressing ordinary
// request logs also suppresses a real stream error after response headers have already gone out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("API startup is quiet and an unexpected error retains the request, stack and response contract", () => {
  const script = `
    import assert from "node:assert/strict";
    import { buildApp } from ${JSON.stringify(new URL("../apps/api/src/app.ts", import.meta.url).href)};
    import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
    import { Readable } from "node:stream";
    import { siteHandler } from ${JSON.stringify(new URL("../apps/api/src/routes/site.ts", import.meta.url).href)};
    import { SearchBusyError } from "@aihot/backend/publication/pool";
    const app = await buildApp();
    app.get("/api/log-check", async () => { throw new DOMException("upstream timed out", "TimeoutError"); });
    app.get("/api/logged", async (req, reply) => {
      req.log.warn({ err: new Error("known upstream failure") }, "upstream failed");
      return reply.code(502).send("upstream unavailable");
    });
    app.get("/api/unlogged", async (_req, reply) => reply.code(503).send("busy"));
    app.get("/api/busy-site", siteHandler(async () => { throw new SearchBusyError(5); }));
    app.get("/api/stream", async (_req, reply) => reply.type("text/plain").send(Readable.from((async function* () {
      yield "started";
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error("stream exploded");
    })())));
    const res = await app.inject({ method: "GET", url: "/api/log-check?token=private-query", headers: { authorization: "Bearer private-auth", cookie: "private-cookie" } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "30");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["content-type"], "application/problem+json");
    assert.equal(res.json().code, "temporarily_unavailable");
    assert.equal(res.json().requestId, res.headers["x-request-id"]);
    assert.equal((await app.inject({ url: "/api/logged" })).statusCode, 502);
    assert.equal((await app.inject({ url: "/api/unlogged" })).statusCode, 503);
    const busy = await app.inject({ url: "/api/busy-site?q=private-query" });
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.headers["retry-after"], "5");
    assert.equal(busy.json().code, "temporarily_unavailable");
    assert.equal(busy.json().reason, undefined);
    const mcp = await app.inject({ method: "POST", url: "/api/mcp?aihot_actor=private-actor", headers: {
      host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": MCP_TOOL_NAMES.latest,
    }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: MCP_TOOL_NAMES.latest, arguments: {},
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    } } });
    assert.equal(mcp.statusCode, 200, mcp.body);
    assert.ok(mcp.body.includes("internal_error"), mcp.body);
    assert.ok(!mcp.body.includes("ECONNREFUSED"));
    await app.inject({ url: "/api/stream?token=private-stream" }).catch(() => {});
    await app.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15000,
    env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1/aihot_logging_test", AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials", LOG_LEVEL: "info" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const error = records.find((record) => record.msg === "unhandled");
  assert.ok(error);
  assert.equal(error.method, "GET");
  assert.equal(error.path, "/api/log-check");
  assert.ok(error.reqId);
  assert.equal(error.err.type, "TimeoutError");
  assert.equal(error.err.message, "upstream timed out");
  assert.match(error.err.stack, /\s+at /);
  assert.ok(!result.stdout.includes("private-"));
  assert.ok(!records.some((record) => /incoming request|request completed/.test(record.msg)));
  assert.equal(records.filter((record) => record.path === "/api/log-check").length, 1);
  assert.equal(records.filter((record) => record.path === "/api/logged").length, 1);
  assert.equal(records.find((record) => record.path === "/api/logged")?.msg, "upstream failed");
  assert.equal(records.filter((record) => record.path === "/api/unlogged").length, 1);
  assert.equal(records.find((record) => record.path === "/api/unlogged")?.status, 503);
  const mcpError = records.find((record) => record.msg === "mcp tool failed");
  assert.ok(mcpError);
  assert.equal(mcpError.path, "/api/mcp");
  assert.equal(mcpError.method, "POST");
  assert.ok(mcpError.reqId);
  assert.ok(mcpError.err.type);
  const streamError = records.find((record) => record.path === "/api/stream" && record.err);
  assert.ok(streamError);
  assert.equal(streamError.err.type, "Error");
  assert.equal(streamError.err.message, "stream exploded");
  assert.match(streamError.err.stack, /\s+at /);
  const busy = records.filter((record) => record.path === "/api/busy-site");
  assert.equal(busy.length, 1);
  assert.equal(busy[0].reason, "search_capacity_exhausted");
  assert.equal(busy[0].status, 503);
});
