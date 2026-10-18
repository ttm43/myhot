// Operator settings: per-service request budgets (the circuit breaker paid calls check before sending).
import type { AdminBudget, AdminSettings, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";

/** The settings page: paid-service budgets. */
export async function settingsOverview(): Promise<BeforeJson<AdminSettings>> {
  return { budgets: await listBudgets() };
}

export async function listBudgets(): Promise<BeforeJson<AdminBudget>[]> {
  return sql<BeforeJson<AdminBudget>[]>`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour
    FROM budgets b ORDER BY b.service`;
}

export async function updateBudget(service: string, input: { perMinute: number; perHour: number; perDay: number; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  for (const v of [input.perMinute, input.perHour, input.perDay]) if (!Number.isInteger(v) || v < 0) throw new Error("budgets are non-negative integers (0 stops the service)");
  const [before] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  const [after] = await sql`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
    RETURNING service, per_minute, per_hour, per_day`;
  await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after);
  return after;
}
