import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ShopInventory } from './ShopInventory'

type Campaign = {
  id: string
  name: string
  description: string
}

type Location = {
  id: string
  campaign_id: string
  name: string
  classification: string
  description: string
  is_accessible: boolean
  is_nearby: boolean
  is_always_nearby: boolean
}

type Shop = {
  id: string
  location_id: string
  name: string
  classification: string
  classifications: string[]
  description: string
}

type ShopClassificationRow = {
  shop_id: string
  classification: string
  display_order: number
}

type CampaignBrowserProps = {
  campaign: Campaign
  characterId: string
  onClose: () => void
}

export function CampaignBrowser({ campaign, characterId, onClose }: CampaignBrowserProps) {
  const [locations, setLocations] = useState<Location[]>([])
  const [shops, setShops] = useState<Shop[]>([])
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null)
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  const selectedLocation = useMemo(
    () => locations.find((location) => location.id === selectedLocationId) ?? null,
    [locations, selectedLocationId],
  )
  const selectedShop = useMemo(
    () => shops.find((shop) => shop.id === selectedShopId) ?? null,
    [shops, selectedShopId],
  )
  const visibleShops = selectedLocation
    ? shops.filter((shop) => shop.location_id === selectedLocation.id)
    : []

  useEffect(() => {
    let isActive = true

    async function loadCampaign() {
      const locationResult = await supabase
        .from('locations')
        .select('id, campaign_id, name, classification, description, is_accessible, is_nearby, is_always_nearby')
        .eq('campaign_id', campaign.id)
        .order('display_order')
        .order('name')

      if (!isActive) return

      if (locationResult.error) {
        console.error('Could not load campaign locations:', locationResult.error)
        setMessage('The campaign locations could not be loaded.')
        setLoading(false)
        return
      }

      const nextLocations = locationResult.data ?? []
      setLocations(nextLocations)

      if (nextLocations.length === 0) {
        setShops([])
        setLoading(false)
        return
      }

      const [shopResult, shopClassificationResult] = await Promise.all([
        supabase
          .from('shops')
          .select('id, location_id, name, classification, description')
          .in('location_id', nextLocations.map((location) => location.id))
          .order('display_order')
          .order('name'),
        supabase
          .from('shop_classifications')
          .select('shop_id, classification, display_order')
          .order('display_order'),
      ])

      if (!isActive) return

      if (shopResult.error || shopClassificationResult.error) {
        console.error('Could not load campaign shops:', shopResult.error ?? shopClassificationResult.error)
        setMessage('The locations loaded, but their shops could not be loaded.')
      } else {
        setShops(attachShopClassifications(shopResult.data ?? [], shopClassificationResult.data ?? []))
      }

      setLoading(false)
    }

    void loadCampaign()

    return () => {
      isActive = false
    }
  }, [campaign.id])

  useEffect(() => {
    const channel = supabase
      .channel(`player-location-access-${campaign.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'locations',
          filter: `campaign_id=eq.${campaign.id}`,
        },
        (payload) => {
          const updatedLocation = payload.new as Location
          setLocations((current) => current.map((location) => (
            location.id === updatedLocation.id ? { ...location, ...updatedLocation } : location
          )))
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [campaign.id])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return

      event.preventDefault()
      if (selectedShopId) {
        setSelectedShopId(null)
      } else if (selectedLocationId) {
        setSelectedLocationId(null)
      } else {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, selectedLocationId, selectedShopId])

  function goBack() {
    if (selectedShopId) {
      setSelectedShopId(null)
    } else if (selectedLocationId) {
      setSelectedLocationId(null)
    } else {
      onClose()
    }
  }

  return (
    <div className="campaign-browser-backdrop" role="presentation">
      <section
        className="campaign-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-browser-title"
      >
        <header className="campaign-browser-header">
          <button className="browser-back-button" type="button" onClick={goBack}>
            {selectedLocationId ? '← Back' : '← Directory'}
          </button>

          <div className="browser-breadcrumb" id="campaign-browser-title">
            <button
              type="button"
              onClick={() => {
                setSelectedLocationId(null)
                setSelectedShopId(null)
              }}
            >
              {campaign.name}
            </button>
            {selectedLocation && (
              <>
                <span aria-hidden="true">—</span>
                <button type="button" onClick={() => setSelectedShopId(null)}>
                  {selectedLocation.name}
                </button>
              </>
            )}
            {selectedShop && (
              <>
                <span aria-hidden="true">—</span>
                <strong>{selectedShop.name}</strong>
              </>
            )}
          </div>

          <button className="browser-close-button" type="button" onClick={onClose} aria-label="Close campaign browser">
            ×
          </button>
        </header>

        <div className="campaign-browser-content">
          {message && <p className="message message-error" role="alert">{message}</p>}

          {loading ? (
            <p className="browser-loading">Opening campaign…</p>
          ) : selectedShop ? (
            <ShopView shop={selectedShop} location={selectedLocation} characterId={characterId} />
          ) : selectedLocation ? (
            <LocationView
              location={selectedLocation}
              shops={visibleShops}
              onSelectShop={setSelectedShopId}
            />
          ) : (
            <CampaignView
              campaign={campaign}
              locations={locations}
              onSelectLocation={setSelectedLocationId}
            />
          )}
        </div>

        <footer className="campaign-browser-footer">
          Press <kbd>Esc</kbd> to {selectedLocationId ? 'go back' : 'close'}.
        </footer>
      </section>
    </div>
  )
}

function CampaignView({
  campaign,
  locations,
  onSelectLocation,
}: {
  campaign: Campaign
  locations: Location[]
  onSelectLocation: (id: string) => void
}) {
  return (
    <div className="browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">Campaign</p>
        <h2>{campaign.name}</h2>
        {campaign.description && <p>{campaign.description}</p>}
      </div>

      <h3 className="browser-list-heading">Locations</h3>
      {locations.length === 0 ? (
        <div className="browser-empty-state">
          <h4>No locations available</h4>
          <p>AskTheDM has not added any locations to this campaign yet.</p>
        </div>
      ) : (
        <div className="browser-card-list">
          {locations.map((location) => (
            <button className="browser-entity-card" type="button" key={location.id} onClick={() => onSelectLocation(location.id)}>
              <div className="location-card-badges">
                <span className="classification-badge">{location.classification}</span>
                <LocationAccessBadge accessible={location.is_accessible} />
                <LocationProximityBadge location={location} />
              </div>
              <strong>{location.name}</strong>
              <span>{location.description || 'No location description has been provided.'}</span>
              <small>Explore location →</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LocationView({
  location,
  shops,
  onSelectShop,
}: {
  location: Location
  shops: Shop[]
  onSelectShop: (id: string) => void
}) {
  return (
    <div className="browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">{location.classification}</p>
        <h2>{location.name}</h2>
        <LocationAccessBadge accessible={location.is_accessible} />
        <LocationProximityBadge location={location} />
        {location.description && <p>{location.description}</p>}
      </div>

      {!location.is_accessible && (
        <p className="location-access-notice" role="status">
          This location is currently Out of Reach. Shop inventories show the party’s last-known information, and purchasing is unavailable.
        </p>
      )}

      <h3 className="browser-list-heading">Shops</h3>
      {shops.length === 0 ? (
        <div className="browser-empty-state">
          <h4>No shops available</h4>
          <p>AskTheDM has not opened any shops in this location yet.</p>
        </div>
      ) : (
        <div className="browser-card-list">
          {shops.map((shop) => (
            <button className="browser-entity-card" type="button" key={shop.id} onClick={() => onSelectShop(shop.id)}>
              <ShopClassificationBadges classifications={shop.classifications} />
              <strong>{shop.name}</strong>
              <span>{shop.description || 'No shop description has been provided.'}</span>
              <small>Enter shop →</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ShopView({ shop, location, characterId }: { shop: Shop; location: Location | null; characterId: string }) {
  const isAccessible = location?.is_accessible ?? true
  const isNearby = location?.is_nearby ?? false
  const canPurchase = isAccessible && isNearby
  return (
    <div className="browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">{shop.classifications.map(titleCase).join(' / ')} shop</p>
        <h2>{shop.name}</h2>
        {shop.description && <p>{shop.description}</p>}
      </div>

      {!isAccessible && (
        <p className="location-access-notice" role="status">
          Last-known inventory only. This location is Out of Reach, so purchases and haggling are locked.
        </p>
      )}

      {isAccessible && !isNearby && (
        <p className="location-access-notice" role="status">
          This location is not Nearby. Its inventory is current, but purchases and haggling are unavailable until the party returns.
        </p>
      )}

      <h3 className="browser-list-heading">{isAccessible ? 'Noteworthy items available' : 'Last-known noteworthy items'}</h3>
      <ShopInventory
        key={`${shop.id}-${isAccessible ? 'live' : 'snapshot'}-${canPurchase ? 'purchasable' : 'view-only'}`}
        shopId={shop.id}
        characterId={characterId}
        isLocationAccessible={isAccessible}
        isPurchaseAvailable={canPurchase}
      />
    </div>
  )
}

function attachShopClassifications(
  shops: Array<Omit<Shop, 'classifications'>>,
  rows: ShopClassificationRow[],
): Shop[] {
  return shops.map((shop) => {
    const classifications = rows
      .filter((row) => row.shop_id === shop.id)
      .sort((left, right) => left.display_order - right.display_order)
      .map((row) => row.classification)

    return { ...shop, classifications: classifications.length > 0 ? classifications : [shop.classification] }
  })
}

function ShopClassificationBadges({ classifications }: { classifications: string[] }) {
  return (
    <span className="shop-classification-badges">
      {classifications.map((classification) => (
        <span className="classification-badge shop-classification" key={classification}>{titleCase(classification)}</span>
      ))}
    </span>
  )
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function LocationAccessBadge({ accessible }: { accessible: boolean }) {
  return (
    <span className={accessible ? 'location-access-badge accessible' : 'location-access-badge out-of-reach'}>
      {accessible ? 'Accessible' : 'Out of Reach'}
    </span>
  )
}

function LocationProximityBadge({ location }: { location: Pick<Location, 'is_nearby' | 'is_always_nearby'> }) {
  if (!location.is_nearby) return null

  return (
    <span className={location.is_always_nearby ? 'location-proximity-badge always-nearby' : 'location-proximity-badge nearby'}>
      {location.is_always_nearby ? 'Always Nearby' : 'Nearby'}
    </span>
  )
}
