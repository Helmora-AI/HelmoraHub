# Supabase control-plane migrations

**Source of truth:** [`../supabase-schema.sql`](../supabase-schema.sql)

Do **not** add `\i` / `\include` files here — the Supabase SQL Editor does not support psql meta-commands.

## Apply (required before Settings → SQL)

1. Open your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** → New query.
3. Paste the full contents of `sql/supabase-schema.sql` (or fetch from Hub: `GET /api/settings/storage/schema` while authenticated as admin).
4. Run the query (idempotent: `create table if not exists` / `add column if not exists`).
5. In Helmora Settings, choose **SQL (Supabase)**, fill URL + service role key + encryption key, **Test connection**, then **Apply**.

### Legacy `ctrlhub_*` tables

If you previously applied the old CtrlHub schema, run [`../rename-ctrlhub-to-helmora.sql`](../rename-ctrlhub-to-helmora.sql) **once** before or instead of re-creating tables.

## Versioned copies (optional)

If you need a dated snapshot for ops, copy `supabase-schema.sql` into this folder as a full standalone `.sql` file (no `\i`). Prefer keeping one source of truth and documenting apply steps over maintaining duplicates.
