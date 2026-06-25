# Audit Report — Statement of Account Viewer

Interactive, filterable Statement-of-Account report grouped **Cost Dimension → Project → Statement of Account**, backed by **Supabase** (BaaS).

Upload an Excel export per cost dimension (Material, Labor, Equipment, Overhead). The browser parses it, sends the rows to a secret-gated Supabase Edge Function, and the data is stored in Postgres. The viewer reads from Supabase and lets you filter by **cost dimension**, **project name**, and **date range**, recomputing each project's running balance and totals on the filtered set. Export to PDF via the browser print dialog.

## Architecture

```
Browser (index.html)
  ├─ READ  : supabase-js (URL + publishable key)  →  SELECT from public tables
  │                                                   (RLS: public read, no public write)
  └─ UPLOAD: SheetJS parses .xlsx in-browser → POST rows + upload key → Edge Function "ingest"
                                                          │ (service role, server-side)
                                                          ▼
                                                   Supabase Postgres
                                                     • dimensions
                                                     • transactions
                                                     • app_config (private: upload key)
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | The web app: loads from Supabase, in-browser upload, filters, PDF export |
| `config.js` | Supabase URL + publishable (anon) key (safe to commit — see Security) |
| `supabase/migrations/*.sql` | Schema, indexes, and RLS policies |
| `supabase/functions/ingest/index.ts` | Edge Function that validates the upload key and replaces a dimension's rows |
| `generate-report.cjs` | Optional **local** PDF generator (reads `./inputs/*.xlsx`, no backend needed) |
| `serve.json` / `package.json` | Static dev server (`npm run dev` → http://localhost:3000) |

## Run locally

```bash
npm install
npm run dev          # serves index.html at http://localhost:3000
```

Or deploy `index.html` + `config.js` to any static host (GitHub Pages, Netlify, etc.) — it talks directly to Supabase.

## Uploading data

1. Click **⬆ Upload Excel** in the toolbar.
2. Choose an `.xlsx` export. **The file name decides the dimension** (e.g. `…Material.xlsx` → Material).
3. Enter the **upload key** (stored in Supabase; see below). Re-uploading a dimension replaces its data.

The expected Excel layout is an R&F "Statement of Account" export with a `Date / Voucher Type / No / CostCenter / Ref No. / Memo / Debit / Credit / Balance` table; columns are matched by header name, so minor layout differences are tolerated.

## Security / data note

⚠️ **This repo is public and the data is configured for public read.** Anyone with the URL + publishable key (both in `config.js`) can read the stored statements. This is an explicit choice. Protection is on the **write** side:

- RLS allows `SELECT` to everyone, and defines **no** insert/update/delete policy → the public key cannot modify anything.
- Uploads go only through the `ingest` Edge Function, which checks an **upload key** stored in a private `app_config` table (no RLS policy → unreadable by the public key; only the service role can read it).

To lock down reads later, change the `transactions`/`dimensions` SELECT policies from `using (true)` to require `auth.role() = 'authenticated'` and add Supabase Auth.

Rotate the upload key in the Supabase SQL editor:

```sql
update public.app_config set value = '<new-secret>' where key = 'upload_secret';
```

## Local PDF export (optional, no backend)

```bash
# put one .xlsx per dimension in ./inputs, then:
npm run report       # writes "Statement Of Account - Cost Dimensions Report.pdf"
```
