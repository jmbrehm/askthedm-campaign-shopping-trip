begin;

alter table public.locations
  add column if not exists is_nearby boolean not null default false,
  add column if not exists is_always_nearby boolean not null default false;

alter table public.locations
  drop constraint if exists locations_always_nearby_requires_nearby;

alter table public.locations
  add constraint locations_always_nearby_requires_nearby
  check (not is_always_nearby or is_nearby);

-- There may be any number of Always Nearby locations, but only one ordinary
-- Nearby location in each campaign.
create unique index if not exists locations_one_regular_nearby_per_campaign
on public.locations (campaign_id)
where is_nearby and not is_always_nearby;

create or replace function public.normalize_location_reachability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not new.is_accessible then
    new.is_nearby := false;
    new.is_always_nearby := false;
  elsif new.is_always_nearby then
    new.is_nearby := true;
  end if;

  return new;
end;
$$;

drop trigger if exists normalize_location_reachability on public.locations;
create trigger normalize_location_reachability
before insert or update of is_accessible, is_nearby, is_always_nearby
on public.locations
for each row execute function public.normalize_location_reachability();

create or replace function public.set_location_proximity(
  target_location_id uuid,
  nearby boolean,
  always_nearby boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_location public.locations%rowtype;
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can change location proximity.' using errcode = '42501';
  end if;

  if nearby is null or always_nearby is null then
    raise exception 'Nearby and Always Nearby states are required.';
  end if;

  if always_nearby and not nearby then
    raise exception 'An Always Nearby location must also be Nearby.';
  end if;

  select location.*
  into target_location
  from public.locations location
  where location.id = target_location_id;

  if not found then
    raise exception 'That location no longer exists.';
  end if;

  -- Serialize proximity changes within this campaign so simultaneous DM tabs
  -- cannot create competing regular Nearby locations.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_location.campaign_id::text, 0)
  );

  select location.*
  into strict target_location
  from public.locations location
  where location.id = target_location_id
  for update;

  if nearby and not always_nearby then
    update public.locations location
    set is_nearby = false,
        is_always_nearby = false
    where location.campaign_id = target_location.campaign_id
      and location.id <> target_location_id
      and location.is_nearby
      and not location.is_always_nearby;
  end if;

  update public.locations
  set is_accessible = case when nearby then true else is_accessible end,
      is_nearby = nearby,
      is_always_nearby = always_nearby
  where id = target_location_id;

  -- Marking an Out of Reach location Nearby returns it to live inventory.
  if nearby then
    delete from public.location_inventory_snapshots snapshot
    where snapshot.location_id = target_location_id;
  end if;

  return jsonb_build_object(
    'location_id', target_location.id,
    'location_name', target_location.name,
    'is_accessible', case when nearby then true else target_location.is_accessible end,
    'is_nearby', nearby,
    'is_always_nearby', always_nearby
  );
end;
$$;

-- Accessibility chooses live versus last-known inventory. Proximity is a
-- separate server-enforced requirement for haggling and purchasing.
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
  location_nearby boolean;
begin
  select location.is_accessible, location.is_nearby
  into location_accessible, location_nearby
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

  if not location_nearby then
    raise exception 'This location is not nearby. Haggling is unavailable until the party returns.';
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
  location_nearby boolean;
begin
  select location.is_accessible, location.is_nearby
  into location_accessible, location_nearby
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

  if not location_nearby then
    raise exception 'This location is not nearby. Purchases are unavailable until the party returns.';
  end if;

  return public._purchase_shop_inventory_access_checked(
    target_character_id,
    target_inventory_id,
    purchase_quantity,
    expected_unit_price_cp
  );
end;
$$;

revoke all on function public.normalize_location_reachability() from public;
revoke all on function public.set_location_proximity(uuid, boolean, boolean) from public;
grant execute on function public.set_location_proximity(uuid, boolean, boolean) to authenticated;

comment on column public.locations.is_nearby is
  'True when player characters may currently haggle and purchase at this location.';
comment on column public.locations.is_always_nearby is
  'Nearby exception that remains active when the campaign regular Nearby location changes.';
comment on function public.set_location_proximity(uuid, boolean, boolean) is
  'Atomically manages the campaign regular Nearby location and unlimited Always Nearby exceptions.';

commit;
