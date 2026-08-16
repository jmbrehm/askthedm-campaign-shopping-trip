begin;

-- Case-insensitive usernames while preserving the user's chosen capitalization.
create extension if not exists citext with schema extensions;

create type public.location_classification as enum (
  'village',
  'town',
  'city',
  'metropolis'
);

create type public.shop_classification as enum (
  'mundane',
  'alchemy',
  'smith',
  'magic',
  'jewelry',
  'tailored',
  'wondrous'
);

create type public.membership_status as enum (
  'pending',
  'accepted',
  'rejected'
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username extensions.citext not null unique,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_username_length
    check (char_length(username::text) between 3 and 32),
  constraint profiles_username_format
    check (username::text ~ '^[A-Za-z0-9_]+$'),
  constraint profiles_admin_username
    check (not is_admin or lower(username::text) = 'askthedm')
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  persuasion_bonus smallint not null default 0,
  deception_bonus smallint not null default 0,
  has_guidance boolean not null default false,
  has_advantage boolean not null default false,
  has_reliable_talent boolean not null default false,
  platinum_pieces integer not null default 0,
  gold_pieces integer not null default 0,
  silver_pieces integer not null default 0,
  copper_pieces integer not null default 0,
  wallet_value_cp bigint generated always as (
    platinum_pieces::bigint * 1000
    + gold_pieces::bigint * 100
    + silver_pieces::bigint * 10
    + copper_pieces::bigint
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint characters_name_present
    check (char_length(btrim(name)) between 1 and 100),
  constraint characters_persuasion_bonus_range
    check (persuasion_bonus between -50 and 50),
  constraint characters_deception_bonus_range
    check (deception_bonus between -50 and 50),
  constraint characters_platinum_nonnegative check (platinum_pieces >= 0),
  constraint characters_gold_nonnegative check (gold_pieces >= 0),
  constraint characters_silver_nonnegative check (silver_pieces >= 0),
  constraint characters_copper_nonnegative check (copper_pieces >= 0)
);

create unique index characters_owner_name_unique
  on public.characters (owner_id, lower(name));

create index characters_owner_id_idx
  on public.characters (owner_id);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  is_listed boolean not null default true,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaigns_name_present
    check (char_length(btrim(name)) between 1 and 120),
  constraint campaigns_description_length
    check (char_length(description) <= 1000)
);

create unique index campaigns_name_unique
  on public.campaigns (lower(name));

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  name text not null,
  classification public.location_classification not null,
  description text not null default '',
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint locations_name_present
    check (char_length(btrim(name)) between 1 and 120),
  constraint locations_description_length
    check (char_length(description) <= 1000)
);

create unique index locations_campaign_name_unique
  on public.locations (campaign_id, lower(name));

create index locations_campaign_id_idx
  on public.locations (campaign_id);

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null,
  classification public.shop_classification not null,
  description text not null default '',
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shops_name_present
    check (char_length(btrim(name)) between 1 and 120),
  constraint shops_description_length
    check (char_length(description) <= 1000)
);

create unique index shops_location_name_unique
  on public.shops (location_id, lower(name));

create index shops_location_id_idx
  on public.shops (location_id);

create table public.campaign_character_memberships (
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  character_id uuid not null references public.characters (id) on delete cascade,
  status public.membership_status not null default 'pending',
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),

  primary key (campaign_id, character_id)
);

create index campaign_memberships_character_id_idx
  on public.campaign_character_memberships (character_id);

create index campaign_memberships_status_idx
  on public.campaign_character_memberships (status);

-- Shared updated_at trigger.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger characters_set_updated_at
before update on public.characters
for each row execute function public.set_updated_at();

create trigger campaigns_set_updated_at
before update on public.campaigns
for each row execute function public.set_updated_at();

create trigger locations_set_updated_at
before update on public.locations
for each row execute function public.set_updated_at();

create trigger shops_set_updated_at
before update on public.shops
for each row execute function public.set_updated_at();

create trigger memberships_set_updated_at
before update on public.campaign_character_memberships
for each row execute function public.set_updated_at();

-- Create an application profile whenever Supabase Auth creates a user.
-- The first AskTheDM registration becomes the single system administrator.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
begin
  requested_username := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');

  if requested_username is null then
    raise exception 'A username is required';
  end if;

  insert into public.profiles (id, username, is_admin)
  values (
    new.id,
    requested_username,
    lower(requested_username) = 'askthedm'
  );

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Security-definer helpers keep authorization checks small and avoid RLS recursion.
create or replace function public.is_system_admin()
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

create or replace function public.owns_character(target_character_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.characters
    where id = target_character_id
      and owner_id = auth.uid()
  );
$$;

create or replace function public.has_campaign_access(target_campaign_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_system_admin()
    or exists (
      select 1
      from public.campaign_character_memberships membership
      join public.characters character
        on character.id = membership.character_id
      where membership.campaign_id = target_campaign_id
        and membership.status = 'accepted'
        and character.owner_id = auth.uid()
    );
$$;

create or replace function public.has_location_access(target_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.locations
    where id = target_location_id
      and public.has_campaign_access(campaign_id)
  );
$$;

revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.is_system_admin() from public;
revoke all on function public.owns_character(uuid) from public;
revoke all on function public.has_campaign_access(uuid) from public;
revoke all on function public.has_location_access(uuid) from public;

grant execute on function public.is_system_admin() to authenticated;
grant execute on function public.owns_character(uuid) to authenticated;
grant execute on function public.has_campaign_access(uuid) to authenticated;
grant execute on function public.has_location_access(uuid) to authenticated;

-- New tables are not automatically exposed in this project, so grant only the
-- operations the authenticated application needs. RLS still decides which rows.
grant usage on type public.location_classification to authenticated;
grant usage on type public.shop_classification to authenticated;
grant usage on type public.membership_status to authenticated;

grant select on table public.profiles to authenticated;
grant select, insert, update, delete on table public.characters to authenticated;
grant select, insert, update, delete on table public.campaigns to authenticated;
grant select, insert, update, delete on table public.locations to authenticated;
grant select, insert, update, delete on table public.shops to authenticated;
grant select, insert, update, delete
  on table public.campaign_character_memberships to authenticated;

alter table public.profiles enable row level security;
alter table public.characters enable row level security;
alter table public.campaigns enable row level security;
alter table public.locations enable row level security;
alter table public.shops enable row level security;
alter table public.campaign_character_memberships enable row level security;

-- Profiles: players see themselves; AskTheDM sees everyone.
create policy profiles_select_self_or_admin
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_system_admin());

-- Characters: owners manage their own records; AskTheDM can view all characters.
create policy characters_select_owner_or_admin
on public.characters
for select
to authenticated
using (owner_id = auth.uid() or public.is_system_admin());

create policy characters_insert_owner
on public.characters
for insert
to authenticated
with check (owner_id = auth.uid());

create policy characters_update_owner
on public.characters
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy characters_delete_owner
on public.characters
for delete
to authenticated
using (owner_id = auth.uid());

-- Campaigns: listed campaigns are discoverable; accepted characters retain access
-- to unlisted campaigns. Only AskTheDM can modify campaign data.
create policy campaigns_select_visible
on public.campaigns
for select
to authenticated
using (is_listed or public.has_campaign_access(id));

create policy campaigns_admin_manage
on public.campaigns
for all
to authenticated
using (public.is_system_admin())
with check (public.is_system_admin() and created_by = auth.uid());

-- Locations and shops become visible after a character has been accepted.
create policy locations_select_campaign_member
on public.locations
for select
to authenticated
using (public.has_campaign_access(campaign_id));

create policy locations_admin_manage
on public.locations
for all
to authenticated
using (public.is_system_admin())
with check (public.is_system_admin());

create policy shops_select_campaign_member
on public.shops
for select
to authenticated
using (public.has_location_access(location_id));

create policy shops_admin_manage
on public.shops
for all
to authenticated
using (public.is_system_admin())
with check (public.is_system_admin());

-- Memberships: players can request with characters they own. AskTheDM reviews.
create policy memberships_select_owner_or_admin
on public.campaign_character_memberships
for select
to authenticated
using (
  public.owns_character(character_id)
  or public.is_system_admin()
);

create policy memberships_insert_pending_for_owned_character
on public.campaign_character_memberships
for insert
to authenticated
with check (
  public.owns_character(character_id)
  and status = 'pending'
  and reviewed_at is null
  and reviewed_by is null
  and exists (
    select 1
    from public.campaigns
    where id = campaign_id
      and is_listed = true
  )
);

create policy memberships_delete_unreviewed_or_rejected
on public.campaign_character_memberships
for delete
to authenticated
using (
  public.owns_character(character_id)
  and status in ('pending', 'rejected')
);

create policy memberships_admin_manage
on public.campaign_character_memberships
for all
to authenticated
using (public.is_system_admin())
with check (
  public.is_system_admin()
  and (
    (status = 'pending' and reviewed_at is null and reviewed_by is null)
    or
    (status in ('accepted', 'rejected')
      and reviewed_at is not null
      and reviewed_by = auth.uid())
  )
);

commit;
