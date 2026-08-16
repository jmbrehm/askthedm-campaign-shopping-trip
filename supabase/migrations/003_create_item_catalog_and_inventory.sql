begin;

-- Universal item catalog, compact spell reference, campaign exclusions, and
-- persistent shop stock. Prices are deliberately absent from catalog items:
-- a generated inventory row stores the final pre-haggling price in copper.

do $$ begin
  create type public.catalog_item_classification as enum (
    'mundane', 'alchemy', 'smith', 'magic', 'jewelry', 'tailored', 'wondrous'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.item_rarity as enum (
    'common', 'uncommon', 'rare', 'very_rare', 'legendary'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.spell_school as enum (
    'abjuration', 'conjuration', 'divination', 'enchantment',
    'evocation', 'illusion', 'necromancy', 'transmutation'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.generation_selection_mode as enum ('fixed', 'random');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.equipment_kind as enum ('armor', 'weapon', 'shield', 'ammunition');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.inventory_source as enum ('manual', 'generated');
exception when duplicate_object then null;
end $$;

create table if not exists public.spells (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name text generated always as (lower(btrim(name))) stored,
  spell_level smallint not null check (spell_level between 0 and 9),
  school public.spell_school not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_name)
);

-- Concrete mundane equipment names used to resolve generic magic items.
-- Category values remain flexible (for example light, medium, heavy,
-- simple_melee, martial_ranged), while tags support narrower future rules.
create table if not exists public.equipment_bases (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name text generated always as (lower(btrim(name))) stored,
  kind public.equipment_kind not null,
  category text not null default '' check (char_length(category) <= 80),
  tags text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_name)
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  normalized_name text generated always as (lower(btrim(name))) stored,
  description text not null default '' check (char_length(description) <= 4000),
  classification public.catalog_item_classification not null,
  rarity public.item_rarity not null,
  requires_attunement boolean not null default false,
  generated_name_template text not null default '{item_name}'
    check (char_length(generated_name_template) between 1 and 240),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_name)
);

-- Optional rules for items whose final identity depends on a spell.
-- Examples:
--   Spell Scroll (3rd Level): random, min=max=3; the item name template is
--     "Scroll of {spell_name}"
--   Enspelled Breastplate: random with allowed schools,
--     and item name template "{item_name} ({spell_name})"
-- An empty allowed_schools array means every school is eligible.
create table if not exists public.item_spell_generation_rules (
  item_id uuid primary key references public.items(id) on delete cascade,
  selection_mode public.generation_selection_mode not null default 'random',
  fixed_spell_id uuid references public.spells(id) on delete restrict,
  minimum_spell_level smallint not null default 0 check (minimum_spell_level between 0 and 9),
  maximum_spell_level smallint not null default 9 check (maximum_spell_level between 0 and 9),
  allowed_schools public.spell_school[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint item_spell_level_range_valid
    check (minimum_spell_level <= maximum_spell_level),
  constraint item_spell_selection_valid
    check (
      (selection_mode = 'fixed' and fixed_spell_id is not null)
      or (selection_mode = 'random' and fixed_spell_id is null)
    )
);

-- Optional rules for generic items that must resolve to concrete equipment.
-- Empty allowed arrays mean no restriction. Examples:
--   +2 Armor: random, allowed_kinds={armor}, template "+2 {equipment_name}"
--   Enspelled Armor: equipment rule plus spell rule, template
--     "Enspelled {equipment_name} ({spell_name})"
create table if not exists public.item_equipment_generation_rules (
  item_id uuid primary key references public.items(id) on delete cascade,
  selection_mode public.generation_selection_mode not null default 'random',
  fixed_equipment_base_id uuid references public.equipment_bases(id) on delete restrict,
  allowed_kinds public.equipment_kind[] not null default '{}',
  allowed_categories text[] not null default '{}',
  required_tags text[] not null default '{}',
  excluded_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint item_equipment_selection_valid
    check (
      (selection_mode = 'fixed' and fixed_equipment_base_id is not null)
      or (selection_mode = 'random' and fixed_equipment_base_id is null)
    )
);

-- Negative-list overrides: globally active items remain available everywhere
-- except in campaigns where the DM has explicitly excluded them.
create table if not exists public.campaign_item_exclusions (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  excluded_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (campaign_id, item_id)
);

-- Each row is a persistent stock lot. The selected spell and display name are
-- stored as a snapshot so generated wares never change identity later.
create table if not exists public.shop_inventory (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  selected_spell_id uuid references public.spells(id) on delete restrict,
  selected_equipment_base_id uuid references public.equipment_bases(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 240),
  rarity public.item_rarity not null,
  price_cp bigint not null check (price_cp >= 0),
  quantity integer not null default 1 check (quantity >= 0),
  is_infinite boolean not null default false,
  source public.inventory_source not null default 'generated',
  stocked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists spells_generation_lookup_idx
  on public.spells (is_active, spell_level, school);
create index if not exists equipment_bases_generation_lookup_idx
  on public.equipment_bases (is_active, kind, category);
create index if not exists items_generation_lookup_idx
  on public.items (is_active, classification, rarity);
create index if not exists campaign_item_exclusions_item_idx
  on public.campaign_item_exclusions (item_id);
create index if not exists shop_inventory_shop_idx
  on public.shop_inventory (shop_id, stocked_at, id);
create index if not exists shop_inventory_item_idx
  on public.shop_inventory (item_id);

create or replace function public.set_catalog_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists spells_set_updated_at on public.spells;
create trigger spells_set_updated_at
before update on public.spells
for each row execute function public.set_catalog_updated_at();

drop trigger if exists items_set_updated_at on public.items;
create trigger items_set_updated_at
before update on public.items
for each row execute function public.set_catalog_updated_at();

drop trigger if exists equipment_bases_set_updated_at on public.equipment_bases;
create trigger equipment_bases_set_updated_at
before update on public.equipment_bases
for each row execute function public.set_catalog_updated_at();

drop trigger if exists item_spell_rules_set_updated_at on public.item_spell_generation_rules;
create trigger item_spell_rules_set_updated_at
before update on public.item_spell_generation_rules
for each row execute function public.set_catalog_updated_at();

drop trigger if exists item_equipment_rules_set_updated_at on public.item_equipment_generation_rules;
create trigger item_equipment_rules_set_updated_at
before update on public.item_equipment_generation_rules
for each row execute function public.set_catalog_updated_at();

drop trigger if exists shop_inventory_set_updated_at on public.shop_inventory;
create trigger shop_inventory_set_updated_at
before update on public.shop_inventory
for each row execute function public.set_catalog_updated_at();

-- Security-definer helpers keep RLS policies readable and avoid depending on
-- the caller's access to the profiles or membership tables.
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

create or replace function public.current_user_can_access_campaign(target_campaign_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_is_admin()
    or exists (
      select 1
      from public.campaign_character_memberships membership
      join public.characters character on character.id = membership.character_id
      where membership.campaign_id = target_campaign_id
        and membership.status = 'accepted'
        and character.owner_id = auth.uid()
    );
$$;

revoke all on function public.current_user_is_admin() from public;
revoke all on function public.current_user_can_access_campaign(uuid) from public;
grant execute on function public.current_user_is_admin() to authenticated;
grant execute on function public.current_user_can_access_campaign(uuid) to authenticated;

alter table public.spells enable row level security;
alter table public.equipment_bases enable row level security;
alter table public.items enable row level security;
alter table public.item_spell_generation_rules enable row level security;
alter table public.item_equipment_generation_rules enable row level security;
alter table public.campaign_item_exclusions enable row level security;
alter table public.shop_inventory enable row level security;

drop policy if exists "Authenticated users can read active spells" on public.spells;
create policy "Authenticated users can read active spells"
on public.spells for select to authenticated
using (is_active or public.current_user_is_admin());

drop policy if exists "DM can manage spells" on public.spells;
create policy "DM can manage spells"
on public.spells for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "Authenticated users can read active equipment bases" on public.equipment_bases;
create policy "Authenticated users can read active equipment bases"
on public.equipment_bases for select to authenticated
using (is_active or public.current_user_is_admin());

drop policy if exists "DM can manage equipment bases" on public.equipment_bases;
create policy "DM can manage equipment bases"
on public.equipment_bases for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "Authenticated users can read active items" on public.items;
create policy "Authenticated users can read active items"
on public.items for select to authenticated
using (is_active or public.current_user_is_admin());

drop policy if exists "DM can manage items" on public.items;
create policy "DM can manage items"
on public.items for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "DM can manage item spell rules" on public.item_spell_generation_rules;
create policy "DM can manage item spell rules"
on public.item_spell_generation_rules for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "DM can manage item equipment rules" on public.item_equipment_generation_rules;
create policy "DM can manage item equipment rules"
on public.item_equipment_generation_rules for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "DM can manage campaign item exclusions" on public.campaign_item_exclusions;
create policy "DM can manage campaign item exclusions"
on public.campaign_item_exclusions for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "Campaign members can read shop inventory" on public.shop_inventory;
create policy "Campaign members can read shop inventory"
on public.shop_inventory for select to authenticated
using (
  exists (
    select 1
    from public.shops shop
    join public.locations location on location.id = shop.location_id
    where shop.id = shop_inventory.shop_id
      and public.current_user_can_access_campaign(location.campaign_id)
  )
);

drop policy if exists "DM can manage shop inventory" on public.shop_inventory;
create policy "DM can manage shop inventory"
on public.shop_inventory for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

grant select, insert, update, delete on table public.spells to authenticated;
grant select, insert, update, delete on table public.equipment_bases to authenticated;
grant select, insert, update, delete on table public.items to authenticated;
grant select, insert, update, delete on table public.item_spell_generation_rules to authenticated;
grant select, insert, update, delete on table public.item_equipment_generation_rules to authenticated;
grant select, insert, update, delete on table public.campaign_item_exclusions to authenticated;
grant select, insert, update, delete on table public.shop_inventory to authenticated;

comment on column public.shop_inventory.price_cp is
  'Generated pre-haggling unit price in copper pieces; display may convert this to gold pieces.';
comment on column public.items.generated_name_template is
  'Supports {item_name}, {spell_name}, and {equipment_name} tokens used during inventory generation.';
comment on table public.equipment_bases is
  'Universal concrete equipment options used to resolve generic generated items such as +2 Armor.';
comment on table public.campaign_item_exclusions is
  'Campaign-specific negative list applied after the universal items.is_active flag.';

commit;
