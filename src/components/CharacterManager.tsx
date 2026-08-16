import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { PurchaseHistoryDialog } from './PurchaseHistory'

type Character = {
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

type CharacterDraft = {
  name: string
  persuasionBonus: string
  deceptionBonus: string
  intimidationBonus: string
  hasGuidance: boolean
  hasAdvantage: boolean
  hasReliableTalent: boolean
  platinumPieces: string
  goldPieces: string
  silverPieces: string
  copperPieces: string
}

const EMPTY_DRAFT: CharacterDraft = {
  name: '',
  persuasionBonus: '0',
  deceptionBonus: '0',
  intimidationBonus: '0',
  hasGuidance: false,
  hasAdvantage: false,
  hasReliableTalent: false,
  platinumPieces: '0',
  goldPieces: '0',
  silverPieces: '0',
  copperPieces: '0',
}

export function CharacterManager({
  userId,
  selectable = false,
  selectedCharacterId = null,
  onSelectCharacter,
}: {
  userId: string
  selectable?: boolean
  selectedCharacterId?: string | null
  onSelectCharacter?: (characterId: string | null) => void
}) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)
  const [historyCharacter, setHistoryCharacter] = useState<Character | null>(null)

  const fetchCharacters = useCallback(() => {
    return supabase
      .from('characters')
      .select(`
        id,
        name,
        persuasion_bonus,
        deception_bonus,
        intimidation_bonus,
        has_guidance,
        has_advantage,
        has_reliable_talent,
        platinum_pieces,
        gold_pieces,
        silver_pieces,
        copper_pieces,
        wallet_value_cp
      `)
      .eq('owner_id', userId)
      .order('created_at', { ascending: true })
  }, [userId])

  useEffect(() => {
    let isActive = true

    void fetchCharacters().then(({ data, error }) => {
      if (!isActive) return

      if (error) {
        console.error('Could not load characters:', error)
        setLoadError('Your characters could not be loaded. Please try refreshing the page.')
      } else {
        setCharacters(data ?? [])
      }

      setLoading(false)
    })

    return () => {
      isActive = false
    }
  }, [fetchCharacters])

  const refreshCharacters = useCallback(async () => {
    const { data, error } = await fetchCharacters()

    if (error) {
      console.error('Could not refresh characters:', error)
      setLoadError('Your updated character list could not be loaded.')
      return false
    }

    setCharacters(data ?? [])
    setLoadError('')
    return true
  }, [fetchCharacters])

  useEffect(() => {
    const channel = supabase
      .channel(`character-wallet-updates-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'characters',
          filter: `owner_id=eq.${userId}`,
        },
        () => void refreshCharacters(),
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [refreshCharacters, userId])

  function openCreateForm() {
    setEditingCharacter(null)
    setEditorOpen(true)
  }

  function openEditForm(character: Character) {
    setEditingCharacter(character)
    setEditorOpen(true)
  }

  function closeEditor() {
    setEditorOpen(false)
    setEditingCharacter(null)
  }

  async function deleteCharacter(character: Character) {
    const confirmed = window.confirm(
      `Delete ${character.name}? This cannot be undone.`,
    )

    if (!confirmed) return

    const { error } = await supabase
      .from('characters')
      .delete()
      .eq('id', character.id)

    if (error) {
      console.error('Could not delete character:', error)
      setLoadError(`${character.name} could not be deleted.`)
      return
    }

    if (selectedCharacterId === character.id) {
      onSelectCharacter?.(null)
    }

    await refreshCharacters()
  }

  return (
    <section className="character-section" aria-labelledby="characters-heading">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Player characters</p>
          <h2 id="characters-heading">Your characters</h2>
        </div>
        {!editorOpen && (
          <button className="button button-primary button-inline" type="button" onClick={openCreateForm}>
            Create character
          </button>
        )}
      </div>

      {editorOpen && (
        <CharacterEditor
          character={editingCharacter}
          userId={userId}
          onCancel={closeEditor}
          onSaved={async () => {
            const refreshed = await refreshCharacters()
            if (refreshed) closeEditor()
          }}
        />
      )}

      {loadError && <p className="message message-error">{loadError}</p>}

      {loading ? (
        <p className="character-list-message">Loading characters…</p>
      ) : characters.length === 0 && !editorOpen ? (
        <div className="empty-state">
          <h3>No adventurers yet</h3>
          <p>Create your first character to prepare for campaign invitations and shopping trips.</p>
          <button className="button button-secondary" type="button" onClick={openCreateForm}>
            Create your first character
          </button>
        </div>
      ) : (
        <div className="character-grid">
          {characters.map((character) => (
            <CharacterCard
              key={character.id}
              character={character}
              selectable={selectable}
              selected={selectedCharacterId === character.id}
              onSelect={() => onSelectCharacter?.(character.id)}
              onHistory={() => setHistoryCharacter(character)}
              onEdit={() => openEditForm(character)}
              onDelete={() => void deleteCharacter(character)}
            />
          ))}
        </div>
      )}
      {historyCharacter && (
        <PurchaseHistoryDialog
          characterId={historyCharacter.id}
          characterName={historyCharacter.name}
          onClose={() => setHistoryCharacter(null)}
        />
      )}
    </section>
  )
}

function CharacterCard({
  character,
  selectable,
  selected,
  onSelect,
  onHistory,
  onEdit,
  onDelete,
}: {
  character: Character
  selectable: boolean
  selected: boolean
  onSelect: () => void
  onHistory: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const traits = [
    character.has_guidance && 'Guidance',
    character.has_advantage && 'Advantage',
    character.has_reliable_talent && 'Reliable Talent',
  ].filter(Boolean) as string[]

  return (
    <article className={selected ? 'character-card character-card-selected' : 'character-card'}>
      <div className="character-card-header">
        <div>
          <p className="character-kicker">Character</p>
          <h3>{character.name}</h3>
        </div>
        <div className="character-actions">
          <button className="text-button" type="button" onClick={onHistory}>History</button>
          <button className="text-button" type="button" onClick={onEdit}>Edit</button>
          <button className="text-button text-button-danger" type="button" onClick={onDelete}>Delete</button>
        </div>
      </div>

      {selectable && (
        <button
          className={selected ? 'character-select-button selected' : 'character-select-button'}
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {selected ? '✓ Selected for campaign' : 'Select for campaign'}
        </button>
      )}

      <div className="skill-grid" aria-label="Haggling skill bonuses">
        <div>
          <span>Persuasion</span>
          <strong>{formatModifier(character.persuasion_bonus)}</strong>
        </div>
        <div>
          <span>Deception</span>
          <strong>{formatModifier(character.deception_bonus)}</strong>
        </div>
        <div>
          <span>Intimidation</span>
          <strong>{formatModifier(character.intimidation_bonus)}</strong>
        </div>
      </div>

      <div className="trait-list" aria-label="Haggling traits">
        {traits.length > 0
          ? traits.map((trait) => <span className="trait-badge" key={trait}>{trait}</span>)
          : <span className="muted-text">No special haggling traits</span>}
      </div>

      <div className="wallet-summary">
        <div className="wallet-heading">
          <span>Wallet</span>
          <strong>{formatGoldValue(character.wallet_value_cp)} gp total</strong>
        </div>
        <dl className="coin-list">
          <div><dt>PP</dt><dd>{character.platinum_pieces}</dd></div>
          <div><dt>GP</dt><dd>{character.gold_pieces}</dd></div>
          <div><dt>SP</dt><dd>{character.silver_pieces}</dd></div>
          <div><dt>CP</dt><dd>{character.copper_pieces}</dd></div>
        </dl>
      </div>
    </article>
  )
}

function CharacterEditor({
  character,
  userId,
  onCancel,
  onSaved,
}: {
  character: Character | null
  userId: string
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<CharacterDraft>(() => characterToDraft(character))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  function updateDraft<Key extends keyof CharacterDraft>(key: Key, value: CharacterDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')

    const name = draft.name.trim()
    const persuasionBonus = parseWholeNumber(draft.persuasionBonus)
    const deceptionBonus = parseWholeNumber(draft.deceptionBonus)
    const intimidationBonus = parseWholeNumber(draft.intimidationBonus)
    const platinumPieces = parseWholeNumber(draft.platinumPieces)
    const goldPieces = parseWholeNumber(draft.goldPieces)
    const silverPieces = parseWholeNumber(draft.silverPieces)
    const copperPieces = parseWholeNumber(draft.copperPieces)

    if (!name || name.length > 100) {
      setMessage('Enter a character name between 1 and 100 characters.')
      return
    }

    if (
      !isInRange(persuasionBonus, -50, 50)
      || !isInRange(deceptionBonus, -50, 50)
      || !isInRange(intimidationBonus, -50, 50)
    ) {
      setMessage('Skill bonuses must be whole numbers between -50 and +50.')
      return
    }

    if ([platinumPieces, goldPieces, silverPieces, copperPieces].some((amount) => !isInRange(amount, 0))) {
      setMessage('Coin amounts must be whole numbers of zero or greater.')
      return
    }

    const values = {
      owner_id: userId,
      name,
      persuasion_bonus: persuasionBonus,
      deception_bonus: deceptionBonus,
      intimidation_bonus: intimidationBonus,
      has_guidance: draft.hasGuidance,
      has_advantage: draft.hasAdvantage,
      has_reliable_talent: draft.hasReliableTalent,
      platinum_pieces: platinumPieces,
      gold_pieces: goldPieces,
      silver_pieces: silverPieces,
      copper_pieces: copperPieces,
    }

    setSubmitting(true)

    const { error } = character
      ? await supabase.from('characters').update(values).eq('id', character.id)
      : await supabase.from('characters').insert(values)

    if (error) {
      console.error('Could not save character:', error)
      setMessage(
        error.code === '23505'
          ? 'You already have a character with that name.'
          : 'That character could not be saved. Please check the values and try again.',
      )
      setSubmitting(false)
      return
    }

    await onSaved()
    setSubmitting(false)
  }

  return (
    <form className="character-editor card" onSubmit={handleSubmit}>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">{character ? 'Update adventurer' : 'New adventurer'}</p>
          <h3>{character ? `Edit ${character.name}` : 'Create a character'}</h3>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>

      <div className="form-section">
        <label htmlFor="character-name">Character name</label>
        <input
          id="character-name"
          type="text"
          value={draft.name}
          onChange={(event) => updateDraft('name', event.target.value)}
          maxLength={100}
          autoFocus
          required
        />
      </div>

      <fieldset>
        <legend>Haggling skills</legend>
        <div className="form-grid three-columns">
          <NumberField
            id="persuasion-bonus"
            label="Persuasion bonus"
            value={draft.persuasionBonus}
            min={-50}
            max={50}
            onChange={(value) => updateDraft('persuasionBonus', value)}
          />
          <NumberField
            id="deception-bonus"
            label="Deception bonus"
            value={draft.deceptionBonus}
            min={-50}
            max={50}
            onChange={(value) => updateDraft('deceptionBonus', value)}
          />
          <NumberField
            id="intimidation-bonus"
            label="Intimidation bonus"
            value={draft.intimidationBonus}
            min={-50}
            max={50}
            onChange={(value) => updateDraft('intimidationBonus', value)}
          />
        </div>

        <div className="checkbox-grid">
          <CheckboxField
            label="Guidance"
            checked={draft.hasGuidance}
            onChange={(checked) => updateDraft('hasGuidance', checked)}
          />
          <CheckboxField
            label="Advantage"
            checked={draft.hasAdvantage}
            onChange={(checked) => updateDraft('hasAdvantage', checked)}
          />
          <CheckboxField
            label="Reliable Talent"
            checked={draft.hasReliableTalent}
            onChange={(checked) => updateDraft('hasReliableTalent', checked)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Wallet</legend>
        <p className="fieldset-help">Enter the number of coins currently carried by this character.</p>
        <div className="form-grid four-columns">
          <NumberField id="platinum-pieces" label="Platinum (pp)" value={draft.platinumPieces} min={0} onChange={(value) => updateDraft('platinumPieces', value)} />
          <NumberField id="gold-pieces" label="Gold (gp)" value={draft.goldPieces} min={0} onChange={(value) => updateDraft('goldPieces', value)} />
          <NumberField id="silver-pieces" label="Silver (sp)" value={draft.silverPieces} min={0} onChange={(value) => updateDraft('silverPieces', value)} />
          <NumberField id="copper-pieces" label="Copper (cp)" value={draft.copperPieces} min={0} onChange={(value) => updateDraft('copperPieces', value)} />
        </div>
      </fieldset>

      {message && <p className="message message-error" role="alert">{message}</p>}

      <div className="editor-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button-primary button-inline" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : character ? 'Save changes' : 'Create character'}
        </button>
      </div>
    </form>
  )
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  label: string
  value: string
  min: number
  max?: number
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </div>
  )
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="checkbox-field">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function characterToDraft(character: Character | null): CharacterDraft {
  if (!character) return EMPTY_DRAFT

  return {
    name: character.name,
    persuasionBonus: String(character.persuasion_bonus),
    deceptionBonus: String(character.deception_bonus),
    intimidationBonus: String(character.intimidation_bonus),
    hasGuidance: character.has_guidance,
    hasAdvantage: character.has_advantage,
    hasReliableTalent: character.has_reliable_talent,
    platinumPieces: String(character.platinum_pieces),
    goldPieces: String(character.gold_pieces),
    silverPieces: String(character.silver_pieces),
    copperPieces: String(character.copper_pieces),
  }
}

function parseWholeNumber(value: string) {
  const number = Number(value)
  return Number.isInteger(number) ? number : Number.NaN
}

function isInRange(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

function formatModifier(value: number) {
  return value >= 0 ? `+${value}` : String(value)
}

function formatGoldValue(copperPieces: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
    Number(copperPieces) / 100,
  )
}
