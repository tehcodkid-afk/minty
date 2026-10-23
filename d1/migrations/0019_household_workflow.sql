-- Selected accounts only supply candidates; existing explicit Household tags remain authoritative.
CREATE TABLE household_accounts (account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE household_recurring (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, start_month TEXT NOT NULL, currency TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, payer TEXT NOT NULL CHECK(payer IN ('a','b')),
 a_weight INTEGER NOT NULL, b_weight INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL
);
CREATE TABLE household_entries (
 id TEXT PRIMARY KEY, month TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, payer TEXT NOT NULL CHECK(payer IN ('a','b')),
 a_weight INTEGER NOT NULL, b_weight INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
 recurring_id TEXT REFERENCES household_recurring(id), voided_at TEXT, created_by TEXT NOT NULL,
 UNIQUE(recurring_id, month)
);
CREATE INDEX idx_household_entries_month ON household_entries(month,currency);
CREATE TABLE merchant_categories (
 merchant TEXT PRIMARY KEY, category TEXT NOT NULL, source TEXT NOT NULL, updated_by TEXT NOT NULL
);
-- Preserve existing explicit household confirmations as actual transaction tags.
INSERT INTO transaction_tags(transaction_id,tag,position)
 SELECT transaction_id,'Household',coalesce((SELECT max(position)+1 FROM transaction_tags t WHERE t.transaction_id=r.transaction_id),0)
 FROM household_reviews r WHERE classification='household'
 ON CONFLICT(transaction_id,tag) DO NOTHING;
CREATE TABLE household_ai_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
CREATE INDEX idx_household_audit_entity ON household_audit(entity,entity_id);
