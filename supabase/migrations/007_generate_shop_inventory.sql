begin;

-- Keep active shop views synchronized when the DM regenerates inventory.
alter table public.shop_inventory replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shop_inventory'
  ) then
    execute 'alter publication supabase_realtime add table public.shop_inventory';
  end if;
end;
$$;

-- Internal transactional generator. Its wrapper functions below perform the
-- administrator check; direct execution is revoked after creation.
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
  slot_index integer;
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

  slot_count := case target_location.classification
    when 'village' then 0
    when 'town' then floor(random() * 4)::integer + 1
    when 'city' then floor(random() * 4)::integer + 3
    when 'metropolis' then floor(random() * 4)::integer + floor(random() * 4)::integer + 2
  end;

  -- Manual stock is deliberately preserved.
  delete from public.shop_inventory inventory
  where inventory.shop_id = target_shop_id
    and inventory.source = 'generated';

  -- Alchemy shops always carry infinite healing potion stock. These entries do
  -- not consume noteworthy-item slots and ignore the settlement price ceiling.
  if target_shop.classification = 'alchemy' then
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
      and item.classification::text = target_shop.classification::text
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

revoke all on function public._generate_shop_inventory(uuid) from public;
revoke all on function public.generate_shop_inventory(uuid) from public;
revoke all on function public.generate_location_inventory(uuid) from public;
grant execute on function public.generate_shop_inventory(uuid) to authenticated;
grant execute on function public.generate_location_inventory(uuid) to authenticated;

comment on function public.generate_shop_inventory(uuid) is
  'Atomically replaces generated stock for one shop while preserving manual inventory rows.';
comment on function public.generate_location_inventory(uuid) is
  'Atomically regenerates every shop in a location while preserving manual inventory rows.';

commit;
