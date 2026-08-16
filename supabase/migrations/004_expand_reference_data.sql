begin;

-- The universal reference catalogs now retain enough information to explain
-- generated spell items and to weight/filter concrete equipment choices.

alter table public.spells
  add column if not exists rules_text text not null default '',
  add column if not exists is_ritual boolean not null default false;

alter table public.equipment_bases
  add column if not exists rarity public.item_rarity not null default 'common';

comment on column public.spells.rules_text is
  'Compact rules reference shown to players for inventory items that grant access to this spell.';
comment on column public.spells.is_ritual is
  'True when the imported spell reference identifies the spell as a ritual.';
comment on column public.equipment_bases.rarity is
  'Relative availability of this concrete equipment base during inventory generation.';

commit;
