-- A variable stores its value in exactly one column: `value` for plain variables,
-- `encrypted_value` for secrets. Enforced here so no code path can store a secret in plaintext.
ALTER TABLE "environment_variables"
  ADD CONSTRAINT "environment_variables_value_matches_secret_flag" CHECK (
    ("is_secret" AND "encrypted_value" IS NOT NULL AND "value" IS NULL)
    OR (NOT "is_secret" AND "value" IS NOT NULL AND "encrypted_value" IS NULL)
  );
