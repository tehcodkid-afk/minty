import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, loadFixture } from "./helpers";
import { readsToday, recordReads } from "../src/limits";

beforeEach(async () => {
  await loadFixture();
  await env.DB.prepare("DELETE FROM app_state WHERE key LIKE 'rows_read:%'").run();
});

describe("read-budget security regressions", () => {
  it.each([
    ["GET", "/household?month=2026-09"], ["POST", "/household/settlements"],
    ["GET", "/tags"], ["GET", "/retirement"], ["GET", "/audit"],
    ["GET", "/audit/advice"], ["GET", "/points"], ["GET", "/status"],
    ["GET", "/items"], ["GET", "/health"], ["GET", "/capacity"],
    ["GET", "/investments"], ["GET", "/statements"],
    ["POST", "/transactions/tags"], ["POST", "/link/token"],
  ])("refuses %s %s before doing data work after the budget is spent", async (method, path) => {
    await recordReads(env.DB, 3_000_001);
    const response = await call(path, { method, ...(method === "POST" ? {body: "{}"} : {}) });
    expect(response.status).toBe(429);
    expect(await readsToday(env.DB)).toBe(3_000_001); // rejected requests must not keep writing counters
  });

  it("counts small reads across sequential requests instead of dropping them", async () => {
    for (let i = 0; i < 3; i++) {
      const before = await readsToday(env.DB);
      expect((await call("/tags")).status).toBe(200);
      expect(await readsToday(env.DB)).toBeGreaterThan(before);
    }
  });

  it("stops an expensive tag scan while keeping configuration-only discovery available", async () => {
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name)
      SELECT 'me',10,'review-'||x,100,'2026-10-01','Synthetic review' FROM n`).run();
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50)
      INSERT INTO transaction_tags (transaction_id,tag,position)
      SELECT t.id,'tag-'||n.x,n.x FROM transactions t,n WHERE t.plaid_txn_id LIKE 'review-%'`).run();
    await recordReads(env.DB, 3_000_001);
    expect((await call("/tags")).status).toBe(429);
    expect((await call("/users")).status).toBe(200);
    expect((await call("/healthz", {token: null})).status).toBe(200);
  });
});
