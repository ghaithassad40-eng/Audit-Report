// Supabase connection for the public read-only viewer.
// The publishable (anon) key is safe to ship in a public repo: it only grants
// the access that Row Level Security allows. Here RLS permits public SELECT and
// blocks all writes — uploads go through the secret-gated `ingest` Edge Function.
window.SUPABASE_CONFIG = {
  url: 'https://vnbncldzstblofloysvq.supabase.co',
  anonKey: 'sb_publishable_9W2NHz8Yo7SVZ_DVsIOP2w_itrZz-nB',
  ingestUrl: 'https://vnbncldzstblofloysvq.supabase.co/functions/v1/ingest',
  usersUrl: 'https://vnbncldzstblofloysvq.supabase.co/functions/v1/users',
};
