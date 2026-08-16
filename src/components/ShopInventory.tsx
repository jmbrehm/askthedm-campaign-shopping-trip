import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'

type Rarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary'
type HaggleSkill = 'persuasion' | 'deception' | 'intimidation'
type HaggleOutcome = 'success' | 'failure' | 'offended'

type InventoryRow = {
  id: string
  shop_id: string
  item_id: string
  selected_spell_id: string | null
  display_name: string
  rarity: Rarity
  price_cp: number
  quantity: number
  is_infinite: boolean
  source: 'manual' | 'generated'
  stock_revision: number
}

type ItemReference = {
  id: string
  description: string
  requires_attunement: boolean
  price_mode: 'rarity_roll' | 'fixed' | 'manual_only'
}

type SpellReference = {
  id: string
  name: string
  rules_text: string
}

type PurchaseCharacter = {
  id: string
  name: string
  persuasion_bonus: number
  deception_bonus: number
  intimidation_bonus: number
  has_guidance: boolean
  has_advantage: boolean
  has_reliable_talent: boolean
  platinum_pieces: number
  gold_pieces: number
  silver_pieces: number
  copper_pieces: number
  wallet_value_cp: number
}

type HaggleRecord = {
  shop_id: string
  character_id: string
  inventory_cycle: number
  inventory_id: string | null
  inventory_stock_revision: number
  skill: HaggleSkill
  d20_roll_1: number
  d20_roll_2: number | null
  selected_d20: number
  adjusted_d20: number
  guidance_roll: number | null
  skill_bonus: number
  total_result: number
  difficulty_class: number
  outcome: HaggleOutcome
  offered_price_cp: number | null
}

type PurchaseResult = {
  display_name: string
  quantity: number
  total_price_cp: number
  was_haggled: boolean
}

type InventoryCorrectionDraft = {
  priceGp: string
  quantity: string
  isInfinite: boolean
}

export function ShopInventory({
  shopId,
  characterId,
  canManageManual = false,
  isLocationAccessible = true,
  isPurchaseAvailable = true,
}: {
  shopId: string
  characterId?: string
  canManageManual?: boolean
  isLocationAccessible?: boolean
  isPurchaseAvailable?: boolean
}) {
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [items, setItems] = useState<ItemReference[]>([])
  const [spells, setSpells] = useState<SpellReference[]>([])
  const [character, setCharacter] = useState<PurchaseCharacter | null>(null)
  const [inventoryCycle, setInventoryCycle] = useState(0)
  const [haggle, setHaggle] = useState<HaggleRecord | null>(null)
  const [selectedInventoryId, setSelectedInventoryId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [purchaseMessage, setPurchaseMessage] = useState('')
  const [removingId, setRemovingId] = useState('')
  const [editingInventoryId, setEditingInventoryId] = useState<string | null>(null)
  const [correctionDraft, setCorrectionDraft] = useState<InventoryCorrectionDraft | null>(null)
  const [savingCorrection, setSavingCorrection] = useState(false)

  const loadInventory = useCallback(async () => {
    const inventoryTable = isLocationAccessible ? 'shop_inventory' : 'location_inventory_snapshots'
    const inventoryResult = await supabase
      .from(inventoryTable)
      .select('id, shop_id, item_id, selected_spell_id, display_name, rarity, price_cp, quantity, is_infinite, source, stock_revision')
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

    const [itemResult, spellResult, shopResult, characterResult] = await Promise.all([
      itemIds.length
        ? supabase.from('items').select('id, description, requires_attunement, price_mode').in('id', itemIds)
        : Promise.resolve({ data: [], error: null }),
      spellIds.length
        ? supabase.from('spells').select('id, name, rules_text').in('id', spellIds)
        : Promise.resolve({ data: [], error: null }),
      characterId && isLocationAccessible && isPurchaseAvailable
        ? supabase.from('shops').select('inventory_cycle').eq('id', shopId).single()
        : Promise.resolve({ data: { inventory_cycle: 0 }, error: null }),
      characterId && isLocationAccessible && isPurchaseAvailable
        ? supabase
            .from('characters')
            .select('id, name, persuasion_bonus, deception_bonus, intimidation_bonus, has_guidance, has_advantage, has_reliable_talent, platinum_pieces, gold_pieces, silver_pieces, copper_pieces, wallet_value_cp')
            .eq('id', characterId)
            .single()
        : Promise.resolve({ data: null, error: null }),
    ])

    const nextCycle = Number(shopResult.data?.inventory_cycle ?? 0)
    let haggleResult: { data: HaggleRecord | null; error: { message: string } | null } = { data: null, error: null }

    if (characterId && isLocationAccessible && isPurchaseAvailable && !shopResult.error) {
      haggleResult = await supabase
        .from('shop_character_haggles')
        .select('shop_id, character_id, inventory_cycle, inventory_id, inventory_stock_revision, skill, d20_roll_1, d20_roll_2, selected_d20, adjusted_d20, guidance_roll, skill_bonus, total_result, difficulty_class, outcome, offered_price_cp')
        .eq('shop_id', shopId)
        .eq('character_id', characterId)
        .eq('inventory_cycle', nextCycle)
        .maybeSingle()
    }

    const referenceError = itemResult.error ?? spellResult.error ?? shopResult.error ?? characterResult.error ?? haggleResult.error
    if (referenceError) {
      console.error('Could not load complete shop purchase context:', referenceError)
      setMessage('The available wares loaded, but some purchase details are unavailable.')
    } else {
      setMessage('')
    }

    setInventory(nextInventory)
    setItems(itemResult.data ?? [])
    setSpells(spellResult.data ?? [])
    setInventoryCycle(nextCycle)
    setCharacter(characterResult.data ?? null)
    setHaggle(haggleResult.data ?? null)
    setLoading(false)
  }, [characterId, isLocationAccessible, isPurchaseAvailable, shopId])

  useEffect(() => {
    void Promise.resolve().then(loadInventory)
  }, [loadInventory])

  useEffect(() => {
    if (!isLocationAccessible) return undefined

    const channel = supabase
      .channel(`shop-purchase-updates-${shopId}-${characterId ?? 'dm'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shop_inventory', filter: `shop_id=eq.${shopId}` },
        () => void loadInventory(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'shops', filter: `id=eq.${shopId}` },
        () => void loadInventory(),
      )

    if (characterId) {
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'characters', filter: `id=eq.${characterId}` },
        () => void loadInventory(),
      )
    }

    channel.subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [characterId, isLocationAccessible, loadInventory, shopId])

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const spellsById = useMemo(() => new Map(spells.map((spell) => [spell.id, spell])), [spells])
  const selectedInventory = inventory.find((row) => row.id === selectedInventoryId) ?? null
  const selectedItem = selectedInventory ? itemsById.get(selectedInventory.item_id) ?? null : null
  const shopkeeperOffended = haggle?.outcome === 'offended' && haggle.inventory_cycle === inventoryCycle

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

  function beginCorrection(row: InventoryRow) {
    setEditingInventoryId(row.id)
    setCorrectionDraft({
      priceGp: goldInputValue(row.price_cp),
      quantity: String(row.quantity),
      isInfinite: row.is_infinite,
    })
    setMessage('')
    setPurchaseMessage('')
  }

  function cancelCorrection() {
    setEditingInventoryId(null)
    setCorrectionDraft(null)
  }

  async function saveCorrection(row: InventoryRow) {
    if (!correctionDraft) return
    const priceCp = parseGoldInput(correctionDraft.priceGp)
    const quantity = Number(correctionDraft.quantity)

    if (priceCp === null) {
      setMessage('Enter a valid price in gold pieces with no more than two decimal places.')
      return
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
      setMessage('Quantity must be a whole number between 1 and 1,000,000.')
      return
    }

    setSavingCorrection(true)
    setMessage('')
    const { error } = await supabase.rpc('correct_shop_inventory', {
      target_inventory_id: row.id,
      corrected_price_cp: priceCp,
      corrected_quantity: quantity,
      corrected_is_infinite: correctionDraft.isInfinite,
    })

    if (error) {
      console.error('Could not correct shop inventory:', error)
      setMessage(error.message || `${row.display_name} could not be corrected.`)
    } else {
      cancelCorrection()
      setPurchaseMessage(`${row.display_name} was corrected. Any outstanding offer for this stock was invalidated.`)
      await loadInventory()
    }
    setSavingCorrection(false)
  }

  function handlePurchased(result: PurchaseResult) {
    setSelectedInventoryId(null)
    setPurchaseMessage(
      `${result.quantity}× ${result.display_name} purchased for ${formatGold(result.total_price_cp)} gp${result.was_haggled ? ' at the agreed price' : ''}.`,
    )
    void loadInventory()
  }

  if (loading) return <p className="browser-loading">Checking the shelves…</p>

  return (
    <>
      {message && <p className="message message-error" role="alert">{message}</p>}
      {purchaseMessage && <p className="message message-success" role="status">{purchaseMessage}</p>}
      {shopkeeperOffended && character && (
        <p className="message message-error" role="alert">
          The shopkeeper is offended by {character.name} and refuses to sell to them until the shop is restocked.
        </p>
      )}

      {inventory.length === 0 ? (
        <div className="browser-empty-state inventory-placeholder">
          <h4>{isLocationAccessible ? 'No noteworthy items available' : 'No noteworthy items in the last-known inventory'}</h4>
          <p>{isLocationAccessible ? 'This shop may still carry ordinary goods appropriate to its trade.' : 'The party had no exceptional stock recorded for this shop when the location became Out of Reach.'}</p>
        </div>
      ) : (
        <div className="shop-inventory-list">
          {inventory.map((row) => {
            const item = itemsById.get(row.item_id)
            const spell = row.selected_spell_id ? spellsById.get(row.selected_spell_id) : null
            const offer = validOfferFor(row, haggle, inventoryCycle)
            return (
              <article className="shop-inventory-card" key={row.id}>
                <div className="inventory-item-heading">
                  <div>
                    <span className={`rarity-badge rarity-${row.rarity}`}>{titleCase(row.rarity)}</span>
                    <h4>{row.display_name}</h4>
                  </div>
                  {offer === null ? (
                    <strong className="inventory-price">{formatGold(row.price_cp)} gp</strong>
                  ) : (
                    <div className="inventory-price inventory-offer-price">
                      <s>{formatGold(row.price_cp)} gp</s>
                      <strong>{formatGold(offer)} gp</strong>
                    </div>
                  )}
                </div>

                <div className="inventory-item-meta">
                  <span>{row.is_infinite ? '∞ available' : `${row.quantity} available`}</span>
                  {item?.requires_attunement && <span>Requires attunement</span>}
                  {row.source === 'manual' && <span>DM-selected</span>}
                  {offer !== null && <span className="offer-badge">Your haggled offer</span>}
                  {item?.description && (
                    <HoverTooltip label="Item details" title={row.display_name} content={item.description} />
                  )}
                  {spell && (
                    <HoverTooltip label="Spell details" title={spell.name} content={spell.rules_text || 'No spell rules text is available.'} />
                  )}
                  {canManageManual && (
                    <div className="inventory-management-actions">
                      <button className="inventory-correct-button" type="button" disabled={savingCorrection || removingId === row.id} onClick={() => beginCorrection(row)}>
                        Correct stock
                      </button>
                      {row.source === 'manual' && (
                        <button className="inventory-remove-button" type="button" disabled={removingId === row.id || savingCorrection} onClick={() => void removeManualItem(row)}>
                          {removingId === row.id ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {canManageManual && editingInventoryId === row.id && correctionDraft && (
                  <div className="inventory-correction-editor">
                    <div className="inventory-correction-heading">
                      <div>
                        <p className="eyebrow">DM correction</p>
                        <strong>Correct this stock entry</strong>
                      </div>
                      <button className="text-button" type="button" disabled={savingCorrection} onClick={cancelCorrection}>Cancel</button>
                    </div>

                    <div className="inventory-correction-fields">
                      <label>
                        Price (gp)
                        <input
                          type="text"
                          inputMode="decimal"
                          value={correctionDraft.priceGp}
                          disabled={savingCorrection}
                          onChange={(event) => setCorrectionDraft((current) => current ? { ...current, priceGp: event.target.value } : current)}
                        />
                      </label>
                      <label>
                        Quantity
                        <input
                          type="number"
                          min="1"
                          max="1000000"
                          step="1"
                          value={correctionDraft.quantity}
                          disabled={savingCorrection || correctionDraft.isInfinite}
                          onChange={(event) => setCorrectionDraft((current) => current ? { ...current, quantity: event.target.value } : current)}
                        />
                      </label>
                      <label className="inventory-infinite-toggle">
                        <input
                          type="checkbox"
                          checked={correctionDraft.isInfinite}
                          disabled={savingCorrection}
                          onChange={(event) => setCorrectionDraft((current) => current ? { ...current, isInfinite: event.target.checked } : current)}
                        />
                        Infinite stock
                      </label>
                    </div>

                    <button className="button button-primary button-inline" type="button" disabled={savingCorrection} onClick={() => void saveCorrection(row)}>
                      {savingCorrection ? 'Saving…' : 'Save correction'}
                    </button>
                  </div>
                )}

                {character && (
                  <button
                    className="button button-primary inventory-purchase-button"
                    type="button"
                    disabled={shopkeeperOffended}
                    onClick={() => {
                      setPurchaseMessage('')
                      setSelectedInventoryId(row.id)
                    }}
                  >
                    {shopkeeperOffended ? 'Service refused' : 'Purchase'}
                  </button>
                )}
              </article>
            )
          })}
        </div>
      )}

      {!character && (
        <p className="inventory-footnote">
          {characterId && !isLocationAccessible
            ? 'Last-known inventory · purchase controls are locked while this location is Out of Reach.'
            : characterId && !isPurchaseAvailable
              ? 'Current inventory · purchase controls are locked because this location is not Nearby.'
            : 'DM inventory view · player purchase controls are hidden.'}
        </p>
      )}

      {selectedInventory && selectedItem && character && createPortal(
        <PurchaseDialog
          key={`${selectedInventory.id}-${selectedInventory.stock_revision}`}
          inventory={selectedInventory}
          item={selectedItem}
          character={character}
          inventoryCycle={inventoryCycle}
          haggle={haggle}
          onClose={() => setSelectedInventoryId(null)}
          onRefresh={loadInventory}
          onPurchased={handlePurchased}
        />,
        document.body,
      )}
    </>
  )
}

function PurchaseDialog({
  inventory,
  item,
  character,
  inventoryCycle,
  haggle,
  onClose,
  onRefresh,
  onPurchased,
}: {
  inventory: InventoryRow
  item: ItemReference
  character: PurchaseCharacter
  inventoryCycle: number
  haggle: HaggleRecord | null
  onClose: () => void
  onRefresh: () => Promise<void>
  onPurchased: (result: PurchaseResult) => void
}) {
  const [quantity, setQuantity] = useState(1)
  const [skill, setSkill] = useState<HaggleSkill>('persuasion')
  const [working, setWorking] = useState<'haggle' | 'purchase' | ''>('')
  const [message, setMessage] = useState('')
  const [latestHaggle, setLatestHaggle] = useState<HaggleRecord | null>(haggle)
  const activeHaggle = latestHaggle ?? haggle
  const offer = validOfferFor(inventory, activeHaggle, inventoryCycle)
  const unitPrice = offer ?? inventory.price_cp
  const totalPrice = unitPrice * quantity
  const canAfford = character.wallet_value_cp >= totalPrice
  const remainingWallet = walletFromCopper(Math.max(0, character.wallet_value_cp - totalPrice))
  const hasUsedHaggle = Boolean(activeHaggle && activeHaggle.inventory_cycle === inventoryCycle)
  const isOffended = activeHaggle?.outcome === 'offended' && activeHaggle.inventory_cycle === inventoryCycle
  const canHaggle = !hasUsedHaggle && item.price_mode === 'rarity_roll' && inventory.rarity !== 'common'
  const maximumQuantity = inventory.is_infinite ? 1000 : inventory.quantity

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }

    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [onClose])

  async function attemptHaggle() {
    setWorking('haggle')
    setMessage('')
    const { data, error } = await supabase.rpc('attempt_shop_haggle', {
      target_character_id: character.id,
      target_inventory_id: inventory.id,
      chosen_skill: skill,
    })

    if (error || !data) {
      console.error('Could not complete haggle:', error)
      setMessage(error?.message ?? 'The haggle attempt could not be completed.')
    } else {
      setLatestHaggle(data as HaggleRecord)
      await onRefresh()
    }
    setWorking('')
  }

  async function purchase() {
    setWorking('purchase')
    setMessage('')
    const { data, error } = await supabase.rpc('purchase_shop_inventory', {
      target_character_id: character.id,
      target_inventory_id: inventory.id,
      purchase_quantity: quantity,
      expected_unit_price_cp: unitPrice,
    })

    if (error || !data) {
      console.error('Could not complete purchase:', error)
      setMessage(error?.message ?? 'The purchase could not be completed.')
      await onRefresh()
      setWorking('')
      return
    }

    onPurchased(data as PurchaseResult)
  }

  return (
    <div className="purchase-dialog-backdrop" role="presentation">
      <section className="purchase-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-dialog-title">
        <header className="purchase-dialog-header">
          <div>
            <p className="eyebrow">Confirm purchase</p>
            <h2 id="purchase-dialog-title">{inventory.display_name}</h2>
          </div>
          <button className="browser-close-button" type="button" onClick={onClose} aria-label="Close purchase window">×</button>
        </header>

        <div className="purchase-dialog-body">
          <section className="purchase-wallet-panel" aria-labelledby="purchase-wallet-title">
            <div className="purchase-section-heading">
              <h3 id="purchase-wallet-title">{character.name}’s wallet</h3>
              <strong>{formatGold(character.wallet_value_cp)} gp</strong>
            </div>
            <WalletCoins wallet={character} />
          </section>

          <section className="purchase-order-panel" aria-labelledby="purchase-order-title">
            <div className="purchase-section-heading">
              <h3 id="purchase-order-title">Purchase</h3>
              <span>{formatGold(unitPrice)} gp each</span>
            </div>
            <label htmlFor="purchase-quantity">Quantity</label>
            <input
              id="purchase-quantity"
              type="number"
              min="1"
              max={maximumQuantity}
              step="1"
              value={quantity}
              onChange={(event) => {
                const nextQuantity = Number(event.target.value)
                setQuantity(Number.isInteger(nextQuantity) ? Math.min(maximumQuantity, Math.max(1, nextQuantity)) : 1)
              }}
            />
            <div className="purchase-total-row">
              <span>Total</span>
              <strong>{formatGold(totalPrice)} gp</strong>
            </div>
            <div className="wallet-after-purchase">
              <span>Wallet after purchase</span>
              <strong>{canAfford ? `${formatGold(character.wallet_value_cp - totalPrice)} gp` : 'Cannot afford'}</strong>
              {canAfford && <WalletCoins wallet={remainingWallet} compact />}
            </div>
          </section>

          <section className="haggle-panel" aria-labelledby="haggle-title">
            <div className="purchase-section-heading">
              <div>
                <p className="eyebrow">Optional</p>
                <h3 id="haggle-title">Haggle for a better price</h3>
              </div>
              {offer !== null && <strong className="successful-offer">Offer: {formatGold(offer)} gp</strong>}
            </div>

            {canHaggle ? (
              <>
                <p className="haggle-explanation">
                  Choose one skill. This is {character.name}’s only haggle attempt at this shop until its inventory regenerates.
                </p>
                <div className="haggle-skill-grid" role="radiogroup" aria-label="Haggling skill">
                  {(['persuasion', 'deception', 'intimidation'] as HaggleSkill[]).map((option) => (
                    <label className={skill === option ? 'haggle-skill selected' : 'haggle-skill'} key={option}>
                      <input type="radio" name="haggle-skill" value={option} checked={skill === option} onChange={() => setSkill(option)} />
                      <span>{titleCase(option)}</span>
                      <strong>{formatModifier(skillBonus(character, option))}</strong>
                    </label>
                  ))}
                </div>
                <div className="haggle-traits">
                  {character.has_advantage && <span>Advantage: roll 2d20</span>}
                  {character.has_guidance && <span>Guidance: add 1d4</span>}
                  {character.has_reliable_talent && <span>Reliable Talent</span>}
                  {!character.has_advantage && !character.has_guidance && !character.has_reliable_talent && <span>No additional roll features</span>}
                </div>
                <button className="button button-secondary haggle-button" type="button" disabled={Boolean(working)} onClick={() => void attemptHaggle()}>
                  {working === 'haggle' ? 'Rolling…' : `Haggle with ${titleCase(skill)}`}
                </button>
              </>
            ) : (
              <HaggleStatus haggle={activeHaggle} inventory={inventory} inventoryCycle={inventoryCycle} priceMode={item.price_mode} />
            )}
          </section>

          {message && <p className="message message-error" role="alert">{message}</p>}
        </div>

        <footer className="purchase-dialog-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button button-primary button-inline" type="button" disabled={Boolean(working) || !canAfford || isOffended} onClick={() => void purchase()}>
            {working === 'purchase' ? 'Purchasing…' : isOffended ? 'Service refused' : `Purchase for ${formatGold(totalPrice)} gp`}
          </button>
        </footer>
      </section>
    </div>
  )
}

function HaggleStatus({
  haggle,
  inventory,
  inventoryCycle,
  priceMode,
}: {
  haggle: HaggleRecord | null
  inventory: InventoryRow
  inventoryCycle: number
  priceMode: ItemReference['price_mode']
}) {
  if (!haggle || haggle.inventory_cycle !== inventoryCycle) {
    return (
      <p className="haggle-unavailable">
        {priceMode === 'fixed'
          ? 'This item has a fixed price and cannot be haggled.'
          : inventory.rarity === 'common'
            ? 'Common items cannot be haggled.'
            : 'This item is not eligible for haggling.'}
      </p>
    )
  }

  const attemptedThisItem = haggle.inventory_id === inventory.id
  const offerStillValid = validOfferFor(inventory, haggle, inventoryCycle) !== null

  return (
    <div className={`haggle-result haggle-${haggle.outcome}`}>
      <div className="haggle-result-heading">
        <strong>{haggleOutcomeTitle(haggle.outcome)}</strong>
        <span>{titleCase(haggle.skill)} vs. DC {haggle.difficulty_class}</span>
      </div>
      <div className="roll-breakdown">
        <span>
          d20: {haggle.d20_roll_1}{haggle.d20_roll_2 === null ? '' : ` and ${haggle.d20_roll_2}; kept ${haggle.selected_d20}`}
        </span>
        {haggle.adjusted_d20 !== haggle.selected_d20 && <span>Reliable Talent: {haggle.selected_d20} → {haggle.adjusted_d20}</span>}
        <span>{titleCase(haggle.skill)}: {formatModifier(haggle.skill_bonus)}</span>
        {haggle.guidance_roll !== null && <span>Guidance: +{haggle.guidance_roll}</span>}
        <strong>Total: {haggle.total_result}</strong>
      </div>
      {haggle.outcome === 'success' && attemptedThisItem && offerStillValid && (
        <p>The shopkeeper agrees to {formatGold(haggle.offered_price_cp ?? inventory.price_cp)} gp per unit for this purchase.</p>
      )}
      {haggle.outcome === 'success' && attemptedThisItem && !offerStillValid && (
        <p>The offer expired because this stock changed after the agreement.</p>
      )}
      {haggle.outcome === 'success' && !attemptedThisItem && (
        <p>This character’s successful offer applies to a different item in this shop.</p>
      )}
      {haggle.outcome === 'failure' && <p>The listed price remains unchanged.</p>}
      {haggle.outcome === 'offended' && <p>The shopkeeper refuses to sell to this character until the shop is restocked.</p>}
    </div>
  )
}

function WalletCoins({
  wallet,
  compact = false,
}: {
  wallet: Pick<PurchaseCharacter, 'platinum_pieces' | 'gold_pieces' | 'silver_pieces' | 'copper_pieces'>
  compact?: boolean
}) {
  return (
    <dl className={compact ? 'purchase-coin-list compact' : 'purchase-coin-list'}>
      <div><dt>PP</dt><dd>{wallet.platinum_pieces}</dd></div>
      <div><dt>GP</dt><dd>{wallet.gold_pieces}</dd></div>
      <div><dt>SP</dt><dd>{wallet.silver_pieces}</dd></div>
      <div><dt>CP</dt><dd>{wallet.copper_pieces}</dd></div>
    </dl>
  )
}

function HoverTooltip({ label, title, content }: { label: string; title: string; content: string }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const closeTimer = useRef<number | null>(null)

  function cancelClose() {
    if (closeTimer.current === null) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  function scheduleClose() {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      setPosition(null)
      closeTimer.current = null
    }, 220)
  }

  useEffect(() => () => cancelClose(), [])

  function positionNearPointer(clientX: number, clientY: number) {
    cancelClose()
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
        onPointerLeave={scheduleClose}
        onFocus={handleFocus}
        onBlur={scheduleClose}
      >
        {label}
      </span>
      {position && createPortal(
        <span
          className="inventory-cursor-tooltip"
          role="tooltip"
          style={position}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        >
          <strong>{title}</strong>
          {content}
        </span>,
        document.body,
      )}
    </>
  )
}

function validOfferFor(row: InventoryRow, haggle: HaggleRecord | null, inventoryCycle: number) {
  if (
    haggle?.outcome !== 'success'
    || haggle.inventory_cycle !== inventoryCycle
    || haggle.inventory_id !== row.id
    || haggle.inventory_stock_revision !== row.stock_revision
    || haggle.offered_price_cp === null
  ) return null

  return haggle.offered_price_cp
}

function skillBonus(character: PurchaseCharacter, skill: HaggleSkill) {
  if (skill === 'persuasion') return character.persuasion_bonus
  if (skill === 'deception') return character.deception_bonus
  return character.intimidation_bonus
}

function walletFromCopper(totalCopper: number) {
  let remainder = totalCopper
  const platinumPieces = Math.floor(remainder / 1000)
  remainder %= 1000
  const goldPieces = Math.floor(remainder / 100)
  remainder %= 100
  const silverPieces = Math.floor(remainder / 10)
  const copperPieces = remainder % 10
  return {
    platinum_pieces: platinumPieces,
    gold_pieces: goldPieces,
    silver_pieces: silverPieces,
    copper_pieces: copperPieces,
  }
}

function haggleOutcomeTitle(outcome: HaggleOutcome) {
  if (outcome === 'success') return 'Haggle successful'
  if (outcome === 'offended') return 'Natural 1 — shopkeeper offended'
  return 'Haggle unsuccessful'
}

function formatModifier(value: number) {
  return value >= 0 ? `+${value}` : String(value)
}

function formatGold(copperPieces: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: copperPieces % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(copperPieces / 100)
}

function goldInputValue(copperPieces: number) {
  return copperPieces % 100 === 0 ? String(copperPieces / 100) : (copperPieces / 100).toFixed(2)
}

function parseGoldInput(value: string) {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, fraction = ''] = normalized.split('.')
  const copperPieces = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(copperPieces) ? copperPieces : null
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
