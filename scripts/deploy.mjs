// `npm run deploy` — what Cloudflare Workers Builds runs on every push to your fork's main.
//
// Normal deploy: apply pending D1 migrations first, then deploy the code that needs them.
// First deploy: the D1 database doesn't exist yet and is created by `wrangler deploy`
// (automatic provisioning, by database_name in wrangler.jsonc), so deploy first, then migrate.
// Migrations are tracked in d1_migrations, so re-running this is safe.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// Run the installed CLI directly so deployment also works on Windows without a shell.
const require = createRequire(import.meta.url);
const WRANGLER = resolve(dirname(require.resolve("wrangler/package.json")), require("wrangler/package.json").bin.wrangler);

// Extra flags are passed to every wrangler call, e.g. `npm run deploy -- --temporary`.
const EXTRA = process.argv.slice(2);

function wrangler(...args) {
  const r = spawnSync(process.execPath, [WRANGLER, ...args, ...EXTRA], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  if (r.error) console.error(r.error.message);
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  return { ok: r.status === 0, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function must(result, what) {
  if (!result.ok) {
    console.error(`\ndeploy: ${what} failed (see above).`);
    process.exit(1);
  }
}

console.log("deploy: applying D1 migrations");
const migrate = wrangler("d1", "migrations", "apply", "DB", "--remote");
if (migrate.ok) {
  console.log("deploy: deploying the Worker");
  must(wrangler("deploy"), "wrangler deploy");
} else if (/provision|couldn't find|could not find|not found/i.test(migrate.output)) {
  console.log("deploy: no database yet (first deploy) — deploying to create it, then migrating");
  must(wrangler("deploy"), "wrangler deploy");
  must(wrangler("d1", "migrations", "apply", "DB", "--remote"), "applying D1 migrations");
} else {
  must(migrate, "applying D1 migrations");
}
console.log("deploy: done");
