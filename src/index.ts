import { saveProductPreference } from "./benefits/preferences";
import type { Env } from "./env";
import * as lunchMoney from "./lunch-money";
import { checkAccess } from "./access";
import { ConfigError, loadConfig, type Config } from "./config";
import { HttpError, MAX_BODY_BYTES, bodyTooLarge, json, unprocessable } from "./http";
import { budgetRefusal, countingDb, usesReadBudget, pruneReadCounts, rateLimited, recordReads } from "./limits";
import * as data from "./routes/data";
import * as household from "./routes/household";
import * as merchantCategories from "./routes/merchant-categories";
import * as abc from "./routes/benefits";
import * as syncReq from "./routes/syncrequest";
import * as link from "./routes/link";
import * as setup from "./routes/status";
import * as bills from "./routes/bills";
import * as ownBills from "./routes/household-bills";
import * as points from "./routes/points";
import * as cfa from "./routes/audit";
import * as inv from "./routes/investments";
import * as egg from "./routes/retirement";
import * as advice from "./routes/advice";
import * as accountNames from "./accounts";
import { runInvestmentSync } from "./investments";
import { refreshIrsLimits } from "./retirement/irs";
import { PlaidError } from "./plaid";
import { CATCH_UP_CRON, checkConnections, runSyncAll } from "./sync";
import { runStatementSync } from "./statements";
import { rekeyTokens } from "./token-key";
import { refreshTotals, snapshotBalances } from "./audit/totals";
import { isPending, markSwept, syncState } from "./routes/syncrequest";

/** Minty Worker. API paths are listed in wrangler.jsonc assets.run_worker_first; everything
 * else is served straight from public/. /healthz is the only path outside the Access check.
 * Sync runs only from the cron triggers (scheduled below); there is deliberately no HTTP sync endpoint. */

type Handler = (c: {
  env: Env; config: Config; request: Request; url: URL; params: string[]; ctx: ExecutionContext; email: string;
}) => Promise<Response>;

const ROUTES: Array<[method: string, path: RegExp, handler: Handler]> = [
  ["GET", /^\/imports\/lunchmoney$/, ({env,config}) => lunchMoney.catalog(env,config)],
  ["POST", /^\/imports\/lunchmoney\/preview$/, ({env,config,request,email}) => lunchMoney.preview(env,config,request,email)],
  ["POST", /^\/imports\/lunchmoney\/apply$/, ({env,config,request,email}) => lunchMoney.apply(env,config,request,email)],
  ["POST", /^\/imports\/lunchmoney\/pause$/, ({env,request}) => lunchMoney.pause(env,request)],
  ["POST", /^\/imports\/lunchmoney\/sync$/, async ({env}) => json(await lunchMoney.syncNext(env))],
  ["GET", /^\/household$/, ({ env, config, url }) => household.list(env, config, url)],
  ["PUT", /^\/household\/settings$/, ({ env, config, request, email }) => household.saveSettings(env, config, request, email)],
  ["PUT", /^\/household\/reviews\/(\d+)$/, ({ env, config, request, email, params }) => household.review(env, config, request, email, Number(params[0]))],
  ["POST", /^\/household\/rules$/, ({ env, request, email }) => household.saveRule(env, request, email)],
  ["DELETE", /^\/household\/rules\/(\d+)$/, ({ env, params, email }) => household.deleteRule(env, Number(params[0]), email)],
  ["POST", /^\/household\/settlements$/, ({ env, request, email }) => household.settle(env, request, email)],
  ["DELETE", /^\/household\/settlements\/([a-zA-Z0-9-]+)$/, ({ env, params, email }) => household.voidSettlement(env, params[0], email)],

  ["PUT", /^\/household\/accounts\/(\d+)$/, ({env,request,email,params}) => household.setAccount(env,request,email,Number(params[0]))],
  ["POST", /^\/household\/entries$/, ({env,config,request,email}) => household.saveEntry(env,config,request,email)],
  ["POST", /^\/household\/recurring$/, ({env,config,request,email}) => household.saveEntry(env,config,request,email,true)],
  ["POST", /^\/household\/recurring\/apply$/, ({env,request,email}) => household.materialize(env,request,email)],
  ["DELETE", /^\/household\/entries\/([a-zA-Z0-9-]+)$/, ({env,email,params}) => household.removeEntry(env,params[0],email)],
  ["DELETE", /^\/household\/recurring\/([a-zA-Z0-9-]+)$/, ({env,email,params}) => household.removeEntry(env,params[0],email,true)],

  ["PUT", /^\/household\/categories$/, ({env,request,email}) => merchantCategories.save(env,request,email)],
  ["POST", /^\/household\/categories\/suggest$/, ({env,request}) => merchantCategories.suggest(env,request)],
  ["GET", /^\/status$/, ({ env, config, email }) => setup.status(env, config, email)],
  ["GET", /^\/users$/, ({ env, config }) => data.users(env, config)],
  ["GET", /^\/items$/, ({ env, config }) => data.items(env, config)],
  ["GET", /^\/health$/, ({ env, config }) => data.health(env, config)],
  ["GET", /^\/accounts$/, ({ env, url }) => data.accounts(env, url)],
  ["GET", /^\/capacity$/, ({ env, config }) => data.capacity(env, config)],
  ["GET", /^\/transactions$/, ({ env, url }) => data.transactions(env, url)],
  ["GET", /^\/tags$/, ({ env }) => data.listTags(env)],
  ["GET", /^\/sync-request$/, ({ env }) => syncReq.getSyncRequest(env)],
  ["POST", /^\/sync-request$/, ({ env, email }) => syncReq.requestSync(env, email)],
  ["PUT", /^\/benefits\/preferences$/, ({env,request,email}) => saveProductPreference(env,request,email)],
  ["GET", /^\/benefits$/, ({ env, url }) => abc.benefits(env, url)],
  ["PUT", /^\/benefits\/cards\/(\d+)$/, ({ env, request, params }) => abc.setCard(env, request, Number(params[0]))],
  ["PUT", /^\/benefits\/marks$/, ({ env, request, email }) => abc.setMark(env, request, email)],
  ["POST", /^\/transactions\/tags$/, ({ env, request }) => data.bulkTags(env, request)],
  ["PUT", /^\/transactions\/([^/]+)\/tags$/, ({ env, request, params }) => {
    if (!/^\d+$/.test(params[0])) throw unprocessable("transaction id must be an integer");
    return data.setTags(env, request, Number(params[0]));
  }],
  ["POST", /^\/link\/token$/, ({ env, config, request, email }) => link.createLinkToken(env, config, request, email)],
  ["POST", /^\/link\/exchange$/, ({ env, config, request, ctx, email }) => link.exchange(env, config, request, ctx, email)],
  ["POST", /^\/link\/cancel$/, ({ env, request, email }) => link.cancel(env, request, email)],
  ["POST", /^\/link\/token\/update$/, ({ env, config, request, email }) => link.updateMode(env, config, request, email)],
  ["GET", /^\/bills$/, ({ env, config }) => bills.bills(env, config)],
  ["POST", /^\/bills$/, ({ env, config, request }) => ownBills.createBill(env, config, request)],
  ["POST", /^\/bills\/known$/, ({ env, request }) => ownBills.knownBills(env, request)],
  ["PUT", /^\/bills\/(\d+)$/, ({ env, config, request, params }) => ownBills.updateBill(env, config, request, Number(params[0]))],
  ["POST", /^\/bills\/(\d+)\/paid$/, ({ env, request, params }) => ownBills.markBillPaid(env, request, Number(params[0]))],
  ["DELETE", /^\/bills\/(\d+)$/, ({ env, params }) => ownBills.deleteBill(env, Number(params[0]))],
  ["GET", /^\/audit$/, ({ env, config, url }) => cfa.audit(env, config, url)],
  ["GET", /^\/audit\/buckets$/, ({ env, url }) => cfa.getBucket(env, url)],
  ["PUT", /^\/audit\/buckets$/, ({ env, request }) => cfa.setBucket(env, request)],
  ["GET", /^\/audit\/advice$/, ({ env, config, url }) => advice.advice(env, config, url)],
  ["PUT", /^\/audit\/checklist$/, ({ env, request }) => advice.setChecklist(env, request)],
  ["GET", /^\/points$/, ({ env }) => points.listPoints(env)],
  ["POST", /^\/points$/, ({ env, config, request }) => points.createReading(env, config, request)],
  ["POST", /^\/points\/known$/, ({ env, request }) => points.knownPoints(env, request)],
  ["PUT", /^\/points\/(\d+)$/, ({ env, config, request, params }) => points.updateReading(env, config, request, Number(params[0]))],
  ["DELETE", /^\/points\/(\d+)$/, ({ env, params }) => points.deleteReading(env, Number(params[0]))],
  ["POST", /^\/link\/token\/statements$/, ({ env, config, request, email }) => link.updateMode(env, config, request, email, "statements")],
  ["POST", /^\/link\/statements\/complete$/, ({ env, config, request, email }) => bills.completeStatements(env, config, request, email)],
  ["GET", /^\/statements$/, ({ env }) => bills.statementBanks(env)],
  ["POST", /^\/statements\/off$/, ({ env, request }) => bills.statementsOff(env, request)],
  ["POST", /^\/statements\/paid$/, ({ env, request }) => bills.markStatementPaid(env, request)],
  ["POST", /^\/link\/token\/investments$/, ({ env, config, request, email }) => link.updateMode(env, config, request, email, "investments")],
  ["POST", /^\/link\/investments\/complete$/, ({ env, config, request, email }) => inv.completeInvestments(env, config, request, email)],
  ["GET", /^\/retirement$/, ({ env, config, url }) => egg.retirement(env, config, url)],
  ["PUT", /^\/retirement\/profile$/, ({ env, config, request }) => egg.setProfile(env, config, request)],
  ["GET", /^\/investments$/, ({ env }) => inv.investmentBanks(env)],
  ["POST", /^\/investments\/off$/, ({ env, request }) => inv.investmentsOff(env, request)],
  ["PUT", /^\/accounts\/(\d+)\/name$/, ({ env, request, params }) => accountNames.renameAccount(env, request, Number(params[0]))],
  ["PUT", /^\/accounts\/(\d+)\/view$/, ({ env, request, params }) => inv.setAccountView(env, request, Number(params[0]))],
  ["POST", /^\/link\/reconnected$/, ({ env, config, request }) => link.reconnected(env, config, request)],
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });

    // Not an API route: a static file (or its 404). Those are the pages in public/
    // and carry no data; Access still guards the hostname at the edge.
    const matches = ROUTES.map(([m, re, h]) => [m, url.pathname.match(re), h] as const).filter(([, m]) => m);
    if (!matches.length) return env.ASSETS.fetch(request);

    // Cloudflare Access adds the sign-in header to any request that carries the Access cookie,
    // including ones another site starts in the signed-in browser. Refuse state-changing requests
    // that didn't come from this origin (browsers always send Origin, and Sec-Fetch-Site, on
    // cross-site POST/PUT).
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ detail: "cross-site request refused" }, 403);
      }
    }

    const auth = await checkAccess(request, env);
    if (!auth.ok) return json({ detail: auth.detail }, 403);

    // Before any D1 or Plaid work (src/limits.ts).
    if (await rateLimited(env, auth.email, request.method, url)) {
      return json({ detail: "Too many requests. Wait a minute and try again." }, 429, { "retry-after": "60" });
    }
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
      const e = bodyTooLarge();
      return json({ detail: e.detail }, e.status);
    }

    const hit = matches.find(([m]) => m === request.method);
    if (!hit) return json({ detail: "method not allowed" }, 405);

    // Every handler read counts, including small queries; refusals do not write usage counters.
    const counted = countingDb(env.DB);
    try {
      const config = loadConfig(env);
      if (usesReadBudget(request.method, url)) {
        const refusal = await budgetRefusal(env);
        if (refusal) return json({ detail: refusal }, 429);
      }
      return await hit[2]({ env: { ...env, DB: counted.db }, config, request, url, params: hit[1]!.slice(1), ctx, email: auth.email });
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
      if (e instanceof ConfigError) return json({ detail: e.message }, 500);
      if (e instanceof PlaidError) {
        console.error(`plaid error ${e.errorCode} (request ${e.requestId ?? "?"})`);
        return json({ detail: `Plaid error: ${e.errorCode}` }, 502);
      }
      console.error("unhandled error", e instanceof Error ? e.message : e);   // never log request bodies
      return json({ detail: "internal error" }, 500);
    } finally {
      const rows = counted.rows();
      if (rows > 0) {
        await recordReads(env.DB, rows).catch((e) => console.error("counting reads failed:", e instanceof Error ? e.message : e));
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Isolate Lunch Money's page/CPU budget from direct Plaid sync and maintenance.
    if(controller.cron===lunchMoney.LUNCH_MONEY_CRON){await lunchMoney.syncNext(env);return;}
    // The 10-minute catch-up continues unfinished downloads, unless someone asked for a sync from
    // the dashboard: then it sweeps every bank, like the hourly run. Sync only ever runs here.
    const catchUp = controller.cron === CATCH_UP_CRON;
    const requested = catchUp && isPending(await syncState(env).catch(() => ({ requested_at: null, last_sweep_at: null })));
    const updatesOnly = catchUp && !requested;
    const results = await runSyncAll(env, undefined, { updatesOnly });
    if (!updatesOnly) await markSwept(env).catch((e) => console.error("marking the sweep failed:", e instanceof Error ? e.message : e));
    if (!updatesOnly || Object.keys(results).length) {          // quiet when nothing is downloading
      console.log(requested ? "requested sync complete" : updatesOnly ? "catch-up sync complete" : "scheduled sync complete", JSON.stringify(results));   // item id -> result; no data
    }
    if (updatesOnly && !Object.keys(results).length) {
      // A quiet catch-up run (nothing downloading): one bank's statement details, if one is due
      // (docs/bills.md). Never in a run that synced, so it never takes sync's CPU or subrequests.
      const done = await runStatementSync(env).catch((e) => {
        console.error("statement details failed:", e instanceof Error ? e.message : e);
        return {};
      });
      if (Object.keys(done).length) console.log("statement details", JSON.stringify(done));   // item id -> status
      // Then one bank's investments (EGG), if one is due: holdings and a page of its transactions.
      const invested = await runInvestmentSync(env).catch((e) => {
        console.error("investments failed:", e instanceof Error ? e.message : e);
        return {};
      });
      if (Object.keys(invested).length) console.log("investments", JSON.stringify(invested));   // item id -> status
      // The IRS contribution limits (EGG): asked only while a year isn't settled, at most once a week.
      const irs = await refreshIrsLimits(env).catch((e) => ({ failed: e instanceof Error ? e.message : String(e) }));
      if (Object.keys(irs).length) console.log("irs limits", JSON.stringify(irs));
      // A correction made on the audit shows within minutes, not at the next hourly run.
      const totals = await refreshTotals(env).catch((e) => {
        console.error("monthly totals failed:", e instanceof Error ? e.message : e);
        return null;
      });
      if (totals?.from) console.log("monthly totals", JSON.stringify(totals));
    }
    if (!catchUp) {
      // After sync, so a failed check never costs a sync; each bank about once a day.
      const checked = await checkConnections(env).catch((e) => {
        console.error("connection check failed:", e instanceof Error ? e.message : e);
        return {};
      });
      if (Object.keys(checked).length) console.log("connection check", JSON.stringify(checked));   // item id -> Plaid code or null
      // The cron reads what it needs whatever the day's read budget says; it only tidies the counters.
      await pruneReadCounts(env.DB).catch((e) => console.error("pruning read counts failed:", e instanceof Error ? e.message : e));
      await link.pruneLinkSessions(env.DB).catch((e) => console.error("pruning Link sessions failed:", e instanceof Error ? e.message : e));
      // While TOKEN_ENC_KEY is being changed: tokens still on the old key, saved under the new one
      // (banks that synced above already were). Reads nothing when TOKEN_ENC_KEY_PREVIOUS isn't set.
      const keys = await rekeyTokens(env).catch((e) => {
        console.error("re-keying tokens failed:", e instanceof Error ? e.message : e);
        return null;
      });
      if (keys && (keys.rekeyed || keys.previous || keys.neither)) console.log("token key", JSON.stringify(keys));   // counts only
      // CFA (docs/cfa.md): today's balances, and the monthly totals where something changed. After
      // sync, so they include this run's transactions; all SQL, so it costs the Worker no CPU to speak of.
      await snapshotBalances(env).catch((e) => console.error("balance snapshots failed:", e instanceof Error ? e.message : e));
      const totals = await refreshTotals(env).catch((e) => {
        console.error("monthly totals failed:", e instanceof Error ? e.message : e);
        return null;
      });
      if (totals?.from) console.log("monthly totals", JSON.stringify(totals));
    }
  },
} satisfies ExportedHandler<Env>;
