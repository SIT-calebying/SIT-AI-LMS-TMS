#!/bin/sh
# Local-only DB bootstrap. Replaces the stock init flow for a fresh Postgres 17 DB.
#
# Why: the postgres image runs *.sql init files with ON_ERROR_STOP, but upstream's
# database/01-schema.sql is not self-consistent on a fresh DB:
#   - `CREATE SCHEMA public;` fails (public already exists)
#   - tables from ~line 3090 on reference training_provider(id) / course_run(id) / app_user(id)
#     before those tables' primary keys exist (they are added later in the file)
# So: load the file tolerantly, load it again (pass 2 creates what pass 1 could not, since the
# keys now exist), report anything on pass 2 that is not "already exists", then seed the admin.
set -u
export PGUSER=postgres PGDATABASE="$POSTGRES_DB"

# Also missing upstream: the schema indexes use gin_trgm_ops (pg_trgm) and the seed hashes with
# crypt()/gen_salt() (pgcrypto), but no CREATE EXTENSION exists anywhere in the repo's SQL.
echo "[local-init] extensions: pg_trgm, pgcrypto (schema public)"
psql -q -c "CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;" || true

echo "[local-init] pass 1 of 01-schema.sql (errors tolerated)"
psql -q -f /schema/01-schema.sql > /tmp/pass1.log 2>&1 || true
echo "[local-init] pass 1 errors: $(grep -c 'ERROR' /tmp/pass1.log)"

echo "[local-init] pass 2 of 01-schema.sql"
psql -q -f /schema/01-schema.sql > /tmp/pass2.log 2>&1 || true
echo "[local-init] pass 2 errors that are NOT expected re-run noise (already exists / multiple primary keys):"
grep 'ERROR' /tmp/pass2.log | grep -v -e 'already exists' -e 'multiple primary keys' | sort | uniq -c || true
echo "[local-init] (end of pass 2 report)"

echo "[local-init] seeding admin (02-local-admin.sql)"
psql -v ON_ERROR_STOP=1 -q -f /schema/02-local-admin.sql || echo "[local-init] ADMIN SEED FAILED"
echo "[local-init] done: $(psql -tAc "select count(*) from information_schema.tables where table_schema='public'") tables"
