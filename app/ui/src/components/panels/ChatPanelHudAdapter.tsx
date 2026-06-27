import { ChatPanel } from './ChatPanel'

/**
 * Adapter that lets the HUD renderer mount ChatPanel from an HudComponentState.
 *
 * HudRenderer invokes { state } for every panel. ChatPanel itself takes flat
 * props. This adapter pulls sessionId and UI config out of `state.data` and
 * forwards them.
 *
 * Expected `state.data` shape:
 *   {
 *     sessionId: string              // REQUIRED
 *     assistantLabel?: string        // defaults to sessionId.toUpperCase()
 *     features?: ChatPanelFeatures
 *     userLabel?: (s?: string) => string
 *     userLabelColor?: (s?: string) => string
 *   }
 *
 * A panel publisher (core piece or plugin) declares its renderer as
 * `{ plugin: null, file: 'ChatPanel' }` and fills `data.sessionId` with
 * whatever session identity applies (e.g. 'main', 'actor-alice', etc.).
 */
export function ChatPanelHudAdapter({ state }: { state: any }) {
  const data = state?.data ?? {}
  const sessionId: string | undefined = data.sessionId

  if (!sessionId) {
    return (
      <div style={{ padding: 12, color: '#f88', fontFamily: 'monospace', fontSize: 11 }}>
        ChatPanel: missing sessionId in piece data.
      </div>
    )
  }

  const assistantLabel = data.assistantLabel ?? sessionId.toUpperCase()
  return (
    <ChatPanel
      sessionId={sessionId}
      assistantLabel={assistantLabel}
      features={data.features}
      userLabel={data.userLabel}
      userLabelColor={data.userLabelColor}
    />
  )
}
