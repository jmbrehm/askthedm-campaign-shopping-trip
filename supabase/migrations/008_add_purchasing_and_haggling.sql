begin;

do $$ begin
  create type public.haggle_skill as enum ('persuasion', 'deception', 'intimidation');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.haggle_outcome as enum ('success', 'failure', 'offended');
exception when duplicate_object then null;
end $$;

alter table public.characters
  add column if not exists intimidation_bonus smallint not null default 0;

alter table public.characters
  drop constraint if exists characters_intimidation_bonus_range;

alter table public.characters
  add constraint characters_intimidation_bonus_range
    check (intimidation_bonus between -50 and 50);

alter table public.shops
  add column if not exists inventory_cycle bigint not null default 0;

alter table public.shops
  drop constraint if exists shops_inventory_cycle_nonnegative;

alter table public.shops
  add constraint shops_inventory_cycle_nonnegative
    check (inventory_cycle >= 0);

alter table public.shop_inventory
  add column if not exists stock_revision bigint not null default 0;

alter table public.shop_inventory
  drop constraint if exists shop_inventory_stock_revision_nonnegative;

alter table public.shop_inventory
  add constraint shop_inventory_stock_revision_nonnegative
    check (stock_revision >= 0);

create table if not exists public.shop_character_haggles (
  shop_id uuid not null references public.shops(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  inventory_cycle bigint not null check (inventory_cycle >= 0),
  inventory_id uuid references public.shop_inventory(id) on delete set null,
  inventory_stock_revision bigint not null check (inventory_stock_revision >= 0),
  skill public.haggle_skill not null,
  d20_roll_1 smallint not null check (d20_roll_1 between 1 and 20),
  d20_roll_2 smallint check (d20_roll_2 between 1 and 20),
  selected_d20 smallint not null check (selected_d20 between 1 and 20),
  adjusted_d20 smallint not null check (adjusted_d20 between 1 and 20),
  guidance_roll smallint check (guidance_roll between 1 and 4),
  skill_bonus smallint not null,
  total_result smallint not null,
  difficulty_class smallint not null,
  outcome public.haggle_outcome not null,
  offered_price_cp bigint check (offered_price_cp is null or offered_price_cp >= 0),
  created_at timestamptz not null default now(),
  primary key (shop_id, character_id, inventory_cycle),
  constraint successful_haggle_has_offer
    check (
      (outcome = 'success' and offered_price_cp is not null)
      or (outcome <> 'success' and offered_price_cp is null)
    )
);

create index if not exists shop_character_haggles_character_idx
  on public.shop_character_haggles (character_id, created_at desc);

create table if not exists public.shop_purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_user_id uuid references auth.users(id) on delete set null,
  character_id uuid references public.characters(id) on delete set null,
  character_name text not null,
  shop_id uuid references public.shops(id) on delete set null,
  inventory_id uuid references public.shop_inventory(id) on delete set null,
  item_id uuid references public.items(id) on delete restrict,
  display_name text not null,
  rarity public.item_rarity not null,
  quantity integer not null check (quantity between 1 and 1000),
  original_unit_price_cp bigint not null check (original_unit_price_cp >= 0),
  unit_price_cp bigint not null check (unit_price_cp >= 0),
  total_price_cp bigint not null check (total_price_cp >= 0),
  was_haggled boolean not null default false,
  wallet_before jsonb not null,
  wallet_after jsonb not null,
  purchased_at timestamptz not null default now()
);

create index if not exists shop_purchases_character_idx
  on public.shop_purchases (character_id, purchased_at desc);
create index if not exists shop_purchases_shop_idx
  on public.shop_purchases (shop_id, purchased_at desc);

-- Price rolls are kept server-side so a successful offer cannot be selected by
-- changing browser state. This helper receives the already-lowered rarity.
create or replace function public._roll_magic_item_price(target_rarity public.item_rarity)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return case target_rarity
    when 'common' then (floor(random() * 6)::bigint + 2) * 1000
    when 'uncommon' then (floor(random() * 6)::bigint + 1) * 10000
    when 'rare' then (floor(random() * 10)::bigint + floor(random() * 10)::bigint + 2) * 100000
    when 'very_rare' then (floor(random() * 4)::bigint + 2) * 1000000
    when 'legendary' then (floor(random() * 6)::bigint + floor(random() * 6)::bigint + 2) * 2500000
  end;
end;
$$;

create or replace function public.attempt_shop_haggle(
  target_character_id uuid,
  target_inventory_id uuid,
  chosen_skill public.haggle_skill
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_character public.characters%rowtype;
  target_inventory public.shop_inventory%rowtype;
  target_shop public.shops%rowtype;
  target_shop_id uuid;
  target_campaign_id uuid;
  item_price_mode public.catalog_price_mode;
  roll_1 integer;
  roll_2 integer;
  selected_roll integer;
  adjusted_roll integer;
  guidance integer;
  applied_bonus integer;
  target_dc integer;
  result_total integer;
  result_outcome public.haggle_outcome;
  lowered_rarity public.item_rarity;
  offer_price bigint;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to haggle.' using errcode = '42501';
  end if;

  select inventory.shop_id
  into target_shop_id
  from public.shop_inventory inventory
  where inventory.id = target_inventory_id;

  if target_shop_id is null then
    raise exception 'That item is no longer available.';
  end if;

  select shop.*
  into target_shop
  from public.shops shop
  where shop.id = target_shop_id
  for update;

  select location.campaign_id
  into target_campaign_id
  from public.locations location
  where location.id = target_shop.location_id;

  select character.*
  into target_character
  from public.characters character
  where character.id = target_character_id
    and character.owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'You can only haggle with a character you own.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.campaign_character_memberships membership
    where membership.campaign_id = target_campaign_id
      and membership.character_id = target_character_id
      and membership.status = 'accepted'
  ) then
    raise exception 'That character has not joined this campaign.' using errcode = '42501';
  end if;

  select inventory.*
  into target_inventory
  from public.shop_inventory inventory
  where inventory.id = target_inventory_id
    and inventory.shop_id = target_shop.id
  for update;

  if not found or (not target_inventory.is_infinite and target_inventory.quantity < 1) then
    raise exception 'That item is no longer available.';
  end if;

  if exists (
    select 1
    from public.shop_character_haggles haggle
    where haggle.shop_id = target_shop.id
      and haggle.character_id = target_character_id
      and haggle.inventory_cycle = target_shop.inventory_cycle
  ) then
    raise exception 'This character has already haggled at this shop during the current inventory cycle.';
  end if;

  select item.price_mode
  into item_price_mode
  from public.items item
  where item.id = target_inventory.item_id;

  if item_price_mode <> 'rarity_roll' or target_inventory.rarity = 'common' then
    raise exception 'This item cannot be haggled.';
  end if;

  target_dc := case target_inventory.rarity
    when 'uncommon' then 15
    when 'rare' then 20
    when 'very_rare' then 25
    when 'legendary' then 30
    else null
  end;

  lowered_rarity := case target_inventory.rarity
    when 'uncommon' then 'common'::public.item_rarity
    when 'rare' then 'uncommon'::public.item_rarity
    when 'very_rare' then 'rare'::public.item_rarity
    when 'legendary' then 'very_rare'::public.item_rarity
    else null
  end;

  applied_bonus := case chosen_skill
    when 'persuasion' then target_character.persuasion_bonus
    when 'deception' then target_character.deception_bonus
    when 'intimidation' then target_character.intimidation_bonus
  end;

  roll_1 := floor(random() * 20)::integer + 1;
  roll_2 := case when target_character.has_advantage
    then floor(random() * 20)::integer + 1
    else null
  end;
  selected_roll := case when roll_2 is null then roll_1 else greatest(roll_1, roll_2) end;
  adjusted_roll := case
    when target_character.has_reliable_talent and selected_roll between 2 and 9 then 10
    else selected_roll
  end;
  guidance := case when target_character.has_guidance
    then floor(random() * 4)::integer + 1
    else null
  end;
  result_total := adjusted_roll + applied_bonus + coalesce(guidance, 0);

  if selected_roll = 1 then
    result_outcome := 'offended';
    offer_price := null;
  elsif result_total >= target_dc then
    result_outcome := 'success';
    offer_price := least(
      target_inventory.price_cp,
      public._roll_magic_item_price(lowered_rarity)
    );
  else
    result_outcome := 'failure';
    offer_price := null;
  end if;

  insert into public.shop_character_haggles (
    shop_id,
    character_id,
    inventory_cycle,
    inventory_id,
    inventory_stock_revision,
    skill,
    d20_roll_1,
    d20_roll_2,
    selected_d20,
    adjusted_d20,
    guidance_roll,
    skill_bonus,
    total_result,
    difficulty_class,
    outcome,
    offered_price_cp
  ) values (
    target_shop.id,
    target_character_id,
    target_shop.inventory_cycle,
    target_inventory.id,
    target_inventory.stock_revision,
    chosen_skill,
    roll_1,
    roll_2,
    selected_roll,
    adjusted_roll,
    guidance,
    applied_bonus,
    result_total,
    target_dc,
    result_outcome,
    offer_price
  );

  return jsonb_build_object(
    'shop_id', target_shop.id,
    'character_id', target_character_id,
    'inventory_cycle', target_shop.inventory_cycle,
    'inventory_id', target_inventory.id,
    'inventory_stock_revision', target_inventory.stock_revision,
    'skill', chosen_skill,
    'd20_roll_1', roll_1,
    'd20_roll_2', roll_2,
    'selected_d20', selected_roll,
    'adjusted_d20', adjusted_roll,
    'guidance_roll', guidance,
    'skill_bonus', applied_bonus,
    'total_result', result_total,
    'difficulty_class', target_dc,
    'outcome', result_outcome,
    'offered_price_cp', offer_price
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
volatile
security definer
set search_path = ''
as $$
declare
  target_character public.characters%rowtype;
  target_inventory public.shop_inventory%rowtype;
  target_shop public.shops%rowtype;
  current_haggle public.shop_character_haggles%rowtype;
  target_shop_id uuid;
  target_campaign_id uuid;
  haggle_found boolean;
  effective_unit_price bigint;
  purchase_total bigint;
  wallet_total bigint;
  wallet_remaining bigint;
  after_pp integer;
  after_gp integer;
  after_sp integer;
  after_cp integer;
  used_offer boolean := false;
  inventory_remaining integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to purchase an item.' using errcode = '42501';
  end if;

  if purchase_quantity is null or purchase_quantity < 1 or purchase_quantity > 1000 then
    raise exception 'Purchase quantity must be between 1 and 1,000.';
  end if;

  select inventory.shop_id
  into target_shop_id
  from public.shop_inventory inventory
  where inventory.id = target_inventory_id;

  if target_shop_id is null then
    raise exception 'That item is no longer available.';
  end if;

  select shop.*
  into target_shop
  from public.shops shop
  where shop.id = target_shop_id
  for update;

  select location.campaign_id
  into target_campaign_id
  from public.locations location
  where location.id = target_shop.location_id;

  select character.*
  into target_character
  from public.characters character
  where character.id = target_character_id
    and character.owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'You can only purchase with a character you own.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.campaign_character_memberships membership
    where membership.campaign_id = target_campaign_id
      and membership.character_id = target_character_id
      and membership.status = 'accepted'
  ) then
    raise exception 'That character has not joined this campaign.' using errcode = '42501';
  end if;

  select inventory.*
  into target_inventory
  from public.shop_inventory inventory
  where inventory.id = target_inventory_id
    and inventory.shop_id = target_shop.id
  for update;

  if not found or (not target_inventory.is_infinite and target_inventory.quantity < purchase_quantity) then
    raise exception 'The requested quantity is no longer available.';
  end if;

  select haggle.*
  into current_haggle
  from public.shop_character_haggles haggle
  where haggle.shop_id = target_shop.id
    and haggle.character_id = target_character_id
    and haggle.inventory_cycle = target_shop.inventory_cycle;
  haggle_found := found;

  if haggle_found and current_haggle.outcome = 'offended' then
    raise exception 'The shopkeeper refuses to sell to this character until the shop is restocked.';
  end if;

  effective_unit_price := target_inventory.price_cp;
  if haggle_found
    and current_haggle.outcome = 'success'
    and current_haggle.inventory_id = target_inventory.id
    and current_haggle.inventory_stock_revision = target_inventory.stock_revision then
    effective_unit_price := current_haggle.offered_price_cp;
    used_offer := true;
  end if;

  if expected_unit_price_cp is null or expected_unit_price_cp <> effective_unit_price then
    raise exception 'The item price changed. Review the current offer before purchasing.';
  end if;

  purchase_total := effective_unit_price * purchase_quantity::bigint;
  wallet_total := target_character.wallet_value_cp;

  if wallet_total < purchase_total then
    raise exception 'This character cannot afford that purchase.';
  end if;

  wallet_remaining := wallet_total - purchase_total;
  after_pp := (wallet_remaining / 1000)::integer;
  wallet_remaining := wallet_remaining % 1000;
  after_gp := (wallet_remaining / 100)::integer;
  wallet_remaining := wallet_remaining % 100;
  after_sp := (wallet_remaining / 10)::integer;
  after_cp := (wallet_remaining % 10)::integer;

  insert into public.shop_purchases (
    buyer_user_id,
    character_id,
    character_name,
    shop_id,
    inventory_id,
    item_id,
    display_name,
    rarity,
    quantity,
    original_unit_price_cp,
    unit_price_cp,
    total_price_cp,
    was_haggled,
    wallet_before,
    wallet_after
  ) values (
    auth.uid(),
    target_character.id,
    target_character.name,
    target_shop.id,
    target_inventory.id,
    target_inventory.item_id,
    target_inventory.display_name,
    target_inventory.rarity,
    purchase_quantity,
    target_inventory.price_cp,
    effective_unit_price,
    purchase_total,
    used_offer,
    jsonb_build_object(
      'pp', target_character.platinum_pieces,
      'gp', target_character.gold_pieces,
      'sp', target_character.silver_pieces,
      'cp', target_character.copper_pieces,
      'total_cp', target_character.wallet_value_cp
    ),
    jsonb_build_object(
      'pp', after_pp,
      'gp', after_gp,
      'sp', after_sp,
      'cp', after_cp,
      'total_cp', target_character.wallet_value_cp - purchase_total
    )
  );

  update public.characters
  set platinum_pieces = after_pp,
      gold_pieces = after_gp,
      silver_pieces = after_sp,
      copper_pieces = after_cp
  where id = target_character.id;

  if target_inventory.is_infinite then
    update public.shop_inventory
    set stock_revision = stock_revision + 1
    where id = target_inventory.id;
    inventory_remaining := target_inventory.quantity;
  elsif target_inventory.quantity = purchase_quantity then
    delete from public.shop_inventory
    where id = target_inventory.id;
    inventory_remaining := 0;
  else
    update public.shop_inventory
    set quantity = quantity - purchase_quantity,
        stock_revision = stock_revision + 1
    where id = target_inventory.id;
    inventory_remaining := target_inventory.quantity - purchase_quantity;
  end if;

  return jsonb_build_object(
    'character_id', target_character.id,
    'inventory_id', target_inventory.id,
    'display_name', target_inventory.display_name,
    'quantity', purchase_quantity,
    'unit_price_cp', effective_unit_price,
    'total_price_cp', purchase_total,
    'was_haggled', used_offer,
    'inventory_remaining', inventory_remaining,
    'wallet', jsonb_build_object(
      'pp', after_pp,
      'gp', after_gp,
      'sp', after_sp,
      'cp', after_cp,
      'total_cp', target_character.wallet_value_cp - purchase_total
    )
  );
end;
$$;

-- Restocking advances the shop cycle even when only persistent manual stock is
-- present. Old haggle records remain as history but no longer match the cycle.
create or replace function public.generate_shop_inventory(target_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can generate shop inventory.' using errcode = '42501';
  end if;

  update public.shops
  set inventory_cycle = inventory_cycle + 1
  where id = target_shop_id;

  return public._generate_shop_inventory(target_shop_id);
end;
$$;

create or replace function public.generate_location_inventory(target_location_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_location public.locations%rowtype;
  shop_record record;
  shop_result jsonb;
  results jsonb := '[]'::jsonb;
  shop_count integer := 0;
  generated_count integer := 0;
  rejected_count integer := 0;
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can generate location inventory.' using errcode = '42501';
  end if;

  select location.*
  into target_location
  from public.locations location
  where location.id = target_location_id;

  if not found then
    raise exception 'Location % does not exist.', target_location_id;
  end if;

  for shop_record in
    select shop.id
    from public.shops shop
    where shop.location_id = target_location_id
    order by shop.display_order, shop.name
  loop
    update public.shops
    set inventory_cycle = inventory_cycle + 1
    where id = shop_record.id;

    shop_result := public._generate_shop_inventory(shop_record.id);
    results := results || jsonb_build_array(shop_result);
    shop_count := shop_count + 1;
    generated_count := generated_count + coalesce((shop_result ->> 'generated_count')::integer, 0);
    rejected_count := rejected_count + coalesce((shop_result ->> 'rejected_count')::integer, 0);
  end loop;

  return jsonb_build_object(
    'location_id', target_location_id,
    'location_name', target_location.name,
    'shop_count', shop_count,
    'generated_count', generated_count,
    'rejected_count', rejected_count,
    'shops', results
  );
end;
$$;

alter table public.shop_character_haggles enable row level security;
alter table public.shop_purchases enable row level security;

drop policy if exists "Players can read their own haggles" on public.shop_character_haggles;
create policy "Players can read their own haggles"
on public.shop_character_haggles for select to authenticated
using (public.owns_character(character_id) or public.current_user_is_admin());

drop policy if exists "Players can read their own purchases" on public.shop_purchases;
create policy "Players can read their own purchases"
on public.shop_purchases for select to authenticated
using (buyer_user_id = auth.uid() or public.current_user_is_admin());

grant usage on type public.haggle_skill to authenticated;
grant usage on type public.haggle_outcome to authenticated;
grant select on table public.shop_character_haggles to authenticated;
grant select on table public.shop_purchases to authenticated;

revoke all on function public._roll_magic_item_price(public.item_rarity) from public;
revoke all on function public.attempt_shop_haggle(uuid, uuid, public.haggle_skill) from public;
revoke all on function public.purchase_shop_inventory(uuid, uuid, integer, bigint) from public;
grant execute on function public.attempt_shop_haggle(uuid, uuid, public.haggle_skill) to authenticated;
grant execute on function public.purchase_shop_inventory(uuid, uuid, integer, bigint) to authenticated;

alter table public.characters replica identity full;
alter table public.shops replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'characters'
  ) then
    execute 'alter publication supabase_realtime add table public.characters';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shops'
  ) then
    execute 'alter publication supabase_realtime add table public.shops';
  end if;
end;
$$;

comment on column public.shops.inventory_cycle is
  'Incremented by every shop or location inventory regeneration; resets per-cycle haggle state.';
comment on column public.shop_inventory.stock_revision is
  'Incremented by every purchase, invalidating outstanding offers for this stock entry.';
comment on table public.shop_character_haggles is
  'One server-rolled haggle attempt per character, shop, and inventory cycle.';
comment on table public.shop_purchases is
  'Immutable transaction snapshots for completed inventory purchases.';

commit;
