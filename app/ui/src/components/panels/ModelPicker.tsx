import { useState, useEffect, useCallback, useRef } from 'react'

interface ModelMeta {
  id: string
  label: string
  note: string
  provider: string
}

interface ModelPickerProps {
  sessionId: string
  sendUrl: string
  /** Model pushed from ChatPanel via SSE model_changed — replaces /chat/session-info polling. */
  externalModel?: string | null
}

export function ModelPicker({ sessionId, sendUrl, externalModel }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelMeta[]>([])
  const [sessionModel, setSessionModel] = useState<string | null>(null)
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
      return
    }
    // Fallback: fetch once on mount or when externalModel is null/undefined
    // (SSE model_changed hasn't fired yet for this session).
    const sid = sessionId ?? 'main'
    let cancelled = false
    fetch(`/chat/session-info?sessionId=${encodeURIComponent(sid)}`)
      .then(r => r.json())
      .then((data: { model: string | null }) => { if (!cancelled) setSessionModel(data.model) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [sessionId, externalModel])

  // '…' only until the first session-info response lands (<100ms typical).
  const currentModel = sessionModel ?? '…'

  // Fetch model catalog from backend — single source of truth from config/index.ts
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

  const selectModel = useCallback((modelId: string) => {
    setOpen(false)
    // Send /model <id> slash command as a system message
    fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: `/model ${modelId}` }),
    }).catch(() => {})
  }, [sessionId, sendUrl])

  const meta = catalog.find(m => m.id === currentModel)
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
            {catalog.map(({ id, label, note }) => {
              const isActive = id === currentModel
              return (
                <button
                  key={id}
                  className={`modelPickerItem${isActive ? ' active' : ''}`}
                  onClick={() => selectModel(id)}
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
