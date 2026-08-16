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

-- Patch the existing, tested generator in place. The migration deliberately
-- verifies every expected source fragment before replacing it so schema drift
-- fails loudly rather than installing a partially modified generator.
do $$
declare
  generator_definition text;
  old_fragment text;
  new_fragment text;
begin
  -- pg_get_functiondef() reformats declarations, so inspect the stored
  -- PL/pgSQL body directly. PostgreSQL preserves this source verbatim.
  select procedure.prosrc
  into strict generator_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = 'public._generate_shop_inventory(uuid)'::regprocedure;

  old_fragment := E'  slot_count integer := 0;\n  slot_index integer;';
  new_fragment := E'  slot_count integer := 0;\n  classification_slot_count integer := 0;\n  slot_index integer;\n  classification_record record;\n  selected_shop_classification public.catalog_item_classification;\n  slot_classifications public.catalog_item_classification[] := ''{}'';';
  if strpos(generator_definition, old_fragment) = 0 then
    raise exception 'Inventory generator declaration did not match the expected version.';
  end if;
  generator_definition := replace(generator_definition, old_fragment, new_fragment);

  old_fragment := E'  slot_count := case target_location.classification\n    when ''village'' then 0\n    when ''town'' then floor(random() * 4)::integer + 1\n    when ''city'' then floor(random() * 4)::integer + 3\n    when ''metropolis'' then floor(random() * 4)::integer + floor(random() * 4)::integer + 2\n  end;';
  new_fragment := E'  -- Roll a complete settlement-sized inventory independently for every\n  -- shop classification, then process the combined slot list below.\n  for classification_record in\n    select mapping.classification\n    from public.shop_classifications mapping\n    where mapping.shop_id = target_shop_id\n    order by mapping.display_order\n  loop\n    classification_slot_count := case target_location.classification\n      when ''village'' then floor(random() * 4)::integer + 1\n      when ''town'' then floor(random() * 4)::integer + floor(random() * 4)::integer + 2\n      when ''city'' then floor(random() * 6)::integer + 4\n      when ''metropolis'' then floor(random() * 6)::integer + floor(random() * 6)::integer + 5\n    end;\n\n    slot_classifications := slot_classifications || array_fill(\n      classification_record.classification,\n      array[classification_slot_count]\n    );\n  end loop;\n\n  -- Fallback protects shops created by an older client during deployment.\n  if cardinality(slot_classifications) = 0 then\n    classification_slot_count := case target_location.classification\n      when ''village'' then floor(random() * 4)::integer + 1\n      when ''town'' then floor(random() * 4)::integer + floor(random() * 4)::integer + 2\n      when ''city'' then floor(random() * 6)::integer + 4\n      when ''metropolis'' then floor(random() * 6)::integer + floor(random() * 6)::integer + 5\n    end;\n    slot_classifications := array_fill(\n      target_shop.classification::text::public.catalog_item_classification,\n      array[classification_slot_count]\n    );\n  end if;\n\n  slot_count := cardinality(slot_classifications);';
  if strpos(generator_definition, old_fragment) = 0 then
    raise exception 'Inventory slot formula did not match the expected version.';
  end if;
  generator_definition := replace(generator_definition, old_fragment, new_fragment);

  old_fragment := E'  if target_shop.classification = ''alchemy'' then';
  new_fragment := E'  if exists (\n    select 1\n    from public.shop_classifications mapping\n    where mapping.shop_id = target_shop_id\n      and mapping.classification = ''alchemy''\n  ) or (\n    not exists (select 1 from public.shop_classifications mapping where mapping.shop_id = target_shop_id)\n    and target_shop.classification::text = ''alchemy''\n  ) then';
  if strpos(generator_definition, old_fragment) = 0 then
    raise exception 'Alchemy inventory condition did not match the expected version.';
  end if;
  generator_definition := replace(generator_definition, old_fragment, new_fragment);

  old_fragment := E'  for slot_index in 1..slot_count loop\n    rarity_roll := floor(random() * 100)::integer + 1;';
  new_fragment := E'  for slot_index in 1..slot_count loop\n    selected_shop_classification := slot_classifications[slot_index];\n    rarity_roll := floor(random() * 100)::integer + 1;';
  if strpos(generator_definition, old_fragment) = 0 then
    raise exception 'Inventory slot loop did not match the expected version.';
  end if;
  generator_definition := replace(generator_definition, old_fragment, new_fragment);

  old_fragment := E'      and item.classification::text = target_shop.classification::text';
  new_fragment := E'      and item.classification = selected_shop_classification';
  if strpos(generator_definition, old_fragment) = 0 then
    raise exception 'Inventory classification filter did not match the expected version.';
  end if;
  generator_definition := replace(generator_definition, old_fragment, new_fragment);

  execute 'create or replace function public._generate_shop_inventory(target_shop_id uuid)
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''''
    as $generator$' || generator_definition || '$generator$';
end;
$$;

comment on table public.shop_classifications is
  'Ordered classifications for each shop; inventory slot counts are rolled independently for every entry.';
comment on function public.save_shop(uuid, uuid, text, text, text[]) is
  'Atomically creates or updates a shop and its ordered, unique classifications.';

commit;
