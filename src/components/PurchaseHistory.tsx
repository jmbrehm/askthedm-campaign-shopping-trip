import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'

type PurchaseRow = {
  id: string
  buyer_user_id: string | null
  character_id: string | null
  character_name: string
  shop_id: string | null
  display_name: string
  rarity: 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary'
  quantity: number
  original_unit_price_cp: number
  unit_price_cp: number
  total_price_cp: number
  was_haggled: boolean
  purchased_at: string
}

type ProfileReference = {
  id: string
  username: string
}

type ShopReference = {
  id: string
  name: string
}

export function PurchaseLedger({
  shopId,
  characterId,
  showBuyer = false,
  showShop = false,
}: {
  shopId?: string
  characterId?: string
  showBuyer?: boolean
  showShop?: boolean
}) {
  const [purchases, setPurchases] = useState<PurchaseRow[]>([])
  const [profiles, setProfiles] = useState<ProfileReference[]>([])
  const [shops, setShops] = useState<ShopReference[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  const loadPurchases = useCallback(async () => {
    let query = supabase
      .from('shop_purchases')
      .select('id, buyer_user_id, character_id, character_name, shop_id, display_name, rarity, quantity, original_unit_price_cp, unit_price_cp, total_price_cp, was_haggled, purchased_at')
      .order('purchased_at', { ascending: false })
      .limit(100)

    if (shopId) query = query.eq('shop_id', shopId)
    if (characterId) query = query.eq('character_id', characterId)

    const purchaseResult = await query
    if (purchaseResult.error) {
      console.error('Could not load purchase history:', purchaseResult.error)
      setMessage('Purchase history could not be loaded.')
      setLoading(false)
      return
    }

    const nextPurchases = purchaseResult.data ?? []
    const buyerIds = [...new Set(nextPurchases.flatMap((purchase) => purchase.buyer_user_id ? [purchase.buyer_user_id] : []))]
    const shopIds = [...new Set(nextPurchases.flatMap((purchase) => purchase.shop_id ? [purchase.shop_id] : []))]

    const [profileResult, shopResult] = await Promise.all([
      showBuyer && buyerIds.length
        ? supabase.from('profiles').select('id, username').in('id', buyerIds)
        : Promise.resolve({ data: [], error: null }),
      showShop && shopIds.length
        ? supabase.from('shops').select('id, name').in('id', shopIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (profileResult.error || shopResult.error) {
      console.error('Could not load purchase history references:', profileResult.error ?? shopResult.error)
      setMessage('Some buyer or shop names are unavailable.')
    } else {
      setMessage('')
    }

    setPurchases(nextPurchases)
    setProfiles(profileResult.data ?? [])
    setShops(shopResult.data ?? [])
    setLoading(false)
  }, [characterId, shopId, showBuyer, showShop])

  useEffect(() => {
    void Promise.resolve().then(loadPurchases)
  }, [loadPurchases])

  useEffect(() => {
    const filter = shopId
      ? `shop_id=eq.${shopId}`
      : characterId
        ? `character_id=eq.${characterId}`
        : undefined
    const channel = supabase
      .channel(`purchase-ledger-${shopId ?? characterId ?? 'all'}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'shop_purchases', ...(filter ? { filter } : {}) },
        () => void loadPurchases(),
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [characterId, loadPurchases, shopId])

  const profilesById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles])
  const shopsById = useMemo(() => new Map(shops.map((shop) => [shop.id, shop])), [shops])
  const totalSpent = purchases.reduce((sum, purchase) => sum + purchase.total_price_cp, 0)
  const unitsPurchased = purchases.reduce((sum, purchase) => sum + purchase.quantity, 0)

  if (loading) return <p className="browser-loading">Opening the ledger…</p>

  return (
    <div className="purchase-ledger">
      {message && <p className="message message-error" role="alert">{message}</p>}

      {purchases.length === 0 ? (
        <div className="browser-empty-state purchase-ledger-empty">
          <h4>No purchases recorded</h4>
          <p>Completed purchases will appear here automatically.</p>
        </div>
      ) : (
        <>
          <div className="ledger-summary" aria-label="Purchase history summary">
            <div><strong>{purchases.length}</strong><span>{purchases.length === 1 ? 'Transaction' : 'Transactions'}</span></div>
            <div><strong>{unitsPurchased}</strong><span>{unitsPurchased === 1 ? 'Item purchased' : 'Items purchased'}</span></div>
            <div><strong>{formatGold(totalSpent)} gp</strong><span>Total spent</span></div>
          </div>

          <div className="purchase-ledger-list">
            {purchases.map((purchase) => {
              const buyer = purchase.buyer_user_id ? profilesById.get(purchase.buyer_user_id) : null
              const shop = purchase.shop_id ? shopsById.get(purchase.shop_id) : null
              const listedTotal = purchase.original_unit_price_cp * purchase.quantity
              const savings = Math.max(0, listedTotal - purchase.total_price_cp)

              return (
                <article className="purchase-ledger-entry" key={purchase.id}>
                  <div className="ledger-entry-heading">
                    <div>
                      <span className={`rarity-badge rarity-${purchase.rarity}`}>{titleCase(purchase.rarity)}</span>
                      <h4>{purchase.display_name}</h4>
                    </div>
                    <time dateTime={purchase.purchased_at}>{formatPurchaseTime(purchase.purchased_at)}</time>
                  </div>

                  <div className="ledger-entry-context">
                    {showBuyer && (
                      <span>
                        <strong>{purchase.character_name}</strong>
                        {buyer ? ` · ${buyer.username}` : ''}
                      </span>
                    )}
                    {showShop && <span><strong>{shop?.name ?? 'Unavailable shop'}</strong></span>}
                    <span>{purchase.quantity} {purchase.quantity === 1 ? 'unit' : 'units'}</span>
                  </div>

                  <div className="ledger-price-row">
                    <div>
                      <span>Paid</span>
                      <strong>{formatGold(purchase.total_price_cp)} gp</strong>
                    </div>
                    <div>
                      <span>Per unit</span>
                      <strong>{formatGold(purchase.unit_price_cp)} gp</strong>
                    </div>
                    {purchase.was_haggled && (
                      <div className="ledger-savings">
                        <span>Haggled savings</span>
                        <strong>{formatGold(savings)} gp</strong>
                        <small>Listed total: {formatGold(listedTotal)} gp</small>
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
          {purchases.length === 100 && <p className="ledger-limit-note">Showing the 100 most recent purchases.</p>}
        </>
      )}
    </div>
  )
}

export function PurchaseHistoryDialog({
  characterId,
  characterName,
  onClose,
}: {
  characterId: string
  characterName: string
  onClose: () => void
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }

    window.addEventListener('keydown', handleEscape, true)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleEscape, true)
    }
  }, [onClose])

  return createPortal(
    <div className="purchase-dialog-backdrop" role="presentation">
      <section className="purchase-history-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-history-title">
        <header className="purchase-dialog-header">
          <div>
            <p className="eyebrow">Purchase history</p>
            <h2 id="purchase-history-title">{characterName}’s ledger</h2>
          </div>
          <button className="browser-close-button" type="button" onClick={onClose} aria-label="Close purchase history">×</button>
        </header>
        <div className="purchase-history-content">
          <PurchaseLedger characterId={characterId} showShop />
        </div>
        <footer className="campaign-browser-footer">Press <kbd>Esc</kbd> to close.</footer>
      </section>
    </div>,
    document.body,
  )
}

function formatGold(copperPieces: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: copperPieces % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(copperPieces / 100)
}

function formatPurchaseTime(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
