import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { ItemCatalogManager } from './ItemCatalogManager'
import { PurchaseLedger } from './PurchaseHistory'
import { ShopInventory } from './ShopInventory'

type LocationClassification = 'village' | 'town' | 'city' | 'metropolis'
type ShopClassification = 'mundane' | 'alchemy' | 'smith' | 'magic' | 'jewelry' | 'tailored' | 'wondrous'

type Campaign = {
  id: string
  name: string
  description: string
  is_listed: boolean
}

type Location = {
  id: string
  campaign_id: string
  name: string
  classification: LocationClassification
  description: string
  is_accessible: boolean
}

type Shop = {
  id: string
  location_id: string
  name: string
  classification: ShopClassification
  description: string
}

type ShopGenerationSummary = {
  shop_id: string
  shop_name: string
  slot_count: number
  generated_count: number
  infinite_count: number
  rejected_count: number
}

type LocationGenerationSummary = {
  location_id: string
  location_name: string
  shop_count: number
  generated_count: number
  rejected_count: number
  shops: ShopGenerationSummary[]
}

type ManualCatalogItem = {
  id: string
  name: string
  classification: ShopClassification
  rarity: 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary'
  price_mode: 'rarity_roll' | 'fixed' | 'manual_only'
  fixed_price_cp: number | null
}

type JoinRequest = {
  campaign_id: string
  character_id: string
  requested_at: string
}

type RequestCharacter = {
  id: string
  owner_id: string
  name: string
}

type RequestProfile = {
  id: string
  username: string
}

type EditorState =
  | { type: 'campaign'; campaign?: Campaign }
  | { type: 'location'; campaignId: string; location?: Location }
  | { type: 'shop'; locationId: string; shop?: Shop }
  | null

const LOCATION_OPTIONS: Array<{ value: LocationClassification; label: string }> = [
  { value: 'village', label: 'Village — population under 1,000' },
  { value: 'town', label: 'Town — population 1,000–6,000' },
  { value: 'city', label: 'City — population 6,000–25,000' },
  { value: 'metropolis', label: 'Metropolis — population 25,000+' },
]

const SHOP_OPTIONS: Array<{ value: ShopClassification; label: string }> = [
  { value: 'mundane', label: 'Mundane — nonmagical equipment and supplies' },
  { value: 'alchemy', label: 'Alchemy — potions and poisons' },
  { value: 'smith', label: 'Smith — weapons and armor' },
  { value: 'magic', label: 'Magic — scrolls, foci, components, and implements' },
  { value: 'jewelry', label: 'Jewelry — rings, necklaces, and gemstones' },
  { value: 'tailored', label: 'Tailored — boots, capes, and robes' },
  { value: 'wondrous', label: 'Wondrous — specialty items' },
]

export function CampaignManager({ userId }: { userId: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [shops, setShops] = useState<Shop[]>([])
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([])
  const [requestCharacters, setRequestCharacters] = useState<RequestCharacter[]>([])
  const [requestProfiles, setRequestProfiles] = useState<RequestProfile[]>([])
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null)
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [reviewingRequest, setReviewingRequest] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)

  const fetchHierarchy = useCallback(async () => {
    const [campaignResult, locationResult, shopResult, requestResult, characterResult, profileResult] = await Promise.all([
      supabase.from('campaigns').select('id, name, description, is_listed').order('name'),
      supabase.from('locations').select('id, campaign_id, name, classification, description, is_accessible').order('display_order').order('name'),
      supabase.from('shops').select('id, location_id, name, classification, description').order('display_order').order('name'),
      supabase
        .from('campaign_character_memberships')
        .select('campaign_id, character_id, requested_at')
        .eq('status', 'pending')
        .order('requested_at'),
      supabase.from('characters').select('id, owner_id, name'),
      supabase.from('profiles').select('id, username'),
    ])

    const error = campaignResult.error
      ?? locationResult.error
      ?? shopResult.error
      ?? requestResult.error
      ?? characterResult.error
      ?? profileResult.error

    return {
      campaigns: campaignResult.data ?? [],
      locations: locationResult.data ?? [],
      shops: shopResult.data ?? [],
      joinRequests: requestResult.data ?? [],
      requestCharacters: characterResult.data ?? [],
      requestProfiles: profileResult.data ?? [],
      error,
    }
  }, [])

  useEffect(() => {
    let isActive = true

    void fetchHierarchy().then((result) => {
      if (!isActive) return

      if (result.error) {
        console.error('Could not load campaign hierarchy:', result.error)
        setMessage('The campaign hierarchy could not be loaded.')
      } else {
        setCampaigns(result.campaigns)
        setLocations(result.locations)
        setShops(result.shops)
        setJoinRequests(result.joinRequests)
        setRequestCharacters(result.requestCharacters)
        setRequestProfiles(result.requestProfiles)
      }

      setLoading(false)
    })

    return () => {
      isActive = false
    }
  }, [fetchHierarchy])

  useEffect(() => {
    const channel = supabase
      .channel('dm-campaign-membership-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'campaign_character_memberships',
        },
        () => {
          void fetchHierarchy().then((result) => {
            if (result.error) {
              console.error('Could not apply live join-request update:', result.error)
              return
            }

            setCampaigns(result.campaigns)
            setLocations(result.locations)
            setShops(result.shops)
            setJoinRequests(result.joinRequests)
            setRequestCharacters(result.requestCharacters)
            setRequestProfiles(result.requestProfiles)
            setMessage('')
          })
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [fetchHierarchy])

  async function refreshHierarchy() {
    const result = await fetchHierarchy()

    if (result.error) {
      console.error('Could not refresh campaign hierarchy:', result.error)
      setMessage('The updated campaign hierarchy could not be loaded.')
      return false
    }

    setCampaigns(result.campaigns)
    setLocations(result.locations)
    setShops(result.shops)
    setJoinRequests(result.joinRequests)
    setRequestCharacters(result.requestCharacters)
    setRequestProfiles(result.requestProfiles)
    setMessage('')
    return true
  }

  async function deleteCampaign(campaign: Campaign) {
    const confirmed = window.confirm(
      `Delete the campaign “${campaign.name}”? All of its locations, shops, and membership requests will also be deleted. This cannot be undone.`,
    )
    if (!confirmed) return

    const { error } = await supabase.from('campaigns').delete().eq('id', campaign.id)
    const deleted = await handleDeleteResult(error, `${campaign.name} could not be deleted.`)
    if (deleted && openCampaignId === campaign.id) closeCampaignBrowser()
  }

  async function deleteLocation(location: Location) {
    const confirmed = window.confirm(
      `Delete the location “${location.name}”? Every shop in this location will also be deleted. This cannot be undone.`,
    )
    if (!confirmed) return

    const { error } = await supabase.from('locations').delete().eq('id', location.id)
    const deleted = await handleDeleteResult(error, `${location.name} could not be deleted.`)
    if (deleted && selectedLocationId === location.id) {
      setSelectedLocationId(null)
      setEditor(null)
    }
  }

  async function deleteShop(shop: Shop) {
    const confirmed = window.confirm(
      `Delete the shop “${shop.name}”? This cannot be undone.`,
    )
    if (!confirmed) return

    const { error } = await supabase.from('shops').delete().eq('id', shop.id)
    await handleDeleteResult(error, `${shop.name} could not be deleted.`)
  }

  async function handleDeleteResult(error: { message: string } | null, failureMessage: string) {
    if (error) {
      console.error(failureMessage, error)
      setMessage(failureMessage)
      return false
    }

    await refreshHierarchy()
    return true
  }

  async function finishSave() {
    const refreshed = await refreshHierarchy()
    if (!refreshed) return
    setEditor(null)
  }

  function openCampaignBrowser(campaignId: string) {
    setOpenCampaignId(campaignId)
    setSelectedLocationId(null)
    setEditor(null)
  }

  function closeCampaignBrowser() {
    setOpenCampaignId(null)
    setSelectedLocationId(null)
    setEditor(null)
  }

  async function reviewJoinRequest(request: JoinRequest, status: 'accepted' | 'rejected') {
    const requestKey = `${request.campaign_id}:${request.character_id}`
    setReviewingRequest(requestKey)
    setMessage('')

    const { error } = await supabase
      .from('campaign_character_memberships')
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: userId,
      })
      .eq('campaign_id', request.campaign_id)
      .eq('character_id', request.character_id)
      .eq('status', 'pending')

    if (error) {
      console.error('Could not review campaign join request:', error)
      setMessage('That join request could not be updated. Please try again.')
      setReviewingRequest('')
      return
    }

    await refreshHierarchy()
    setReviewingRequest('')
  }

  return (
    <section className="campaign-section" aria-labelledby="campaigns-heading">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">DM workshop</p>
          <h2 id="campaigns-heading">Campaign hierarchy</h2>
        </div>
        {!editor && (
          <div className="section-heading-actions">
            <button className="button button-secondary" type="button" onClick={() => setCatalogOpen(true)}>Item catalog</button>
            <button className="button button-primary button-inline" type="button" onClick={() => setEditor({ type: 'campaign' })}>Create campaign</button>
          </div>
        )}
      </div>

      {!loading && (
        <JoinRequestQueue
          requests={joinRequests}
          campaigns={campaigns}
          characters={requestCharacters}
          profiles={requestProfiles}
          reviewingRequest={reviewingRequest}
          onReview={(request, status) => void reviewJoinRequest(request, status)}
        />
      )}

      {editor?.type === 'campaign' && !editor.campaign && (
        <CampaignEditor
          campaign={editor.campaign}
          userId={userId}
          onCancel={() => setEditor(null)}
          onSaved={() => finishSave()}
        />
      )}

      {message && <p className="message message-error">{message}</p>}

      {loading ? (
        <p className="hierarchy-message">Loading campaigns…</p>
      ) : campaigns.length === 0 && !editor ? (
        <div className="empty-state hierarchy-empty-state">
          <h3>No campaigns yet</h3>
          <p>Create a campaign, then populate it with locations and shops.</p>
          <button className="button button-secondary" type="button" onClick={() => setEditor({ type: 'campaign' })}>
            Create your first campaign
          </button>
        </div>
      ) : (
        <div className="campaign-list">
          {campaigns.map((campaign) => {
            const campaignLocations = locations.filter((location) => location.campaign_id === campaign.id)

            return (
              <article className="campaign-panel" key={campaign.id}>
                <div className="entity-row campaign-row">
                  <div className="shop-marker" aria-hidden="true">◆</div>
                  <div className="entity-copy">
                    <div className="entity-title-line">
                      <h3>{campaign.name}</h3>
                      <span className={campaign.is_listed ? 'visibility-badge listed' : 'visibility-badge'}>
                        {campaign.is_listed ? 'Listed' : 'Unlisted'}
                      </span>
                    </div>
                    {campaign.description && <p>{campaign.description}</p>}
                    <span className="entity-count">
                      {campaignLocations.length} {campaignLocations.length === 1 ? 'location' : 'locations'}
                    </span>
                    <EntityActions
                      onAdd={() => openCampaignBrowser(campaign.id)}
                      addLabel="Enter campaign"
                      onEdit={() => setEditor({ type: 'campaign', campaign })}
                      onDelete={() => void deleteCampaign(campaign)}
                    />
                  </div>
                </div>

                {editor?.type === 'campaign' && editor.campaign?.id === campaign.id && (
                  <CampaignEditor
                    campaign={campaign}
                    userId={userId}
                    onCancel={() => setEditor(null)}
                    onSaved={() => finishSave()}
                  />
                )}

              </article>
            )
          })}
        </div>
      )}

      {openCampaignId && campaigns.find((campaign) => campaign.id === openCampaignId) && (
        <DmCampaignBrowser
          campaign={campaigns.find((campaign) => campaign.id === openCampaignId) as Campaign}
          locations={locations.filter((location) => location.campaign_id === openCampaignId)}
          shops={shops}
          selectedLocationId={selectedLocationId}
          editor={editor}
          userId={userId}
          onSelectLocation={(locationId) => {
            setSelectedLocationId(locationId)
            setEditor(null)
          }}
          onBack={() => {
            if (editor) setEditor(null)
            else if (selectedLocationId) setSelectedLocationId(null)
            else closeCampaignBrowser()
          }}
          onClose={closeCampaignBrowser}
          onEditCampaign={(campaign) => setEditor({ type: 'campaign', campaign })}
          onAddLocation={(campaignId) => setEditor({ type: 'location', campaignId })}
          onEditLocation={(location) => setEditor({ type: 'location', campaignId: location.campaign_id, location })}
          onAddShop={(locationId) => setEditor({ type: 'shop', locationId })}
          onEditShop={(shop) => setEditor({ type: 'shop', locationId: shop.location_id, shop })}
          onDeleteCampaign={(campaign) => void deleteCampaign(campaign)}
          onDeleteLocation={(location) => void deleteLocation(location)}
          onDeleteShop={(shop) => void deleteShop(shop)}
          onCancelEditor={() => setEditor(null)}
          onSaved={finishSave}
        />
      )}
      {catalogOpen && <ItemCatalogManager userId={userId} onClose={() => setCatalogOpen(false)} />}
    </section>
  )
}

function JoinRequestQueue({
  requests,
  campaigns,
  characters,
  profiles,
  reviewingRequest,
  onReview,
}: {
  requests: JoinRequest[]
  campaigns: Campaign[]
  characters: RequestCharacter[]
  profiles: RequestProfile[]
  reviewingRequest: string
  onReview: (request: JoinRequest, status: 'accepted' | 'rejected') => void
}) {
  return (
    <section className="join-request-queue" aria-labelledby="join-requests-heading">
      <div className="join-request-heading">
        <h3 id="join-requests-heading">Join requests</h3>
        <span className={requests.length > 0 ? 'request-count has-requests' : 'request-count'}>
          {requests.length}
        </span>
      </div>

      {requests.length === 0 ? (
        <p className="no-requests">No characters are waiting for campaign approval.</p>
      ) : (
        <div className="join-request-list">
          {requests.map((request) => {
            const campaign = campaigns.find((entry) => entry.id === request.campaign_id)
            const character = characters.find((entry) => entry.id === request.character_id)
            const profile = profiles.find((entry) => entry.id === character?.owner_id)
            const requestKey = `${request.campaign_id}:${request.character_id}`
            const submitting = reviewingRequest === requestKey

            return (
              <article className="join-request-card" key={requestKey}>
                <div>
                  <p className="request-character">{character?.name ?? 'Unknown character'}</p>
                  <p className="request-details">
                    <strong>{profile?.username ?? 'Unknown player'}</strong>
                    {' wants to join '}
                    <strong>{campaign?.name ?? 'Unknown campaign'}</strong>
                  </p>
                  <p className="request-date">Requested {formatRequestDate(request.requested_at)}</p>
                </div>
                <div className="request-actions">
                  <button
                    className="button request-button accept"
                    type="button"
                    disabled={submitting}
                    onClick={() => onReview(request, 'accepted')}
                  >
                    {submitting ? 'Working…' : 'Accept'}
                  </button>
                  <button
                    className="button request-button reject"
                    type="button"
                    disabled={submitting}
                    onClick={() => onReview(request, 'rejected')}
                  >
                    Reject
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function DmCampaignBrowser({
  campaign,
  locations,
  shops,
  selectedLocationId,
  editor,
  userId,
  onSelectLocation,
  onBack,
  onClose,
  onEditCampaign,
  onAddLocation,
  onEditLocation,
  onAddShop,
  onEditShop,
  onDeleteCampaign,
  onDeleteLocation,
  onDeleteShop,
  onCancelEditor,
  onSaved,
}: {
  campaign: Campaign
  locations: Location[]
  shops: Shop[]
  selectedLocationId: string | null
  editor: EditorState
  userId: string
  onSelectLocation: (locationId: string) => void
  onBack: () => void
  onClose: () => void
  onEditCampaign: (campaign: Campaign) => void
  onAddLocation: (campaignId: string) => void
  onEditLocation: (location: Location) => void
  onAddShop: (locationId: string) => void
  onEditShop: (shop: Shop) => void
  onDeleteCampaign: (campaign: Campaign) => void
  onDeleteLocation: (location: Location) => void
  onDeleteShop: (shop: Shop) => void
  onCancelEditor: () => void
  onSaved: () => Promise<void>
}) {
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null)
  const [showPurchaseHistory, setShowPurchaseHistory] = useState(false)
  const selectedLocation = locations.find((location) => location.id === selectedLocationId) ?? null
  const locationShops = selectedLocation
    ? shops.filter((shop) => shop.location_id === selectedLocation.id)
    : []
  const selectedShop = locationShops.find((shop) => shop.id === selectedShopId) ?? null

  const goBack = useCallback(() => {
    if (showPurchaseHistory) setShowPurchaseHistory(false)
    else if (selectedShopId) setSelectedShopId(null)
    else onBack()
  }, [onBack, selectedShopId, showPurchaseHistory])

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
      goBack()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goBack])

  return (
    <div className="campaign-browser-backdrop" role="presentation">
      <section
        className="campaign-browser dm-campaign-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dm-campaign-browser-title"
      >
        <header className="campaign-browser-header">
          <button className="browser-back-button" type="button" onClick={goBack}>
            {showPurchaseHistory ? '← Shop' : selectedShop ? '← Location' : selectedLocation ? '← Campaign' : '← Workshop'}
          </button>
          <div className="browser-breadcrumb" id="dm-campaign-browser-title">
            <button type="button" onClick={() => {
              setShowPurchaseHistory(false)
              setSelectedShopId(null)
              if (selectedLocation) onBack()
            }}>{campaign.name}</button>
            {selectedLocation && (
              <>
                <span aria-hidden="true">—</span>
                {selectedShop ? (
                  <button type="button" onClick={() => {
                    setShowPurchaseHistory(false)
                    setSelectedShopId(null)
                  }}>{selectedLocation.name}</button>
                ) : (
                  <strong>{selectedLocation.name}</strong>
                )}
              </>
            )}
            {selectedShop && (
              <>
                <span aria-hidden="true">—</span>
                {showPurchaseHistory ? (
                  <button type="button" onClick={() => setShowPurchaseHistory(false)}>{selectedShop.name}</button>
                ) : (
                  <strong>{selectedShop.name}</strong>
                )}
              </>
            )}
            {showPurchaseHistory && (
              <>
                <span aria-hidden="true">—</span>
                <strong>Purchase history</strong>
              </>
            )}
          </div>
          <button className="browser-close-button" type="button" onClick={onClose} aria-label="Close campaign editor">
            ×
          </button>
        </header>

        <div className="campaign-browser-content">
          {selectedShop && selectedLocation && showPurchaseHistory ? (
            <DmPurchaseHistoryLayer shop={selectedShop} location={selectedLocation} />
          ) : selectedShop && selectedLocation ? (
            <DmShopLayer
              shop={selectedShop}
              location={selectedLocation}
              onViewPurchaseHistory={() => setShowPurchaseHistory(true)}
            />
          ) : selectedLocation ? (
            <DmLocationLayer
              location={selectedLocation}
              shops={locationShops}
              editor={editor}
              onAddShop={() => onAddShop(selectedLocation.id)}
              onEditLocation={() => onEditLocation(selectedLocation)}
              onDeleteLocation={() => onDeleteLocation(selectedLocation)}
              onEditShop={onEditShop}
              onDeleteShop={onDeleteShop}
              onSelectShop={setSelectedShopId}
              onCancelEditor={onCancelEditor}
              onSaved={onSaved}
            />
          ) : (
            <DmCampaignLayer
              campaign={campaign}
              locations={locations}
              editor={editor}
              userId={userId}
              shops={shops}
              onSelectLocation={onSelectLocation}
              onEditCampaign={() => onEditCampaign(campaign)}
              onDeleteCampaign={() => onDeleteCampaign(campaign)}
              onAddLocation={() => onAddLocation(campaign.id)}
              onEditLocation={onEditLocation}
              onDeleteLocation={onDeleteLocation}
              onCancelEditor={onCancelEditor}
              onSaved={onSaved}
            />
          )}
        </div>

        <footer className="campaign-browser-footer">
          Press <kbd>Esc</kbd> to {showPurchaseHistory ? 'return to the shop' : selectedShop ? 'return to the location' : editor ? 'cancel editing' : selectedLocation ? 'return to the campaign' : 'close'}.
        </footer>
      </section>
    </div>
  )
}

function DmCampaignLayer({
  campaign,
  locations,
  shops,
  editor,
  userId,
  onSelectLocation,
  onEditCampaign,
  onDeleteCampaign,
  onAddLocation,
  onEditLocation,
  onDeleteLocation,
  onCancelEditor,
  onSaved,
}: {
  campaign: Campaign
  locations: Location[]
  shops: Shop[]
  editor: EditorState
  userId: string
  onSelectLocation: (locationId: string) => void
  onEditCampaign: () => void
  onDeleteCampaign: () => void
  onAddLocation: () => void
  onEditLocation: (location: Location) => void
  onDeleteLocation: (location: Location) => void
  onCancelEditor: () => void
  onSaved: () => Promise<void>
}) {
  return (
    <div className="browser-view dm-browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">DM campaign editor</p>
        <div className="dm-browser-title-line">
          <div>
            <h2>{campaign.name}</h2>
            <span className={campaign.is_listed ? 'visibility-badge listed' : 'visibility-badge'}>
              {campaign.is_listed ? 'Listed' : 'Unlisted'}
            </span>
          </div>
          <EntityActions onEdit={onEditCampaign} onDelete={onDeleteCampaign} />
        </div>
        {campaign.description && <p>{campaign.description}</p>}
      </div>

      {editor?.type === 'campaign' && editor.campaign?.id === campaign.id && (
        <CampaignEditor campaign={campaign} userId={userId} onCancel={onCancelEditor} onSaved={onSaved} />
      )}

      <div className="dm-browser-section-heading">
        <h3 className="browser-list-heading">Locations</h3>
        {!editor && (
          <button className="button button-primary button-inline" type="button" onClick={onAddLocation}>Add location</button>
        )}
      </div>

      {editor?.type === 'location' && editor.campaignId === campaign.id && !editor.location && (
        <LocationEditor campaignId={campaign.id} onCancel={onCancelEditor} onSaved={onSaved} />
      )}

      {locations.length === 0 && !editor ? (
        <div className="browser-empty-state">
          <h4>No locations yet</h4>
          <p>Add the first location to begin building this campaign's shopping directory.</p>
        </div>
      ) : (
        <div className="browser-card-list dm-browser-card-list">
          {locations.map((location) => {
            const shopCount = shops.filter((shop) => shop.location_id === location.id).length
            const editing = editor?.type === 'location' && editor.location?.id === location.id

            return (
              <div className="dm-browser-card-wrap" key={location.id}>
                <button className="browser-entity-card" type="button" onClick={() => onSelectLocation(location.id)}>
                  <div className="location-card-badges">
                    <span className="classification-badge">{titleCase(location.classification)}</span>
                    <LocationAccessBadge accessible={location.is_accessible} />
                  </div>
                  <strong>{location.name}</strong>
                  <span>{location.description || 'No location description has been provided.'}</span>
                  <small>{shopCount} {shopCount === 1 ? 'shop' : 'shops'} · Manage location →</small>
                </button>
                <div className="dm-card-actions">
                  <button className="text-button" type="button" onClick={() => onEditLocation(location)}>Edit</button>
                  <button className="text-button text-button-danger" type="button" onClick={() => onDeleteLocation(location)}>Delete</button>
                </div>
                {editing && (
                  <LocationEditor campaignId={campaign.id} location={location} onCancel={onCancelEditor} onSaved={onSaved} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DmLocationLayer({
  location,
  shops,
  editor,
  onAddShop,
  onEditLocation,
  onDeleteLocation,
  onEditShop,
  onDeleteShop,
  onSelectShop,
  onCancelEditor,
  onSaved,
}: {
  location: Location
  shops: Shop[]
  editor: EditorState
  onAddShop: () => void
  onEditLocation: () => void
  onDeleteLocation: () => void
  onEditShop: (shop: Shop) => void
  onDeleteShop: (shop: Shop) => void
  onSelectShop: (shopId: string) => void
  onCancelEditor: () => void
  onSaved: () => Promise<void>
}) {
  const [generating, setGenerating] = useState('')
  const [generationMessage, setGenerationMessage] = useState('')
  const [generationError, setGenerationError] = useState('')
  const [changingAccessibility, setChangingAccessibility] = useState(false)

  async function toggleAccessibility() {
    const nextAccessible = !location.is_accessible
    const confirmed = window.confirm(
      nextAccessible
        ? `Mark ${location.name} as Accessible? Players will immediately see the current live inventories and may purchase again.`
        : `Mark ${location.name} as Out of Reach? Players will keep seeing a frozen snapshot of the current inventories, but purchasing will be locked.`,
    )
    if (!confirmed) return

    setChangingAccessibility(true)
    setGenerationMessage('')
    setGenerationError('')
    const { data, error } = await supabase.rpc('set_location_accessibility', {
      target_location_id: location.id,
      accessible: nextAccessible,
    })

    if (error || !data) {
      console.error('Could not change location accessibility:', error)
      setGenerationError(error?.message ?? `${location.name}'s accessibility could not be changed.`)
    } else {
      const result = data as { snapshot_count: number }
      await onSaved()
      setGenerationMessage(
        nextAccessible
          ? `${location.name} is Accessible. Players can now see current inventories and make purchases.`
          : `${location.name} is Out of Reach. ${result.snapshot_count} last-known inventory ${result.snapshot_count === 1 ? 'entry was' : 'entries were'} frozen for players.`,
      )
    }
    setChangingAccessibility(false)
  }

  async function generateShop(shop: Shop) {
    setGenerating(shop.id)
    setGenerationMessage('')
    setGenerationError('')
    const { data, error } = await supabase.rpc('generate_shop_inventory', { target_shop_id: shop.id })

    if (error || !data) {
      console.error('Could not generate shop inventory:', error)
      setGenerationError(`${shop.name} could not be stocked. ${error?.message ?? ''}`.trim())
    } else {
      const summary = data as ShopGenerationSummary
      setGenerationMessage(generationSummaryText(summary))
    }
    setGenerating('')
  }

  async function generateLocation() {
    setGenerating(location.id)
    setGenerationMessage('')
    setGenerationError('')
    const { data, error } = await supabase.rpc('generate_location_inventory', { target_location_id: location.id })

    if (error || !data) {
      console.error('Could not generate location inventory:', error)
      setGenerationError(`${location.name} could not be stocked. ${error?.message ?? ''}`.trim())
    } else {
      const summary = data as LocationGenerationSummary
      setGenerationMessage(
        `${summary.shop_count} ${summary.shop_count === 1 ? 'shop' : 'shops'} restocked with ${summary.generated_count} inventory ${summary.generated_count === 1 ? 'entry' : 'entries'}. ${summary.rejected_count} ${summary.rejected_count === 1 ? 'slot was' : 'slots were'} left empty.`,
      )
    }
    setGenerating('')
  }

  return (
    <div className="browser-view dm-browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">{titleCase(location.classification)}</p>
        <div className="dm-browser-title-line">
          <div>
            <h2>{location.name}</h2>
            <LocationAccessBadge accessible={location.is_accessible} />
          </div>
          <EntityActions onEdit={onEditLocation} onDelete={onDeleteLocation} />
        </div>
        {location.description && <p>{location.description}</p>}
      </div>

      {editor?.type === 'location' && editor.location?.id === location.id && (
        <LocationEditor campaignId={location.campaign_id} location={location} onCancel={onCancelEditor} onSaved={onSaved} />
      )}

      <div className="dm-browser-section-heading">
        <h3 className="browser-list-heading">Shops</h3>
        {!editor && (
          <div className="dm-browser-heading-actions">
            <button
              className={`button button-inline location-access-button ${location.is_accessible ? 'mark-unreachable' : 'mark-accessible'}`}
              type="button"
              disabled={Boolean(generating) || changingAccessibility}
              onClick={() => void toggleAccessibility()}
            >
              {changingAccessibility ? 'Updating…' : location.is_accessible ? 'Mark out of reach' : 'Mark accessible'}
            </button>
            <button className="button button-secondary button-inline" type="button" disabled={Boolean(generating) || changingAccessibility || shops.length === 0} onClick={() => void generateLocation()}>
              {generating === location.id ? 'Generating…' : 'Generate all inventories'}
            </button>
            <button className="button button-primary button-inline" type="button" disabled={Boolean(generating) || changingAccessibility} onClick={onAddShop}>Add shop</button>
          </div>
        )}
      </div>

      {generationMessage && <p className="message message-success" role="status">{generationMessage}</p>}
      {generationError && <p className="message message-error" role="alert">{generationError}</p>}

      {editor?.type === 'shop' && editor.locationId === location.id && !editor.shop && (
        <ShopEditor locationId={location.id} onCancel={onCancelEditor} onSaved={onSaved} />
      )}

      {shops.length === 0 && !editor ? (
        <div className="browser-empty-state">
          <h4>No shops yet</h4>
          <p>Add the first shop to this location.</p>
        </div>
      ) : (
        <div className="browser-card-list dm-browser-card-list">
          {shops.map((shop) => {
            const editing = editor?.type === 'shop' && editor.shop?.id === shop.id
            return (
              <div className="dm-browser-card-wrap shop-management-card" key={shop.id}>
                <button className="browser-entity-card" type="button" onClick={() => onSelectShop(shop.id)}>
                  <span className="classification-badge shop-classification">{titleCase(shop.classification)}</span>
                  <strong>{shop.name}</strong>
                  <span>{shop.description || 'No shop description has been provided.'}</span>
                  <small>Enter shop →</small>
                </button>
                <div className="dm-card-actions">
                  <button className="text-button add-button" type="button" disabled={Boolean(generating)} onClick={() => void generateShop(shop)}>
                    {generating === shop.id ? 'Generating…' : 'Generate inventory'}
                  </button>
                  <button className="text-button" type="button" onClick={() => onEditShop(shop)}>Edit</button>
                  <button className="text-button text-button-danger" type="button" onClick={() => onDeleteShop(shop)}>Delete</button>
                </div>
                {editing && (
                  <ShopEditor locationId={location.id} shop={shop} onCancel={onCancelEditor} onSaved={onSaved} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DmShopLayer({
  shop,
  location,
  onViewPurchaseHistory,
}: {
  shop: Shop
  location: Location
  onViewPurchaseHistory: () => void
}) {
  const [addingManualItem, setAddingManualItem] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  async function generateInventory() {
    setGenerating(true)
    setMessage('')
    setErrorMessage('')
    const { data, error } = await supabase.rpc('generate_shop_inventory', { target_shop_id: shop.id })

    if (error || !data) {
      console.error('Could not generate shop inventory:', error)
      setErrorMessage(`${shop.name} could not be stocked. ${error?.message ?? ''}`.trim())
    } else {
      setMessage(generationSummaryText(data as ShopGenerationSummary))
    }
    setGenerating(false)
  }

  return (
    <div className="browser-view dm-browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">{titleCase(shop.classification)} shop · {titleCase(location.classification)}</p>
        <h2>{shop.name}</h2>
        {shop.description && <p>{shop.description}</p>}
      </div>

      <div className="dm-browser-section-heading">
        <h3 className="browser-list-heading">Noteworthy items available</h3>
        <div className="dm-browser-heading-actions">
          <button className="button button-secondary button-inline" type="button" disabled={generating || addingManualItem} onClick={() => void generateInventory()}>
            {generating ? 'Generating…' : 'Generate inventory'}
          </button>
          <button className="button button-primary button-inline" type="button" disabled={generating || addingManualItem} onClick={() => setAddingManualItem(true)}>
            Add manual item
          </button>
          <button className="button button-secondary button-inline" type="button" disabled={generating || addingManualItem} onClick={onViewPurchaseHistory}>
            Purchase history
          </button>
        </div>
      </div>

      {message && <p className="message message-success" role="status">{message}</p>}
      {errorMessage && <p className="message message-error" role="alert">{errorMessage}</p>}

      {addingManualItem && (
        <ManualInventoryEditor
          shopId={shop.id}
          onCancel={() => setAddingManualItem(false)}
          onAdded={(displayName) => {
            setAddingManualItem(false)
            setMessage(`${displayName} was added as manual stock and will be preserved during regeneration.`)
            setErrorMessage('')
          }}
        />
      )}

      <ShopInventory key={shop.id} shopId={shop.id} canManageManual />
    </div>
  )
}

function DmPurchaseHistoryLayer({ shop, location }: { shop: Shop; location: Location }) {
  return (
    <div className="browser-view dm-browser-view">
      <div className="browser-introduction">
        <p className="eyebrow">DM records · {titleCase(location.classification)}</p>
        <h2>Purchase history</h2>
        <p>Completed purchases from {shop.name} appear here automatically.</p>
      </div>

      <PurchaseLedger shopId={shop.id} showBuyer canReverse />
    </div>
  )
}

function ManualInventoryEditor({
  shopId,
  onCancel,
  onAdded,
}: {
  shopId: string
  onCancel: () => void
  onAdded: (displayName: string) => void
}) {
  const [catalogItems, setCatalogItems] = useState<ManualCatalogItem[]>([])
  const [itemQuery, setItemQuery] = useState('')
  const [selectedItemId, setSelectedItemId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [priceGp, setPriceGp] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [isInfinite, setIsInfinite] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let isActive = true
    void supabase
      .from('items')
      .select('id, name, classification, rarity, price_mode, fixed_price_cp')
      .eq('is_active', true)
      .order('name')
      .then((result) => {
        if (!isActive) return
        if (result.error) {
          console.error('Could not load manual inventory catalog:', result.error)
          setMessage('The item catalog could not be loaded.')
        } else {
          setCatalogItems(result.data ?? [])
        }
        setLoading(false)
      })

    return () => {
      isActive = false
    }
  }, [])

  function chooseCatalogItem(value: string) {
    setItemQuery(value)
    const selected = catalogItems.find((item) => item.name.toLowerCase() === value.trim().toLowerCase())
    setSelectedItemId(selected?.id ?? '')
    if (!selected) return
    setDisplayName(selected.name)
    setPriceGp(selected.fixed_price_cp === null ? '' : formatGpFromCopper(selected.fixed_price_cp))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const selectedItem = catalogItems.find((item) => item.id === selectedItemId)
    const numericPrice = Number(priceGp)
    const numericQuantity = Number(quantity)

    if (!selectedItem) {
      setMessage('Choose an item from the catalog suggestions.')
      return
    }
    if (!displayName.trim() || displayName.trim().length > 240) {
      setMessage('Enter a display name up to 240 characters.')
      return
    }
    if (priceGp.trim() === '' || !Number.isFinite(numericPrice) || numericPrice < 0 || Math.round(numericPrice * 100) > Number.MAX_SAFE_INTEGER) {
      setMessage('Enter a valid nonnegative price in gold pieces.')
      return
    }
    if (!Number.isInteger(numericQuantity) || numericQuantity < 1) {
      setMessage('Quantity must be a whole number of at least 1.')
      return
    }

    setSubmitting(true)
    setMessage('')
    const { error } = await supabase.from('shop_inventory').insert({
      shop_id: shopId,
      item_id: selectedItem.id,
      display_name: displayName.trim(),
      rarity: selectedItem.rarity,
      price_cp: Math.round(numericPrice * 100),
      quantity: numericQuantity,
      is_infinite: isInfinite,
      source: 'manual',
    })

    if (error) {
      console.error('Could not add manual inventory:', error)
      setMessage('The manual inventory item could not be added.')
      setSubmitting(false)
      return
    }

    onAdded(displayName.trim())
    setSubmitting(false)
  }

  return (
    <form className="entity-editor nested-entity-editor manual-inventory-editor" onSubmit={submit}>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">Manual stock</p>
          <h3>Add an item</h3>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>

      <div>
        <label htmlFor="manual-catalog-item">Catalog item</label>
        <input
          id="manual-catalog-item"
          list="manual-catalog-items"
          value={itemQuery}
          onChange={(event) => chooseCatalogItem(event.target.value)}
          placeholder={loading ? 'Loading catalog…' : 'Type an item name'}
          autoComplete="off"
          disabled={loading}
          required
        />
        <datalist id="manual-catalog-items">
          {catalogItems.map((item) => <option value={item.name} key={item.id}>{titleCase(item.classification)} · {titleCase(item.rarity)}</option>)}
        </datalist>
        <p className="field-hint">Generic items can be given a resolved name below, such as “+2 Breastplate.”</p>
      </div>

      <div>
        <label htmlFor="manual-display-name">Displayed item name</label>
        <input id="manual-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={240} required />
      </div>

      <div className="form-grid two-columns">
        <div>
          <label htmlFor="manual-price">Price (gp)</label>
          <input id="manual-price" type="number" min="0" step="0.01" value={priceGp} onChange={(event) => setPriceGp(event.target.value)} required />
        </div>
        <div>
          <label htmlFor="manual-quantity">Quantity</label>
          <input id="manual-quantity" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={isInfinite} required />
        </div>
      </div>

      <label className="checkbox-field">
        <input type="checkbox" checked={isInfinite} onChange={(event) => setIsInfinite(event.target.checked)} />
        <span>Infinite stock</span>
      </label>

      {message && <p className="message message-error" role="alert">{message}</p>}
      <div className="editor-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button-primary button-inline" type="submit" disabled={loading || submitting}>{submitting ? 'Adding…' : 'Add to shop'}</button>
      </div>
    </form>
  )
}

function EntityActions({
  onAdd,
  addLabel,
  onEdit,
  onDelete,
}: {
  onAdd?: () => void
  addLabel?: string
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="entity-actions">
      {onAdd && <button className="text-button add-button" type="button" onClick={onAdd}>{addLabel}</button>}
      <button className="text-button" type="button" onClick={onEdit}>Edit</button>
      <button className="text-button text-button-danger" type="button" onClick={onDelete}>Delete</button>
    </div>
  )
}

function CampaignEditor({
  campaign,
  userId,
  onCancel,
  onSaved,
}: {
  campaign?: Campaign
  userId: string
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(campaign?.name ?? '')
  const [description, setDescription] = useState(campaign?.description ?? '')
  const [isListed, setIsListed] = useState(campaign?.is_listed ?? true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanName = name.trim()

    if (!validateText(cleanName, description, 120)) {
      setMessage('Enter a campaign name up to 120 characters and a description up to 1,000 characters.')
      return
    }

    setSubmitting(true)
    const values = { name: cleanName, description: description.trim(), is_listed: isListed, created_by: userId }
    const { error } = campaign
      ? await supabase.from('campaigns').update(values).eq('id', campaign.id)
      : await supabase.from('campaigns').insert(values)

    await finishEditorSave(error, setMessage, onSaved, setSubmitting)
  }

  return (
    <EntityEditorShell title={campaign ? `Edit ${campaign.name}` : 'Create a campaign'} onCancel={onCancel} onSubmit={submit} submitting={submitting} submitLabel={campaign ? 'Save campaign' : 'Create campaign'} message={message}>
      <TextFields name={name} description={description} entity="campaign" onNameChange={setName} onDescriptionChange={setDescription} />
      <label className="checkbox-field visibility-checkbox">
        <input type="checkbox" checked={isListed} onChange={(event) => setIsListed(event.target.checked)} />
        <span>
          <strong>List this campaign</strong>
          <small>Players can discover it and request to join with a character.</small>
        </span>
      </label>
    </EntityEditorShell>
  )
}

function LocationEditor({
  campaignId,
  location,
  onCancel,
  onSaved,
}: {
  campaignId: string
  location?: Location
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(location?.name ?? '')
  const [description, setDescription] = useState(location?.description ?? '')
  const [classification, setClassification] = useState<LocationClassification>(location?.classification ?? 'village')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!validateText(cleanName, description, 120)) {
      setMessage('Enter a location name up to 120 characters and a description up to 1,000 characters.')
      return
    }

    setSubmitting(true)
    const values = { campaign_id: campaignId, name: cleanName, classification, description: description.trim() }
    const { error } = location
      ? await supabase.from('locations').update(values).eq('id', location.id)
      : await supabase.from('locations').insert(values)

    await finishEditorSave(error, setMessage, onSaved, setSubmitting)
  }

  return (
    <EntityEditorShell title={location ? `Edit ${location.name}` : 'Add a location'} onCancel={onCancel} onSubmit={submit} submitting={submitting} submitLabel={location ? 'Save location' : 'Add location'} message={message} nested>
      <TextFields name={name} description={description} entity="location" onNameChange={setName} onDescriptionChange={setDescription} />
      <ClassificationSelect value={classification} options={LOCATION_OPTIONS} onChange={(value) => setClassification(value as LocationClassification)} />
    </EntityEditorShell>
  )
}

function ShopEditor({
  locationId,
  shop,
  onCancel,
  onSaved,
}: {
  locationId: string
  shop?: Shop
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(shop?.name ?? '')
  const [description, setDescription] = useState(shop?.description ?? '')
  const [classification, setClassification] = useState<ShopClassification>(shop?.classification ?? 'mundane')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!validateText(cleanName, description, 120)) {
      setMessage('Enter a shop name up to 120 characters and a description up to 1,000 characters.')
      return
    }

    setSubmitting(true)
    const values = { location_id: locationId, name: cleanName, classification, description: description.trim() }
    const { error } = shop
      ? await supabase.from('shops').update(values).eq('id', shop.id)
      : await supabase.from('shops').insert(values)

    await finishEditorSave(error, setMessage, onSaved, setSubmitting)
  }

  return (
    <EntityEditorShell title={shop ? `Edit ${shop.name}` : 'Add a shop'} onCancel={onCancel} onSubmit={submit} submitting={submitting} submitLabel={shop ? 'Save shop' : 'Add shop'} message={message} nested>
      <TextFields name={name} description={description} entity="shop" onNameChange={setName} onDescriptionChange={setDescription} />
      <ClassificationSelect value={classification} options={SHOP_OPTIONS} onChange={(value) => setClassification(value as ShopClassification)} />
    </EntityEditorShell>
  )
}

function EntityEditorShell({
  title,
  onCancel,
  onSubmit,
  submitting,
  submitLabel,
  message,
  nested = false,
  children,
}: {
  title: string
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  submitting: boolean
  submitLabel: string
  message: string
  nested?: boolean
  children: ReactNode
}) {
  return (
    <form className={nested ? 'entity-editor nested-entity-editor' : 'entity-editor card'} onSubmit={onSubmit}>
      <div className="editor-heading">
        <h3>{title}</h3>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>
      {children}
      {message && <p className="message message-error" role="alert">{message}</p>}
      <div className="editor-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button-primary button-inline" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

function TextFields({
  name,
  description,
  entity,
  onNameChange,
  onDescriptionChange,
}: {
  name: string
  description: string
  entity: string
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
}) {
  return (
    <div className="entity-form-grid">
      <div>
        <label htmlFor={`${entity}-name`}>Name</label>
        <input id={`${entity}-name`} type="text" value={name} onChange={(event) => onNameChange(event.target.value)} maxLength={120} autoFocus required />
      </div>
      <div>
        <label htmlFor={`${entity}-description`}>Short description</label>
        <textarea id={`${entity}-description`} value={description} onChange={(event) => onDescriptionChange(event.target.value)} maxLength={1000} rows={3} />
        <span className="character-counter">{description.length}/1000</span>
      </div>
    </div>
  )
}

function ClassificationSelect({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="classification-field">
      <label htmlFor={`classification-${value}`}>Classification</label>
      <select id={`classification-${value}`} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select>
    </div>
  )
}

async function finishEditorSave(
  error: { code?: string; message: string } | null,
  setMessage: (message: string) => void,
  onSaved: () => Promise<void>,
  setSubmitting: (submitting: boolean) => void,
) {
  if (error) {
    console.error('Could not save hierarchy item:', error)
    setMessage(error.code === '23505' ? 'That name is already used here.' : 'This item could not be saved. Please try again.')
    setSubmitting(false)
    return
  }

  await onSaved()
  setSubmitting(false)
}

function validateText(name: string, description: string, maxNameLength: number) {
  return name.length >= 1 && name.length <= maxNameLength && description.length <= 1000
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

function generationSummaryText(summary: ShopGenerationSummary) {
  const noteworthyCount = summary.generated_count - summary.infinite_count
  const infiniteText = summary.infinite_count > 0
    ? ` plus ${summary.infinite_count} infinite healing ${summary.infinite_count === 1 ? 'stock entry' : 'stock entries'}`
    : ''
  return `${summary.shop_name} was restocked with ${noteworthyCount} noteworthy ${noteworthyCount === 1 ? 'item' : 'items'}${infiniteText}. ${summary.rejected_count} ${summary.rejected_count === 1 ? 'slot was' : 'slots were'} left empty.`
}

function formatGpFromCopper(copperPieces: number) {
  return (copperPieces / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function formatRequestDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}
