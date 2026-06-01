import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from 'react'
import { ChatTimeline, type ChatEntry } from './ChatTimeline'
import { ChatAnchorSlot } from './ChatAnchorSlot'
import { chatAnchorRegistry, useAnchors } from '../../hooks/useChatAnchors'
import { SlashMenu } from './SlashMenu'
import { ModelPicker } from './ModelPicker'

interface PendingImage {
  label: string
  base64: string
  mediaType: string
  thumbnail: string
}

interface ChatPanelFeatures {
  slashMenu?: boolean
  images?: boolean
  compaction?: boolean
  modelPicker?: boolean
}

/**
 * ChatPanel — session-scoped chat UI.
 *
 * Receives a sessionId as the single identity for the conversation. Derives
 * all HTTP endpoints from it. Core/plugins differ only in how they compose a
 * sessionId (e.g. "main" for the root chat, "actor-<name>" for per-actor
 * chats) — this component does not know or care about the naming scheme.
 */
interface ChatPanelProps {
  sessionId: string
  assistantLabel: string
  features?: ChatPanelFeatures
  userLabel?: (source?: string) => string
  userLabelColor?: (source?: string) => string
}

let imageCounter = 0

const defaultFeatures: ChatPanelFeatures = {
  slashMenu: true,
  images: true,
  compaction: true,
  modelPicker: true,
}

const defaultUserLabel = (source?: string) => {
  if (!source || source === 'chat' || source === 'you') return 'YOU'
  if (source === 'jarvis') return 'JARVIS'
  if (source === 'main') return 'MAIN'
  if (source === 'grpc') return 'GRPC'
  // actor-alice → ALICE, actor-crash → CRASH
  if (source.startsWith('actor-')) return source.slice(6).toUpperCase()
  return source.toUpperCase()
}

const defaultUserLabelColor = (source?: string) => {
  if (!source || source === 'chat' || source === 'you') return 'var(--chat-user-label)'
  if (source === 'system') return '#fa4'
  if (source === 'jarvis') return '#4af'
  if (source === 'main') return '#4af'
  if (source === 'grpc') return '#fa4'
  if (source.startsWith('actor-')) return '#a6f'
  return '#4af'
}

export function ChatPanel({
  sessionId,
  assistantLabel,
  features: featuresProp,
  userLabel: userLabelProp,
  userLabelColor: userLabelColorProp,
}: ChatPanelProps) {
  if (!sessionId) {
    throw new Error('ChatPanel requires a non-empty sessionId prop')
  }

  // All endpoints are derived from sessionId — a single source of identity.
  const streamUrl = `/chat-stream?sessionId=${encodeURIComponent(sessionId)}`
  const historyUrl = `/chat/history?sessionId=${encodeURIComponent(sessionId)}`
  const sendUrl = `/chat/send`
  const abortUrl = `/chat/abort`
  const clearUrl = `/chat/clear-session`
  const compactUrl = `/chat/compact`

  const features = useMemo(() => ({ ...defaultFeatures, ...featuresProp }), [featuresProp])
  const getUserLabel = useMemo(() => userLabelProp ?? defaultUserLabel, [userLabelProp])
  const getUserLabelColor = useMemo(() => userLabelColorProp ?? defaultUserLabelColor, [userLabelColorProp])

  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [slashActive, setSlashActive] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const toolStartTimes = useRef(new Map<string, number>())

  // Pending choice cards — buffered while a turn is still streaming, so the
  // card always lands at the END of the assistant turn instead of being
  // injected mid-stream. Flushed on `done`/`error`/`aborted` or when the
  // turn settles (no streaming text and no running capability).
  const pendingChoices = useRef<Array<Extract<ChatEntry, { kind: 'choice' }>>>([])

  // Queued user messages — sent by the user while the session was busy,
  // mirrored from the backend's pendingPrompts queue via SSE `pending_queue`.
  // They render as faint cards under the JARVIS thinking indicator until the
  // backend drains them and they materialize as real user messages.
  const [pendingQueue, setPendingQueue] = useState<Array<{ text: string; source?: string; hasImages?: boolean }>>([])

  // Mirror of streaming/thinking state read inside the SSE callback — that
  // useEffect closes over initial values, so reading state directly there
  // would be stale. Refs stay current.
  const isStreamingRef = useRef(false)
  const isThinkingRef = useRef(false)

  /** Append all buffered choice cards to entries. Safe to call multiple times. */
  const flushPendingChoices = useCallback(() => {
    if (pendingChoices.current.length === 0) return
    const toAppend = pendingChoices.current
    pendingChoices.current = []
    setEntries(prev => [...prev, ...toAppend])
  }, [])

  // Reset conversation state when sessionId changes (panels reused across sessions)
  useEffect(() => {
    setEntries([])
    setStreamingText('')
    setIsStreaming(false)
    setIsThinking(false)
    toolStartTimes.current.clear()
    pendingChoices.current = []
    setPendingQueue([])
  }, [sessionId])

  // Keep refs in sync so the SSE callback below can read the live values.
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
  useEffect(() => { isThinkingRef.current = isThinking }, [isThinking])

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    el.style.height = `${scrollH}px`
    const maxH = window.innerHeight * 0.3
    el.style.overflowY = scrollH > maxH ? 'auto' : 'hidden'
  }, [])

  useEffect(() => { autoResize() }, [input, autoResize])

  useEffect(() => {
    if (features.slashMenu && input.startsWith('/')) {
      setSlashActive(true)
      setSlashQuery(input.slice(1))
    } else {
      setSlashActive(false)
      setSlashQuery('')
    }
  }, [input, features.slashMenu])

  // Hydrate from session history for reconnect/detach
  useEffect(() => {
    fetch(historyUrl)
      .then(r => r.json())
      .then((history: ChatEntry[] | Array<{ role: string; text: string; source?: string }>) => {
        if (!history || history.length === 0) return
        if ('kind' in history[0]) {
          setEntries(history as ChatEntry[])
        } else {
          setEntries((history as Array<{ role: string; text: string; source?: string }>).map(m => ({
            kind: 'message' as const,
            role: m.role === 'user' ? 'user' as const : 'assistant' as const,
            text: m.text,
            source: m.source,
          })))
        }
      })
      .catch(() => {})
  }, [historyUrl])

  // SSE stream scoped to this sessionId
  useEffect(() => {
    const source = new EventSource(streamUrl)

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)

      switch (data.type) {
        // Authoritative state snapshot from the backend stack.
        // Takes precedence over inferred state from individual events.
        // idle → clear thinking+streaming; processing → thinking; waiting_tools → thinking.
        case 'session_state':
          if (data.state === 'idle') {
            setIsThinking(false)
            setIsStreaming(false)
          } else {
            // processing or waiting_tools → session is active
            setIsThinking(true)
          }
          break
        case 'user':
          setEntries(prev => [...prev, { kind: 'message', role: 'user', text: data.text, images: data.images, source: data.source, session: data.session }])
          setIsThinking(true)
          break
        case 'delta':
          setIsThinking(false)
          setIsStreaming(true)
          setStreamingText(prev => prev + data.text)
          break
        case 'done':
          setIsStreaming(false)
          // isThinking is managed by session_state — do not set it here.
          // session_state:idle arrives before/with 'done' and is authoritative.
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          // Turn finished — collapse intermediate `thinking_text` entries and
          // promote the last one to a proper `message` if streamingText was empty.
          //
          // This handles the pattern: model responds (text → thinking_text on
          // tool_start) → tool calls (e.g. memory_reinforce) → no further deltas
          // → done arrives with streamingText=''. Without this, the assistant
          // response stays trapped in a thinking_text entry and never appears as
          // a message in the timeline.
          setEntries(prev => {
            // Find the last live thinking_text entry — that is the final assistant
            // response when no deltas were emitted after the last tool call.
            const lastLiveIdx = (() => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].kind === 'thinking_text' && (prev[i] as any).live) return i
              }
              return -1
            })()
            // Only promote if there is no assistant message entry already for
            // this turn (i.e. streamingText was empty when done fired).
            const hasMessageAfterLastTool = prev.some((e, i) =>
              e.kind === 'message' && (e as any).role === 'assistant' && i > lastLiveIdx
            )
            return prev.map((e, i) => {
              if (e.kind !== 'thinking_text' || !(e as any).live) return e
              const isLast = i === lastLiveIdx
              if (isLast && !hasMessageAfterLastTool && lastLiveIdx !== -1) {
                // Promote: convert the last live thinking_text to a message entry.
                return { kind: 'message', role: 'assistant', text: (e as any).text, source: (e as any).source, session: (e as any).session } as any
              }
              // All other live thinking_text entries collapse normally.
              return { ...e, live: false, expanded: false }
            })
          })
          // Turn finished — choice cards captured during the turn now land
          // at the very end of the conversation, AFTER any final assistant text.
          flushPendingChoices()
          break
        case 'error':
          setIsStreaming(false)
          // isThinking managed by session_state — authoritative source.
          setStreamingText('')
          setEntries(prev => [
            // Collapse any live thinking_text from this turn before appending the error.
            ...prev.map(e => e.kind === 'thinking_text' && e.live ? { ...e, live: false, expanded: false } : e),
            { kind: 'error', message: data.error ?? 'Unknown error', source: data.source, session: data.session },
          ])
          // Even on error, surface the buffered cards so the user isn't blocked.
          flushPendingChoices()
          break
        case 'tool_start':
          // Skip jarvis_ask_choice — the choice card (kind:'choice') replaces
          // the default capability entry for this tool.
          if (data.name === 'jarvis_ask_choice') break
          setStreamingText(prev => {
            if (prev) {
              setIsStreaming(false)
              // Intermediate text between tool calls is "thinking out loud" —
              // record as `thinking_text` (live) so it gets de-emphasized now and
              // collapsed when the turn ends. The final answer lands separately
              // as a `message` entry on `done`.
              setEntries(msgs => [...msgs, { kind: 'thinking_text', text: prev, source: data.source, session: data.session, live: true, expanded: true }])
            }
            return ''
          })
          toolStartTimes.current.set(data.id, Date.now())
          setEntries(prev => [...prev, { kind: 'capability', name: data.name, id: data.id, args: data.args, status: 'running' }])
          setIsThinking(true)
          break
        case 'tool_done': {
          if (data.name === 'jarvis_ask_choice') break
          const startTime = toolStartTimes.current.get(data.id)
          const ms = startTime ? Date.now() - startTime : undefined
          toolStartTimes.current.delete(data.id)
          setEntries(prev => prev.map(e =>
            e.kind === 'capability' && e.id === data.id ? { ...e, status: 'done' as const, ms, output: data.output } : e
          ))
          setEntries(prev => {
            const hasRunning = prev.some(e => e.kind === 'capability' && e.status === 'running')
            if (!hasRunning) setIsThinking(true)
            return prev
          })
          break
        }
        case 'tool_progress':
          // Live stdout chunk from a running capability — append to its output
          // so the user can watch progress in real time (e.g. npm install, build).
          setEntries(prev => prev.map(e => {
            if (e.kind !== 'capability' || e.id !== data.id) return e
            return { ...e, output: ((e.output ?? '') + (data.chunk ?? '')), expanded: true }
          }))
          break
        case 'tool_cancelled':
          if (data.name === 'jarvis_ask_choice') break
          toolStartTimes.current.delete(data.id)
          setEntries(prev => prev.map(e =>
            e.kind === 'capability' && e.id === data.id ? { ...e, status: 'cancelled' as const } : e
          ))
          break
        case 'aborted':
          setIsStreaming(false)
          // Do NOT setIsThinking(false) here — session_state is the authoritative
          // source. If drainQueue fires immediately after abort, session_state:processing
          // arrives in the same SSE flush and must win. Letting aborted reset isThinking
          // causes a race where the drain's thinking indicator gets wiped.
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session, aborted: true }])
            }
            return ''
          })
          // Collapse intermediate thinking_text entries from this turn.
          setEntries(prev => prev.map(e =>
            e.kind === 'thinking_text' && e.live ? { ...e, live: false, expanded: false } : e
          ))
          flushPendingChoices()
          break
        case 'compaction_start':
          if (!features.compaction) break
          // Engine B (fallback / forced) is about to summarize — show a live
          // banner so the user sees that compaction is in progress. Engine A
          // (server-side) does NOT emit start; it's instantaneous from here.
          setEntries(prev => [...prev, {
            kind: 'compaction_pending',
            engine: 'fallback',
            tokensBefore: data.tokensBefore ?? 0,
            reason: data.reason,
            startedAt: Date.now(),
          }])
          break
        case 'compaction':
          if (!features.compaction) break
          setIsThinking(false)
          setIsStreaming(false)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          // Compaction implies the turn ended — collapse any live thinking_text.
          setEntries(prev => prev.map(e =>
            e.kind === 'thinking_text' && e.live ? { ...e, live: false, expanded: false } : e
          ))
          // If a `compaction_pending` banner exists (Engine B path), REPLACE
          // it in place — keeps timeline ordering clean. Otherwise just
          // append the final entry (Engine A path: no pending banner ever).
          setEntries(prev => {
            const finalEntry = {
              kind: 'compaction' as const,
              engine: (data.engine ?? 'api') as 'api' | 'fallback',
              tokensBefore: data.tokensBefore ?? 0,
              tokensAfter: data.tokensAfter ?? 0,
              summary: data.summary ?? '',
            }
            // Replace the LAST compaction_pending entry (most recent first wins
            // if there are multiple — shouldn't happen in practice).
            for (let idx = prev.length - 1; idx >= 0; idx--) {
              if (prev[idx].kind === 'compaction_pending') {
                const next = prev.slice()
                next[idx] = finalEntry
                return next
              }
            }
            return [...prev, finalEntry]
          })
          break
        case 'session_cleared':
          setEntries([])
          setStreamingText('')
          setIsStreaming(false)
          setIsThinking(false)
          // Drop any buffered cards — they belonged to the wiped session.
          pendingChoices.current = []
          setPendingQueue([])
          // Drop all anchors for this session.
          chatAnchorRegistry.clear(sessionId)
          break
        case 'anchor.set':
        case 'anchor.remove':
        case 'anchor.clear':
          // Generic anchor channel — applies regardless of source piece/plugin.
          // Defensive: ignore events whose sessionId doesn't match this panel.
          if (data?.sessionId && data.sessionId !== sessionId) break
          chatAnchorRegistry.applySSEEvent({
            type: data.type,
            sessionId: data.sessionId ?? sessionId,
            anchor: data.anchor,
            anchorId: data.anchorId,
          })
          break
        case 'system':
          // System notifications — shown in chat timeline but never sent to LLM.
          if (data?.session && data.session !== sessionId) break
          setEntries(prev => [...prev, {
            kind: 'system',
            text: data.text ?? '',
            subtype: data.subtype,
            detail: data.detail,
            session: data.session,
          }])
          break
        case 'timeline_entry': {
          // Generic plugin timeline entry. The `entry` payload carries `text`
          // (fallback), optional `renderer` (external plugin component), and
          // `payload` (structured data for that component). The ChatPanel
          // stays completely agnostic — it just passes the entry through.
          const e = data?.entry
          if (!e) break
          if (e.sessionId && e.sessionId !== sessionId) break
          setEntries(prev => [...prev, {
            kind: 'timeline_entry',
            text: e.text ?? '',
            rendererKind: e.rendererKind,
            renderer: e.renderer,
            payload: e.payload,
            session: e.sessionId ?? sessionId,
          }])
          break
        }
        case 'pending_queue':
          // Backend snapshot of the user-message queue for this session.
          // Empty array clears the UI list (drained or aborted).
          setPendingQueue(Array.isArray(data.items) ? data.items : [])
          break
        case 'choice': {
          // DO NOT clear streaming state here — we want the assistant text
          // that's currently mid-flight to keep streaming and finish naturally.
          // The card itself is BUFFERED and only flushed when the turn ends
          // (`done` / `error` / `aborted`), so it always lands at the bottom,
          // never injected mid-stream.

          // Normalize: prefer `questions[]`, fall back to legacy single-question fields
          const questions = Array.isArray(data.questions) && data.questions.length > 0
            ? data.questions.map((q: any) => ({
                question: String(q.question ?? ''),
                options: Array.isArray(q.options) ? q.options : [],
                multi: !!q.multi,
                allow_other: q.allow_other !== false,
              }))
            : [{
                question: String(data.question ?? ''),
                options: Array.isArray(data.options) ? data.options : [],
                multi: !!data.multi,
                allow_other: data.allow_other !== false,
              }]

          const card: Extract<ChatEntry, { kind: 'choice' }> = {
            kind: 'choice',
            choice_id: data.choice_id,
            questions,
          }
          pendingChoices.current.push(card)

          // Edge case: if the turn isn't streaming AND nothing is thinking
          // when the choice arrives (e.g. a deferred capability triggered it
          // outside of a normal turn flow), flush immediately so the card
          // doesn't get stuck in the buffer. Use refs because state read
          // inside this SSE callback would be stale.
          if (!isStreamingRef.current && !isThinkingRef.current) {
            flushPendingChoices()
          }
          break
        }
      }
    }

    return () => source.close()
  }, [streamUrl, features.compaction, flushPendingChoices])

  // ESC to abort — fires when this panel's textarea has focus
  useEffect(() => {
    const handleEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && panelRef.current?.contains(document.activeElement)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        fetch(abortUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {})
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [abortUrl, sessionId])

  const send = (overrideText?: string) => {
    const prompt = (overrideText ?? input).trim()
    if (!prompt && images.length === 0) return

    const text = prompt || (images.length > 0 ? images.map(i => i.label).join(', ') : '')
    const payload: Record<string, unknown> = {
      sessionId,
      prompt: text,
      ...(features.images && images.length > 0
        ? { images: images.map(({ label, base64, mediaType }) => ({ label, base64, mediaType })) }
        : {}),
    }

    setInput('')
    setImages([])
    setSlashActive(false)
    fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
    textareaRef.current?.focus()
  }

  const handleSlashSelect = useCallback((name: string) => {
    setSlashActive(false)
    setSlashQuery('')
    setInput('')

    if (name === 'clear_session') {
      fetch(clearUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {})
      textareaRef.current?.focus()
      return
    }
    if (name === 'compact') {
      fetch(compactUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {})
      textareaRef.current?.focus()
      return
    }

    send(`use /${name}`)
  }, [sessionId, clearUrl, compactUrl, images])

  const handleSlashClose = useCallback(() => {
    setSlashActive(false)
    setInput('')
  }, [])

  const handleKey = (e: KeyboardEvent) => {
    if (slashActive && ['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(e.key)) return
    if (slashActive && e.key === 'Enter' && !e.shiftKey) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }

  const handlePaste = (e: ClipboardEvent) => {
    if (!features.images) return
    const items = e.clipboardData?.items
    if (!items) return

    const hasText = Array.from(items).some(i => i.type === 'text/plain')
    const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'))

    if (imageItems.length === 0 || hasText) return

    e.preventDefault()
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const [header, base64] = dataUrl.split(',')
        const mediaType = header.split(':')[1].split(';')[0]
        imageCounter++
        const label = `Image #${imageCounter}`
        setImages(prev => [...prev, { label, base64, mediaType, thumbnail: dataUrl }])
      }
      reader.readAsDataURL(file)
    }
  }

  const removeImage = (label: string) => {
    setImages(prev => prev.filter(i => i.label !== label))
  }

  const handleChoiceSubmit = useCallback((index: number, answers: { values: string[]; otherText?: string }[]) => {
    // Build prompt from captured questions+answers BEFORE mutating state
    let questionsSnapshot: Array<{ question: string; options: { value: string; label: string }[]; multi: boolean }> = []

    setEntries(prev => {
      const target = prev[index]
      if (!target || target.kind !== 'choice') return prev
      // Snapshot questions (prefer new shape, fall back to legacy fields)
      if (Array.isArray(target.questions) && target.questions.length > 0) {
        questionsSnapshot = target.questions.map(q => ({
          question: q.question,
          options: q.options,
          multi: q.multi,
        }))
      } else if (target.question) {
        questionsSnapshot = [{
          question: target.question,
          options: target.options ?? [],
          multi: !!target.multi,
        }]
      }
      return prev.map((e, i) => {
        if (i !== index) return e
        if (e.kind !== 'choice') return e
        return { ...e, answers }
      })
    })

    if (questionsSnapshot.length === 0) return

    // Serialize: "[choice] q → answer" (single) or "[choice]\nq1 → a1\nq2 → a2" (multi)
    const lineFor = (qi: number): string => {
      const q = questionsSnapshot[qi]
      const a = answers[qi]
      if (!q || !a) return ''
      const labels = a.values.map(v => {
        if (v === '__other__') return a.otherText ?? '(other)'
        return q.options.find(o => o.value === v)?.label ?? v
      })
      const joined = q.multi ? labels.join(', ') : (labels[0] ?? '')
      return `${q.question} → ${joined}`
    }

    const prompt = questionsSnapshot.length === 1
      ? `[choice] ${lineFor(0)}`
      : `[choice]\n${questionsSnapshot.map((_, i) => lineFor(i)).filter(Boolean).join('\n')}`

    fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt }),
    }).catch(() => {})
  }, [sendUrl, sessionId])

  // ── Anchor submit ─────────────────────────────────────────────────────
  // Choice anchors render via the shared ChoiceCard. When the user confirms,
  // we serialize the prompt the same way as inline submits, dispatch it,
  // and remove the anchor. The matching kind:'choice' history entry will be
  // reconstructed from tool_use on next history fetch — no inline tweak
  // needed because the inline copy was hidden while the anchor was active.
  const handleAnchorChoiceSubmit = useCallback(
    (anchorId: string, answers: { values: string[]; otherText?: string }[]) => {
      // Pull the anchor from the live registry to grab the questions snapshot.
      const all = chatAnchorRegistry.dump()[sessionId] ?? []
      const anchor = all.find(a => a.id === anchorId)
      if (!anchor) return
      const payload = anchor.payload as
        | { choice_id: string; questions: Array<{ question: string; options: { value: string; label: string }[]; multi: boolean }> }
        | undefined
      if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) return

      const lineFor = (qi: number): string => {
        const q = payload.questions[qi]
        const a = answers[qi]
        if (!q || !a) return ''
        const labels = a.values.map(v => {
          if (v === '__other__') return a.otherText ?? '(other)'
          return q.options.find(o => o.value === v)?.label ?? v
        })
        const joined = q.multi ? labels.join(', ') : (labels[0] ?? '')
        return `${q.question} → ${joined}`
      }
      const prompt = payload.questions.length === 1
        ? `[choice] ${lineFor(0)}`
        : `[choice]\n${payload.questions.map((_, i) => lineFor(i)).filter(Boolean).join('\n')}`

      // Optimistically remove the anchor — backend will also send anchor.remove
      // when it observes the [choice] reply, so this is double-safe.
      chatAnchorRegistry.remove(sessionId, anchorId)

      fetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, prompt }),
      }).catch(() => {})
    },
    [sendUrl, sessionId],
  )

  // Dismiss a choice anchor — sends a "(dismissed)" reply so the AI knows the
  // user closed the prompt without answering, then optimistically removes the
  // anchor. Backend's [choice] observer also publishes anchor.remove, making
  // this idempotent.
  const handleAnchorChoiceDismiss = useCallback(
    (anchorId: string) => {
      const all = chatAnchorRegistry.dump()[sessionId] ?? []
      const anchor = all.find(a => a.id === anchorId)
      const payload = anchor?.payload as
        | { questions?: Array<{ question: string }> }
        | undefined
      // Build a minimal but recognizable "[choice] ... → (dismissed)" line so
      // consumeChoiceAnswer can pair it with the matching pending entry in
      // history reconstruction.
      const firstQ = payload?.questions?.[0]?.question?.trim() ?? ''
      const prompt = firstQ
        ? `[choice] ${firstQ} → (dismissed)`
        : `[choice] (dismissed)`

      chatAnchorRegistry.remove(sessionId, anchorId)

      fetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, prompt }),
      }).catch(() => {})
    },
    [sendUrl, sessionId],
  )

  // Drop all anchors of this session whenever the panel is reused for a
  // different sessionId — prevents stale anchors leaking across.
  useEffect(() => {
    return () => {
      chatAnchorRegistry.clear(sessionId)
    }
  }, [sessionId])

  const toggleExpand = useCallback((index: number) => {
    setEntries(prev => prev.map((e, j) => {
      if (j !== index) return e
      if (e.kind === 'capability') return { ...e, expanded: !e.expanded }
      if (e.kind === 'compaction') return { ...e, expanded: !e.expanded }
      if (e.kind === 'thinking_text') return { ...e, expanded: !e.expanded }
      return e
    }))
  }, [])

  // Derive hidden inline choice IDs from the live anchor list — any choice
  // currently rendered in the anchor slot must NOT also render inline.
  const activeAnchors = useAnchors(sessionId)
  const hiddenChoiceIds = useMemo(() => {
    const set = new Set<string>()
    for (const a of activeAnchors) {
      if (a.rendererKind !== 'choice') continue
      const cid = (a.payload as { choice_id?: string } | undefined)?.choice_id
      if (cid) set.add(cid)
      // Also hide by anchor.id, which equals choice_id for ChoicePromptPiece.
      if (a.id) set.add(a.id)
    }
    return set
  }, [activeAnchors])

  return (
    <div className="chatDocked" ref={panelRef}>
      <div className="chatDockedOutput" onMouseDown={e => e.stopPropagation()}>
        <ChatTimeline
          entries={entries}
          streamingText={streamingText}
          isStreaming={isStreaming}
          isThinking={isThinking}
          assistantLabel={assistantLabel}
          userLabel={getUserLabel}
          userLabelColor={getUserLabelColor}
          onToggleExpand={toggleExpand}
          onChoiceSubmit={handleChoiceSubmit}
          pendingQueue={pendingQueue}
          hiddenChoiceIds={hiddenChoiceIds}
        />
      </div>

      <ChatAnchorSlot
        sessionId={sessionId}
        assistantLabel={assistantLabel}
        assistantLabelColor="var(--chat-jarvis-label)"
        onChoiceSubmit={handleAnchorChoiceSubmit}
        onChoiceDismiss={handleAnchorChoiceDismiss}
      />

      <div className="chatDockedInput">
        {features.modelPicker && (
          <ModelPicker sessionId={sessionId} sendUrl={sendUrl} />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {features.slashMenu && (
            <SlashMenu
              query={slashQuery}
              onSelect={handleSlashSelect}
              onClose={handleSlashClose}
              visible={slashActive}
            />
          )}
          {features.images && images.length > 0 && (
            <div className="chatImagePreview">
              {images.map(img => (
                <div key={img.label} className="chatImageThumb">
                  <img src={img.thumbnail} alt={img.label} />
                  <span className="chatImageLabel">{img.label}</span>
                  <button className="chatImageRemove" onClick={() => removeImage(img.label)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="chatInputBar" style={{ alignItems: 'flex-end' }}>
            <span className="chatInputLabel" style={{ paddingBottom: '3px' }}>YOU</span>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKey}
              onPaste={handlePaste}
              placeholder={features.slashMenu ? 'Type a message... (/ for commands)' : 'Type a message...'}
              autoFocus
              rows={1}
              className="chatInput chatTextarea"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
