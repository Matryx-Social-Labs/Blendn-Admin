-- SCRUM-1358: a role the app connects as, which reads and writes rows and can do nothing else.
-- The web process and `prisma migrate deploy` shared the owner (on Railway, superuser) credentials, so one slip in a
-- `$queryRawUnsafe` ran with the right to drop any table or `COPY ... PROGRAM`. Migrations keep the owner role
-- (`MIGRATE_DATABASE_URL`, prisma.config.ts); the runtime `DATABASE_URL` moves to this role (DEPLOYMENT.md).
--
-- No password here, so no secret in git: a LOGIN role without one cannot sign in over the network until the owner sets
-- it (`ALTER ROLE blendn_app WITH PASSWORD ...`). Re-runnable: the role is cluster-wide and may already exist (another
-- database on the same server, or a schema rebuilt from empty), so its attributes are set whether it was made here or
-- not, and GRANT / REVOKE repeat harmlessly.
--
-- ALTER DEFAULT PRIVILEGES covers tables and sequences the role running it (the owner) creates later, so every future
-- migration must keep running as that same owner role.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  CREATE ROLE blendn_app;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
ALTER ROLE blendn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Only Postgres 14 and older let every role create in `public`; say it here so the role cannot on any version.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Nor temp tables: `pg_temp` is searched first, so one made through an injection would shadow a real table for every
-- later request on that pooled connection. Nothing in the app makes one; the owner is unaffected.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO blendn_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO blendn_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO blendn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO blendn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO blendn_app;

-- The migration history is the deploy's, not the app's: nothing at runtime reads it.
REVOKE ALL ON TABLE _prisma_migrations FROM blendn_app;

-- A GRANT or REVOKE by a role that does not own the object only warns and changes nothing. Refuse that here, so the
-- deploy fails (and this transaction applies nothing) rather than leaving a role with half its rights.
DO $$
BEGIN
  IF NOT has_schema_privilege('blendn_app', 'public', 'USAGE')
     OR has_schema_privilege('blendn_app', 'public', 'CREATE')
     OR has_database_privilege('blendn_app', current_database(), 'TEMPORARY')
     OR NOT has_table_privilege('blendn_app', 'notifications', 'DELETE')
     OR has_table_privilege('blendn_app', '_prisma_migrations', 'SELECT')
  THEN
    RAISE EXCEPTION 'blendn_app did not get the rights this migration grants: run it as the owner of the schema';
  END IF;
END
$$;

COMMIT;
