begin;

-- Preserve the complete reference text supplied for larger catalog entries.
alter table public.items
  drop constraint if exists items_description_check;
alter table public.items
  drop constraint if exists items_description_length_check;
alter table public.items
  add constraint items_description_length_check
  check (char_length(description) <= 12000);

-- Most equipment rules select by broad kind/category/tag filters. Rows in this
-- table optionally narrow a random rule to an exact set of concrete bases.
-- No rows for an item means the broad filters remain authoritative.
create table if not exists public.item_equipment_generation_allowed_bases (
  item_id uuid not null
    references public.item_equipment_generation_rules(item_id) on delete cascade,
  equipment_base_id uuid not null
    references public.equipment_bases(id) on delete restrict,
  primary key (item_id, equipment_base_id)
);

create index if not exists item_equipment_allowed_bases_equipment_idx
  on public.item_equipment_generation_allowed_bases (equipment_base_id);

alter table public.item_equipment_generation_allowed_bases enable row level security;

drop policy if exists "Authenticated users can read active item spell rules"
  on public.item_spell_generation_rules;
create policy "Authenticated users can read active item spell rules"
on public.item_spell_generation_rules for select to authenticated
using (
  exists (
    select 1 from public.items item
    where item.id = item_spell_generation_rules.item_id
      and (item.is_active or public.current_user_is_admin())
  )
);

drop policy if exists "Authenticated users can read active item equipment rules"
  on public.item_equipment_generation_rules;
create policy "Authenticated users can read active item equipment rules"
on public.item_equipment_generation_rules for select to authenticated
using (
  exists (
    select 1 from public.items item
    where item.id = item_equipment_generation_rules.item_id
      and (item.is_active or public.current_user_is_admin())
  )
);

drop policy if exists "Authenticated users can read active equipment allowlists"
  on public.item_equipment_generation_allowed_bases;
create policy "Authenticated users can read active equipment allowlists"
on public.item_equipment_generation_allowed_bases for select to authenticated
using (
  exists (
    select 1 from public.items item
    where item.id = item_equipment_generation_allowed_bases.item_id
      and (item.is_active or public.current_user_is_admin())
  )
);

drop policy if exists "DM can manage equipment allowlists"
  on public.item_equipment_generation_allowed_bases;
create policy "DM can manage equipment allowlists"
on public.item_equipment_generation_allowed_bases for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

grant select, insert, update, delete
  on table public.item_equipment_generation_allowed_bases to authenticated;

comment on table public.item_equipment_generation_allowed_bases is
  'Optional exact equipment-base allowlist for a random equipment generation rule; an empty set means its broad filters apply.';

commit;
