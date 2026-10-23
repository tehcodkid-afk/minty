-- Household decisions are separate from bank data. All tables are additive so the
-- pre-household application can run unchanged if its design is restored.
CREATE TABLE household_settings (
 id INTEGER PRIMARY KEY CHECK (id = 1), a_owner TEXT NOT NULL, b_owner TEXT,
 a_label TEXT NOT NULL, b_label TEXT NOT NULL,
 a_weight INTEGER NOT NULL CHECK(a_weight BETWEEN 1 AND 1000),
 b_weight INTEGER NOT NULL CHECK(b_weight BETWEEN 1 AND 1000),
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE household_reviews (
 transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, classification TEXT NOT NULL CHECK(classification IN ('personal','household','churning','exclude','unreviewed')),
 shared_cents INTEGER, payer TEXT CHECK(payer IN ('a','b')), a_weight INTEGER, b_weight INTEGER,
 note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 reviewed_by TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE household_rules (
 id INTEGER PRIMARY KEY, merchant TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 currency TEXT NOT NULL, direction INTEGER NOT NULL CHECK(direction IN (-1,1)),
 classification TEXT NOT NULL CHECK(classification IN ('personal','household','churning','exclude')),
 created_by TEXT NOT NULL,
 UNIQUE(merchant,account_id,currency,direction)
);
CREATE TABLE household_settlements (
 id TEXT PRIMARY KEY, month TEXT NOT NULL, date TEXT NOT NULL, currency TEXT NOT NULL,
 from_person TEXT NOT NULL CHECK(from_person IN ('a','b')), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
 voided_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_household_settlements_month ON household_settlements(month,currency);
CREATE TABLE household_audit (
 id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
 detail TEXT NOT NULL, actor TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
