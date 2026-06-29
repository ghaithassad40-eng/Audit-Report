-- report_data() now includes the division on each transaction.
create or replace function public.report_data()
returns jsonb language plpgsql security definer stable set search_path = public as $$
begin
  if not public.has_access() then
    return jsonb_build_object('dimensions', '[]'::jsonb, 'transactions', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'dimensions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', name, 'sort_order', sort_order, 'account', account,
        'period_from', period_from, 'period_to', period_to) order by sort_order), '[]'::jsonb)
      from public.dimensions),
    'transactions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'division', division, 'cost_dimension', cost_dimension, 'project', project, 'seq', seq,
        'txn_date', txn_date, 'ts', ts, 'voucher_type', voucher_type,
        'voucher_no', voucher_no, 'ref_no', ref_no, 'memo', memo,
        'debit', debit, 'credit', credit) order by division, cost_dimension, project, seq), '[]'::jsonb)
      from public.transactions)
  );
end;
$$;
