import type { Usage } from './llm.ts'
import type { Period } from './period.ts'
export const LEASE_SECONDS = 120
export class BriefingStore {
  private db: D1Database
  private period: Period
  constructor(db: D1Database, period: Period) { this.db = db; this.period = period }

  latest() {
    return this.db.prepare("SELECT payload, generated_at FROM briefing_windows WHERE scope = 'general' AND period_from = ? AND period_until = ? AND payload IS NOT NULL")
      .bind(this.period.from, this.period.until).first<{ payload: string; generated_at: number }>()
  }

  async claim(token: string, now: number) {
    const result = await this.db.prepare(`INSERT INTO briefing_windows (scope, period_from, period_until, lease_token, lease_until)
      VALUES ('general', ?, ?, ?, ?) ON CONFLICT(scope, period_from, period_until) DO UPDATE SET lease_token = excluded.lease_token,
      lease_until = excluded.lease_until WHERE briefing_windows.lease_until <= ? AND briefing_windows.payload IS NULL`)
      .bind(this.period.from, this.period.until, token, now + LEASE_SECONDS, now).run()
    return result.meta.changes === 1
  }

  async save(token: string, payload: string, now: number) {
    const result = await this.db.prepare(`UPDATE briefing_windows SET payload = ?, generated_at = ?, lease_token = NULL,
      lease_until = 0 WHERE scope = 'general' AND period_from = ? AND period_until = ? AND lease_token = ? AND lease_until > ?`)
      .bind(payload, now, this.period.from, this.period.until, token, now).run()
    return result.meta.changes === 1
  }

  release(token: string) {
    return this.db.prepare("UPDATE briefing_windows SET lease_token = NULL, lease_until = 0 WHERE scope = 'general' AND period_from = ? AND period_until = ? AND lease_token = ?")
      .bind(this.period.from, this.period.until, token).run()
  }

  begin(token: string, now: number, model: string, version: string, inputs: string, request: string) {
    return this.db.prepare(`INSERT INTO briefing_generations
      (id, scope, started_at, status, model, prompt_version, inputs, request)
      VALUES (?, 'general', ?, 'pending', ?, ?, ?, ?)`).bind(token, now, model, version, inputs, request).run()
  }

  /** History and the latest snapshot are committed atomically, with a fenced lease. */
  async complete(token: string, payload: string, response: string, usage: Usage, now: number) {
    const result = await this.db.batch([
      this.db.prepare(`UPDATE briefing_generations SET finished_at = ?, response = ?, payload = ?,
        input_tokens = ?, output_tokens = ?, neurons = ?, neurons_basis = ?,
        status = CASE WHEN EXISTS (SELECT 1 FROM briefing_windows WHERE scope = 'general' AND period_from = ? AND period_until = ? AND lease_token = ? AND lease_until > ?)
        THEN 'succeeded' ELSE 'superseded' END WHERE id = ? AND status = 'pending'`)
        .bind(now, response, payload, usage.input_tokens, usage.output_tokens, usage.neurons, usage.neurons_basis, this.period.from, this.period.until, token, now, token),
      this.db.prepare(`UPDATE briefing_windows SET payload = ?, generated_at = ?, generation_id = ?, lease_token = NULL, lease_until = 0
        WHERE scope = 'general' AND period_from = ? AND period_until = ? AND lease_token = ? AND lease_until > ?
        AND EXISTS (SELECT 1 FROM briefing_generations WHERE id = ? AND status = 'succeeded')`)
        .bind(payload, now, token, this.period.from, this.period.until, token, now, token),
    ])
    return result[0].meta.changes === 1 && result[1].meta.changes === 1
  }

  async fail(token: string, now: number, code: string, response: string | null, usage: Usage) {
    await this.db.batch([
      this.db.prepare(`UPDATE briefing_generations SET status = 'failed', finished_at = ?, error_code = ?, response = ?,
        input_tokens = ?, output_tokens = ?, neurons = ?, neurons_basis = ? WHERE id = ? AND status = 'pending'`)
        .bind(now, code, response, usage.input_tokens, usage.output_tokens, usage.neurons, usage.neurons_basis, token),
      // Failed refreshes have a short cooldown to bound repeated billable failures.
      this.db.prepare("UPDATE briefing_windows SET lease_token = NULL, lease_until = ? WHERE scope = 'general' AND period_from = ? AND period_until = ? AND lease_token = ?")
        .bind(now + 60, this.period.from, this.period.until, token),
    ])
  }
}
