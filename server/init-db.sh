#!/bin/sh
set -eu
# This runs only while initializing a NEW PostgreSQL volume. Existing volumes
# require an explicit migration; never drop/reinitialize them to apply changes.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_password RUNTIME_DB_PASSWORD
CREATE ROLE yuelian_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SELECT format('ALTER ROLE yuelian_runtime PASSWORD %L', :'runtime_password') \gexec
\i /migrations/001_permissions.sql
\i /migrations/002_nonce_cleanup_privilege.sql
\i /migrations/003_business_integration.sql
\i /migrations/004_submission_recovery.sql
SQL
