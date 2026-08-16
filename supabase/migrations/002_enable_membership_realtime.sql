begin;

-- Broadcast character campaign requests and DM decisions to active clients.
-- The check keeps this migration safe to run more than once.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'campaign_character_memberships'
  ) then
    execute 'alter publication supabase_realtime add table public.campaign_character_memberships';
  end if;
end;
$$;

commit;
