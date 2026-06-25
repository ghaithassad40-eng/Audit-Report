// Admin management of the approved-phone allowlist. Gated by the upload key
// (same secret as `ingest`, stored in the private app_config table). Runs with
// the service role so it can read/write allowed_users despite its RLS lock.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let p: any;
  try { p = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const cfg = await supabase.from('app_config').select('value').eq('key', 'upload_secret').single();
  if (cfg.error || !cfg.data) return json({ error: 'Server misconfigured' }, 500);
  if (p.secret !== cfg.data.value) return json({ error: 'Unauthorized (bad upload key)' }, 401);

  const action = String(p.action || 'list');

  if (action === 'list') {
    const { data, error } = await supabase.from('allowed_users')
      .select('phone, label, added_at').order('added_at', { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json({ users: data });
  }

  if (action === 'add') {
    const phone = digits(p.phone);
    const label = String(p.label ?? '').trim();
    if (phone.length < 8) return json({ error: 'Phone must include country code (digits only), e.g. 96597207194.' }, 400);
    const { error } = await supabase.from('allowed_users')
      .upsert({ phone, label }, { onConflict: 'phone' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, phone, label });
  }

  if (action === 'remove') {
    const phone = digits(p.phone);
    const { error } = await supabase.from('allowed_users').delete().eq('phone', phone);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, phone });
  }

  return json({ error: 'Unknown action' }, 400);
});
