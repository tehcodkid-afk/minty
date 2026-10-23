-- One shared Lunch Money budget. All financial rows remain in Minty's canonical ledger.
ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'plaid';
ALTER TABLE accounts ADD COLUMN feed TEXT NOT NULL DEFAULT 'plaid';
CREATE TABLE lunch_money_budget (id INTEGER PRIMARY KEY CHECK(id=1), budget_id INTEGER NOT NULL);
CREATE TABLE lunch_money_accounts (
 remote_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
 start_date TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, offset INTEGER NOT NULL DEFAULT 0,
 cycle_end TEXT, cycle_started TEXT, cycle_since TEXT, cursor TEXT, last_full_sync TEXT, lease TEXT, lease_until TEXT, last_attempt TEXT, last_success TEXT, last_error TEXT,
 next_run TEXT NOT NULL DEFAULT '', source_status TEXT, source_updated_at TEXT
);
CREATE TABLE lunch_money_stage (
 remote_id INTEGER NOT NULL REFERENCES lunch_money_accounts(remote_id) ON DELETE CASCADE,
 transaction_id INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(remote_id,transaction_id)
);
CREATE TABLE lunch_money_records (
 transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
 remote_id INTEGER NOT NULL, source_transaction_id INTEGER NOT NULL, body TEXT NOT NULL,
 imported_at TEXT NOT NULL, UNIQUE(remote_id,source_transaction_id)
);
CREATE TABLE lunch_money_plans (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, budget_id INTEGER NOT NULL, body TEXT NOT NULL,
 expires_at TEXT NOT NULL, applied_at TEXT
);
CREATE INDEX idx_lunch_money_due ON lunch_money_accounts(enabled,next_run);
