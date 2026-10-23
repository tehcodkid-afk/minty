import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
});
after(async () => { await browser?.close(); });

// Real dashboard, lock and household scripts. No live service or bank data. The platform
// authenticator is simulated, while Chromium supplies the actual modal/inert/focus behavior.
async function visit(t, { state = "on", available = true, recent = false, path = "/?household" } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  let reads = 0;
  await page.route("http://localhost:4399/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/household") {
      reads++;
      return route.fulfill({ status: 503, json: { error: "Test response" } });
    }
    if (pathname.endsWith(".js") && !["/lock.js", "/household.js"].includes(pathname)) {
      return route.fulfill({ contentType: "application/javascript", body: "" });
    }
    try {
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      const body = await readFile(new URL(`../../public/${name}`, import.meta.url));
      await route.fulfill({ body, contentType: name.endsWith(".js") ? "application/javascript"
        : name.endsWith(".css") ? "text/css" : "text/html" });
    } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.addInitScript(({ state, available, recent }) => {
    if (state) localStorage.setItem("minty_lock", JSON.stringify({ state, cred: "AQID" }));
    if (recent) sessionStorage.setItem("minty_lock_seen", String(Date.now()));
    window.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => available };
    window.verifications = 0;
    Object.defineProperty(navigator, "credentials", { value: {
      get: async () => {
        window.verifications++;
        if (window.rejectUnlock) throw new Error("Cancelled");
        const bytes = new Uint8Array(37); bytes[32] = 4;
        return { response: { authenticatorData: bytes.buffer } };
      },
      create: async () => ({ rawId: new Uint8Array([1, 2, 3]).buffer }),
    } });
  }, { state, available, recent });
  await page.goto(`http://localhost:4399${path}`);
  return { page, reads: () => reads };
}

async function unlock(page) {
  await page.locator("#minty-lock .primary").click({ timeout: 2000 });
  await page.waitForFunction(() => !document.documentElement.classList.contains("minty-locked"));
  await page.waitForFunction(() => document.querySelector("#household").matches(":modal"));
}

test("Household deep link lets the visible Unlock button authenticate", async t => {
  const { page, reads } = await visit(t);
  await page.locator("#minty-lock .primary").waitFor({ state: "visible" });
  await unlock(page);
  assert.equal(await page.evaluate(() => window.verifications), 1);
  assert.equal(reads(), 1);
});

test("Household stays closed and unread until authentication succeeds", async t => {
  const { page, reads } = await visit(t);
  await page.locator("#minty-lock .primary").waitFor({ state: "visible" });
  assert.equal(await page.locator("#household").evaluate(el => el.open), false);
  assert.equal(reads(), 0);
  await page.evaluate(() => { window.rejectUnlock = true; });
  await page.locator("#minty-lock .primary").click();
  await page.locator("#minty-lock .err").filter({ hasText: "Couldn't unlock" }).waitFor();
  assert.equal(reads(), 0);
  assert.equal(await page.locator("#household").evaluate(el => el.open), false);
  await page.evaluate(() => { window.rejectUnlock = false; });
  await unlock(page);
});

for (const [name, options] of Object.entries({ disabled: { state: "off" }, unavailable: { available: false }, recent: { recent: true } })) {
  test(`Household opens when the device lock is ${name}`, async t => {
    const { page } = await visit(t, options);
    await page.waitForFunction(() => document.querySelector("#household").matches(":modal"));
    assert.equal(await page.locator("html").evaluate(el => el.classList.contains("minty-locked")), false);
  });
}

test("first-visit setup can be accepted or declined before opening Household", async t => {
  for (const accept of [true, false]) {
    const { page } = await visit(t, { state: null });
    await page.locator(accept ? "#minty-lock .primary" : "#minty-lock .secondary:not(.again)").click({ timeout: 2000 });
    await page.waitForFunction(() => document.querySelector("#household").matches(":modal"));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("minty_lock")).state), accept ? "on" : "off");
  }
});

test("returning after five minutes can unlock and restore Household", async t => {
  const { page } = await visit(t);
  await unlock(page);
  await page.evaluate(() => {
    sessionStorage.setItem("minty_lock_seen", "1");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator("#minty-lock .primary").waitFor({ state: "visible" });
  await unlock(page);
  assert.equal(await page.evaluate(() => window.verifications), 2);
});

test("ordinary dashboard does not open Household after unlocking", async t => {
  const { page, reads } = await visit(t, { path: "/" });
  await page.locator("#minty-lock .primary").click({ timeout: 2000 });
  await page.waitForFunction(() => !document.documentElement.classList.contains("minty-locked"));
  assert.equal(await page.locator("#household").evaluate(el => el.open), false);
  assert.equal(reads(), 0);
  await page.locator("[data-open-household=\"\"]").evaluate(el => el.click());
  await page.waitForFunction(() => document.querySelector("#household").matches(":modal"));
});
