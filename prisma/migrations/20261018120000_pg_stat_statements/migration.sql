-- Query statistics for the performance work (Canada launch, 2026-10-18).
--
-- Railway's Postgres already preloads the library (shared_preload_libraries =
-- pg_stat_statements); only the extension was missing, so there was no way to
-- ask which statements take the time. Where the library is not preloaded
-- (local Docker, CI) the extension still installs and only its view refuses to
-- be read, so this is safe everywhere. The extension is not trusted, so this
-- needs the superuser role migrations run as on Railway and in CI; a deploy
-- that ran migrations as a lesser role would stop here.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
COMMIT;
