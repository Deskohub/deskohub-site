-- A draft deployment may already have applied the first pass migration.
-- Move any pending recipient to their sign-in identity before dropping the column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pass_purchases WHERE holder_account_id IS NULL) THEN
    RETURN;
  END IF;

  LOCK TABLE auth."user" IN SHARE ROW EXCLUSIVE MODE;

  WITH missing_logins AS (
    SELECT DISTINCT lower(btrim(holder_email)) AS email
    FROM pass_purchases
    WHERE holder_account_id IS NULL
    EXCEPT
    SELECT email FROM auth."user"
  ), new_logins AS MATERIALIZED (
    SELECT uuid_generate_v7()::text AS id, email FROM missing_logins
  ), new_accounts AS (
    INSERT INTO customer_accounts (id)
    SELECT id FROM new_logins
    RETURNING id
  )
  INSERT INTO auth."user" (id, name, email)
  SELECT new_logins.id, '', new_logins.email
  FROM new_logins JOIN new_accounts USING (id);

  UPDATE pass_purchases AS pass
  SET holder_account_id = login.id
  FROM auth."user" AS login
  WHERE pass.holder_account_id IS NULL
    AND login.email = lower(btrim(pass.holder_email));
END $$;
--> statement-breakpoint
ALTER TABLE "pass_purchases" DROP CONSTRAINT "pass_purchases_holder_check";--> statement-breakpoint
ALTER TABLE "pass_purchases" DROP COLUMN "holder_email";--> statement-breakpoint
ALTER TABLE "pass_purchases" ALTER COLUMN "holder_account_id" SET NOT NULL;
