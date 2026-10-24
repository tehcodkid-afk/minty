ALTER TABLE accounts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'unassigned' CHECK(purpose IN ('unassigned','personal','churning'));
UPDATE accounts SET purpose='personal' WHERE id IN (SELECT account_id FROM household_accounts);
CREATE TABLE benefit_product_preferences (
 product_id TEXT NOT NULL, benefit_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 PRIMARY KEY(product_id,benefit_id)
);
