// /api/mark：记一条内容的反馈（niubi 牛逼 / received 收到 / boring 无聊）；查一批内容当前的反馈和 AI 判断；导出全部（给 autored 的 feedback.py --stats）。
// /api/mark/judgments：autored 的 judge.py 把 AI 判断（档位、分数、理由、触发事实）批量写进来，卡片上显示，用户点按钮即覆盖。
// 站点只在本机跑，接口不鉴权。
import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import type { ServerModule } from "@aihot/backend/modules";

const LABELS = new Set(["niubi", "received", "boring"]);
const ID = /^[a-z0-9]{10,40}$/;

interface MarkBody {
  id?: unknown;
  label?: unknown;
  note?: unknown;
}

interface JudgmentIn {
  id?: unknown;
  label?: unknown;
  score?: unknown;
  reason?: unknown;
  trigger_fact?: unknown;
  version?: unknown;
}

export const server: ServerModule = {
  name: "mark",
  http(app: FastifyInstance) {
    app.post("/api/mark", async (req, reply) => {
      const body = (req.body ?? {}) as MarkBody;
      const id = String(body.id ?? "");
      const label = String(body.label ?? "");
      const note = body.note == null ? null : String(body.note).slice(0, 500);
      if (!ID.test(id) || !LABELS.has(label)) {
        return reply.code(400).header("Cache-Control", "no-store").send({ ok: false, error: "bad id or label" });
      }
      const [exists] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE id = ${id}`;
      if (!exists) return reply.code(404).header("Cache-Control", "no-store").send({ ok: false, error: "unknown article" });
      await sql`
        INSERT INTO marks (article_id, label, note) VALUES (${id}, ${label}, ${note})
        ON CONFLICT (article_id) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, updated_at = now()`;
      await sql`INSERT INTO mark_events (article_id, label, note) VALUES (${id}, ${label}, ${note})`;
      return reply.header("Cache-Control", "no-store").send({ ok: true, id, label });
    });

    app.delete("/api/mark/:id", async (req, reply) => {
      const id = String((req.params as { id?: string }).id ?? "");
      if (!ID.test(id)) return reply.code(400).send({ ok: false, error: "bad id" });
      await sql`DELETE FROM marks WHERE article_id = ${id}`;
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    });

    // 一批 id 的用户反馈 + AI 判断。
    app.get("/api/mark", async (req, reply) => {
      const raw = String((req.query as { ids?: string }).ids ?? "");
      const ids = raw.split(",").map((s) => s.trim()).filter((s) => ID.test(s)).slice(0, 300);
      const marks: Record<string, string> = {};
      const ai: Record<string, { label: string; score: number; reason: string | null; fact: string | null; version: string | null }> = {};
      if (ids.length) {
        const rows = await sql<{ article_id: string; label: string }[]>`SELECT article_id, label FROM marks WHERE article_id = ANY(${ids})`;
        for (const row of rows) marks[row.article_id] = row.label;
        const judged = await sql<{ article_id: string; label: string; score: number; reason: string | null; trigger_fact: string | null; version: string | null }[]>`
          SELECT article_id, label, score, reason, trigger_fact, version FROM ai_judgments WHERE article_id = ANY(${ids})`;
        for (const row of judged) ai[row.article_id] = { label: row.label, score: row.score, reason: row.reason, fact: row.trigger_fact, version: row.version };
      }
      return reply.header("Cache-Control", "no-store").send({ ok: true, marks, ai });
    });

    // judge.py 批量写入 AI 判断（最多 500 条一次）。
    app.post("/api/mark/judgments", async (req, reply) => {
      const body = (req.body ?? {}) as { items?: unknown };
      const items = Array.isArray(body.items) ? (body.items as JudgmentIn[]).slice(0, 500) : [];
      let written = 0;
      for (const it of items) {
        const id = String(it.id ?? "");
        const label = String(it.label ?? "");
        const score = Number(it.score);
        if (!ID.test(id) || !LABELS.has(label) || !Number.isFinite(score)) continue;
        const reason = it.reason == null ? null : String(it.reason).slice(0, 1000);
        const fact = it.trigger_fact == null ? null : String(it.trigger_fact).slice(0, 600);
        const version = it.version == null ? null : String(it.version).slice(0, 80);
        const result = await sql`
          INSERT INTO ai_judgments (article_id, label, score, reason, trigger_fact, version, judged_at)
          SELECT ${id}, ${label}, ${score}, ${reason}, ${fact}, ${version}, now()
          WHERE EXISTS (SELECT 1 FROM articles WHERE id = ${id})
          ON CONFLICT (article_id) DO UPDATE SET label = EXCLUDED.label, score = EXCLUDED.score, reason = EXCLUDED.reason,
            trigger_fact = EXCLUDED.trigger_fact, version = EXCLUDED.version, judged_at = now()`;
        written += result.count ?? 0;
      }
      return reply.header("Cache-Control", "no-store").send({ ok: true, received: items.length, written });
    });

    app.get("/api/mark/all", async (_req, reply) => {
      const rows = await sql`
        SELECT m.article_id AS id, m.label, m.note, m.updated_at, a.title, a.url, a.published_at, s.name AS source,
               j.label AS ai_label, j.score AS ai_score
        FROM marks m JOIN articles a ON a.id = m.article_id JOIN sources s ON s.id = a.source_id
        LEFT JOIN ai_judgments j ON j.article_id = m.article_id
        ORDER BY m.updated_at DESC`;
      return reply.header("Cache-Control", "no-store").send({ ok: true, count: rows.length, marks: rows });
    });
  },
};
