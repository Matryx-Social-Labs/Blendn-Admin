-- SCRUM-1358: a role the app connects as, which reads and writes rows and can do nothing else.
-- The web process and `prisma migrate deploy` shared the owner (on Railway, superuser) credentials, so one slip in a
-- `$queryRawUnsafe` ran with the right to drop any table or `COPY ... PROGRAM`. Migrations keep the owner role
-- (`MIGRATE_DATABASE_URL`, prisma.config.ts); the runtime `DATABASE_URL` moves to this role (OWNER.md).
--
-- No password here, so no secret in git: a LOGIN role without one cannot sign in over the network until the owner sets
-- it (`ALTER ROLE blendn_app WITH PASSWORD ...`). Re-runnable: the role is cluster-wide and may already exist (another
-- database on the same server, or a schema rebuilt from empty), and GRANT / REVOKE repeat harmlessly.
--
-- ALTER DEFAULT PRIVILEGES covers tables and sequences the role running it (the owner) creates later, so every future
-- migration must keep running as that same owner role.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blendn_app') THEN
    CREATE ROLE blendn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Only Postgres 14 and older let every role create in `public`; say it here so the role cannot on any version.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO blendn_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO blendn_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO blendn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO blendn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO blendn_app;

-- The migration history is the deploy's, not the app's: nothing at runtime reads it.
REVOKE ALL ON TABLE _prisma_migrations FROM blendn_app;

COMMIT;
