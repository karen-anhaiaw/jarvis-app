import React, { useRef, useEffect, useState, useCallback } from 'react'
import { MarkdownText } from '../MarkdownText'

// ─── TimelineEntryRenderer ────────────────────────────────────────────────────
// Generic renderer for `kind: 'timeline_entry'` entries. Attempts to load the
// external plugin renderer if `renderer` is specified, falls back to `text`.
// Mirrors the HUD plugin renderer pattern — no core coupling to plugin logic.

const _rendererCache = new Map<string, React.ComponentType<{ payload: unknown; text: string; expanded?: boolean }>>()

function TimelineEntryRenderer({
  index,
  entry,
  onToggleExpand,
}: {
  index: number
  entry: Extract<ReturnType<() => import('./ChatTimeline').ChatEntry>, { kind: 'timeline_entry' }>
  onToggleExpand: (i: number) => void
}) {
  const [ExternalRenderer, setExternalRenderer] = React.useState<
    React.ComponentType<{ payload: unknown; text: string; expanded?: boolean }> | null
  >(null)
  const [loadFailed, setLoadFailed] = React.useState(false)

  React.useEffect(() => {
    if (!entry.renderer || loadFailed) return
    const key = `${entry.renderer.plugin}/${entry.renderer.file}`
    if (_rendererCache.has(key)) {
      setExternalRenderer(() => _rendererCache.get(key)!)
      return
    }
    const url = `/plugins/${entry.renderer.plugin}/renderers/${entry.renderer.file}.js`
    import(/* @vite-ignore */ url)
      .then((mod) => {
        const comp = mod.default ?? mod[entry.renderer!.file]
        if (typeof comp === 'function') {
          _rendererCache.set(key, comp)
          setExternalRenderer(() => comp)
        } else {
          setLoadFailed(true)
        }
      })
      .catch(() => setLoadFailed(true))
  }, [entry.renderer?.plugin, entry.renderer?.file])

  // If renderer loaded — delegate entirely, no core chrome
  if (ExternalRenderer) {
    return (
      <div key={index} style={{ marginBottom: '2px' }}>
        <ExternalRenderer
          payload={entry.payload}
          text={entry.text}
          expanded={entry.expanded}
        />
      </div>
    )
  }

  // Fallback — plain system-style pill, collapsible if payload has a `detail` string
  const fallbackDetail =
    typeof (entry.payload as any)?.detail === 'string'
      ? (entry.payload as any).detail as string
      : null
  const hasDetail = !!fallbackDetail

  return (
    <div style={{ marginBottom: '2px' }}>
      <div
        style={{
          padding: '3px 8px',
          borderRadius: hasDetail ? (entry.expanded ? '4px 4px 0 0' : '4px') : '4px',
          fontSize: '10px',
          borderLeft: '3px solid #a78bfa',
          background: '#1a1e2e',
          color: '#c4b5fd',
          fontFamily: 'var(--font-mono)',
          cursor: hasDetail ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
        onClick={hasDetail ? () => onToggleExpand(index) : undefined}
      >
        <span style={{ flex: 1 }}>{entry.text}</span>
        {hasDetail && (
          <span style={{ opacity: 0.5, flexShrink: 0 }}>{entry.expanded ? '▾' : '▸'}</span>
        )}
      </div>
      {hasDetail && entry.expanded && (
        <div style={{
          padding: '6px 10px 6px 14px',
          background: '#0d1117',
          borderLeft: '3px solid #a78bfa44',
          borderRadius: '0 0 4px 4px',
          fontSize: '10px',
          color: '#c4b5fd99',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word' as const,
          lineHeight: '1.5',
          fontFamily: 'var(--font-mono)',
          maxHeight: '300px',
          overflowY: 'auto' as const,
        }}>
          {fallbackDetail}
        </div>
      )}
    </div>
  )
}

interface ChatImage {
  label: string
  base64: string
  mediaType: string
}

export interface ChoiceOption {
  value: string
  label: string
  description?: string
}

export interface ChoiceQuestion {
  question: string
  options: ChoiceOption[]
  multi: boolean
  allow_other: boolean
}

export interface ChoiceAnswer {
  values: string[]
  otherText?: string
  /** Marker — set by the dismiss path. Renders as "(dismissed)" in history
   *  and tells consumers the user closed the prompt without choosing. */
  dismissed?: boolean
}

export type ChatEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; images?: ChatImage[]; source?: string; session?: string; aborted?: boolean }
  /**
   * Intermediate assistant text emitted between tool calls within a single turn.
   * Visually de-emphasized while the turn is live; collapses into a clickable
   * "thinking" block once the turn ends (done / error / aborted). The model's
   * actual final answer lands as a regular `kind:'message'` entry.
   */
  | { kind: 'thinking_text'; text: string; source?: string; session?: string; live?: boolean; expanded?: boolean }
  | { kind: 'capability'; name: string; id: string; args?: string; status: 'running' | 'done' | 'cancelled'; ms?: number; output?: string; expanded?: boolean }
  | { kind: 'compaction'; engine: 'api' | 'fallback' | 'sliding-window'; tokensBefore: number; tokensAfter: number; summary: string; expanded?: boolean }
  | { kind: 'compaction_pending'; engine: 'fallback'; tokensBefore: number; reason?: 'forced' | 'threshold' | 'growth' | 'sliding-window'; startedAt: number }
  | { kind: 'compaction_failed'; engine: 'fallback'; tokensBefore: number; reason: string }
  | { kind: 'bash_result'; command: string; output: string; exitCode: number; ms: number; expanded?: boolean }
  | { kind: 'system'; text: string; subtype?: string; detail?: string; session?: string; expanded?: boolean }
  | {
      kind: 'timeline_entry'
      text: string
      rendererKind?: string
      renderer?: { plugin: string; file: string }
      payload?: unknown
      session?: string
      expanded?: boolean
    }
  | { kind: 'error'; message: string; source?: string; session?: string }
  | {
      kind: 'choice'
      choice_id: string
      /** New: one card, many questions */
      questions: ChoiceQuestion[]
      /** Per-question answers when submitted */
      answers?: ChoiceAnswer[]
      /** @deprecated legacy single-question fields (still read for backward compat) */
      question?: string
      options?: ChoiceOption[]
      multi?: boolean
      allow_other?: boolean
      answer?: string[]
      other_text?: string
    }

/** A user message that arrived while a turn was busy and is waiting in line. */
export interface PendingQueueItem {
  text: string
  source?: string
  hasImages?: boolean
}

interface Props {
  entries: ChatEntry[]
  streamingText: string
  isStreaming: boolean
  isThinking: boolean
  assistantLabel: string
  /** Labels for user messages — maps source to display name */
  userLabel?: (source?: string) => string
  /** Colors for user labels */
  userLabelColor?: (source?: string) => string
  /** Colors for assistant labels */
  assistantLabelColor?: string
  onToggleExpand: (index: number) => void
  /** Submit a choice answer — one answer per question. */
  onChoiceSubmit?: (index: number, answers: ChoiceAnswer[]) => void
  /** Pending user messages waiting in queue while the current turn finishes.
   *  Rendered as small cards under the JARVIS thinking indicator. */
  pendingQueue?: PendingQueueItem[]
  /** choice_ids whose inline ChoiceCard should be HIDDEN — they are being
   *  rendered by the ChatAnchorSlot above the composer instead. Once the
   *  user replies, the anchor is removed and the choice_id leaves this set,
   *  at which point the inline card (now `answered`) appears in history. */
  hiddenChoiceIds?: ReadonlySet<string>
}

// ─── Choice card (inline prompt with radio / checkbox + free-text "Other") ───

const OTHER_VALUE = '__other__'

export interface ChoiceCardProps {
  index: number
  entry: Extract<ChatEntry, { kind: 'choice' }>
  onSubmit?: (index: number, answers: ChoiceAnswer[]) => void
  /** Optional dismiss handler. When provided, a "Dismiss" button is rendered
   *  to the LEFT of the Confirm button. Used for live anchor cards — the host
   *  is expected to send a dismissal signal to the AI and remove the anchor.
   *  Inline (historical) cards omit this prop, so no Dismiss button appears. */
  onDismiss?: (index: number) => void
  assistantLabel: string
  assistantLabelColor: string
}

/** Normalize an entry to questions[] — handles legacy single-question entries
 *  coming from older SSE payloads or persisted history. */
function getQuestions(entry: Extract<ChatEntry, { kind: 'choice' }>): ChoiceQuestion[] {
  if (Array.isArray(entry.questions) && entry.questions.length > 0) return entry.questions
  if (entry.question && Array.isArray(entry.options)) {
    return [{
      question: entry.question,
      options: entry.options,
      multi: !!entry.multi,
      allow_other: entry.allow_other !== false,
    }]
  }
  return []
}

/** Normalize answers — supports both new `answers` and legacy `answer`/`other_text`. */
function getAnswers(entry: Extract<ChatEntry, { kind: 'choice' }>): ChoiceAnswer[] | null {
  if (Array.isArray(entry.answers) && entry.answers.length > 0) return entry.answers
  if (Array.isArray(entry.answer) && entry.answer.length > 0) {
    return [{ values: entry.answer, otherText: entry.other_text }]
  }
  return null
}

export function ChoiceCard({ index, entry, onSubmit, onDismiss, assistantLabel, assistantLabelColor }: ChoiceCardProps) {
  const questions = getQuestions(entry)
  const persistedAnswers = getAnswers(entry)
  const answered = persistedAnswers !== null

  // One state slot per question
  const [selectedByQ, setSelectedByQ] = useState<Array<Set<string>>>(
    () => questions.map(() => new Set<string>())
  )
  const [otherTextByQ, setOtherTextByQ] = useState<string[]>(
    () => questions.map(() => '')
  )

  const cardRef = useRef<HTMLDivElement>(null)

  // Auto-focus first option when card appears
  useEffect(() => {
    if (answered) return
    const node = cardRef.current?.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')
    node?.focus()
  }, [answered])

  const toggle = useCallback((qIdx: number, value: string) => {
    setSelectedByQ(prev => {
      const next = prev.slice()
      const curr = new Set(prev[qIdx])
      const q = questions[qIdx]
      if (q?.multi) {
        if (curr.has(value)) curr.delete(value)
        else curr.add(value)
      } else {
        curr.clear()
        curr.add(value)
      }
      next[qIdx] = curr
      return next
    })
  }, [questions])

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTextByQ(prev => {
      const next = prev.slice()
      next[qIdx] = text
      return next
    })
  }, [])

  // Each question must have at least one valid answer (value chosen, OR 'other' + text)
  const questionAnswered = (qIdx: number): boolean => {
    const sel = selectedByQ[qIdx]
    if (!sel || sel.size === 0) return false
    const hasOther = sel.has(OTHER_VALUE)
    if (hasOther && otherTextByQ[qIdx].trim().length === 0) return false
    return true
  }

  const canSubmit = !answered && questions.length > 0 && questions.every((_, i) => questionAnswered(i))

  const handleSubmit = useCallback(() => {
    if (!canSubmit || !onSubmit) return
    const answers: ChoiceAnswer[] = questions.map((_, i) => {
      const values = Array.from(selectedByQ[i])
      const hasOther = values.includes(OTHER_VALUE)
      return { values, otherText: hasOther ? otherTextByQ[i].trim() : undefined }
    })
    onSubmit(index, answers)
  }, [canSubmit, onSubmit, index, questions, selectedByQ, otherTextByQ])

  // Global Enter → submit, unless the active element is a textarea (Other field handles its own Enter)
  const onKeyDownCard = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    const active = document.activeElement
    if (active && active.tagName === 'TEXTAREA') return
    if (!canSubmit) return
    e.preventDefault()
    handleSubmit()
  }, [canSubmit, handleSubmit])

  const renderAnswerSummaryFor = (qIdx: number) => {
    if (!answered || !persistedAnswers) return null
    const ans = persistedAnswers[qIdx]
    if (!ans) return null

    // Dismissed: render a muted "(dismissed)" pill instead of an answer.
    if (ans.dismissed) {
      return (
        <div style={{
          marginTop: '4px',
          padding: '3px 8px',
          background: 'rgba(120,120,120,0.08)',
          borderLeft: '2px solid #6a7080',
          borderRadius: '0 3px 3px 0',
          fontSize: '11px',
          color: '#7a8090',
          fontStyle: 'italic',
        }}>
          <span style={{ opacity: 0.7, marginRight: '6px' }}>✗</span>
          dismissed
        </div>
      )
    }

    const q = questions[qIdx]
    const labels = ans.values.map(v => {
      if (v === OTHER_VALUE) return ans.otherText ?? '(other)'
      return q?.options.find(o => o.value === v)?.label ?? v
    })
    if (labels.length === 0) return null
    return (
      <div style={{
        marginTop: '4px',
        padding: '3px 8px',
        background: 'rgba(68,170,255,0.08)',
        borderLeft: '2px solid #4af',
        borderRadius: '0 3px 3px 0',
        fontSize: '11px',
        color: '#4af',
      }}>
        <span style={{ opacity: 0.7, marginRight: '6px' }}>→</span>
        {labels.join(', ')}
      </div>
    )
  }

  const renderQuestion = (q: ChoiceQuestion, qIdx: number) => {
    const sel = selectedByQ[qIdx] ?? new Set<string>()
    const otherChecked = sel.has(OTHER_VALUE)
    const persisted = persistedAnswers?.[qIdx]
    const persistedValues = new Set(persisted?.values ?? [])
    const nameAttr = `choice-${entry.choice_id}-q${qIdx}`

    return (
      <div
        key={qIdx}
        style={{
          marginTop: qIdx === 0 ? 0 : '10px',
          paddingTop: qIdx === 0 ? 0 : '8px',
          borderTop: qIdx === 0 ? 'none' : '1px dashed #2a3040',
        }}
      >
        <div style={{
          color: 'var(--chat-jarvis)',
          fontSize: '13px',
          lineHeight: '1.4',
          marginBottom: '4px',
          fontWeight: questions.length > 1 ? 500 : 400,
        }}>
          {questions.length > 1 && (
            <span style={{ color: assistantLabelColor, marginRight: '6px', fontSize: '10px', fontFamily: 'var(--font-display)' }}>
              Q{qIdx + 1}
            </span>
          )}
          {q.question}
          {q.multi && (
            <span style={{ marginLeft: '6px', fontSize: '9px', color: '#6a7a8a', letterSpacing: '0.5px' }}>· MULTI</span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {q.options.map(opt => {
            const checked = sel.has(opt.value) || (answered && persistedValues.has(opt.value))
            return (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '4px 6px',
                  borderRadius: '3px',
                  cursor: answered ? 'default' : 'pointer',
                  background: checked ? 'rgba(68,170,255,0.08)' : 'transparent',
                  border: checked ? '1px solid rgba(68,170,255,0.3)' : '1px solid transparent',
                  fontSize: '12px',
                  color: 'var(--chat-jarvis)',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={e => { if (!answered && !checked) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)' }}
                onMouseLeave={e => { if (!answered && !checked) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <input
                  type={q.multi ? 'checkbox' : 'radio'}
                  name={nameAttr}
                  checked={checked}
                  disabled={answered}
                  onChange={() => toggle(qIdx, opt.value)}
                  style={{ marginTop: '2px', accentColor: '#4af' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{opt.label}</div>
                  {opt.description && (
                    <div style={{ fontSize: '10px', color: '#6a7a8a', marginTop: '1px' }}>{opt.description}</div>
                  )}
                </div>
              </label>
            )
          })}

          {q.allow_other && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                padding: '4px 6px',
                borderRadius: '3px',
                cursor: answered ? 'default' : 'pointer',
                background: otherChecked || (answered && persistedValues.has(OTHER_VALUE))
                  ? 'rgba(68,170,255,0.08)'
                  : 'transparent',
                border: otherChecked || (answered && persistedValues.has(OTHER_VALUE))
                  ? '1px solid rgba(68,170,255,0.3)'
                  : '1px solid transparent',
                fontSize: '12px',
                color: 'var(--chat-jarvis)',
              }}
            >
              <input
                type={q.multi ? 'checkbox' : 'radio'}
                name={nameAttr}
                checked={otherChecked || (answered && persistedValues.has(OTHER_VALUE))}
                disabled={answered}
                onChange={() => toggle(qIdx, OTHER_VALUE)}
                style={{ marginTop: '2px', accentColor: '#4af' }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontStyle: 'italic', opacity: 0.85 }}>Other (write your own)</div>
                {(otherChecked && !answered) && (
                  <textarea
                    value={otherTextByQ[qIdx] ?? ''}
                    onChange={e => setOtherText(qIdx, e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSubmit()
                      }
                    }}
                    placeholder="Type your answer..."
                    autoFocus
                    rows={2}
                    style={{
                      width: '100%',
                      marginTop: '4px',
                      padding: '4px 6px',
                      background: '#0a0e14',
                      color: 'var(--chat-jarvis)',
                      border: '1px solid #2a3040',
                      borderRadius: '3px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '12px',
                      resize: 'vertical',
                      outline: 'none',
                    }}
                  />
                )}
                {answered && persistedValues.has(OTHER_VALUE) && persisted?.otherText && (
                  <div style={{ fontSize: '11px', color: '#8cf', marginTop: '2px', fontStyle: 'italic' }}>
                    "{persisted.otherText}"
                  </div>
                )}
              </div>
            </label>
          )}
        </div>

        {renderAnswerSummaryFor(qIdx)}
      </div>
    )
  }

  if (questions.length === 0) return null

  const headerLabel = questions.length > 1 ? `CHOICE · ${questions.length} QUESTIONS` : `CHOICE${questions[0].multi ? ' · MULTI' : ''}`

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDownCard}
      style={{
        marginBottom: '8px',
        padding: '8px 10px',
        background: '#11151e',
        border: '1px solid #2a3040',
        borderLeft: '3px solid #4af',
        borderRadius: '4px',
        opacity: answered ? 0.75 : 1,
        outline: 'none',
      }}
    >
      <div style={{
        color: assistantLabelColor,
        fontFamily: 'var(--font-display)',
        fontSize: '9px',
        fontWeight: 600,
        marginBottom: '6px',
        letterSpacing: '0.5px',
      }}>
        {assistantLabel} · {headerLabel}
      </div>

      {questions.map((q, i) => renderQuestion(q, i))}

      {!answered && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
          <div style={{ fontSize: '10px', color: '#4a5a6a', fontFamily: 'var(--font-mono)' }}>
            ⏎ to confirm
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {onDismiss && (
              <button
                onClick={() => onDismiss(index)}
                title="Dismiss this choice — sends '(dismissed)' to JARVIS"
                style={{
                  padding: '4px 12px',
                  fontSize: '11px',
                  fontWeight: 500,
                  letterSpacing: '0.5px',
                  border: '1px solid #3a4050',
                  borderRadius: '3px',
                  background: 'transparent',
                  color: '#7a8090',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#5a6070'
                  e.currentTarget.style.color = '#a0a8b8'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#3a4050'
                  e.currentTarget.style.color = '#7a8090'
                }}
              >
                DISMISS
              </button>
            )}
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              style={{
                padding: '4px 14px',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.5px',
                border: `1px solid ${canSubmit ? '#4af' : '#2a3040'}`,
                borderRadius: '3px',
                background: canSubmit ? 'rgba(68,170,255,0.15)' : 'transparent',
                color: canSubmit ? '#4af' : '#4a5a6a',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              CONFIRM
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export const ChatTimeline = React.memo(function ChatTimeline({
  entries,
  streamingText,
  isStreaming,
  isThinking,
  assistantLabel,
  userLabel = () => 'YOU',
  userLabelColor = () => 'var(--chat-user-label)',
  assistantLabelColor = 'var(--chat-jarvis-label)',
  onToggleExpand,
  onChoiceSubmit,
  pendingQueue = [],
  hiddenChoiceIds,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // "Stick to bottom" — auto-scroll only while the user is already at the
  // bottom of the timeline. If they scrolled up to read older messages,
  // new content appends silently without yanking them away.
  // Threshold: small slack to absorb sub-pixel rounding and natural
  // overscroll on macOS rubber-banding.
  const SCROLL_BOTTOM_THRESHOLD_PX = 32
  const stickToBottomRef = useRef(true)

  // Track scroll position to maintain stickToBottom flag.
  // Mount: snap to bottom (so a freshly-loaded history shows the latest
  // message) and start in sticky mode.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottomRef.current = true

    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll only when sticky. Triggers on entries, streaming text, the
  // queue, AND the thinking state — anything that changes layout below.
  // Exception: if the last entry is a user message that JUST appeared, we
  // always snap to bottom even if the user had scrolled up. Sending a new
  // message implies "I want to see the answer" — staying scrolled up would
  // be disorienting.
  const lastEntryRef = useRef<ChatEntry | null>(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const last = entries[entries.length - 1] ?? null
    const isFreshUserMsg =
      last && last.kind === 'message' && last.role === 'user' && last !== lastEntryRef.current
    lastEntryRef.current = last

    if (isFreshUserMsg) {
      el.scrollTop = el.scrollHeight
      stickToBottomRef.current = true
      return
    }
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries, streamingText, pendingQueue, isThinking])

  const labelFor = (msg: ChatEntry & { kind: 'message' }) => {
    if (msg.role === 'user') return userLabel(msg.source)
    if (msg.source && msg.source !== 'jarvis') return msg.source.toUpperCase()
    return assistantLabel
  }

  const labelColor = (msg: ChatEntry & { kind: 'message' }) => {
    if (msg.role === 'user') return userLabelColor(msg.source)
    if (msg.source && msg.source !== 'jarvis') return '#a6f'
    return assistantLabelColor
  }

  return (
    <div ref={containerRef} style={{ height: '100%', overflowY: 'auto', padding: '8px 12px', fontSize: '14px', fontFamily: 'var(--font-mono)', userSelect: 'text', WebkitUserSelect: 'text' }}>
      {entries.map((entry, i) => {
        if (entry.kind === 'message') {
          return (
            <div key={i} style={{
              color: entry.role === 'user' ? 'var(--chat-user)' : 'var(--chat-jarvis)',
              lineHeight: '1.5',
              marginBottom: '4px',
              ...(entry.role === 'user' ? { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const } : {}),
            }}>
              <div style={{ color: labelColor(entry), fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600, marginBottom: '2px' }}>
                {labelFor(entry)}
              </div>
              {entry.role === 'user' ? (
                <>
                  {entry.text}
                  {entry.images && entry.images.length > 0 && (
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                      {entry.images.map(img => (
                        <div key={img.label} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                          <img
                            src={`data:${img.mediaType};base64,${img.base64}`}
                            alt={img.label}
                            style={{ maxHeight: '120px', maxWidth: '200px', borderRadius: '4px', border: '1px solid var(--panel-border)' }}
                          />
                          <span style={{ fontSize: '8px', color: 'var(--color-muted)' }}>{img.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <MarkdownText text={entry.text} />
              )}
              {entry.aborted && (
                <span style={{ color: '#666', fontStyle: 'italic', marginLeft: '8px', fontSize: '10px' }}>⊘ interrupted</span>
              )}
            </div>
          )
        }

        if (entry.kind === 'thinking_text') {
          // Live (turn still running): show de-emphasized inline text in italic, no toggle.
          // Collapsed (turn ended): show a clickable bar that expands to reveal the text.
          if (entry.live) {
            return (
              <div
                key={i}
                style={{
                  color: 'var(--color-muted, #888)',
                  fontStyle: 'italic',
                  opacity: 0.75,
                  whiteSpace: 'pre-wrap',
                  lineHeight: '1.5',
                  marginBottom: '4px',
                  borderLeft: '2px solid #444',
                  paddingLeft: '8px',
                }}
              >
                <div style={{ color: '#666', fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600, marginBottom: '2px', fontStyle: 'normal', letterSpacing: '0.5px' }}>
                  THINKING
                </div>
                <MarkdownText text={entry.text} />
              </div>
            )
          }

          // Collapsed/expanded historical thinking block.
          const lines = entry.text.split('\n')
          const previewText = lines[0]?.slice(0, 80) ?? ''
          const hasMore = entry.text.length > 80 || lines.length > 1
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: entry.expanded ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #555',
                  background: '#1a1e2e',
                  color: '#888',
                  cursor: 'pointer',
                  fontStyle: 'italic',
                }}
                onClick={() => onToggleExpand(i)}
              >
                <span style={{ marginRight: '4px' }}>💭</span>
                <span style={{ fontStyle: 'normal', fontWeight: 600, letterSpacing: '0.5px' }}>thinking</span>
                {!entry.expanded && previewText && (
                  <span style={{ marginLeft: '6px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '60%', verticalAlign: 'bottom' }}>
                    — {previewText}{hasMore ? '…' : ''}
                  </span>
                )}
                <span style={{ marginLeft: '4px', opacity: 0.5, fontStyle: 'normal' }}>{entry.expanded ? '▾' : '▸'}</span>
              </div>
              {entry.expanded && (
                <div
                  style={{
                    padding: '6px 10px 6px 14px',
                    background: '#0d1117',
                    borderLeft: '3px solid #444',
                    borderRadius: '0 0 4px 4px',
                    fontSize: '12px',
                    color: '#aaa',
                    lineHeight: '1.5',
                    fontStyle: 'italic',
                  }}
                >
                  <MarkdownText text={entry.text} />
                </div>
              )}
            </div>
          )
        }

        if (entry.kind === 'capability') {
          let rawOutput = entry.output ?? ''
          try {
            const parsed = JSON.parse(rawOutput)
            rawOutput = parsed.stdout ?? parsed.text ?? parsed.content ?? parsed.path ?? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed))
          } catch { /* not JSON, use as-is */ }
          rawOutput = rawOutput.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          const outputLines = rawOutput.split('\n').filter(Boolean)
          // isLive: tool is still running and has partial output to show
          const isLive = entry.status === 'running' && outputLines.length > 0
          const LIVE_LINES = 12
          const visibleLines = isLive
            ? outputLines.slice(-LIVE_LINES)
            : entry.expanded
              ? outputLines
              : outputLines.slice(-1)
          const hasMore = !isLive && outputLines.length > 1

          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: visibleLines.length > 0 ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: entry.status === 'running' ? '3px solid #f1fa8c'
                    : entry.status === 'done' ? '3px solid #50fa7b'
                    : '3px solid #666',
                  background: '#1a1e2e',
                  color: entry.status === 'running' ? '#f1fa8c'
                    : entry.status === 'done' ? '#50fa7b'
                    : '#666',
                  cursor: (!isLive && entry.output) ? 'pointer' : 'default',
                }}
                onClick={(!isLive && entry.output) ? () => onToggleExpand(i) : undefined}
              >
                {entry.status === 'running' && <span style={{ animation: 'pulse 1.5s infinite', display: 'inline-block' }}>⚡</span>}
                {entry.status === 'done' && '✓'}
                {entry.status === 'cancelled' && '⊘'}
                {' '}<strong>{entry.name}</strong>
                {entry.args && <span style={{ opacity: 0.7, marginLeft: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '60%', verticalAlign: 'bottom' }}>{entry.args}</span>}
                {entry.status === 'done' && entry.ms != null && <span style={{ marginLeft: '4px' }}>{entry.ms}ms</span>}
                {entry.status === 'cancelled' && <span style={{ fontStyle: 'italic' }}> interrupted</span>}
                {hasMore && <span style={{ marginLeft: '4px', opacity: 0.5 }}>{entry.expanded ? '▾' : '▸'}</span>}
                {/* ⤢ open delegate worker chat panel.
                    During running: workerLabel from __delegate_worker: progress chunk.
                    After done: workerLabel from worker.label in output JSON. */}
                {(entry.name === 'delegate task' || entry.name === 'delegate read task') && (() => {
                  let workerLabel: string | undefined
                  // 1. progress chunk (running or done)
                  const m = (entry.output ?? '').match(/__delegate_worker:([a-z0-9-]+)/)
                  if (m) workerLabel = m[1]
                  // 2. output JSON (done)
                  if (!workerLabel) try { workerLabel = JSON.parse(entry.output ?? '{}')?.worker?.label } catch {}
                  if (!workerLabel) return null
                  const pieceId = `delegate-chat-${workerLabel}`
                  return (
                    <span
                      title={`Open worker chat: ${workerLabel}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        fetch('/hud/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pieceId }) })
                      }}
                      style={{ marginLeft: '8px', cursor: 'pointer', opacity: entry.status === 'running' ? 1 : 0.7, fontSize: '12px' }}
                    >⤢</span>
                  )
                })()}
              </div>
              {visibleLines.length > 0 && (
                <div
                  style={{
                    padding: '4px 8px 4px 14px',
                    background: '#0d1117',
                    borderLeft: isLive ? '3px solid rgba(241,250,140,0.3)' : '3px solid #333',
                    borderRadius: '0 0 4px 4px',
                    fontSize: '9px',
                    color: isLive ? '#c8c8c8' : '#888',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: isLive ? '180px' : (entry.expanded ? 'none' : '16px'),
                    overflowY: isLive ? 'auto' : 'hidden',
                    cursor: (!isLive && hasMore) ? 'pointer' : 'default',
                    lineHeight: '1.4',
                    fontFamily: 'var(--font-mono)',
                  }}
                  onClick={(!isLive && hasMore) ? () => onToggleExpand(i) : undefined}
                >
                  {isLive && outputLines.length > LIVE_LINES && (
                    <span style={{ display: 'block', color: '#555', marginBottom: '2px', fontSize: '8px' }}>
                      … {outputLines.length - LIVE_LINES} earlier lines
                    </span>
                  )}
                  {visibleLines.join('\n')}
                  {isLive && <span style={{ display: 'inline-block', width: '5px', height: '10px', background: '#f1fa8c88', marginLeft: '2px', animation: 'blink 1s infinite', verticalAlign: 'middle' }} />}
                </div>
              )}
            </div>
          )
        }

        if (entry.kind === 'bash_result') {
          const ok = entry.exitCode === 0
          const lines = entry.output ? entry.output.split('\n') : []
          const previewLines = lines.slice(-3)
          const hasMore = lines.length > 3
          const visibleLines = entry.expanded ? lines : previewLines

          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: (entry.output && visibleLines.length > 0) ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: ok ? '3px solid #50fa7b' : '3px solid #ff5555',
                  background: '#1a1e2e',
                  color: ok ? '#50fa7b' : '#ff5555',
                  cursor: hasMore ? 'pointer' : 'default',
                  fontFamily: 'var(--font-mono)',
                }}
                onClick={hasMore ? () => onToggleExpand(i) : undefined}
              >
                <span style={{ opacity: 0.6 }}>$</span>{' '}
                <strong>{entry.command}</strong>
                <span style={{ marginLeft: '8px', opacity: 0.6 }}>{entry.ms}ms · exit {entry.exitCode}</span>
                {hasMore && <span style={{ marginLeft: '4px', opacity: 0.5 }}>{entry.expanded ? '▾' : '▸'}</span>}
              </div>
              {entry.output && visibleLines.length > 0 && (
                <div
                  style={{
                    padding: '4px 8px 4px 14px',
                    background: '#111420',
                    borderLeft: ok ? '3px solid #50fa7b44' : '3px solid #ff555544',
                    borderRadius: '0 0 4px 4px',
                    fontSize: '9px',
                    color: ok ? '#aaa' : '#ff8888',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    lineHeight: '1.4',
                    cursor: hasMore ? 'pointer' : 'default',
                  }}
                  onClick={hasMore ? () => onToggleExpand(i) : undefined}
                >
                  {visibleLines.join('\n')}
                  {!entry.expanded && hasMore && (
                    <span style={{ display: 'block', color: '#666', marginTop: '2px' }}>
                      … {lines.length - 3} more lines
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        }

        if (entry.kind === 'choice') {
          // Hide inline if an anchor for this choice is currently rendered
          // above the composer. Once the anchor is removed (after answer),
          // the inline card reappears — by then it carries `answers` and
          // renders as the answered/historical form.
          if (hiddenChoiceIds?.has(entry.choice_id)) return null
          return (
            <ChoiceCard
              key={i}
              index={i}
              entry={entry}
              onSubmit={onChoiceSubmit}
              assistantLabel={assistantLabel}
              assistantLabelColor={assistantLabelColor}
            />
          )
        }

        if (entry.kind === 'compaction_pending') {
          const beforeK = Math.round(entry.tokensBefore / 1000)
          const reasonLabel =
            entry.reason === 'forced' ? 'forced' :
            entry.reason === 'growth' ? 'abrupt growth' :
            entry.reason === 'sliding-window' ? 'sliding window' :
            'threshold'
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #ffb86c',
                  background: '#1a1e2e',
                  color: '#ffb86c',
                  fontFamily: 'var(--font-mono)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span style={{ animation: 'pulse 1.5s infinite', display: 'inline-block' }}>⏳</span>
                <span>Compacting context — {beforeK}K tokens ({reasonLabel})…</span>
              </div>
            </div>
          )
        }

        if (entry.kind === 'compaction_failed') {
          const beforeK = Math.round(entry.tokensBefore / 1000)
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #ff5555',
                  background: '#1a1e2e',
                  color: '#ff5555',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                ⚠ Compaction failed — history preserved ({beforeK}K tokens intact)
                <div style={{ marginTop: '2px', fontSize: '9px', color: '#888', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {entry.reason}
                </div>
              </div>
            </div>
          )
        }

        if (entry.kind === 'compaction') {
          const beforeK = Math.round(entry.tokensBefore / 1000)
          const afterK = Math.round(entry.tokensAfter / 1000)
          const badge =
            entry.engine === 'fallback' ? ' (fallback)' :
            entry.engine === 'sliding-window' ? ' (sliding window)' :
            ''
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: entry.expanded ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #8be9fd',
                  background: '#1a1e2e',
                  color: '#8be9fd',
                  cursor: 'pointer',
                }}
                onClick={() => onToggleExpand(i)}
              >
                Context compacted — {beforeK}K → {afterK}K tokens{badge}
                <span style={{ marginLeft: '4px', opacity: 0.5 }}>{entry.expanded ? '▾' : '▸'}</span>
              </div>
              {entry.expanded && (
                <div style={{
                  padding: '4px 8px 4px 14px',
                  background: '#111420',
                  borderLeft: '3px solid #333',
                  borderRadius: '0 0 4px 4px',
                  fontSize: '9px',
                  color: '#888',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '200px',
                  overflowY: 'auto',
                  lineHeight: '1.4',
                }}>
                  {entry.summary}
                </div>
              )}
            </div>
          )
        }

        if (entry.kind === 'error') {
          // "aborted" is a user-initiated cancel — render as a subtle grey note,
          // not a red error banner (the user already clicked Stop).
          const raw = entry.message ?? ''
          if (raw === 'aborted') {
            return (
              <div key={i} style={{ marginBottom: '4px' }}>
                <div style={{
                  padding: '4px 10px',
                  fontSize: '10px',
                  color: '#666',
                  fontFamily: 'var(--font-mono)',
                  fontStyle: 'italic',
                }}>— stopped —</div>
              </div>
            )
          }
          // For real API errors (now pre-formatted by the backend as "[STATUS] type: msg"),
          // display as-is. Fallback: try to extract inner message from legacy raw JSON.
          const inner = raw.match(/"message":"([^"]+)"/)?.[1]
            ?? raw.match(/message: ([^,}\n]+)/)?.[1]
            ?? raw.slice(0, 200)
          return (
            <div key={i} style={{ marginBottom: '4px' }}>
              <div
                style={{
                  padding: '6px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  borderLeft: '3px solid #ff5555',
                  background: '#2a1a1a',
                  color: '#ff7070',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--font-mono)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '6px',
                }}
              >
                <span style={{ flexShrink: 0 }}>⚠</span>
                <span>{inner}</span>
              </div>
            </div>
          )
        }

        if (entry.kind === 'system') {
          // Generic system notification. Plain text, optionally collapsible
          // if `detail` is present. `subtype` is forwarded verbatim — the
          // core stays agnostic; no plugin-specific branches here.
          const hasDetail = !!entry.detail
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: hasDetail ? (entry.expanded ? '4px 4px 0 0' : '4px') : '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #f1fa8c',
                  background: '#1a1e2e',
                  color: '#f1fa8c',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--font-mono)',
                  cursor: hasDetail ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                onClick={hasDetail ? () => onToggleExpand(i) : undefined}
              >
                <span style={{ flex: 1 }}>{entry.text}</span>
                {hasDetail && (
                  <span style={{ opacity: 0.5, flexShrink: 0 }}>
                    {entry.expanded ? '▾' : '▸'}
                  </span>
                )}
              </div>
              {hasDetail && entry.expanded && (
                <div style={{
                  padding: '6px 10px 6px 14px',
                  background: '#0d1117',
                  borderLeft: '3px solid #f1fa8c44',
                  borderRadius: '0 0 4px 4px',
                  fontSize: '10px',
                  color: '#c8c860',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word' as const,
                  lineHeight: '1.5',
                  fontFamily: 'var(--font-mono)',
                  maxHeight: '300px',
                  overflowY: 'auto' as const,
                }}>
                  {entry.detail}
                </div>
              )}
            </div>
          )
        }

        if (entry.kind === 'timeline_entry') {
          return (
            <TimelineEntryRenderer
              key={i}
              index={i}
              entry={entry}
              onToggleExpand={onToggleExpand}
            />
          )
        }

        return null
      })}

      {isThinking && !streamingText && (() => {
        const hasRunning = entries.some(e => e.kind === 'capability' && e.status === 'running')
        return (
          <div style={{ color: '#666', lineHeight: '1.5', marginBottom: '4px' }}>
            <span style={{ color: assistantLabelColor, marginRight: '8px', fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600, opacity: 0.6 }}>{assistantLabel}</span>
            <span style={{ fontStyle: 'italic', animation: 'pulse 1.5s infinite', display: 'inline-block' }}>
              {hasRunning ? 'working...' : 'thinking...'}
            </span>
          </div>
        )
      })()}

      {streamingText && (
        <div style={{ color: 'var(--chat-jarvis)', whiteSpace: 'pre-wrap', lineHeight: '1.5', marginBottom: '4px' }}>
          <span style={{ color: assistantLabelColor, marginRight: '8px', fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600 }}>{assistantLabel}</span>
          <MarkdownText text={streamingText} />
          {isStreaming && <span className="streaming-cursor" />}
        </div>
      )}

      {/*
        Queued user messages — rendered as faint cards directly under the
        thinking/streaming indicator. They become real user messages once the
        backend drains the queue. Visual hierarchy: less prominent than real
        messages (italic, low opacity) so the user reads them as "in flight".
      */}
      {pendingQueue.length > 0 && (
        <div style={{ marginTop: '6px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '9px', letterSpacing: '1.5px', color: '#5a6c8a', textTransform: 'uppercase', fontFamily: 'var(--font-display)', marginBottom: '2px' }}>
            queued · {pendingQueue.length}
          </div>
          {pendingQueue.map((item, idx) => (
            <div
              key={idx}
              style={{
                background: 'rgba(120, 180, 255, 0.05)',
                border: '1px dashed rgba(120, 180, 255, 0.18)',
                borderRadius: '6px',
                padding: '6px 10px',
                fontSize: '12px',
                color: 'rgba(207, 216, 232, 0.6)',
                fontStyle: 'italic',
                lineHeight: '1.4',
                position: 'relative',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '5px',
                  height: '5px',
                  background: 'rgba(120, 180, 255, 0.5)',
                  borderRadius: '50%',
                  marginRight: '8px',
                  verticalAlign: 'middle',
                  animation: 'pulse 1.8s infinite',
                }}
              />
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {item.text}
                {item.hasImages && (
                  <span style={{ marginLeft: '6px', fontSize: '10px', opacity: 0.7 }}>📎</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        .streaming-cursor {
          display: inline-block;
          width: 7px;
          height: 12px;
          background: #50fa7b;
          animation: blink 1s infinite;
          vertical-align: middle;
          margin-left: 2px;
        }
      `}</style>
    </div>
  )
})
