import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Classification = 'mundane' | 'alchemy' | 'smith' | 'magic' | 'jewelry' | 'tailored' | 'wondrous'
type Rarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary'
type SpellSchool = 'abjuration' | 'conjuration' | 'divination' | 'enchantment' | 'evocation' | 'illusion' | 'necromancy' | 'transmutation'
type EquipmentKind = 'armor' | 'weapon' | 'shield' | 'ammunition'
type CatalogMode = 'list' | 'edit' | 'import'

type CatalogItem = {
  id: string
  name: string
  description: string
  classification: Classification
  rarity: Rarity
  requires_attunement: boolean
  generated_name_template: string
  is_active: boolean
}

type SpellRule = {
  item_id: string
  minimum_spell_level: number
  maximum_spell_level: number
  allowed_schools: SpellSchool[]
}

type EquipmentRule = {
  item_id: string
  allowed_kinds: EquipmentKind[]
  allowed_categories: string[]
  required_tags: string[]
  excluded_tags: string[]
}

type DraftItem = Omit<CatalogItem, 'id'> & {
  spell_rule: Omit<SpellRule, 'item_id'> | null
  equipment_rule: Omit<EquipmentRule, 'item_id'> | null
}

type ParsedImport = {
  rows: DraftItem[]
  errors: string[]
  fileName: string
}

const CLASSIFICATIONS: Array<{ value: Classification; label: string }> = [
  { value: 'mundane', label: 'Mundane' },
  { value: 'alchemy', label: 'Alchemy' },
  { value: 'smith', label: 'Smith' },
  { value: 'magic', label: 'Magic' },
  { value: 'jewelry', label: 'Jewelry' },
  { value: 'tailored', label: 'Tailored' },
  { value: 'wondrous', label: 'Wondrous' },
]

const RARITIES: Array<{ value: Rarity; label: string }> = [
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'very_rare', label: 'Very Rare' },
  { value: 'legendary', label: 'Legendary' },
]

const SPELL_SCHOOLS: SpellSchool[] = [
  'abjuration', 'conjuration', 'divination', 'enchantment',
  'evocation', 'illusion', 'necromancy', 'transmutation',
]

const EQUIPMENT_KINDS: EquipmentKind[] = ['armor', 'weapon', 'shield', 'ammunition']

const EMPTY_DRAFT: DraftItem = {
  name: '',
  description: '',
  classification: 'mundane',
  rarity: 'common',
  requires_attunement: false,
  generated_name_template: '{item_name}',
  is_active: true,
  spell_rule: null,
  equipment_rule: null,
}

const CSV_HEADERS = [
  'name', 'description', 'classification', 'rarity', 'requires_attunement', 'is_active',
  'generated_name_template', 'spell_minimum_level', 'spell_maximum_level', 'spell_schools',
  'equipment_kinds', 'equipment_categories', 'equipment_required_tags', 'equipment_excluded_tags',
]

export function ItemCatalogManager({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [items, setItems] = useState<CatalogItem[]>([])
  const [spellRules, setSpellRules] = useState<SpellRule[]>([])
  const [equipmentRules, setEquipmentRules] = useState<EquipmentRule[]>([])
  const [mode, setMode] = useState<CatalogMode>('list')
  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(true)

  const fetchCatalog = useCallback(async () => {
    const [itemResult, spellRuleResult, equipmentRuleResult] = await Promise.all([
      supabase
        .from('items')
        .select('id, name, description, classification, rarity, requires_attunement, generated_name_template, is_active')
        .order('name'),
      supabase
        .from('item_spell_generation_rules')
        .select('item_id, minimum_spell_level, maximum_spell_level, allowed_schools'),
      supabase
        .from('item_equipment_generation_rules')
        .select('item_id, allowed_kinds, allowed_categories, required_tags, excluded_tags'),
    ])

    return {
      items: itemResult.data ?? [],
      spellRules: spellRuleResult.data ?? [],
      equipmentRules: equipmentRuleResult.data ?? [],
      error: itemResult.error ?? spellRuleResult.error ?? equipmentRuleResult.error,
    }
  }, [])

  const refreshCatalog = useCallback(async () => {
    const result = await fetchCatalog()
    if (result.error) {
      console.error('Could not load item catalog:', result.error)
      setMessage('The item catalog could not be loaded.')
      setLoading(false)
      return false
    }

    setItems(result.items)
    setSpellRules(result.spellRules)
    setEquipmentRules(result.equipmentRules)
    setMessage('')
    setLoading(false)
    return true
  }, [fetchCatalog])

  useEffect(() => {
    let isActive = true

    void fetchCatalog().then((result) => {
      if (!isActive) return
      if (result.error) {
        console.error('Could not load item catalog:', result.error)
        setMessage('The item catalog could not be loaded.')
      } else {
        setItems(result.items)
        setSpellRules(result.spellRules)
        setEquipmentRules(result.equipmentRules)
      }
      setLoading(false)
    })

    return () => {
      isActive = false
    }
  }, [fetchCatalog])

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
      if (mode === 'list') onClose()
      else {
        setMode('list')
        setEditingItem(null)
        setMessage('')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mode, onClose])

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase()
    return items.filter((item) => {
      if (!showInactive && !item.is_active) return false
      return !query
        || item.name.toLowerCase().includes(query)
        || item.description.toLowerCase().includes(query)
        || item.classification.includes(query)
        || item.rarity.replace('_', ' ').includes(query)
    })
  }, [items, search, showInactive])

  async function toggleActive(item: CatalogItem) {
    const { error } = await supabase.from('items').update({ is_active: !item.is_active }).eq('id', item.id)
    if (error) {
      console.error('Could not update item activity:', error)
      setMessage(`${item.name} could not be ${item.is_active ? 'deactivated' : 'activated'}.`)
      return
    }
    await refreshCatalog()
  }

  function openEditor(item?: CatalogItem) {
    setEditingItem(item ?? null)
    setMode('edit')
    setMessage('')
  }

  return (
    <div className="campaign-browser-backdrop" role="presentation">
      <section className="campaign-browser catalog-manager" role="dialog" aria-modal="true" aria-labelledby="catalog-manager-title">
        <header className="campaign-browser-header">
          <button
            className="browser-back-button"
            type="button"
            onClick={() => {
              if (mode === 'list') onClose()
              else {
                setMode('list')
                setEditingItem(null)
                setMessage('')
              }
            }}
          >
            {mode === 'list' ? '← DM Workshop' : '← Item catalog'}
          </button>
          <div className="browser-breadcrumb" id="catalog-manager-title">
            <strong>Universal Item Catalog</strong>
            {mode !== 'list' && <><span aria-hidden="true">—</span><strong>{mode === 'edit' ? editingItem ? 'Edit item' : 'Create item' : 'CSV import'}</strong></>}
          </div>
          <button className="browser-close-button" type="button" onClick={onClose} aria-label="Close item catalog">×</button>
        </header>

        <div className="campaign-browser-content catalog-content">
          {message && <p className="message message-error" role="alert">{message}</p>}

          {mode === 'edit' ? (
            <ItemEditor
              item={editingItem}
              spellRule={spellRules.find((rule) => rule.item_id === editingItem?.id) ?? null}
              equipmentRule={equipmentRules.find((rule) => rule.item_id === editingItem?.id) ?? null}
              userId={userId}
              onCancel={() => {
                setMode('list')
                setEditingItem(null)
              }}
              onSaved={async () => {
                await refreshCatalog()
                setMode('list')
                setEditingItem(null)
              }}
            />
          ) : mode === 'import' ? (
            <CsvImporter
              userId={userId}
              existingItems={items}
              onCancel={() => setMode('list')}
              onImported={async () => {
                await refreshCatalog()
                setMode('list')
              }}
            />
          ) : (
            <div className="catalog-list-view">
              <div className="catalog-toolbar">
                <div>
                  <p className="eyebrow">DM catalog tools</p>
                  <h2>Items</h2>
                  <p>{items.filter((item) => item.is_active).length} active · {items.length} total</p>
                </div>
                <div className="catalog-toolbar-actions">
                  <button className="button button-secondary" type="button" onClick={() => setMode('import')}>Import CSV</button>
                  <button className="button button-primary button-inline" type="button" onClick={() => openEditor()}>Create item</button>
                </div>
              </div>

              <div className="catalog-filters">
                <label>
                  Search items
                  <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, description, classification…" />
                </label>
                <label className="checkbox-field">
                  <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
                  <span>Show inactive items</span>
                </label>
              </div>

              {loading ? (
                <p className="browser-loading">Loading item catalog…</p>
              ) : filteredItems.length === 0 ? (
                <div className="browser-empty-state">
                  <h4>{items.length === 0 ? 'No items yet' : 'No matching items'}</h4>
                  <p>{items.length === 0 ? 'Create an item manually or import a CSV to begin.' : 'Try changing your search or filters.'}</p>
                </div>
              ) : (
                <div className="catalog-item-list">
                  {filteredItems.map((item) => {
                    const hasSpellRule = spellRules.some((rule) => rule.item_id === item.id)
                    const hasEquipmentRule = equipmentRules.some((rule) => rule.item_id === item.id)
                    return (
                      <article className={item.is_active ? 'catalog-item-card' : 'catalog-item-card inactive'} key={item.id}>
                        <div className="catalog-item-copy">
                          <div className="entity-title-line">
                            <h3>{item.name}</h3>
                            <span className="classification-badge">{labelValue(item.classification)}</span>
                            <span className={`rarity-badge rarity-${item.rarity}`}>{labelValue(item.rarity)}</span>
                            <span className={item.is_active ? 'visibility-badge listed' : 'visibility-badge'}>{item.is_active ? 'Active' : 'Inactive'}</span>
                          </div>
                          {item.description && <p>{item.description}</p>}
                          <div className="catalog-item-flags">
                            {item.requires_attunement && <span>Requires attunement</span>}
                            {hasSpellRule && <span>Chooses a spell</span>}
                            {hasEquipmentRule && <span>Chooses equipment</span>}
                            {item.generated_name_template !== '{item_name}' && <span>{item.generated_name_template}</span>}
                          </div>
                        </div>
                        <div className="catalog-item-actions">
                          <button className="text-button" type="button" onClick={() => openEditor(item)}>Edit</button>
                          <button className={item.is_active ? 'text-button text-button-danger' : 'text-button add-button'} type="button" onClick={() => void toggleActive(item)}>
                            {item.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="campaign-browser-footer">Press <kbd>Esc</kbd> to {mode === 'list' ? 'close' : 'return to the catalog'}.</footer>
      </section>
    </div>
  )
}

function ItemEditor({
  item,
  spellRule,
  equipmentRule,
  userId,
  onCancel,
  onSaved,
}: {
  item: CatalogItem | null
  spellRule: SpellRule | null
  equipmentRule: EquipmentRule | null
  userId: string
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<DraftItem>(() => itemToDraft(item, spellRule, equipmentRule))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  function update<K extends keyof DraftItem>(key: K, value: DraftItem[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validationError = validateDraft(draft)
    if (validationError) {
      setMessage(validationError)
      return
    }

    setSubmitting(true)
    setMessage('')
    const values = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      classification: draft.classification,
      rarity: draft.rarity,
      requires_attunement: draft.requires_attunement,
      generated_name_template: draft.generated_name_template.trim(),
      is_active: draft.is_active,
      ...(!item ? { created_by: userId } : {}),
    }

    const itemResult = item
      ? await supabase.from('items').update(values).eq('id', item.id).select('id').single()
      : await supabase.from('items').insert(values).select('id').single()

    if (itemResult.error || !itemResult.data) {
      console.error('Could not save catalog item:', itemResult.error)
      setMessage(itemResult.error?.code === '23505' ? 'An item with that name already exists.' : 'The item could not be saved.')
      setSubmitting(false)
      return
    }

    const ruleError = await saveGenerationRules(itemResult.data.id, draft)
    if (ruleError) {
      console.error('Could not save item generation rules:', ruleError)
      setMessage('The item was saved, but its generation rules could not be saved. Please try editing it again.')
      setSubmitting(false)
      return
    }

    await onSaved()
    setSubmitting(false)
  }

  return (
    <form className="catalog-editor" onSubmit={submit}>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">{item ? 'Edit catalog entry' : 'New catalog entry'}</p>
          <h2>{item ? item.name : 'Create an item'}</h2>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>

      <div className="entity-form-grid">
        <div>
          <label htmlFor="catalog-item-name">Name</label>
          <input id="catalog-item-name" value={draft.name} onChange={(event) => update('name', event.target.value)} maxLength={160} autoFocus required />
        </div>
        <div>
          <label htmlFor="catalog-item-description">Description</label>
          <textarea id="catalog-item-description" value={draft.description} onChange={(event) => update('description', event.target.value)} maxLength={12000} rows={4} />
          <span className="character-counter">{draft.description.length}/12000</span>
        </div>
      </div>

      <div className="form-grid two-columns">
        <div>
          <label htmlFor="catalog-classification">Classification</label>
          <select id="catalog-classification" value={draft.classification} onChange={(event) => update('classification', event.target.value as Classification)}>
            {CLASSIFICATIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="catalog-rarity">Rarity</label>
          <select id="catalog-rarity" value={draft.rarity} onChange={(event) => update('rarity', event.target.value as Rarity)}>
            {RARITIES.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      <div className="checkbox-grid catalog-status-options">
        <label className="checkbox-field">
          <input type="checkbox" checked={draft.requires_attunement} onChange={(event) => update('requires_attunement', event.target.checked)} />
          <span>Requires attunement</span>
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={draft.is_active} onChange={(event) => update('is_active', event.target.checked)} />
          <span>Active in generation pool</span>
        </label>
      </div>

      <fieldset className="catalog-rule-fieldset">
        <legend>Generated identity</legend>
        <label htmlFor="generated-name-template">Generated name template</label>
        <input id="generated-name-template" value={draft.generated_name_template} onChange={(event) => update('generated_name_template', event.target.value)} maxLength={240} required />
        <p className="field-hint">Available tokens: {'{item_name}'}, {'{spell_name}'}, and {'{equipment_name}'}. Ordinary items should use {'{item_name}'}.</p>

        <label className="checkbox-field catalog-rule-toggle">
          <input
            type="checkbox"
            checked={Boolean(draft.spell_rule)}
            onChange={(event) => update('spell_rule', event.target.checked ? { minimum_spell_level: 0, maximum_spell_level: 9, allowed_schools: [] } : null)}
          />
          <span>
            <strong>Choose a random spell when generated</strong>
            <small>Used for scrolls, enspelled equipment, and similar items.</small>
          </span>
        </label>

        {draft.spell_rule && (
          <div className="catalog-rule-panel">
            <div className="form-grid two-columns">
              <div>
                <label htmlFor="minimum-spell-level">Minimum spell level</label>
                <input id="minimum-spell-level" type="number" min="0" max="9" value={draft.spell_rule.minimum_spell_level} onChange={(event) => update('spell_rule', { ...draft.spell_rule as NonNullable<DraftItem['spell_rule']>, minimum_spell_level: Number(event.target.value) })} />
              </div>
              <div>
                <label htmlFor="maximum-spell-level">Maximum spell level</label>
                <input id="maximum-spell-level" type="number" min="0" max="9" value={draft.spell_rule.maximum_spell_level} onChange={(event) => update('spell_rule', { ...draft.spell_rule as NonNullable<DraftItem['spell_rule']>, maximum_spell_level: Number(event.target.value) })} />
              </div>
            </div>
            <p className="field-hint">Leave every school unchecked to allow all schools.</p>
            <div className="compact-checkbox-grid">
              {SPELL_SCHOOLS.map((school) => (
                <label className="checkbox-field" key={school}>
                  <input
                    type="checkbox"
                    checked={draft.spell_rule?.allowed_schools.includes(school) ?? false}
                    onChange={() => update('spell_rule', {
                      ...draft.spell_rule as NonNullable<DraftItem['spell_rule']>,
                      allowed_schools: toggleArrayValue(draft.spell_rule?.allowed_schools ?? [], school),
                    })}
                  />
                  <span>{labelValue(school)}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="checkbox-field catalog-rule-toggle">
          <input
            type="checkbox"
            checked={Boolean(draft.equipment_rule)}
            onChange={(event) => update('equipment_rule', event.target.checked ? { allowed_kinds: [], allowed_categories: [], required_tags: [], excluded_tags: [] } : null)}
          />
          <span>
            <strong>Choose random equipment when generated</strong>
            <small>Turns generic results such as +2 Armor into a concrete item.</small>
          </span>
        </label>

        {draft.equipment_rule && (
          <div className="catalog-rule-panel">
            <p className="field-hint">Choose at least one equipment kind.</p>
            <div className="compact-checkbox-grid">
              {EQUIPMENT_KINDS.map((kind) => (
                <label className="checkbox-field" key={kind}>
                  <input
                    type="checkbox"
                    checked={draft.equipment_rule?.allowed_kinds.includes(kind) ?? false}
                    onChange={() => update('equipment_rule', {
                      ...draft.equipment_rule as NonNullable<DraftItem['equipment_rule']>,
                      allowed_kinds: toggleArrayValue(draft.equipment_rule?.allowed_kinds ?? [], kind),
                    })}
                  />
                  <span>{labelValue(kind)}</span>
                </label>
              ))}
            </div>
            <ArrayTextField label="Allowed categories" value={draft.equipment_rule.allowed_categories} onChange={(value) => update('equipment_rule', { ...draft.equipment_rule as NonNullable<DraftItem['equipment_rule']>, allowed_categories: value })} hint="Optional, comma-separated. Example: light, medium, heavy" />
            <ArrayTextField label="Required tags" value={draft.equipment_rule.required_tags} onChange={(value) => update('equipment_rule', { ...draft.equipment_rule as NonNullable<DraftItem['equipment_rule']>, required_tags: value })} hint="Optional, comma-separated. Every listed tag must be present." />
            <ArrayTextField label="Excluded tags" value={draft.equipment_rule.excluded_tags} onChange={(value) => update('equipment_rule', { ...draft.equipment_rule as NonNullable<DraftItem['equipment_rule']>, excluded_tags: value })} hint="Optional, comma-separated." />
          </div>
        )}
      </fieldset>

      {message && <p className="message message-error" role="alert">{message}</p>}
      <div className="editor-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button-primary button-inline" type="submit" disabled={submitting}>{submitting ? 'Saving…' : item ? 'Save item' : 'Create item'}</button>
      </div>
    </form>
  )
}

function CsvImporter({
  userId,
  existingItems,
  onCancel,
  onImported,
}: {
  userId: string
  existingItems: CatalogItem[]
  onCancel: () => void
  onImported: () => Promise<void>
}) {
  const [parsed, setParsed] = useState<ParsedImport | null>(null)
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setParsing(true)
    setMessage('')
    try {
      const text = await file.text()
      setParsed(validateImportCsv(text, file.name))
    } catch (error) {
      console.error('Could not read CSV:', error)
      setMessage('That CSV file could not be read.')
      setParsed(null)
    }
    setParsing(false)
    event.target.value = ''
  }

  async function importRows() {
    if (!parsed || parsed.errors.length > 0 || parsed.rows.length === 0) return
    setImporting(true)
    setMessage('')

    const result = await importDraftItems(parsed.rows, userId)
    if (result.error) {
      console.error('CSV import failed:', result.error)
      setMessage(`The import stopped after ${result.completed} of ${parsed.rows.length} rows. ${result.error.message}`)
      setImporting(false)
      return
    }

    await onImported()
    setImporting(false)
  }

  const existingNames = new Set(existingItems.map((item) => item.name.trim().toLowerCase()))
  const updateCount = parsed?.rows.filter((row) => existingNames.has(row.name.trim().toLowerCase())).length ?? 0

  return (
    <div className="catalog-importer">
      <div className="editor-heading">
        <div>
          <p className="eyebrow">Bulk catalog tools</p>
          <h2>Import items from CSV</h2>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>

      <div className="import-instructions">
        <h3>Prepare the file</h3>
        <p>Download the template, keep its header row, and add one item per row. Lists such as spell schools or equipment kinds use semicolons inside their cell.</p>
        <button className="button button-secondary" type="button" onClick={downloadCsvTemplate}>Download CSV template</button>
      </div>

      <label className="csv-drop-zone">
        <strong>{parsing ? 'Reading file…' : 'Choose an item CSV'}</strong>
        <span>The file is validated and previewed before anything is saved.</span>
        <input type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={parsing || importing} />
      </label>

      {message && <p className="message message-error" role="alert">{message}</p>}

      {parsed && (
        <div className="import-preview">
          <div className="import-summary">
            <div><strong>{parsed.rows.length}</strong><span>valid rows</span></div>
            <div><strong>{updateCount}</strong><span>updates</span></div>
            <div><strong>{parsed.rows.length - updateCount}</strong><span>new items</span></div>
            <div className={parsed.errors.length ? 'has-errors' : ''}><strong>{parsed.errors.length}</strong><span>errors</span></div>
          </div>

          {parsed.errors.length > 0 ? (
            <div className="import-errors">
              <h3>Fix these errors before importing</h3>
              <ul>{parsed.errors.slice(0, 30).map((error) => <li key={error}>{error}</li>)}</ul>
              {parsed.errors.length > 30 && <p>And {parsed.errors.length - 30} more errors.</p>}
            </div>
          ) : (
            <div className="import-table-wrap">
              <table className="import-table">
                <thead><tr><th>Action</th><th>Name</th><th>Classification</th><th>Rarity</th><th>Generated identity</th></tr></thead>
                <tbody>
                  {parsed.rows.slice(0, 20).map((row) => (
                    <tr key={row.name.toLowerCase()}>
                      <td>{existingNames.has(row.name.trim().toLowerCase()) ? 'Update' : 'Create'}</td>
                      <td>{row.name}</td>
                      <td>{labelValue(row.classification)}</td>
                      <td>{labelValue(row.rarity)}</td>
                      <td>{row.generated_name_template}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 20 && <p className="field-hint">Showing the first 20 of {parsed.rows.length} valid rows.</p>}
            </div>
          )}

          <div className="editor-actions">
            <button className="button button-secondary" type="button" onClick={() => setParsed(null)}>Clear file</button>
            <button className="button button-primary button-inline" type="button" disabled={importing || parsed.errors.length > 0 || parsed.rows.length === 0} onClick={() => void importRows()}>
              {importing ? 'Importing…' : `Import ${parsed.rows.length} items`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ArrayTextField({ label, value, onChange, hint }: { label: string; value: string[]; onChange: (value: string[]) => void; hint: string }) {
  return (
    <div>
      <label>{label}</label>
      <input value={value.join(', ')} onChange={(event) => onChange(splitList(event.target.value, ','))} />
      <p className="field-hint">{hint}</p>
    </div>
  )
}

function itemToDraft(item: CatalogItem | null, spellRule: SpellRule | null, equipmentRule: EquipmentRule | null): DraftItem {
  if (!item) return { ...EMPTY_DRAFT }
  return {
    ...item,
    spell_rule: spellRule ? {
      minimum_spell_level: spellRule.minimum_spell_level,
      maximum_spell_level: spellRule.maximum_spell_level,
      allowed_schools: spellRule.allowed_schools,
    } : null,
    equipment_rule: equipmentRule ? {
      allowed_kinds: equipmentRule.allowed_kinds,
      allowed_categories: equipmentRule.allowed_categories,
      required_tags: equipmentRule.required_tags,
      excluded_tags: equipmentRule.excluded_tags,
    } : null,
  }
}

function validateDraft(draft: DraftItem) {
  if (!draft.name.trim() || draft.name.trim().length > 160) return 'Enter an item name up to 160 characters.'
  if (draft.description.length > 12000) return 'Item descriptions cannot exceed 12,000 characters.'
  const template = draft.generated_name_template.trim()
  if (!template || template.length > 240) return 'Enter a generated name template up to 240 characters.'
  if (draft.spell_rule) {
    if (!template.includes('{spell_name}')) return 'Spell-generating items must include {spell_name} in their name template.'
    if (draft.spell_rule.minimum_spell_level < 0 || draft.spell_rule.maximum_spell_level > 9 || draft.spell_rule.minimum_spell_level > draft.spell_rule.maximum_spell_level) {
      return 'Spell levels must be between 0 and 9, with the minimum no higher than the maximum.'
    }
  }
  if (draft.equipment_rule) {
    if (!template.includes('{equipment_name}')) return 'Equipment-generating items must include {equipment_name} in their name template.'
    if (draft.equipment_rule.allowed_kinds.length === 0) return 'Choose at least one eligible equipment kind.'
  }
  return ''
}

async function saveGenerationRules(itemId: string, draft: DraftItem) {
  const [deleteSpell, deleteEquipment] = await Promise.all([
    supabase.from('item_spell_generation_rules').delete().eq('item_id', itemId),
    supabase.from('item_equipment_generation_rules').delete().eq('item_id', itemId),
  ])
  if (deleteSpell.error || deleteEquipment.error) return deleteSpell.error ?? deleteEquipment.error

  if (draft.spell_rule) {
    const { error } = await supabase.from('item_spell_generation_rules').insert({
      item_id: itemId,
      selection_mode: 'random',
      fixed_spell_id: null,
      ...draft.spell_rule,
    })
    if (error) return error
  }

  if (draft.equipment_rule) {
    const { error } = await supabase.from('item_equipment_generation_rules').insert({
      item_id: itemId,
      selection_mode: 'random',
      fixed_equipment_base_id: null,
      ...draft.equipment_rule,
    })
    if (error) return error
  }

  return null
}

function validateImportCsv(text: string, fileName: string): ParsedImport {
  const parsedRows = parseCsv(text)
  const errors: string[] = []
  if (parsedRows.length === 0) return { rows: [], errors: ['The CSV is empty.'], fileName }

  const headers = parsedRows[0].map((header) => header.trim().toLowerCase())
  const required = ['name', 'description', 'classification', 'rarity', 'requires_attunement']
  const missing = required.filter((header) => !headers.includes(header))
  if (missing.length) return { rows: [], errors: [`Missing required columns: ${missing.join(', ')}.`], fileName }

  const unknown = headers.filter((header) => header && !CSV_HEADERS.includes(header))
  if (unknown.length) errors.push(`Unknown columns: ${unknown.join(', ')}.`)

  const seenNames = new Set<string>()
  const rows: DraftItem[] = []
  parsedRows.slice(1).forEach((values, index) => {
    const rowNumber = index + 2
    if (values.every((value) => !value.trim())) return
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column]?.trim() ?? '']))
    const name = record.name ?? ''
    const normalizedName = name.toLowerCase()
    const classification = record.classification as Classification
    const rarity = normalizeRarity(record.rarity)
    const attunement = parseBoolean(record.requires_attunement)
    const active = record.is_active === '' ? true : parseBoolean(record.is_active)
    const rowErrors: string[] = []

    if (!name || name.length > 160) rowErrors.push('name must contain 1–160 characters')
    if ((record.description ?? '').length > 12000) rowErrors.push('description exceeds 12,000 characters')
    if (!CLASSIFICATIONS.some((option) => option.value === classification)) rowErrors.push(`invalid classification “${record.classification}”`)
    if (!rarity) rowErrors.push(`invalid rarity “${record.rarity}”`)
    if (attunement === null) rowErrors.push('requires_attunement must be true or false')
    if (active === null) rowErrors.push('is_active must be true or false')
    if (seenNames.has(normalizedName)) rowErrors.push('duplicate item name in this CSV')
    seenNames.add(normalizedName)

    const minimumLevel = record.spell_minimum_level === '' ? null : Number(record.spell_minimum_level)
    const maximumLevel = record.spell_maximum_level === '' ? null : Number(record.spell_maximum_level)
    const schools = splitList(record.spell_schools ?? '', ';') as SpellSchool[]
    const hasSpellRule = minimumLevel !== null || maximumLevel !== null || schools.length > 0
    if (hasSpellRule) {
      if (!Number.isInteger(minimumLevel) || !Number.isInteger(maximumLevel) || (minimumLevel as number) < 0 || (maximumLevel as number) > 9 || (minimumLevel as number) > (maximumLevel as number)) {
        rowErrors.push('spell minimum/maximum levels must both be integers from 0–9')
      }
      const invalidSchools = schools.filter((school) => !SPELL_SCHOOLS.includes(school))
      if (invalidSchools.length) rowErrors.push(`invalid spell schools: ${invalidSchools.join(', ')}`)
    }

    const kinds = splitList(record.equipment_kinds ?? '', ';') as EquipmentKind[]
    const categories = splitList(record.equipment_categories ?? '', ';')
    const requiredTags = splitList(record.equipment_required_tags ?? '', ';')
    const excludedTags = splitList(record.equipment_excluded_tags ?? '', ';')
    const hasEquipmentRule = kinds.length > 0 || categories.length > 0 || requiredTags.length > 0 || excludedTags.length > 0
    const invalidKinds = kinds.filter((kind) => !EQUIPMENT_KINDS.includes(kind))
    if (invalidKinds.length) rowErrors.push(`invalid equipment kinds: ${invalidKinds.join(', ')}`)
    if (hasEquipmentRule && kinds.length === 0) rowErrors.push('equipment rules require at least one equipment kind')

    const template = record.generated_name_template || '{item_name}'
    if (template.length > 240) rowErrors.push('generated_name_template exceeds 240 characters')
    if (hasSpellRule && !template.includes('{spell_name}')) rowErrors.push('spell rules require {spell_name} in generated_name_template')
    if (hasEquipmentRule && !template.includes('{equipment_name}')) rowErrors.push('equipment rules require {equipment_name} in generated_name_template')

    if (rowErrors.length) {
      errors.push(`Row ${rowNumber}: ${rowErrors.join('; ')}.`)
      return
    }

    rows.push({
      name,
      description: record.description ?? '',
      classification,
      rarity: rarity as Rarity,
      requires_attunement: attunement as boolean,
      is_active: active as boolean,
      generated_name_template: template,
      spell_rule: hasSpellRule ? {
        minimum_spell_level: minimumLevel as number,
        maximum_spell_level: maximumLevel as number,
        allowed_schools: schools,
      } : null,
      equipment_rule: hasEquipmentRule ? {
        allowed_kinds: kinds,
        allowed_categories: categories,
        required_tags: requiredTags,
        excluded_tags: excludedTags,
      } : null,
    })
  })

  if (rows.length > 5000) errors.push('Imports are limited to 5,000 items at a time.')
  return { rows, errors, fileName }
}

async function importDraftItems(rows: DraftItem[], userId: string) {
  let completed = 0
  for (const batch of chunk(rows, 200)) {
    const { data, error } = await supabase.from('items').upsert(
      batch.map((row) => ({
        name: row.name.trim(),
        description: row.description.trim(),
        classification: row.classification,
        rarity: row.rarity,
        requires_attunement: row.requires_attunement,
        is_active: row.is_active,
        generated_name_template: row.generated_name_template.trim(),
        created_by: userId,
      })),
      { onConflict: 'normalized_name' },
    ).select('id, normalized_name')

    if (error || !data) return { completed, error: error ?? new Error('Imported items could not be returned.') }
    const idsByName = new Map(data.map((item) => [item.normalized_name, item.id]))
    const itemIds = data.map((item) => item.id)

    const [spellDelete, equipmentDelete] = await Promise.all([
      supabase.from('item_spell_generation_rules').delete().in('item_id', itemIds),
      supabase.from('item_equipment_generation_rules').delete().in('item_id', itemIds),
    ])
    const deleteError = spellDelete.error ?? equipmentDelete.error
    if (deleteError) return { completed, error: deleteError }

    const spellRows = batch.flatMap((row) => row.spell_rule ? [{ item_id: idsByName.get(row.name.trim().toLowerCase()), selection_mode: 'random', fixed_spell_id: null, ...row.spell_rule }] : [])
    const equipmentRows = batch.flatMap((row) => row.equipment_rule ? [{ item_id: idsByName.get(row.name.trim().toLowerCase()), selection_mode: 'random', fixed_equipment_base_id: null, ...row.equipment_rule }] : [])

    if (spellRows.length) {
      const { error: spellError } = await supabase.from('item_spell_generation_rules').insert(spellRows)
      if (spellError) return { completed, error: spellError }
    }
    if (equipmentRows.length) {
      const { error: equipmentError } = await supabase.from('item_equipment_generation_rules').insert(equipmentRows)
      if (equipmentError) return { completed, error: equipmentError }
    }
    completed += batch.length
  }
  return { completed, error: null }
}

function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (character === '"') {
      if (quoted && next === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '')
  return rows
}

function downloadCsvTemplate() {
  const sampleRows = [
    CSV_HEADERS,
    ['Cloak of Example', 'A sample static item.', 'tailored', 'uncommon', 'true', 'true', '{item_name}', '', '', '', '', '', '', ''],
    ['Spell Scroll (3rd Level)', 'Resolves to a specific third-level spell.', 'magic', 'uncommon', 'false', 'true', 'Scroll of {spell_name}', '3', '3', '', '', '', '', ''],
    ['+2 Armor', 'Resolves to a specific suit of armor.', 'smith', 'very_rare', 'false', 'true', '+2 {equipment_name}', '', '', '', 'armor', 'light;medium;heavy', '', ''],
  ]
  const csv = sampleRows.map((row) => row.map(csvEscape).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'askthedm-item-import-template.csv'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function csvEscape(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', '1'].includes(normalized)) return true
  if (['false', 'no', '0'].includes(normalized)) return false
  return null
}

function normalizeRarity(value: string): Rarity | null {
  const normalized = value.trim().toLowerCase().replaceAll(' ', '_').replaceAll('-', '_')
  return RARITIES.some((option) => option.value === normalized) ? normalized as Rarity : null
}

function splitList(value: string, separator: string) {
  return value.split(separator).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
}

function toggleArrayValue<T>(values: T[], value: T) {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
}

function labelValue(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}
