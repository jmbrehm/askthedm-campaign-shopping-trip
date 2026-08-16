begin;

-- Purchase ledgers update immediately for the DM and the purchasing player.
alter table public.shop_purchases replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shop_purchases'
  ) then
    execute 'alter publication supabase_realtime add table public.shop_purchases';
  end if;
end;
$$;

commit;
