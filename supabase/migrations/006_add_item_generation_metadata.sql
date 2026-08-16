begin;

-- Shop category, magical status, quantity behavior, and pricing behavior are
-- separate concerns. Keeping them independent lets a smith carry mundane and
-- magical wares while allowing potions and scrolls to receive special stock
-- quantities without relying on item-name matching.
do $$ begin
  create type public.catalog_item_kind as enum ('standard', 'potion', 'scroll');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.catalog_price_mode as enum ('rarity_roll', 'fixed', 'manual_only');
exception when duplicate_object then null;
end $$;

alter table public.items
  add column if not exists is_magical boolean not null default true,
  add column if not exists item_kind public.catalog_item_kind not null default 'standard',
  add column if not exists price_mode public.catalog_price_mode not null default 'rarity_roll',
  add column if not exists fixed_price_cp bigint,
  add column if not exists automatic_generation_eligible boolean not null default true;

alter table public.items
  drop constraint if exists items_fixed_price_nonnegative,
  drop constraint if exists items_price_mode_value_valid,
  drop constraint if exists items_manual_only_not_automatic;

alter table public.items
  add constraint items_fixed_price_nonnegative
    check (fixed_price_cp is null or fixed_price_cp >= 0),
  add constraint items_price_mode_value_valid
    check (
      (price_mode = 'fixed' and fixed_price_cp is not null)
      or (price_mode <> 'fixed' and fixed_price_cp is null)
    ),
  add constraint items_manual_only_not_automatic
    check (price_mode <> 'manual_only' or not automatic_generation_eligible);

create index if not exists items_automatic_generation_lookup_idx
  on public.items (
    is_active,
    automatic_generation_eligible,
    classification,
    rarity,
    is_magical
  );

comment on column public.items.is_magical is
  'Whether the catalog entry is magical; independent of the shop classification.';
comment on column public.items.item_kind is
  'Semantic stock kind used for quantity rules: potion 1d4, scroll 1d2, standard 1.';
comment on column public.items.price_mode is
  'How a stock price is established: rarity dice, fixed catalog price, or DM-only manual pricing.';
comment on column public.items.fixed_price_cp is
  'Fixed catalog price in copper pieces; populated only when price_mode is fixed.';
comment on column public.items.automatic_generation_eligible is
  'Whether random shop generation may select this item. Legendary items are disabled by application policy.';

commit;
