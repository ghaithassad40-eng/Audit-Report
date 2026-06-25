// Secret-gated ingest endpoint. The browser parses the .xlsx and POSTs the rows;
// this function (running with the service role, which bypasses RLS) replaces all
// transactions for the given cost dimension. Public clients can only READ via the
// anon key — they cannot reach this write path without the upload secret.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Upload secret lives in the private app_config table (RLS-locked; only service_role can read it).
  const cfg = await supabase.from('app_config').select('value').eq('key', 'upload_secret').single();
  if (cfg.error || !cfg.data) return json({ error: 'Server misconfigured (no upload secret)' }, 500);
  if (payload.secret !== cfg.data.value) return json({ error: 'Unauthorized (bad upload key)' }, 401);

  const dimension = String(payload.dimension || '').trim();
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  if (!dimension || !rows) return json({ error: 'Missing dimension or rows' }, 400);

  // Upsert dimension metadata.
  const dimErr = (await supabase.from('dimensions').upsert({
    name: dimension,
    sort_order: Number.isFinite(payload.sort_order) ? payload.sort_order : 99,
    account: payload.account ?? null,
    period_from: payload.from ?? null,
    period_to: payload.to ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'name' })).error;
  if (dimErr) return json({ error: 'dimensions upsert failed: ' + dimErr.message }, 500);

  // Replace this dimension's transactions.
  const delErr = (await supabase.from('transactions').delete().eq('cost_dimension', dimension)).error;
  if (delErr) return json({ error: 'delete failed: ' + delErr.message }, 500);

  const records = rows.map((r: any, i: number) => ({
    cost_dimension: dimension,
    project: String(r.project ?? '').trim(),
    seq: Number.isFinite(r.seq) ? r.seq : i,
    txn_date: r.iso || null,        // yyyy-mm-dd or null
    ts: Number.isFinite(r.ts) ? r.ts : 0,
    voucher_type: r.type ?? '',
    voucher_no: r.no ?? '',
    ref_no: r.ref ?? '',
    memo: r.memo ?? '',
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
  }));

  let inserted = 0;
  for (let i = 0; i < records.length; i += 1000) {
    const chunk = records.slice(i, i + 1000);
    const err = (await supabase.from('transactions').insert(chunk)).error;
    if (err) return json({ error: 'insert failed: ' + err.message, inserted }, 500);
    inserted += chunk.length;
  }

  return json({ ok: true, dimension, inserted });
});
