import { useCallback, useEffect, useMemo, useState, type FocusEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'

type InventoryRow = {
  id: string
  shop_id: string
  item_id: string
  selected_spell_id: string | null
  display_name: string
  rarity: 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary'
  price_cp: number
  quantity: number
  is_infinite: boolean
  source: 'manual' | 'generated'
}

type ItemReference = {
  id: string
  description: string
  requires_attunement: boolean
}

type SpellReference = {
  id: string
  name: string
  rules_text: string
}

export function ShopInventory({ shopId, canManageManual = false }: { shopId: string; canManageManual?: boolean }) {
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [items, setItems] = useState<ItemReference[]>([])
  const [spells, setSpells] = useState<SpellReference[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [removingId, setRemovingId] = useState('')

  const loadInventory = useCallback(async () => {
    const inventoryResult = await supabase
      .from('shop_inventory')
      .select('id, shop_id, item_id, selected_spell_id, display_name, rarity, price_cp, quantity, is_infinite, source')
      .eq('shop_id', shopId)
      .order('price_cp')
      .order('display_name')

    if (inventoryResult.error) {
      console.error('Could not load shop inventory:', inventoryResult.error)
      setMessage('This shop’s inventory could not be loaded.')
      setLoading(false)
      return
    }

    const nextInventory = inventoryResult.data ?? []
    const itemIds = [...new Set(nextInventory.map((row) => row.item_id))]
    const spellIds = [...new Set(nextInventory.flatMap((row) => row.selected_spell_id ? [row.selected_spell_id] : []))]

    const [itemResult, spellResult] = await Promise.all([
      itemIds.length
        ? supabase.from('items').select('id, description, requires_attunement').in('id', itemIds)
        : Promise.resolve({ data: [], error: null }),
      spellIds.length
        ? supabase.from('spells').select('id, name, rules_text').in('id', spellIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (itemResult.error || spellResult.error) {
      console.error('Could not load inventory references:', itemResult.error ?? spellResult.error)
      setMessage('The available wares loaded, but some item details are unavailable.')
    } else {
      setMessage('')
    }

    setInventory(nextInventory)
    setItems(itemResult.data ?? [])
    setSpells(spellResult.data ?? [])
    setLoading(false)
  }, [shopId])

  useEffect(() => {
    void Promise.resolve().then(loadInventory)
  }, [loadInventory])

  useEffect(() => {
    const channel = supabase
      .channel(`shop-inventory-${shopId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shop_inventory' },
        () => void loadInventory(),
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadInventory, shopId])

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const spellsById = useMemo(() => new Map(spells.map((spell) => [spell.id, spell])), [spells])

  async function removeManualItem(row: InventoryRow) {
    if (!window.confirm(`Remove “${row.display_name}” from this shop?`)) return
    setRemovingId(row.id)
    const { error } = await supabase
      .from('shop_inventory')
      .delete()
      .eq('id', row.id)
      .eq('source', 'manual')

    if (error) {
      console.error('Could not remove manual inventory:', error)
      setMessage(`${row.display_name} could not be removed.`)
    } else {
      setInventory((current) => current.filter((entry) => entry.id !== row.id))
      setMessage('')
    }
    setRemovingId('')
  }

  if (loading) return <p className="browser-loading">Checking the shelves…</p>

  if (inventory.length === 0) {
    return (
      <div className="browser-empty-state inventory-placeholder">
        <h4>No noteworthy items available</h4>
        <p>This shop may still carry ordinary goods appropriate to its trade.</p>
      </div>
    )
  }

  return (
    <>
      {message && <p className="message message-error" role="alert">{message}</p>}
      <div className="shop-inventory-list">
        {inventory.map((row) => {
          const item = itemsById.get(row.item_id)
          const spell = row.selected_spell_id ? spellsById.get(row.selected_spell_id) : null
          return (
            <article className="shop-inventory-card" key={row.id}>
              <div className="inventory-item-heading">
                <div>
                  <span className={`rarity-badge rarity-${row.rarity}`}>{titleCase(row.rarity)}</span>
                  <h4>{row.display_name}</h4>
                </div>
                <strong className="inventory-price">{formatGold(row.price_cp)} gp</strong>
              </div>

              <div className="inventory-item-meta">
                <span>{row.is_infinite ? '∞ available' : `${row.quantity} available`}</span>
                {item?.requires_attunement && <span>Requires attunement</span>}
                {row.source === 'manual' && <span>DM-selected</span>}
                {item?.description && (
                  <HoverTooltip label="Item details" title={row.display_name} content={item.description} />
                )}
                {spell && (
                  <HoverTooltip label="Spell details" title={spell.name} content={spell.rules_text || 'No spell rules text is available.'} />
                )}
                {canManageManual && row.source === 'manual' && (
                  <button className="inventory-remove-button" type="button" disabled={removingId === row.id} onClick={() => void removeManualItem(row)}>
                    {removingId === row.id ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
      <p className="inventory-footnote">Purchasing and haggling controls are coming next.</p>
    </>
  )
}

function HoverTooltip({ label, title, content }: { label: string; title: string; content: string }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  function positionNearPointer(clientX: number, clientY: number) {
    const tooltipWidth = Math.min(390, window.innerWidth - 20)
    const left = Math.max(10, Math.min(clientX + 15, window.innerWidth - tooltipWidth - 10))
    const top = clientY > window.innerHeight - 300 ? Math.max(10, clientY - 280) : clientY + 18
    setPosition({ left, top })
  }

  function handlePointerMove(event: PointerEvent<HTMLSpanElement>) {
    positionNearPointer(event.clientX, event.clientY)
  }

  function handleFocus(event: FocusEvent<HTMLSpanElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    positionNearPointer(bounds.left, bounds.bottom)
  }

  return (
    <>
      <span
        className="inventory-tooltip-trigger"
        tabIndex={0}
        onPointerEnter={handlePointerMove}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setPosition(null)}
        onFocus={handleFocus}
        onBlur={() => setPosition(null)}
      >
        {label}
      </span>
      {position && createPortal(
        <span className="inventory-cursor-tooltip" role="tooltip" style={position}>
          <strong>{title}</strong>
          {content}
        </span>,
        document.body,
      )}
    </>
  )
}

function formatGold(copperPieces: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: copperPieces % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(copperPieces / 100)
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
