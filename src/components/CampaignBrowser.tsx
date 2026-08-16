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
}

type Shop = {
  id: string
  location_id: string
  name: string
  classification: string
  description: string
}

type CampaignBrowserProps = {
  campaign: Campaign
  onClose: () => void
}

export function CampaignBrowser({ campaign, onClose }: CampaignBrowserProps) {
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
        .select('id, campaign_id, name, classification, description')
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

      const shopResult = await supabase
        .from('shops')
        .select('id, location_id, name, classification, description')
        .in('location_id', nextLocations.map((location) => location.id))
        .order('display_order')
        .order('name')

      if (!isActive) return

      if (shopResult.error) {
        console.error('Could not load campaign shops:', shopResult.error)
        setMessage('The locations loaded, but their shops could not be loaded.')
      } else {
        setShops(shopResult.data ?? [])
      }

      setLoading(false)
    }

    void loadCampaign()

    return () => {
      isActive = false
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
            <ShopView shop={selectedShop} />
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
              <span className="classification-badge">{location.classification}</span>
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
        {location.description && <p>{location.description}</p>}
      </div>

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
              <span className="classification-badge shop-classification">{shop.classification}</span>
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

function ShopView({ shop }: { shop: Shop }) {
  return (
    <div className="browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">{shop.classification} shop</p>
        <h2>{shop.name}</h2>
        {shop.description && <p>{shop.description}</p>}
      </div>

      <h3 className="browser-list-heading">Noteworthy items available</h3>
      <ShopInventory key={shop.id} shopId={shop.id} />
    </div>
  )
}
