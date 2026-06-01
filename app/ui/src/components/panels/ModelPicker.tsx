import { useState, useEffect, useRef, useCallback } from 'react'
import { useHudPiece } from '../../hooks/useHudStream'

// Known models with display labels
const MODEL_LABELS: Record<string, { label: string; note: string }> = {
  'claude-opus-4-8':    { label: 'Opus 4.8',   note: '1M · Max' },
  'claude-opus-4-7':    { label: 'Opus 4.7',   note: '1M · Max' },
  'claude-opus-4-6':    { label: 'Opus 4.6',   note: '1M · Max' },
  'claude-sonnet-4-6':  { label: 'Sonnet 4.6', note: '1M · High' },
  'claude-haiku-4-5':   { label: 'Haiku 4.5',  note: '200K · Fast' },
  'gpt-4o':             { label: 'GPT-4o',     note: 'OpenAI' },
  'gpt-4o-mini':        { label: 'GPT-4o Mini',note: 'OpenAI · Fast' },
  'gpt-4.1':            { label: 'GPT-4.1',    note: 'OpenAI' },
  'o3':                 { label: 'o3',          note: 'OpenAI · Reason' },
  'o4-mini':            { label: 'o4-mini',     note: 'OpenAI · Fast' },
}

interface ModelPickerProps {
  sessionId: string
  sendUrl: string
}

export function ModelPicker({ sessionId, sendUrl }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<string[]>([])
  const [sessionModel, setSessionModel] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Current model from token-counter HUD piece (live, via SSE) — reflects global active provider.
  // Used as fallback for the main session; overridden by sessionModel for actor sessions.
  const tokenCounter = useHudPiece('token-counter')
  const globalModel: string = (tokenCounter?.data as any)?.model ?? '…'

  // For non-main sessions (actors), fetch the real model from the session itself.
  useEffect(() => {
    if (!sessionId || sessionId === 'main') {
      setSessionModel(null)
      return
    }
    let cancelled = false
    const fetchModel = () => {
      fetch(`/chat/session-info?sessionId=${encodeURIComponent(sessionId)}`)
        .then(r => r.json())
        .then((data: { model: string | null }) => {
          if (!cancelled) setSessionModel(data.model)
        })
        .catch(() => {})
    }
    fetchModel()
    // Refresh every 5s to pick up model changes
    const interval = setInterval(fetchModel, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sessionId])

  const currentModel = sessionModel ?? globalModel

  // Populate model list from known config (mirrors getValidModels() in config/index.ts)
  useEffect(() => {
    setAvailable(Object.keys(MODEL_LABELS))
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

  const meta = MODEL_LABELS[currentModel]
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
            {available.map(id => {
              const m = MODEL_LABELS[id]
              const isActive = id === currentModel
              return (
                <button
                  key={id}
                  className={`modelPickerItem${isActive ? ' active' : ''}`}
                  onClick={() => selectModel(id)}
                >
                  <span className="modelPickerItemLabel">{m?.label ?? id}</span>
                  {m?.note && <span className="modelPickerItemNote">{m.note}</span>}
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
