# Audit Report — Statement of Account Viewer

Interactive, filterable Statement-of-Account report grouped **Cost Dimension → Project → Statement of Account**, backed by **Supabase** (BaaS).

Upload an Excel export per cost dimension (Material, Labor, Equipment, Overhead). The browser parses it, sends the rows to a secret-gated Supabase Edge Function, and the data is stored in Postgres. The viewer reads from Supabase and lets you filter by **cost dimension**, **project name**, and **date range**, recomputing each project's running balance and totals on the filtered set. Export to PDF via the browser print dialog.

## Architecture

```
Browser (index.html)
  ├─ AUTH  : phone OTP login (Supabase Auth) — only allowlisted numbers
  ├─ READ  : supabase-js (URL + publishable key)  →  SELECT (RLS: authenticated + allowlisted)
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
| `app.config.json` | All config: Supabase URL + publishable key, branding, cost dimensions, side options, and every UI string (safe to commit — see Security) |
| `styles.css` | All styling, with the palette as `:root` CSS variables (design tokens) |
| `app.js` | All client logic, fully config-driven (no hardcoded data/strings) |
| `supabase/migrations/*.sql` | Schema, indexes, and RLS policies |
| `supabase/functions/ingest/index.ts` | Edge Function that validates the upload key and replaces a dimension's rows |
| `generate-report.cjs` | Optional **local** PDF generator (reads `./inputs/*.xlsx`, no backend needed) |
| `serve.json` / `package.json` | Static dev server (`npm run dev` → http://localhost:3000) |

## Run locally

```bash
npm install
npm run dev          # serves index.html at http://localhost:3000
```

Or deploy the static files (`index.html`, `styles.css`, `app.js`, `app.config.json`, `logo.png`) to any static host (GitHub Pages, Netlify, etc.) — it talks directly to Supabase.

## Uploading data

1. Click **⬆ Upload Excel** in the toolbar.
2. Choose an `.xlsx` export. **The file name decides the dimension** (e.g. `…Material.xlsx` → Material).
3. Enter the **upload key** (stored in Supabase; see below). Re-uploading a dimension replaces its data.

The expected Excel layout is an R&F "Statement of Account" export with a `Date / Voucher Type / No / CostCenter / Ref No. / Memo / Debit / Credit / Balance` table; columns are matched by header name, so minor layout differences are tolerated.

## Authentication

Reads are gated behind login (Supabase Auth). The sign-in screen offers **two methods**:

- **Username & password** — admin-created accounts. The username is mapped to an internal email (`username@audit.local`) under the hood. Works with no SMS provider.
- **Phone code (OTP)** — the user enters a phone number and verifies an SMS code. Requires Twilio (see below).

Access is unified by `public.has_access()`: an authenticated user is allowed if their **phone is on the allowlist** (`allowed_users`) **or** they are an **admin-created login account** (`app_users`). The publishable/anon key alone reads nothing. Writes go only through Edge Functions (upload-key gated).

### Creating accounts

Open **⚙ Admin** from the login screen (or **⚙ Users** in the toolbar), enter the **upload key**, then:
- **Username / password accounts** — create a username + password for a user (no SMS needed).
- **Approved phone numbers** — allowlist a phone for OTP login.

Both go through the `users` Edge Function (service role, upload-key gated). There is **no public sign-up**.

### SMS delivery — required one-time setup (Twilio Verify)

Supabase cannot send SMS on its own. In the Supabase dashboard → **Authentication → Sign In / Providers → Phone**:
1. Enable the **Phone** provider.
2. Set SMS provider to **Twilio Verify** and paste your Twilio **Account SID**, **Auth Token**, and **Verify Service SID**.
3. (Recommended) Disable "Enable phone signups" is *not* needed here — access is already restricted by the allowlist, so even if anyone logs in they can't read unless approved.

Each SMS costs money (billed by Twilio).

### Managing approved phone numbers

**In the app (recommended):** click **⚙ Admin — manage approved users** on the login screen (or **⚙ Users** in the toolbar once signed in), enter the **upload key**, then add/remove users by name + phone. This calls the `users` Edge Function (service role, upload-key gated).

**Or in the Supabase SQL editor** (digits only, country code, **no** `+`):

```sql
insert into public.allowed_users (phone, label) values ('96550000000', 'Ghaith') on conflict do nothing;
delete from public.allowed_users where phone = '96550000000';
```

### Rotate the upload key

```sql
update public.app_config set value = '<new-secret>' where key = 'upload_secret';
```

## Local PDF export (optional, no backend)

```bash
# put one .xlsx per dimension in ./inputs, then:
npm run report       # writes "Statement Of Account - Cost Dimensions Report.pdf"
```
