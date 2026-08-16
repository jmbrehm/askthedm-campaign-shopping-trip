begin;

alter table public.locations
  add column if not exists is_accessible boolean not null default true;

-- A frozen copy of the players' last-known inventory. These rows are replaced
-- only when an accessible location is deliberately marked out of reach.
create table if not exists public.location_inventory_snapshots (
  id uuid primary key,
  location_id uuid not null references public.locations(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  selected_spell_id uuid references public.spells(id) on delete restrict,
  selected_equipment_base_id uuid references public.equipment_bases(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 240),
  rarity public.item_rarity not null,
  price_cp bigint not null check (price_cp >= 0),
  quantity integer not null check (quantity >= 0),
  is_infinite boolean not null default false,
  source public.inventory_source not null,
  stock_revision bigint not null default 0 check (stock_revision >= 0),
  snapshotted_at timestamptz not null default now()
);

create index if not exists location_inventory_snapshots_location_idx
  on public.location_inventory_snapshots (location_id, shop_id);
create index if not exists location_inventory_snapshots_shop_idx
  on public.location_inventory_snapshots (shop_id, price_cp, display_name);

alter table public.location_inventory_snapshots enable row level security;

drop policy if exists "Campaign members can read frozen inventory" on public.location_inventory_snapshots;
create policy "Campaign members can read frozen inventory"
on public.location_inventory_snapshots for select to authenticated
using (
  public.current_user_is_admin()
  or exists (
    select 1
    from public.locations location
    where location.id = location_inventory_snapshots.location_id
      and not location.is_accessible
      and public.current_user_can_access_campaign(location.campaign_id)
  )
);

drop policy if exists "DM can manage frozen inventory" on public.location_inventory_snapshots;
create policy "DM can manage frozen inventory"
on public.location_inventory_snapshots for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

grant select, insert, update, delete on table public.location_inventory_snapshots to authenticated;

-- Players may only read live inventory while its location is accessible. The
-- existing DM management policy continues to grant AskTheDM full live access.
drop policy if exists "Campaign members can read shop inventory" on public.shop_inventory;
create policy "Campaign members can read shop inventory"
on public.shop_inventory for select to authenticated
using (
  exists (
    select 1
    from public.shops shop
    join public.locations location on location.id = shop.location_id
    where shop.id = shop_inventory.shop_id
      and location.is_accessible
      and public.current_user_can_access_campaign(location.campaign_id)
  )
);

create or replace function public.set_location_accessibility(
  target_location_id uuid,
  accessible boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_location public.locations%rowtype;
  snapshot_count integer := 0;
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can change location accessibility.' using errcode = '42501';
  end if;

  if accessible is null then
    raise exception 'An accessibility state is required.';
  end if;

  select location.*
  into target_location
  from public.locations location
  where location.id = target_location_id
  for update;

  if not found then
    raise exception 'That location no longer exists.';
  end if;

  if target_location.is_accessible = accessible then
    select count(*)::integer
    into snapshot_count
    from public.location_inventory_snapshots snapshot
    where snapshot.location_id = target_location_id;

    return jsonb_build_object(
      'location_id', target_location.id,
      'location_name', target_location.name,
      'is_accessible', target_location.is_accessible,
      'changed', false,
      'snapshot_count', snapshot_count
    );
  end if;

  delete from public.location_inventory_snapshots snapshot
  where snapshot.location_id = target_location_id;

  if not accessible then
    insert into public.location_inventory_snapshots (
      id,
      location_id,
      shop_id,
      item_id,
      selected_spell_id,
      selected_equipment_base_id,
      display_name,
      rarity,
      price_cp,
      quantity,
      is_infinite,
      source,
      stock_revision,
      snapshotted_at
    )
    select
      inventory.id,
      target_location_id,
      inventory.shop_id,
      inventory.item_id,
      inventory.selected_spell_id,
      inventory.selected_equipment_base_id,
      inventory.display_name,
      inventory.rarity,
      inventory.price_cp,
      inventory.quantity,
      inventory.is_infinite,
      inventory.source,
      inventory.stock_revision,
      now()
    from public.shop_inventory inventory
    join public.shops shop on shop.id = inventory.shop_id
    where shop.location_id = target_location_id;

    get diagnostics snapshot_count = row_count;
  end if;

  update public.locations
  set is_accessible = accessible
  where id = target_location_id;

  return jsonb_build_object(
    'location_id', target_location.id,
    'location_name', target_location.name,
    'is_accessible', accessible,
    'changed', true,
    'snapshot_count', snapshot_count
  );
end;
$$;

-- Preserve the existing purchase and haggle implementations behind wrappers.
-- The wrappers lock and validate the location before invoking them.
do $$
begin
  if to_regprocedure('public._attempt_shop_haggle_access_checked(uuid,uuid,public.haggle_skill)') is null then
    alter function public.attempt_shop_haggle(uuid, uuid, public.haggle_skill)
      rename to _attempt_shop_haggle_access_checked;
  end if;

  if to_regprocedure('public._purchase_shop_inventory_access_checked(uuid,uuid,integer,bigint)') is null then
    alter function public.purchase_shop_inventory(uuid, uuid, integer, bigint)
      rename to _purchase_shop_inventory_access_checked;
  end if;
end;
$$;

create or replace function public.attempt_shop_haggle(
  target_character_id uuid,
  target_inventory_id uuid,
  chosen_skill public.haggle_skill
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  location_accessible boolean;
begin
  select location.is_accessible
  into location_accessible
  from public.shop_inventory inventory
  join public.shops shop on shop.id = inventory.shop_id
  join public.locations location on location.id = shop.location_id
  where inventory.id = target_inventory_id
  for share of location;

  if not found then
    raise exception 'That item is no longer available.';
  end if;

  if not location_accessible then
    raise exception 'This location is currently out of reach. Its displayed inventory is last-known information only.';
  end if;

  return public._attempt_shop_haggle_access_checked(
    target_character_id,
    target_inventory_id,
    chosen_skill
  );
end;
$$;

create or replace function public.purchase_shop_inventory(
  target_character_id uuid,
  target_inventory_id uuid,
  purchase_quantity integer,
  expected_unit_price_cp bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  location_accessible boolean;
begin
  select location.is_accessible
  into location_accessible
  from public.shop_inventory inventory
  join public.shops shop on shop.id = inventory.shop_id
  join public.locations location on location.id = shop.location_id
  where inventory.id = target_inventory_id
  for share of location;

  if not found then
    raise exception 'That item is no longer available.';
  end if;

  if not location_accessible then
    raise exception 'This location is currently out of reach. Purchases are unavailable.';
  end if;

  return public._purchase_shop_inventory_access_checked(
    target_character_id,
    target_inventory_id,
    purchase_quantity,
    expected_unit_price_cp
  );
end;
$$;

revoke all on function public.set_location_accessibility(uuid, boolean) from public;
revoke all on function public._attempt_shop_haggle_access_checked(uuid, uuid, public.haggle_skill) from public;
revoke all on function public._purchase_shop_inventory_access_checked(uuid, uuid, integer, bigint) from public;
revoke all on function public._attempt_shop_haggle_access_checked(uuid, uuid, public.haggle_skill) from authenticated;
revoke all on function public._purchase_shop_inventory_access_checked(uuid, uuid, integer, bigint) from authenticated;
revoke all on function public.attempt_shop_haggle(uuid, uuid, public.haggle_skill) from public;
revoke all on function public.purchase_shop_inventory(uuid, uuid, integer, bigint) from public;
grant execute on function public.set_location_accessibility(uuid, boolean) to authenticated;
grant execute on function public.attempt_shop_haggle(uuid, uuid, public.haggle_skill) to authenticated;
grant execute on function public.purchase_shop_inventory(uuid, uuid, integer, bigint) to authenticated;

alter table public.locations replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'locations'
  ) then
    execute 'alter publication supabase_realtime add table public.locations';
  end if;
end;
$$;

comment on column public.locations.is_accessible is
  'When false, players see frozen last-known shop inventory and cannot haggle or purchase.';
comment on table public.location_inventory_snapshots is
  'Last-known player-visible inventory captured when a location becomes out of reach.';
comment on function public.set_location_accessibility(uuid, boolean) is
  'Atomically captures or clears player inventory snapshots and changes location accessibility.';

commit;
