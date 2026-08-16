begin;

-- Preserve enough of the original stock row to reconstruct finite inventory
-- when a sold-out purchase is reversed after its inventory row was deleted.
alter table public.shop_purchases
  add column if not exists selected_spell_id uuid references public.spells(id) on delete restrict,
  add column if not exists selected_equipment_base_id uuid references public.equipment_bases(id) on delete restrict,
  add column if not exists inventory_source public.inventory_source,
  add column if not exists inventory_was_infinite boolean,
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references auth.users(id) on delete set null,
  add column if not exists reversal_wallet_before jsonb,
  add column if not exists reversal_wallet_after jsonb,
  add column if not exists restored_inventory_id uuid references public.shop_inventory(id) on delete set null;

-- Backfill snapshots for earlier purchases whose stock row still exists.
update public.shop_purchases purchase
set selected_spell_id = inventory.selected_spell_id,
    selected_equipment_base_id = inventory.selected_equipment_base_id,
    inventory_source = inventory.source,
    inventory_was_infinite = inventory.is_infinite
from public.shop_inventory inventory
where purchase.inventory_id = inventory.id
  and purchase.inventory_source is null;

create or replace function public.capture_purchase_inventory_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.inventory_id is not null then
    select
      inventory.selected_spell_id,
      inventory.selected_equipment_base_id,
      inventory.source,
      inventory.is_infinite
    into
      new.selected_spell_id,
      new.selected_equipment_base_id,
      new.inventory_source,
      new.inventory_was_infinite
    from public.shop_inventory inventory
    where inventory.id = new.inventory_id;
  end if;

  return new;
end;
$$;

drop trigger if exists shop_purchases_capture_inventory_snapshot on public.shop_purchases;
create trigger shop_purchases_capture_inventory_snapshot
before insert on public.shop_purchases
for each row execute function public.capture_purchase_inventory_snapshot();

-- Correcting stock invalidates any offer tied to the old price or quantity by
-- advancing stock_revision in the same atomic operation.
create or replace function public.correct_shop_inventory(
  target_inventory_id uuid,
  corrected_price_cp bigint,
  corrected_quantity integer,
  corrected_is_infinite boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  corrected_inventory public.shop_inventory%rowtype;
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can correct shop inventory.' using errcode = '42501';
  end if;

  if corrected_price_cp is null or corrected_price_cp < 0 then
    raise exception 'The corrected price must be zero or greater.';
  end if;

  if corrected_quantity is null or corrected_quantity < 1 or corrected_quantity > 1000000 then
    raise exception 'The corrected quantity must be between 1 and 1,000,000.';
  end if;

  if corrected_is_infinite is null then
    raise exception 'The infinite-stock setting is required.';
  end if;

  update public.shop_inventory
  set price_cp = corrected_price_cp,
      quantity = corrected_quantity,
      is_infinite = corrected_is_infinite,
      stock_revision = stock_revision + 1,
      updated_at = now()
  where id = target_inventory_id
  returning * into corrected_inventory;

  if not found then
    raise exception 'That inventory entry is no longer available.';
  end if;

  return jsonb_build_object(
    'id', corrected_inventory.id,
    'display_name', corrected_inventory.display_name,
    'price_cp', corrected_inventory.price_cp,
    'quantity', corrected_inventory.quantity,
    'is_infinite', corrected_inventory.is_infinite,
    'stock_revision', corrected_inventory.stock_revision
  );
end;
$$;

create or replace function public.reverse_shop_purchase(target_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_purchase public.shop_purchases%rowtype;
  target_character public.characters%rowtype;
  current_inventory public.shop_inventory%rowtype;
  restored_inventory uuid;
  wallet_total bigint;
  wallet_remainder bigint;
  after_pp integer;
  after_gp integer;
  after_sp integer;
  after_cp integer;
  stock_restored boolean := false;
  inventory_found boolean := false;
begin
  if not public.current_user_is_admin() then
    raise exception 'Only AskTheDM can reverse purchases.' using errcode = '42501';
  end if;

  select purchase.*
  into target_purchase
  from public.shop_purchases purchase
  where purchase.id = target_purchase_id
  for update;

  if not found then
    raise exception 'That purchase no longer exists.';
  end if;

  if target_purchase.reversed_at is not null then
    raise exception 'That purchase has already been reversed.';
  end if;

  if target_purchase.character_id is null then
    raise exception 'The original character no longer exists, so their wallet cannot be refunded.';
  end if;

  select character.*
  into target_character
  from public.characters character
  where character.id = target_purchase.character_id
  for update;

  if not found then
    raise exception 'The original character no longer exists, so their wallet cannot be refunded.';
  end if;

  wallet_total := target_character.wallet_value_cp + target_purchase.total_price_cp;
  wallet_remainder := wallet_total;
  after_pp := (wallet_remainder / 1000)::integer;
  wallet_remainder := wallet_remainder % 1000;
  after_gp := (wallet_remainder / 100)::integer;
  wallet_remainder := wallet_remainder % 100;
  after_sp := (wallet_remainder / 10)::integer;
  after_cp := (wallet_remainder % 10)::integer;

  update public.characters
  set platinum_pieces = after_pp,
      gold_pieces = after_gp,
      silver_pieces = after_sp,
      copper_pieces = after_cp
  where id = target_character.id;

  -- Infinite inventory was never consumed, so only finite stock is restored.
  if coalesce(target_purchase.inventory_was_infinite, false) = false
    and target_purchase.shop_id is not null then
    if target_purchase.inventory_id is not null then
      select inventory.*
      into current_inventory
      from public.shop_inventory inventory
      where inventory.id = target_purchase.inventory_id
        and inventory.shop_id = target_purchase.shop_id
      for update;
      inventory_found := found;
    end if;

    if inventory_found then
      restored_inventory := current_inventory.id;
      if not current_inventory.is_infinite then
        update public.shop_inventory
        set quantity = quantity + target_purchase.quantity,
            stock_revision = stock_revision + 1,
            updated_at = now()
        where id = current_inventory.id;
        stock_restored := true;
      end if;
    elsif exists (select 1 from public.shops shop where shop.id = target_purchase.shop_id) then
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
        source,
        stock_revision
      ) values (
        target_purchase.shop_id,
        target_purchase.item_id,
        target_purchase.selected_spell_id,
        target_purchase.selected_equipment_base_id,
        target_purchase.display_name,
        target_purchase.rarity,
        target_purchase.original_unit_price_cp,
        target_purchase.quantity,
        false,
        coalesce(target_purchase.inventory_source, 'generated'::public.inventory_source),
        1
      ) returning id into restored_inventory;
      stock_restored := true;
    end if;
  end if;

  update public.shop_purchases
  set reversed_at = now(),
      reversed_by = auth.uid(),
      reversal_wallet_before = jsonb_build_object(
        'pp', target_character.platinum_pieces,
        'gp', target_character.gold_pieces,
        'sp', target_character.silver_pieces,
        'cp', target_character.copper_pieces,
        'total_cp', target_character.wallet_value_cp
      ),
      reversal_wallet_after = jsonb_build_object(
        'pp', after_pp,
        'gp', after_gp,
        'sp', after_sp,
        'cp', after_cp,
        'total_cp', wallet_total
      ),
      restored_inventory_id = restored_inventory
  where id = target_purchase.id;

  return jsonb_build_object(
    'purchase_id', target_purchase.id,
    'character_id', target_character.id,
    'character_name', target_character.name,
    'display_name', target_purchase.display_name,
    'refund_cp', target_purchase.total_price_cp,
    'stock_restored', stock_restored,
    'restored_inventory_id', restored_inventory,
    'wallet', jsonb_build_object(
      'pp', after_pp,
      'gp', after_gp,
      'sp', after_sp,
      'cp', after_cp,
      'total_cp', wallet_total
    )
  );
end;
$$;

revoke all on function public.capture_purchase_inventory_snapshot() from public;
revoke all on function public.correct_shop_inventory(uuid, bigint, integer, boolean) from public;
revoke all on function public.reverse_shop_purchase(uuid) from public;
grant execute on function public.correct_shop_inventory(uuid, bigint, integer, boolean) to authenticated;
grant execute on function public.reverse_shop_purchase(uuid) to authenticated;

comment on column public.shop_purchases.reversed_at is
  'When set, the purchase was refunded by the DM and no longer counts toward net spending.';
comment on function public.correct_shop_inventory(uuid, bigint, integer, boolean) is
  'Atomically corrects stock and invalidates haggled offers tied to the previous stock revision.';
comment on function public.reverse_shop_purchase(uuid) is
  'Atomically refunds a character, restores finite stock when possible, and preserves the reversed ledger entry.';

commit;
