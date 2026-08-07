import { useState, useEffect, useCallback, useRef } from 'react'

interface ModelMeta {
  id: string
  label: string
  note: string
  provider: string
  /** Present only on effort-capable rows (Anthropic non-Haiku), mission Gearbox. */
  effort?: string
  effortLabel?: string
}

interface ModelPickerProps {
  sessionId: string
  sendUrl: string
  /** Model pushed from ChatPanel via SSE model_changed — replaces /chat/session-info polling. */
  externalModel?: string | null
  /** Effort pushed from ChatPanel via SSE model_changed (mission Gearbox). */
  externalEffort?: string | null
}

export function ModelPicker({ sessionId, sendUrl, externalModel, externalEffort }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelMeta[]>([])
  const [sessionModel, setSessionModel] = useState<string | null>(null)
  // Current effort (mission Gearbox) — null means "no effort" (Haiku/OpenAI/
  // DeepSeek) or "not yet known". Mirrors sessionModel's hydration pattern.
  const [sessionEffort, setSessionEffort] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Token-counter HUD piece aggregates the most-recent model ACROSS ALL
  // sessions (scope ALL). Displaying it here leaked background sessions'
  // models into this panel: an actor responding on Sonnet flipped main's
  // footer while main was pinned to Fable (bug, 2026-06-11). It is now ONLY
  // a re-fetch trigger — when the aggregate flips, we re-poll THIS session's
  // truth immediately instead of waiting for the 5s interval.
  // Model state: hydrated by externalModel prop (SSE model_changed from ChatPanel).
  // One-time fetch on mount + sessionId change as fallback for cases where
  // model_changed hasn't fired yet (e.g. panel opened mid-session).
  // No polling — the SSE event covers all live changes.
  useEffect(() => {
    if (externalModel) {
      // ChatPanel already has the model via SSE — trust it immediately.
      setSessionModel(externalModel)
      setSessionEffort(externalEffort ?? null)
      return
    }
    // Fallback: fetch once on mount or when externalModel is null/undefined
    // (SSE model_changed hasn't fired yet for this session).
    const sid = sessionId ?? 'main'
    let cancelled = false
    fetch(`/chat/session-info?sessionId=${encodeURIComponent(sid)}`)
      .then(r => r.json())
      .then((data: { model: string | null; effort?: string | null }) => {
        if (cancelled) return
        setSessionModel(data.model)
        setSessionEffort(data.effort ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [sessionId, externalModel, externalEffort])

  // '…' only until the first session-info response lands (<100ms typical).
  const currentModel = sessionModel ?? '…'

  // Fetch model catalog from backend — single source of truth from config/index.ts
  // Mission Gearbox: expanded cartesian catalog (one row per effort level for
  // effort-capable models; single row otherwise). Flat list, no grouping.
  useEffect(() => {
    fetch('/chat/models')
      .then(r => r.json())
      .then((data: ModelMeta[]) => setCatalog(data))
      .catch(() => {})
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Mission Gearbox: selecting a row sends model + effort as a single JSON
  // command — atomic on the live session (Sir's decision). effort is optional:
  // no-effort models (Haiku/OpenAI/DeepSeek) send a bare "/model <id>".
  const selectModel = useCallback((modelId: string, effort?: string) => {
    setOpen(false)
    const suffix = effort ? ` ${JSON.stringify({ effort })}` : ''
    fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: `/model ${modelId}${suffix}` }),
    }).catch(() => {})
  }, [sessionId, sendUrl])

  // Trigger label: find the catalog row matching BOTH model and effort so the
  // header shows "Opus 4.8 High" (not just "Opus 4.8"). Falls back to any row
  // with just the model id (no-effort models, or effort not yet hydrated).
  const meta = catalog.find(m => m.id === currentModel && (m.effort ?? null) === (sessionEffort ?? null))
    ?? catalog.find(m => m.id === currentModel)
  const displayLabel = meta?.label ?? currentModel
  const displayNote = meta?.note ?? ''

  return (
    <div className="modelPickerBar" ref={dropdownRef}>
      <button
        className="modelPickerTrigger"
        onClick={() => setOpen(o => !o)}
        title="Switch model"
      >
        <span className="modelPickerIcon">◈</span>
        <span className="modelPickerLabel">{displayLabel}</span>
        {displayNote && <span className="modelPickerNote">{displayNote}</span>}
        <span className="modelPickerChevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="modelPickerDropdown">
          <div className="modelPickerSearch">
            <span className="modelPickerSearchLabel">Select model</span>
          </div>
          <div className="modelPickerList">
            {catalog.map(({ id, label, note, effort }) => {
              // Active row = model AND effort combined (mission Gearbox) — a
              // model with 4 effort rows only ever has ONE active at a time.
              const isActive = id === currentModel && (effort ?? null) === (sessionEffort ?? null)
              return (
                <button
                  key={`${id}:${effort ?? '-'}`}
                  className={`modelPickerItem${isActive ? ' active' : ''}`}
                  onClick={() => selectModel(id, effort)}
                >
                  <span className="modelPickerItemLabel">{label}</span>
                  {note && <span className="modelPickerItemNote">{note}</span>}
                  {isActive && <span className="modelPickerItemCheck">✓</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
