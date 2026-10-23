# Security hardening for this fork

## Changes

- Upstream update checks have read-only permission and only publish a comparison link in the
  workflow summary. No automated sync or deployment of upstream code.
- All data routes, including tag scans, retirement, audit, points, setup, and mutations,
  check the read budget before running. `/users` reads configuration only; `/healthz` remains
  public liveness. Every handler read counts, including requests below 1,000 rows. Usage is
  persisted before returning a response. Refused requests do not write usage counters.
- The current Cloudflare Vitest plugin and patched dependencies replace the deprecated test
  pool. CI installs with scripts disabled and audits development and production packages.
- Recovery guidance distinguishes re-encryption from revoking credentials and acknowledges
  that stolen ciphertext remains decryptable with its original key.

## Before connecting real banks

1. Review and merge the hardening PR. Require its Worker check on `main`, block force pushes,
   and route subsequent code changes through pull requests. The old scheduled sync continues
   until the replacement workflow is on the default branch.
2. In Cloudflare, disable non-production branch builds and verify the production branch is
   `main`. Preview URLs being disabled does not by itself disable preview builds. Restrict
   build-token privileges and use `npm ci --ignore-scripts` for installation.
3. Configure Access for the exact hostname and specific household email addresses; set
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and matching `ALLOWED_LOGINS`. Every admitted person is
   fully trusted. Check that an unauthenticated data request is denied at the deployed host.
4. Store unique encryption and Plaid keys as Worker secrets. Test linking, sync, and reconnect
   with Plaid Sandbox first. Production bank linking and account credentials are owner actions.
5. After production setup, reconcile one bank's accounts, balances, posted transactions,
   refunds and statement credits against its statements. Verify history coverage explicitly
   before treating yearly spend or returns as complete. Retain an encrypted backup.

The code changes do not configure Cloudflare, connect a bank, or change an installed dashboard.

## Budget limits

The default three-million-row read budget leaves headroom under D1's free daily read quota.
It is not an atomic quota reservation: in-flight concurrent queries, budget lookups, accounting,
background work and other D1 clients also consume resources. Each request with handler reads
now writes one accounting row, so monitor D1's separate read and write quotas. Rate limits and
fully trusted household access remain part of the model. A spent budget returns a diagnostic
429 from data endpoints, including `/status`, rather than running setup queries past the limit.

## Dashboard integration boundary

Minty can supply bank accounts, transactions and credit matches to the combined private
`finance-manager` dashboard. Build the connector in that dashboard's shared backend. Use
provider-scoped identities, explicit owner/card mappings, pending-to-posted reconciliation,
and an import preview before replacing or combining saved records. Preserve user corrections.

The current Minty API expects a human Access JWT and rejects email-less service tokens; do
not weaken that check to make background imports work. A separately scoped authenticated
read-only integration API or an owner-reviewed export/import is additional work. Real bank
credentials stay in the bank-collection service, not browser scripts or GitHub.

## Verification

`npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm audit`, and
`npm run build:demo`. The regression tests use synthetic records and dummy credentials.
Keep operational account details, bank names, keys, tokens and private exports out of this repo.
