import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type MembershipStatus = 'pending' | 'accepted' | 'rejected'

type Campaign = {
  id: string
  name: string
  description: string
}

type Membership = {
  campaign_id: string
  character_id: string
  status: MembershipStatus
}

export function CampaignDirectory({ selectedCharacterId }: { selectedCharacterId: string | null }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [loading, setLoading] = useState(true)
  const [submittingCampaignId, setSubmittingCampaignId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const fetchDirectory = useCallback(async () => {
    const [campaignResult, membershipResult] = await Promise.all([
      supabase
        .from('campaigns')
        .select('id, name, description')
        .eq('is_listed', true)
        .order('name'),
      supabase
        .from('campaign_character_memberships')
        .select('campaign_id, character_id, status'),
    ])

    return {
      campaigns: campaignResult.data ?? [],
      memberships: membershipResult.data ?? [],
      error: campaignResult.error ?? membershipResult.error,
    }
  }, [])

  useEffect(() => {
    let isActive = true

    void fetchDirectory().then((result) => {
      if (!isActive) return

      if (result.error) {
        console.error('Could not load campaign directory:', result.error)
        setMessage('The campaign directory could not be loaded.')
      } else {
        setCampaigns(result.campaigns)
        setMemberships(result.memberships)
      }

      setLoading(false)
    })

    return () => {
      isActive = false
    }
  }, [fetchDirectory])

  async function refreshMemberships() {
    const { data, error } = await supabase
      .from('campaign_character_memberships')
      .select('campaign_id, character_id, status')

    if (error) {
      console.error('Could not refresh campaign requests:', error)
      setMessage('The request was sent, but its updated status could not be loaded.')
      return
    }

    setMemberships(data ?? [])
    setMessage('')
  }

  async function requestToJoin(campaignId: string) {
    if (!selectedCharacterId) {
      setMessage('Select one of your characters before requesting to join a campaign.')
      return
    }

    setSubmittingCampaignId(campaignId)
    setMessage('')

    const existing = memberships.find(
      (membership) => membership.campaign_id === campaignId
        && membership.character_id === selectedCharacterId,
    )

    if (existing?.status === 'rejected') {
      const { error: deleteError } = await supabase
        .from('campaign_character_memberships')
        .delete()
        .eq('campaign_id', campaignId)
        .eq('character_id', selectedCharacterId)

      if (deleteError) {
        console.error('Could not clear declined campaign request:', deleteError)
        setMessage('The previous request could not be cleared. Please try again.')
        setSubmittingCampaignId(null)
        return
      }
    }

    const { error } = await supabase
      .from('campaign_character_memberships')
      .insert({
        campaign_id: campaignId,
        character_id: selectedCharacterId,
        status: 'pending',
      })

    if (error) {
      console.error('Could not request campaign membership:', error)
      setMessage(
        error.code === '23505'
          ? 'That character already has a request for this campaign.'
          : 'The join request could not be sent. Please try again.',
      )
      setSubmittingCampaignId(null)
      return
    }

    await refreshMemberships()
    setSubmittingCampaignId(null)
  }

  return (
    <section className="campaign-directory" aria-labelledby="campaign-directory-heading">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Available adventures</p>
          <h2 id="campaign-directory-heading">Campaign directory</h2>
        </div>
      </div>

      <p className={selectedCharacterId ? 'directory-instruction character-ready' : 'directory-instruction'}>
        {selectedCharacterId
          ? 'Character selected. Choose a campaign and send a join request.'
          : 'Select a character on the left to request entry into a campaign.'}
      </p>

      {message && <p className="message message-error" role="alert">{message}</p>}

      {loading ? (
        <p className="hierarchy-message">Loading campaigns…</p>
      ) : campaigns.length === 0 ? (
        <div className="empty-state directory-empty-state">
          <h3>No listed campaigns</h3>
          <p>AskTheDM has not opened any campaigns for join requests yet.</p>
        </div>
      ) : (
        <div className="directory-list">
          {campaigns.map((campaign) => {
            const membership = selectedCharacterId
              ? memberships.find(
                  (entry) => entry.campaign_id === campaign.id
                    && entry.character_id === selectedCharacterId,
                )
              : undefined
            const buttonState = getJoinButtonState(membership?.status, Boolean(selectedCharacterId))

            return (
              <article className="directory-card" key={campaign.id}>
                <div className="entity-title-line">
                  <h3>{campaign.name}</h3>
                  <span className="visibility-badge listed">Listed</span>
                </div>
                {campaign.description
                  ? <p>{campaign.description}</p>
                  : <p className="muted-description">No campaign description has been provided.</p>}

                <div className="directory-actions">
                  <button
                    className={buttonState.className}
                    type="button"
                    disabled={buttonState.disabled || submittingCampaignId === campaign.id}
                    onClick={() => void requestToJoin(campaign.id)}
                  >
                    {submittingCampaignId === campaign.id ? 'Sending request…' : buttonState.label}
                  </button>
                  {membership && (
                    <span className={`membership-status status-${membership.status}`}>
                      {membership.status === 'accepted'
                        ? 'Accepted'
                        : membership.status === 'pending'
                          ? 'Awaiting DM review'
                          : 'Previous request declined'}
                    </span>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function getJoinButtonState(status: MembershipStatus | undefined, hasCharacter: boolean) {
  if (!hasCharacter) {
    return { label: 'Select a character first', disabled: true, className: 'button directory-join-button' }
  }

  if (status === 'pending') {
    return { label: 'Request pending', disabled: true, className: 'button directory-join-button pending' }
  }

  if (status === 'accepted') {
    return { label: 'Campaign joined', disabled: true, className: 'button directory-join-button accepted' }
  }

  if (status === 'rejected') {
    return { label: 'Request again', disabled: false, className: 'button directory-join-button' }
  }

  return { label: 'Request to join', disabled: false, className: 'button directory-join-button' }
}
