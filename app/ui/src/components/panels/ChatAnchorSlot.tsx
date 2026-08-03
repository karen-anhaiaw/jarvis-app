// app/ui/src/components/panels/ChatAnchorSlot.tsx
//
// Renders all anchors registered for `sessionId`, stacked vertically with
// highest priority on top. Lives between the chat scroll area and the
// composer, so anchors stay visible regardless of scroll position.
//
// Renderer dispatch:
//   - rendererKind === "choice"  → built-in ChoiceCard from ChatTimeline
//   - renderer.{plugin,file}     → loaded via /plugins/<plugin>/renderers/<file>.js
//                                  (same loader used for HUD pieces)
//   - otherwise                  → fallback diagnostic block
//
// IMPORTANT: This component is session-scoped. Multiple ChatPanel instances
// (e.g. main + actor side-panel) each render their OWN slot with their OWN
// sessionId — anchors never bleed across.

import { useAnchors, chatAnchorRegistry, type ChatAnchor } from '../../hooks/useChatAnchors'
import { ChoiceCard, type ChatEntry, type ChoiceAnswer } from './ChatTimeline'
import { PluginAnchorRenderer, anchorErrorStyle } from './PluginAnchorRenderer'

interface Props {
  sessionId: string
  /** Forwarded from ChatPanel for the assistant label on built-in renderers. */
  assistantLabel: string
  assistantLabelColor: string
  /** Same submit handler used by inline ChoiceCard. ChatPanel owns the state
   *  and calls registry.remove() once the answer is committed. */
  onChoiceSubmit?: (anchorId: string, answers: ChoiceAnswer[]) => void
  /** Dismiss handler — host sends a `(dismissed)` signal to the AI and removes
   *  the anchor. Only choice anchors expose a Dismiss button. */
  onChoiceDismiss?: (anchorId: string) => void
}

// ── Built-in choice renderer adapter ────────────────────────────────────────

interface ChoiceAnchorPayload {
  choice_id: string
  questions: Array<{
    question: string
    options: Array<{ value: string; label: string; description?: string }>
    multi: boolean
    allow_other: boolean
  }>
}

function ChoiceAnchorRenderer({
  anchor,
  assistantLabel,
  assistantLabelColor,
  onChoiceSubmit,
  onChoiceDismiss,
}: {
  anchor: ChatAnchor
  assistantLabel: string
  assistantLabelColor: string
  onChoiceSubmit?: (anchorId: string, answers: ChoiceAnswer[]) => void
  onChoiceDismiss?: (anchorId: string) => void
}) {
  const payload = anchor.payload as ChoiceAnchorPayload | undefined
  if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) {
    return <div style={anchorErrorStyle}>choice anchor: invalid payload</div>
  }
  // Synthesize a ChatEntry-shaped object so we can reuse ChoiceCard verbatim.
  const fakeEntry = {
    kind: 'choice' as const,
    choice_id: payload.choice_id,
    questions: payload.questions,
  } as Extract<ChatEntry, { kind: 'choice' }>

  return (
    <ChoiceCard
      index={0}
      entry={fakeEntry}
      assistantLabel={assistantLabel}
      assistantLabelColor={assistantLabelColor}
      onSubmit={(_idx, answers) => {
        // Delegate to the panel — it owns history/state, then calls
        // chatAnchorRegistry.remove() once the answer is dispatched.
        onChoiceSubmit?.(anchor.id, answers)
      }}
      // Only forward dismiss when the host wants live cards to be cancellable.
      // Inline (historical) ChoiceCards never receive a dismiss handler.
      onDismiss={onChoiceDismiss ? () => onChoiceDismiss(anchor.id) : undefined}
    />
  )
}

// ── Slot ────────────────────────────────────────────────────────────────────

const slotContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '6px 0',
  // Slot is a flex item; never grow past its content. Composer stays anchored.
  flex: '0 0 auto',
}

export function ChatAnchorSlot({
  sessionId,
  assistantLabel,
  assistantLabelColor,
  onChoiceSubmit,
  onChoiceDismiss,
}: Props) {
  // This slot renders the "composer-above" mount point only: anchors that
  // target `composer-above` OR carry no `slot` at all (historical anchors,
  // e.g. choice cards, default here — preserves pre-0.10.0 behaviour byte-for-
  // byte). Anchors bound to other slots (composer-actions, header-actions,
  // message-footer) are rendered by their own ChatSlotHost elsewhere.
  const anchors = useAnchors(sessionId).filter(
    (a) => a.slot === undefined || a.slot === 'composer-above',
  )
  if (anchors.length === 0) return null

  return (
    <div className="chatAnchorSlot" style={slotContainerStyle}>
      {anchors.map((anchor) => {
        // Built-in: choice
        if (anchor.rendererKind === 'choice' && !anchor.renderer) {
          return (
            <ChoiceAnchorRenderer
              key={`${anchor.sessionId}::${anchor.id}`}
              anchor={anchor}
              assistantLabel={assistantLabel}
              assistantLabelColor={assistantLabelColor}
              onChoiceSubmit={onChoiceSubmit}
              onChoiceDismiss={onChoiceDismiss}
            />
          )
        }
        // Plugin renderer
        if (anchor.renderer?.plugin && anchor.renderer.file) {
          return <PluginAnchorRenderer key={`${anchor.sessionId}::${anchor.id}`} anchor={anchor} />
        }
        // Fallback diagnostic — visible misconfiguration
        return (
          <div key={`${anchor.sessionId}::${anchor.id}`} style={anchorErrorStyle}>
            anchor "{anchor.id}" from "{anchor.source}": unknown rendererKind "{anchor.rendererKind}" and no renderer.{'{plugin,file}'} provided
          </div>
        )
      })}
    </div>
  )
}

// Re-export so non-React consumers can imperatively manage anchors
export { chatAnchorRegistry }
