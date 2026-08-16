import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'

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
}

type Shop = {
  id: string
  location_id: string
  name: string
  classification: ShopClassification
  description: string
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
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set())
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<EditorState>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [reviewingRequest, setReviewingRequest] = useState('')

  const fetchHierarchy = useCallback(async () => {
    const [campaignResult, locationResult, shopResult, requestResult, characterResult, profileResult] = await Promise.all([
      supabase.from('campaigns').select('id, name, description, is_listed').order('name'),
      supabase.from('locations').select('id, campaign_id, name, classification, description').order('display_order').order('name'),
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

  function toggleExpanded(id: string, entity: 'campaign' | 'location') {
    const setter = entity === 'campaign' ? setExpandedCampaigns : setExpandedLocations

    setter((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function deleteCampaign(campaign: Campaign) {
    const confirmed = window.confirm(
      `Delete the campaign “${campaign.name}”? All of its locations, shops, and membership requests will also be deleted. This cannot be undone.`,
    )
    if (!confirmed) return

    const { error } = await supabase.from('campaigns').delete().eq('id', campaign.id)
    await handleDeleteResult(error, `${campaign.name} could not be deleted.`)
  }

  async function deleteLocation(location: Location) {
    const confirmed = window.confirm(
      `Delete the location “${location.name}”? Every shop in this location will also be deleted. This cannot be undone.`,
    )
    if (!confirmed) return

    const { error } = await supabase.from('locations').delete().eq('id', location.id)
    await handleDeleteResult(error, `${location.name} could not be deleted.`)
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
      return
    }

    await refreshHierarchy()
  }

  async function finishSave(expand?: { campaignId?: string; locationId?: string }) {
    const refreshed = await refreshHierarchy()
    if (!refreshed) return

    if (expand?.campaignId) {
      setExpandedCampaigns((current) => new Set(current).add(expand.campaignId as string))
    }
    if (expand?.locationId) {
      setExpandedLocations((current) => new Set(current).add(expand.locationId as string))
    }
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
          <button className="button button-primary button-inline" type="button" onClick={() => setEditor({ type: 'campaign' })}>
            Create campaign
          </button>
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
            const expanded = expandedCampaigns.has(campaign.id)

            return (
              <article className="campaign-panel" key={campaign.id}>
                <div className="entity-row campaign-row">
                  <button
                    className="expand-button"
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${campaign.name}`}
                    onClick={() => toggleExpanded(campaign.id, 'campaign')}
                  >
                    {expanded ? '−' : '+'}
                  </button>
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
                      onAdd={() => {
                        setExpandedCampaigns((current) => new Set(current).add(campaign.id))
                        setEditor({ type: 'location', campaignId: campaign.id })
                      }}
                      addLabel="Add location"
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

                {expanded && (
                  <div className="location-list">
                    {editor?.type === 'location' && editor.campaignId === campaign.id && !editor.location && (
                      <LocationEditor
                        campaignId={campaign.id}
                        onCancel={() => setEditor(null)}
                        onSaved={() => finishSave({ campaignId: campaign.id })}
                      />
                    )}

                    {campaignLocations.length === 0 && !(editor?.type === 'location' && editor.campaignId === campaign.id) ? (
                      <p className="nested-empty">No locations have been added to this campaign.</p>
                    ) : campaignLocations.map((location) => (
                      <LocationPanel
                        key={location.id}
                        location={location}
                        shops={shops.filter((shop) => shop.location_id === location.id)}
                        expanded={expandedLocations.has(location.id)}
                        editor={editor}
                        onToggle={() => toggleExpanded(location.id, 'location')}
                        onAddShop={() => {
                          setExpandedLocations((current) => new Set(current).add(location.id))
                          setEditor({ type: 'shop', locationId: location.id })
                        }}
                        onEdit={() => setEditor({ type: 'location', campaignId: campaign.id, location })}
                        onDelete={() => void deleteLocation(location)}
                        onCancelEditor={() => setEditor(null)}
                        onLocationSaved={() => finishSave({ campaignId: campaign.id })}
                        onShopSaved={() => finishSave({ campaignId: campaign.id, locationId: location.id })}
                        onEditShop={(shop) => setEditor({ type: 'shop', locationId: location.id, shop })}
                        onDeleteShop={(shop) => void deleteShop(shop)}
                      />
                    ))}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
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

function LocationPanel({
  location,
  shops,
  expanded,
  editor,
  onToggle,
  onAddShop,
  onEdit,
  onDelete,
  onCancelEditor,
  onLocationSaved,
  onShopSaved,
  onEditShop,
  onDeleteShop,
}: {
  location: Location
  shops: Shop[]
  expanded: boolean
  editor: EditorState
  onToggle: () => void
  onAddShop: () => void
  onEdit: () => void
  onDelete: () => void
  onCancelEditor: () => void
  onLocationSaved: () => Promise<void>
  onShopSaved: () => Promise<void>
  onEditShop: (shop: Shop) => void
  onDeleteShop: (shop: Shop) => void
}) {
  return (
    <article className="location-panel">
      <div className="entity-row location-row">
        <button
          className="expand-button small"
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${location.name}`}
          onClick={onToggle}
        >
          {expanded ? '−' : '+'}
        </button>
        <div className="entity-copy">
          <div className="entity-title-line">
            <h4>{location.name}</h4>
            <span className="classification-badge">{titleCase(location.classification)}</span>
          </div>
          {location.description && <p>{location.description}</p>}
          <span className="entity-count">{shops.length} {shops.length === 1 ? 'shop' : 'shops'}</span>
          <EntityActions onAdd={onAddShop} addLabel="Add shop" onEdit={onEdit} onDelete={onDelete} />
        </div>
      </div>

      {editor?.type === 'location' && editor.location?.id === location.id && (
        <LocationEditor
          campaignId={location.campaign_id}
          location={location}
          onCancel={onCancelEditor}
          onSaved={onLocationSaved}
        />
      )}

      {expanded && (
        <div className="shop-list">
          {editor?.type === 'shop' && editor.locationId === location.id && !editor.shop && (
            <ShopEditor locationId={location.id} onCancel={onCancelEditor} onSaved={onShopSaved} />
          )}

          {shops.length === 0 && !(editor?.type === 'shop' && editor.locationId === location.id) ? (
            <p className="nested-empty shop-empty">No shops have been added to this location.</p>
          ) : shops.map((shop) => (
            <div key={shop.id}>
              <article className="entity-row shop-row">
                <div className="shop-marker" aria-hidden="true">◆</div>
                <div className="entity-copy">
                  <div className="entity-title-line">
                    <h5>{shop.name}</h5>
                    <span className="classification-badge shop-classification">{titleCase(shop.classification)}</span>
                  </div>
                  {shop.description && <p>{shop.description}</p>}
                  <EntityActions onEdit={() => onEditShop(shop)} onDelete={() => onDeleteShop(shop)} />
                </div>
              </article>

              {editor?.type === 'shop' && editor.shop?.id === shop.id && (
                <ShopEditor
                  locationId={location.id}
                  shop={shop}
                  onCancel={onCancelEditor}
                  onSaved={onShopSaved}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </article>
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
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatRequestDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}
