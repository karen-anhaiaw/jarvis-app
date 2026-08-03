// app/ui/src/components/panels/ChatSlotHost.tsx
//
// Generic mount point for a single named ChatSlot.
//
// The core (@jarvis/core) NAMES the slots (ChatSlot union). The UI OWNS where
// each slot physically renders — ChatPanel instantiates one ChatSlotHost per
// slot at the right place in its layout. A plugin targets a slot BY NAME by
// publishing a ChatAnchor with `slot: <name>`; it never references geometry.
//
// This host is deliberately dumb: filter this session's anchors down to the
// ones bound to `slot`, then render each via the shared PluginAnchorRenderer
// (the same dynamic loader the composer-above anchors use). Built-in kinds
// like "choice" are NOT handled here — those live in ChatAnchorSlot (the
// composer-above host) which owns the ChoiceCard adapter. A ChatSlotHost only
// renders plugin-provided renderers.
//
// INVARIANT: no anchors for this slot ⇒ renders null ⇒ zero DOM ⇒ the host's
// container in ChatPanel stays byte-identical to pre-slot layout.

import { useAnchors } from '../../hooks/useChatAnchors'
import type { ChatSlot } from '../../hooks/useChatAnchors'
import { useSlotFills } from '../../hooks/useChatSlotFills'
import { PluginAnchorRenderer, anchorErrorStyle } from './PluginAnchorRenderer'
import type { ChatSlotContext } from './PluginAnchorRenderer'

interface Props {
  sessionId: string
  /** Which named mount point this host renders. */
  slot: ChatSlot
  /** Base URL for remote sessions — forwarded to renderers via ctx.baseUrl. */
  baseUrl?: string
  /** Layout direction. Composer-actions is a horizontal button row; the
   *  stacked slots (footer/header) default to a column. */
  direction?: 'row' | 'column'
  /** Extra style merged onto the container (e.g. gap, alignment). */
  style?: React.CSSProperties
  /** Class hook for CSS targeting per slot. */
  className?: string
}

export function ChatSlotHost({
  sessionId,
  slot,
  baseUrl,
  direction = 'row',
  style,
  className,
}: Props) {
  // Two sources feed a slot host:
  //   - anchors: per-session, ephemeral (this session only).
  //   - fills:   global, session-agnostic (every session, incl. future ones).
  const anchors = useAnchors(sessionId).filter((a) => a.slot === slot)
  const fills = useSlotFills(slot)
  if (anchors.length === 0 && fills.length === 0) return null

  // The host owns the session context and PUSHES it into each plugin renderer.
  const ctx: ChatSlotContext = { sessionId, slot, baseUrl }

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: direction,
    gap: '6px',
    flex: '0 0 auto',
    alignItems: 'center',
    ...style,
  }

  return (
    <div className={className ?? `chatSlotHost chatSlot-${slot}`} style={containerStyle}>
      {/* Global fills first — they are the persistent controls (e.g. mic). */}
      {fills.map((fill) => (
        <PluginAnchorRenderer
          key={`fill::${fill.id}`}
          // Synthesize a minimal anchor so the shared loader can mount the
          // fill's renderer. The fill carries no per-session payload; the
          // renderer gets everything it needs from `ctx`.
          anchor={{
            id: fill.id,
            sessionId,
            source: fill.renderer.plugin,
            slot,
            rendererKind: 'slot-fill',
            payload: undefined,
            renderer: fill.renderer,
          }}
          ctx={ctx}
        />
      ))}
      {anchors.map((anchor) => {
        if (anchor.renderer?.plugin && anchor.renderer.file) {
          return (
            <PluginAnchorRenderer
              key={`${anchor.sessionId}::${anchor.id}`}
              anchor={anchor}
              ctx={ctx}
            />
          )
        }
        // A slot host only mounts plugin renderers. An anchor bound to a slot
        // without a {plugin,file} renderer is a misconfiguration — surface it.
        return (
          <div key={`${anchor.sessionId}::${anchor.id}`} style={anchorErrorStyle}>
            slot "{slot}" anchor "{anchor.id}" from "{anchor.source}": no renderer.{'{plugin,file}'} provided
          </div>
        )
      })}
    </div>
  )
}
