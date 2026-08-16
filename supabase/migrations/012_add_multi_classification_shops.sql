begin;

-- A shop keeps its original classification column as its primary classification
-- for backward compatibility. This ordered relation is the source of truth for
-- all classifications used by the UI and inventory generator.
create table public.shop_classifications (
  shop_id uuid not null references public.shops(id) on delete cascade,
  classification public.catalog_item_classification not null,
  display_order smallint not null check (display_order >= 0),
  primary key (shop_id, classification),
  unique (shop_id, display_order)
);

insert into public.shop_classifications (shop_id, classification, display_order)
select shop.id, shop.classification::text::public.catalog_item_classification, 0
from public.shops shop
on conflict (shop_id, classification) do nothing;

alter table public.shop_classifications enable row level security;

create policy "Campaign members can read shop classifications"
on public.shop_classifications for select to authenticated
using (
  exists (
    select 1
    from public.shops shop
    join public.locations location on location.id = shop.location_id
    where shop.id = shop_classifications.shop_id
      and public.current_user_can_access_campaign(location.campaign_id)
  )
);

create policy "DM can manage shop classifications"
on public.shop_classifications for all to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

grant select, insert, update, delete on table public.shop_classifications to authenticated;

-- Save the shop and its ordered classifications in one transaction.
create or replace function public.save_shop(
  target_shop_id uuid,
  target_location_id uuid,
  target_name text,
  target_description text,
  target_classifications text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_shop_id uuid;
  classification_name text;
  classification_index integer;
  shop_classification_type text;
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can save shops.' using errcode = '42501';
  end if;

  if coalesce(cardinality(target_classifications), 0) = 0 then
    raise exception 'A shop requires at least one classification.';
  end if;

  if cardinality(target_classifications) <> (
    select count(distinct value)
    from unnest(target_classifications) as entry(value)
  ) then
    raise exception 'Shop classifications cannot contain duplicates.';
  end if;

  foreach classification_name in array target_classifications loop
    if classification_name not in ('mundane', 'alchemy', 'smith', 'magic', 'jewelry', 'tailored', 'wondrous') then
      raise exception 'Unknown shop classification: %', classification_name;
    end if;
  end loop;

  select format_type(attribute.atttypid, attribute.atttypmod)
  into strict shop_classification_type
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid = 'public.shops'::regclass
    and attribute.attname = 'classification'
    and not attribute.attisdropped;

  if target_shop_id is null then
    execute format(
      'insert into public.shops (location_id, name, classification, description) values ($1, $2, $3::%s, $4) returning id',
      shop_classification_type
    )
    into saved_shop_id
    using target_location_id, btrim(target_name), target_classifications[1], btrim(target_description);
  else
    execute format(
      'update public.shops set location_id = $1, name = $2, classification = $3::%s, description = $4 where id = $5 returning id',
      shop_classification_type
    )
    into saved_shop_id
    using target_location_id, btrim(target_name), target_classifications[1], btrim(target_description), target_shop_id;

    if saved_shop_id is null then
      raise exception 'Shop % does not exist.', target_shop_id;
    end if;
  end if;

  delete from public.shop_classifications
  where shop_id = saved_shop_id;

  for classification_index in 1..cardinality(target_classifications) loop
    insert into public.shop_classifications (shop_id, classification, display_order)
    values (
      saved_shop_id,
      target_classifications[classification_index]::public.catalog_item_classification,
      classification_index - 1
    );
  end loop;

  return saved_shop_id;
end;
$$;

revoke all on function public.save_shop(uuid, uuid, text, text, text[]) from public;
grant execute on function public.save_shop(uuid, uuid, text, text, text[]) to authenticated;

-- Install the complete generator explicitly so this migration does not depend
-- on the formatting or source text of the function currently in Supabase.
create or replace function public._generate_shop_inventory(target_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shop public.shops%rowtype;
  target_location public.locations%rowtype;
  candidate public.items%rowtype;
  spell_rule public.item_spell_generation_rules%rowtype;
  equipment_rule public.item_equipment_generation_rules%rowtype;
  selected_spell public.spells%rowtype;
  selected_equipment public.equipment_bases%rowtype;
  slot_count integer := 0;
  classification_slot_count integer := 0;
  slot_index integer;
  classification_record record;
  selected_shop_classification public.catalog_item_classification;
  slot_classifications public.catalog_item_classification[] := '{}';
  rarity_roll integer;
  selected_rarity public.item_rarity;
  generated_price_cp bigint;
  maximum_price_cp bigint;
  generated_quantity integer;
  generated_name text;
  generated_count integer := 0;
  infinite_count integer := 0;
  rejected_count integer := 0;
  location_tier integer;
  equipment_rule_found boolean;
  spell_rule_found boolean;
  used_item_ids uuid[] := '{}';
  used_display_names text[] := '{}';
begin
  -- The row lock serializes competing regenerations for the same shop.
  select shop.*
  into target_shop
  from public.shops shop
  where shop.id = target_shop_id
  for update;

  if not found then
    raise exception 'Shop % does not exist.', target_shop_id;
  end if;

  select location.*
  into strict target_location
  from public.locations location
  where location.id = target_shop.location_id;

  location_tier := case target_location.classification
    when 'village' then 1
    when 'town' then 2
    when 'city' then 3
    when 'metropolis' then 4
  end;

  maximum_price_cp := case target_location.classification
    when 'village' then 7000
    when 'town' then 200000
    when 'city' then 20000000
    when 'metropolis' then null
  end;

  -- Roll the complete settlement formula independently for each shop
  -- classification, then process the combined ordered slot list.
  for classification_record in
    select mapping.classification
    from public.shop_classifications mapping
    where mapping.shop_id = target_shop_id
    order by mapping.display_order
  loop
    classification_slot_count := case target_location.classification
      when 'village' then floor(random() * 4)::integer + 1
      when 'town' then floor(random() * 4)::integer + floor(random() * 4)::integer + 2
      when 'city' then floor(random() * 6)::integer + 4
      when 'metropolis' then floor(random() * 6)::integer + floor(random() * 6)::integer + 5
    end;

    slot_classifications := slot_classifications || array_fill(
      classification_record.classification::public.catalog_item_classification,
      array[classification_slot_count]
    );
  end loop;

  -- Protect shops created by an older client during a rolling deployment.
  if cardinality(slot_classifications) = 0 then
    classification_slot_count := case target_location.classification
      when 'village' then floor(random() * 4)::integer + 1
      when 'town' then floor(random() * 4)::integer + floor(random() * 4)::integer + 2
      when 'city' then floor(random() * 6)::integer + 4
      when 'metropolis' then floor(random() * 6)::integer + floor(random() * 6)::integer + 5
    end;
    slot_classifications := array_fill(
      target_shop.classification::text::public.catalog_item_classification,
      array[classification_slot_count]
    );
  end if;

  slot_count := cardinality(slot_classifications);

  -- Manual stock is deliberately preserved.
  delete from public.shop_inventory inventory
  where inventory.shop_id = target_shop_id
    and inventory.source = 'generated';

  -- Alchemy shops always carry infinite healing potion stock. These entries do
  -- not consume noteworthy-item slots and ignore the settlement price ceiling.
  if exists (
    select 1
    from public.shop_classifications mapping
    where mapping.shop_id = target_shop_id
      and mapping.classification = 'alchemy'
  ) or (
    not exists (
      select 1
      from public.shop_classifications mapping
      where mapping.shop_id = target_shop_id
    )
    and target_shop.classification::text = 'alchemy'
  ) then
    for candidate in
      select item.*
      from public.items item
      join (
        values
          ('potion of healing'::text, 1),
          ('potion of greater healing'::text, 2),
          ('potion of superior healing'::text, 3),
          ('potion of supreme healing'::text, 4)
      ) as healing(normalized_name, minimum_tier)
        on healing.normalized_name = item.normalized_name
      where healing.minimum_tier <= location_tier
        and item.is_active
        and item.automatic_generation_eligible
        and item.price_mode = 'fixed'
        and item.fixed_price_cp is not null
        and not exists (
          select 1
          from public.campaign_item_exclusions exclusion
          where exclusion.campaign_id = target_location.campaign_id
            and exclusion.item_id = item.id
        )
      order by healing.minimum_tier
    loop
      insert into public.shop_inventory (
        shop_id,
        item_id,
        display_name,
        rarity,
        price_cp,
        quantity,
        is_infinite,
        source
      ) values (
        target_shop_id,
        candidate.id,
        candidate.name,
        candidate.rarity,
        candidate.fixed_price_cp,
        1,
        true,
        'generated'
      );

      used_item_ids := array_append(used_item_ids, candidate.id);
      used_display_names := array_append(used_display_names, lower(btrim(candidate.name)));
      generated_count := generated_count + 1;
      infinite_count := infinite_count + 1;
    end loop;
  end if;

  for slot_index in 1..slot_count loop
    selected_shop_classification := slot_classifications[slot_index];
    rarity_roll := floor(random() * 100)::integer + 1;
    selected_rarity := case target_location.classification
      when 'town' then
        case when rarity_roll <= 80 then 'common'::public.item_rarity else 'uncommon'::public.item_rarity end
      when 'city' then
        case
          when rarity_roll <= 20 then 'common'::public.item_rarity
          when rarity_roll <= 90 then 'uncommon'::public.item_rarity
          else 'rare'::public.item_rarity
        end
      when 'metropolis' then
        case
          when rarity_roll <= 15 then 'common'::public.item_rarity
          when rarity_roll <= 55 then 'uncommon'::public.item_rarity
          when rarity_roll <= 90 then 'rare'::public.item_rarity
          else 'very_rare'::public.item_rarity
        end
      else 'common'::public.item_rarity
    end;

    select item.*
    into candidate
    from public.items item
    where item.is_active
      and item.automatic_generation_eligible
      and item.rarity = selected_rarity
      and item.rarity <> 'legendary'
      and item.classification = selected_shop_classification
      and item.price_mode in ('rarity_roll', 'fixed')
      and not (item.id = any(used_item_ids))
      and not exists (
        select 1
        from public.campaign_item_exclusions exclusion
        where exclusion.campaign_id = target_location.campaign_id
          and exclusion.item_id = item.id
      )
    order by random()
    limit 1;

    if not found then
      rejected_count := rejected_count + 1;
      continue;
    end if;

    -- Exclude a catalog item immediately, even if its price or identity later
    -- rejects the slot. This prevents repeated rolls of the same entry.
    used_item_ids := array_append(used_item_ids, candidate.id);

    generated_price_cp := case candidate.price_mode
      when 'fixed' then candidate.fixed_price_cp
      when 'rarity_roll' then case candidate.rarity
        when 'common' then (floor(random() * 6)::bigint + 2) * 1000
        when 'uncommon' then (floor(random() * 6)::bigint + 1) * 10000
        when 'rare' then (floor(random() * 10)::bigint + floor(random() * 10)::bigint + 2) * 100000
        when 'very_rare' then (floor(random() * 4)::bigint + 2) * 1000000
        when 'legendary' then (floor(random() * 6)::bigint + floor(random() * 6)::bigint + 2) * 2500000
      end
      else null
    end;

    if generated_price_cp is null
      or (maximum_price_cp is not null and generated_price_cp > maximum_price_cp) then
      rejected_count := rejected_count + 1;
      continue;
    end if;

    generated_name := candidate.generated_name_template;
    generated_name := replace(generated_name, '{item_name}', candidate.name);
    selected_spell.id := null;
    selected_equipment.id := null;

    select rule.*
    into equipment_rule
    from public.item_equipment_generation_rules rule
    where rule.item_id = candidate.id;
    equipment_rule_found := found;

    if equipment_rule_found then
      if equipment_rule.selection_mode = 'fixed' then
        select equipment.*
        into selected_equipment
        from public.equipment_bases equipment
        where equipment.id = equipment_rule.fixed_equipment_base_id
          and equipment.is_active;
      else
        select equipment.*
        into selected_equipment
        from public.equipment_bases equipment
        where equipment.is_active
          and (
            (
              exists (
                select 1
                from public.item_equipment_generation_allowed_bases allowed
                where allowed.item_id = candidate.id
              )
              and exists (
                select 1
                from public.item_equipment_generation_allowed_bases allowed
                where allowed.item_id = candidate.id
                  and allowed.equipment_base_id = equipment.id
              )
            )
            or (
              not exists (
                select 1
                from public.item_equipment_generation_allowed_bases allowed
                where allowed.item_id = candidate.id
              )
              and (
                cardinality(equipment_rule.allowed_kinds) = 0
                or equipment.kind = any(equipment_rule.allowed_kinds)
              )
              and (
                cardinality(equipment_rule.allowed_categories) = 0
                or equipment.category = any(equipment_rule.allowed_categories)
              )
              and equipment_rule.required_tags <@ equipment.tags
              and not (equipment_rule.excluded_tags && equipment.tags)
            )
          )
        order by random()
        limit 1;
      end if;

      if selected_equipment.id is null then
        rejected_count := rejected_count + 1;
        continue;
      end if;
      generated_name := replace(generated_name, '{equipment_name}', selected_equipment.name);
    end if;

    select rule.*
    into spell_rule
    from public.item_spell_generation_rules rule
    where rule.item_id = candidate.id;
    spell_rule_found := found;

    if spell_rule_found then
      if spell_rule.selection_mode = 'fixed' then
        select spell.*
        into selected_spell
        from public.spells spell
        where spell.id = spell_rule.fixed_spell_id
          and spell.is_active;
      else
        select spell.*
        into selected_spell
        from public.spells spell
        where spell.is_active
          and spell.spell_level between spell_rule.minimum_spell_level and spell_rule.maximum_spell_level
          and (
            cardinality(spell_rule.allowed_schools) = 0
            or spell.school = any(spell_rule.allowed_schools)
          )
        order by random()
        limit 1;
      end if;

      if selected_spell.id is null then
        rejected_count := rejected_count + 1;
        continue;
      end if;
      generated_name := replace(generated_name, '{spell_name}', selected_spell.name);
    end if;

    generated_name := btrim(generated_name);
    if generated_name = ''
      or char_length(generated_name) > 240
      or lower(generated_name) = any(used_display_names) then
      rejected_count := rejected_count + 1;
      continue;
    end if;

    generated_quantity := case candidate.item_kind
      when 'potion' then floor(random() * 4)::integer + 1
      when 'scroll' then floor(random() * 2)::integer + 1
      else 1
    end;

    insert into public.shop_inventory (
      shop_id,
      item_id,
      selected_spell_id,
      selected_equipment_base_id,
      display_name,
      rarity,
      price_cp,
      quantity,
      is_infinite,
      source
    ) values (
      target_shop_id,
      candidate.id,
      selected_spell.id,
      selected_equipment.id,
      generated_name,
      candidate.rarity,
      generated_price_cp,
      generated_quantity,
      false,
      'generated'
    );

    used_display_names := array_append(used_display_names, lower(generated_name));
    generated_count := generated_count + 1;
  end loop;

  return jsonb_build_object(
    'shop_id', target_shop_id,
    'shop_name', target_shop.name,
    'slot_count', slot_count,
    'generated_count', generated_count,
    'infinite_count', infinite_count,
    'rejected_count', rejected_count
  );
end;
$$;

comment on table public.shop_classifications is
  'Ordered classifications for each shop; inventory slot counts are rolled independently for every entry.';
comment on function public.save_shop(uuid, uuid, text, text, text[]) is
  'Atomically creates or updates a shop and its ordered, unique classifications.';

commit;
