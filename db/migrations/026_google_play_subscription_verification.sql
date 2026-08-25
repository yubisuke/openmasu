-- Extend the protected Google Play verification queue for initial subscription orders.
ALTER TABLE ephemeral.google_play_product_verifications
  ADD COLUMN purchase_kind text NOT NULL DEFAULT 'one_time_product'
    CHECK (purchase_kind IN ('one_time_product', 'subscription_initial'));

ALTER TABLE ledger.google_play_purchase_verification_results
  ADD COLUMN purchase_kind text NOT NULL DEFAULT 'one_time_product'
    CHECK (purchase_kind IN ('one_time_product', 'subscription_initial'));
