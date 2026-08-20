import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { HudComponentState } from '../../types/hud'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-clojure'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-toml'
import { marked } from 'marked'

// ─── Types mirrored from diff-viewer piece ───

interface Annotation {
  line: number
  text: string
  type?: 'info' | 'warning' | 'error'
}

interface DiffEntry {
  path: string
  language: string
  oldContent: string
  newContent: string
  diff: string
  annotations?: Annotation[]
}

interface FileEntry {
  path: string
  language: string
  content: string
  highlightLines?: number[]
  annotations?: Annotation[]
}

interface DiffViewerData {
  mode: 'diff' | 'file' | 'compare'
  viewMode: 'inline' | 'side-by-side'
  activeTab: number
  title?: string
  interactive?: boolean
  diffs?: DiffEntry[]
  file?: FileEntry
  historyCount: number
}

/** A tab accumulated in local state — wraps the incoming data */
interface ViewerTab {
  id: string
  title: string
  data: DiffViewerData
  interactive: boolean
}

// ─── Send ai.request to the backend ───
// DiffViewer replies always target the session that opened the diff. The
// piece publishes `data.sessionId` on the HUD state; this helper forwards it.
function sendAiRequest(sessionId: string, prompt: string) {
  if (!sessionId) return
  fetch('/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, prompt }),
  }).catch(() => {})
}

// No-op — panel visibility is controlled by empty-tab check in render.
// We intentionally do NOT call /hud/hide (which persists visible:false
// in settings and prevents the panel from reappearing on next show_diff).

// ─── Styles ───

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    background: '#0a0e14',
    color: '#c8d0d8',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: '12px',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    borderBottom: '1px solid #1a2030',
    background: '#0d1218',
    flexShrink: 0,
    minHeight: '32px',
  },
  title: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#4af',
    letterSpacing: '1px',
    textTransform: 'uppercase' as const,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  toggleBtn: (active: boolean) => ({
    padding: '2px 8px',
    fontSize: '10px',
    border: `1px solid ${active ? '#4af' : '#2a3040'}`,
    borderRadius: '3px',
    background: active ? 'rgba(68,170,255,0.15)' : 'transparent',
    color: active ? '#4af' : '#6a7a8a',
    cursor: 'pointer',
    transition: 'all 0.15s',
  }),
  actionBtn: (variant: 'accept' | 'reject') => {
    const isAccept = variant === 'accept'
    return {
      padding: '3px 12px',
      fontSize: '10px',
      fontWeight: 600,
      border: `1px solid ${isAccept ? '#4c8' : '#f55'}`,
      borderRadius: '3px',
      background: isAccept ? 'rgba(68,200,100,0.15)' : 'rgba(255,80,80,0.15)',
      color: isAccept ? '#8fd8a0' : '#f8a0a0',
      cursor: 'pointer',
      transition: 'all 0.15s',
      letterSpacing: '0.5px',
    }
  },
  tabBar: {
    display: 'flex',
    gap: '0',
    borderBottom: '1px solid #1a2030',
    background: '#0b1018',
    flexShrink: 0,
    overflowX: 'auto' as const,
  },
  tab: (active: boolean, status: string) => {
    const statusColors: Record<string, string> = {
      accepted: '#4c8',
      rejected: '#f55',
      pending: active ? '#4af' : '#6a7a8a',
    }
    const color = statusColors[status] ?? statusColors.pending
    return {
      padding: '4px 8px',
      fontSize: '10px',
      color,
      borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
      cursor: 'pointer',
      background: active ? 'rgba(68,170,255,0.05)' : 'transparent',
      transition: 'all 0.15s',
      whiteSpace: 'nowrap' as const,
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    }
  },
  tabClose: {
    fontSize: '9px',
    color: '#4a5a6a',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '1px 2px',
    borderRadius: '2px',
    transition: 'all 0.15s',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    contain: 'strict' as const,
  },
  fileView: {
    padding: '0',
    overflow: 'auto',
    height: '100%',
  },
  lineNumber: {
    display: 'inline-block',
    width: '45px',
    textAlign: 'right' as const,
    paddingRight: '12px',
    color: '#3a4a5a',
    userSelect: 'none' as const,
    fontSize: '11px',
  },
  codeLine: (highlighted: boolean) => ({
    display: 'block',
    padding: '0 8px 0 0',
    background: highlighted ? 'rgba(68,170,255,0.08)' : 'transparent',
    borderLeft: highlighted ? '3px solid #4af' : '3px solid transparent',
    height: '18px',
    lineHeight: '18px',
  }),
  annotation: (type: string) => {
    const colors: Record<string, { bg: string; border: string; color: string }> = {
      info: { bg: 'rgba(68,170,255,0.1)', border: '#4af', color: '#8cf' },
      warning: { bg: 'rgba(255,170,68,0.1)', border: '#fa4', color: '#fc8' },
      error: { bg: 'rgba(255,68,68,0.1)', border: '#f44', color: '#f88' },
    }
    const c = colors[type] ?? colors.info
    return {
      padding: '2px 8px 2px 60px',
      fontSize: '10px',
      color: c.color,
      background: c.bg,
      borderLeft: `3px solid ${c.border}`,
    }
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#3a4a5a',
    fontSize: '12px',
    fontStyle: 'italic',
  },
  stats: {
    display: 'flex',
    gap: '12px',
    padding: '4px 10px',
    borderTop: '1px solid #1a2030',
    background: '#0b1018',
    fontSize: '10px',
    color: '#4a5a6a',
    flexShrink: 0,
    alignItems: 'center',
  },
  statusBadge: (status: string) => {
    const colors: Record<string, { bg: string; color: string }> = {
      accepted: { bg: 'rgba(68,200,100,0.2)', color: '#8fd8a0' },
      rejected: { bg: 'rgba(255,80,80,0.2)', color: '#f8a0a0' },
    }
    const c = colors[status]
    if (!c) return { display: 'none' }
    return {
      padding: '1px 6px',
      borderRadius: '3px',
      fontSize: '9px',
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      background: c.bg,
      color: c.color,
      letterSpacing: '0.5px',
    }
  },
}

// ─── Diff theme ───

const diffTheme = {
  variables: {
    dark: {
      diffViewerBackground: '#0a0e14',
      diffViewerColor: '#c8d0d8',
      addedBackground: 'rgba(68,200,100,0.12)',
      addedColor: '#8fd8a0',
      removedBackground: 'rgba(255,80,80,0.12)',
      removedColor: '#f8a0a0',
      wordAddedBackground: 'rgba(68,200,100,0.25)',
      wordRemovedBackground: 'rgba(255,80,80,0.25)',
      addedGutterBackground: 'rgba(68,200,100,0.08)',
      removedGutterBackground: 'rgba(255,80,80,0.08)',
      gutterBackground: '#0b1018',
      gutterBackgroundDark: '#080c12',
      highlightBackground: 'rgba(68,170,255,0.08)',
      highlightGutterBackground: 'rgba(68,170,255,0.05)',
      codeFoldGutterBackground: '#0d1218',
      codeFoldBackground: '#0d1218',
      emptyLineBackground: '#0a0e14',
      codeFoldContentColor: '#4a5a6a',
    },
  },
  line: {
    fontSize: '12px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  gutter: {
    minWidth: '40px',
    fontSize: '11px',
  },
}

// ─── Syntax highlighting helper ───

const prismLangMap: Record<string, string> = {
  typescript: 'typescript', tsx: 'typescript', javascript: 'javascript',
  jsx: 'javascript', python: 'python', bash: 'bash', json: 'json',
  yaml: 'yaml', css: 'css', sql: 'sql', markdown: 'markdown',
  clojure: 'clojure', java: 'java', go: 'go', rust: 'rust',
  toml: 'toml', text: 'text',
}

function highlightSyntax(str: string, language: string): any {
  const prismLang = prismLangMap[language]
  if (!prismLang || !Prism.languages[prismLang]) {
    return <span>{str}</span>
  }
  const html = Prism.highlight(str, Prism.languages[prismLang], prismLang)
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

// ─── Markdown Preview Component ───

// Custom marked renderer: syntax-highlight fenced code blocks via Prism
const mdRenderer = new marked.Renderer()
mdRenderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = lang ?? 'text'
  const prismLang = prismLangMap[language]
  let highlighted = text
  if (prismLang && Prism.languages[prismLang]) {
    try {
      highlighted = Prism.highlight(text, Prism.languages[prismLang], prismLang)
    } catch { /* fallback to plain */ }
  }
  return `<pre class="md-pre-code"><code class="language-${language}">${highlighted}</code></pre>`
}
mdRenderer.link = ({ href, text }: { href?: string | null; text: string }) => {
  return `<a href="${String(href ?? '')}" target="_blank" rel="noopener noreferrer">${text}</a>`
}

function MarkdownPreviewView({ file, theme }: { file: FileEntry; theme: 'muted' | 'sepia' | 'dark' }) {
  const html = useMemo(() => {
    return marked.parse(file.content, { renderer: mdRenderer, async: false, gfm: true, breaks: false }) as string
  }, [file.content])

  return (
    <div className={`md-book-scroll md-theme-${theme}`}>
      <div className="md-book-page">
        <div className="md-book-content" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  )
}

// ─── File View Component ───

function FileView({ file }: { file: FileEntry }) {
  const lines = file.content.split('\n')
  const highlightSet = useMemo(() => new Set(file.highlightLines ?? []), [file.highlightLines])
  const annotationMap = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const a of file.annotations ?? []) {
      const list = map.get(a.line) ?? []
      list.push(a)
      map.set(a.line, list)
    }
    return map
  }, [file.annotations])

  return (
    <div style={styles.fileView}>
      <div style={{ margin: 0, padding: '4px 0', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: '12px', whiteSpace: 'pre' }}>
        {lines.map((line, i) => {
          const lineNum = i + 1
          const isHighlighted = highlightSet.has(lineNum)
          const lineAnnotations = annotationMap.get(lineNum)
          return (
            <div key={i}>
              <div style={styles.codeLine(isHighlighted)}>
                <span style={styles.lineNumber}>{lineNum}</span>
                {highlightSyntax(line, file.language)}
              </div>
              {lineAnnotations?.map((a, j) => (
                <div key={`a-${i}-${j}`} style={styles.annotation(a.type ?? 'info')}>
                  {'💬 '}{a.text}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Diff Content Component ───

function DiffContent({
  diffs,
  viewMode,
  mode,
}: {
  diffs: DiffEntry[]
  viewMode: 'inline' | 'side-by-side'
  mode: string
}) {
  const [subTab, setSubTab] = useState(0)

  // Reset sub-tab when diffs change
  useEffect(() => { setSubTab(0) }, [diffs])

  const activeDiff = diffs[subTab] ?? diffs[0]
  if (!activeDiff) return null

  return (
    <>
      {/* Sub-tabs for multi-file diffs within a single viewer tab */}
      {diffs.length > 1 && (
        <div style={styles.tabBar}>
          {diffs.map((d, i) => {
            const fileName = d.path.split('/').pop() ?? d.path
            return (
              <div
                key={i}
                style={styles.tab(i === subTab, 'pending')}
                onClick={() => setSubTab(i)}
              >
                {fileName}
              </div>
            )
          })}
        </div>
      )}
      <div style={styles.content}>
        <ReactDiffViewer
          oldValue={activeDiff.oldContent}
          newValue={activeDiff.newContent}
          splitView={viewMode === 'side-by-side'}
          useDarkTheme={true}
          styles={diffTheme}
          compareMethod={DiffMethod.WORDS}
          renderContent={(str) => highlightSyntax(str ?? '', activeDiff.language)}
          leftTitle={mode === 'compare' ? activeDiff.path.split(' → ')[0] : 'Before'}
          rightTitle={mode === 'compare' ? activeDiff.path.split(' → ')[1] : 'After'}
        />
      </div>
    </>
  )
}

// ─── Main Renderer ───

let tabIdCounter = 0

export function DiffViewerRenderer({ state }: { state: HudComponentState }) {
  const data = state.data as unknown as DiffViewerData | undefined
  const lastHistoryCount = useRef(0)

  const [tabs, setTabs] = useState<ViewerTab[]>([])
  const [activeTabIdx, setActiveTabIdx] = useState(0)
  const [viewMode, setViewMode] = useState<'inline' | 'side-by-side'>('side-by-side')
  const [mdPreviewMode, setMdPreviewMode] = useState(true) // preview vs raw for .md files
  const [mdTheme, setMdTheme] = useState<'muted' | 'sepia' | 'dark'>('muted')

  // Load persisted theme from server settings on mount
  useEffect(() => {
    fetch('/hud/md-theme')
      .then(r => r.json())
      .then(({ mdTheme: saved }) => {
        if (saved === 'muted' || saved === 'sepia' || saved === 'dark') setMdTheme(saved)
      })
      .catch(() => {})
  }, [])

  // Session that opened each tab — used to route Accept/Reject/Dismiss replies
  // back to the correct chat. Piece publishes data.sessionId per tab.
  const tabSessions = useRef(new Map<string, string>())

  // Accumulate new data as tabs — each new hud.update adds a tab
  useEffect(() => {
    if (!data) return
    // Avoid re-adding the same data (historyCount is unique per publish)
    if (data.historyCount === lastHistoryCount.current) return
    lastHistoryCount.current = data.historyCount

    const title = data.title
      ?? (data.mode === 'file' && data.file ? data.file.path.split('/').pop() : undefined)
      ?? (data.diffs?.[0]?.path?.split('/').pop())
      ?? 'View'

    const tabId = `tab-${++tabIdCounter}`
    if ((data as any).sessionId) {
      tabSessions.current.set(tabId, String((data as any).sessionId))
    }
    const newTab: ViewerTab = {
      id: tabId,
      title,
      data,
      interactive: data.interactive ?? false,
    }

    setTabs(prev => {
      const next = [...prev, newTab]
      // Switch to the new tab
      setTimeout(() => setActiveTabIdx(next.length - 1), 0)
      return next
    })

    if (data.viewMode) setViewMode(data.viewMode)
    // Auto-enable preview when opening a markdown file (theme is preserved from localStorage)
    if (data.mode === 'file' && data.file?.language === 'markdown') {
      setMdPreviewMode(true)
    }
  }, [data])

  const toggleView = useCallback(() => {
    setViewMode(prev => prev === 'inline' ? 'side-by-side' : 'inline')
  }, [])

  const removeTab = useCallback((idx: number) => {
    setTabs(prev => {
      const next = prev.filter((_, i) => i !== idx)
      return next
    })
    setActiveTabIdx(prev => {
      const newLen = tabs.length - 1
      if (newLen <= 0) return 0
      if (prev >= newLen) return newLen - 1
      if (prev > idx) return prev - 1
      return prev
    })
  }, [tabs])

  const closeTab = useCallback((idx: number) => {
    const tab = tabs[idx]
    if (!tab) return

    // Only notify AI when an interactive tab is dismissed without decision
    if (tab.interactive) {
      const paths = tab.data.diffs?.map(d => d.path).join(', ')
        ?? tab.data.file?.path
        ?? tab.title
      const sid = tabSessions.current.get(tab.id) ?? ''
      sendAiRequest(sid, `[SYSTEM] User dismissed diff viewer tab "${tab.title}" (${paths}) without accepting or rejecting.`)
      tabSessions.current.delete(tab.id)
    }

    removeTab(idx)
  }, [tabs, removeTab])

  const acceptTab = useCallback((idx: number) => {
    const tab = tabs[idx]
    if (!tab || !tab.interactive) return

    const paths = tab.data.diffs?.map(d => d.path).join(', ')
      ?? tab.data.file?.path
      ?? tab.title
    const fileCount = tab.data.diffs?.length ?? 1
    const sid = tabSessions.current.get(tab.id) ?? ''
    sendAiRequest(sid,
      `[SYSTEM] User ACCEPTED the changes in diff "${tab.title}" (${fileCount} file(s): ${paths}). Proceed with these changes.`
    )
    tabSessions.current.delete(tab.id)

    removeTab(idx)
  }, [tabs, removeTab])

  const rejectTab = useCallback((idx: number) => {
    const tab = tabs[idx]
    if (!tab || !tab.interactive) return

    const paths = tab.data.diffs?.map(d => d.path).join(', ')
      ?? tab.data.file?.path
      ?? tab.title
    const fileCount = tab.data.diffs?.length ?? 1
    const sid = tabSessions.current.get(tab.id) ?? ''
    sendAiRequest(sid,
      `[SYSTEM] User REJECTED the changes in diff "${tab.title}" (${fileCount} file(s): ${paths}). Please revert or propose alternatives.`
    )
    tabSessions.current.delete(tab.id)

    removeTab(idx)
  }, [tabs, removeTab])

  // Empty state — no tabs: return null so the panel disappears
  if (tabs.length === 0) {
    return null
  }

  const activeTab = tabs[activeTabIdx] ?? tabs[0]
  const tabData = activeTab.data
  const isDiff = tabData.mode === 'diff' || tabData.mode === 'compare'
  const isMarkdownFile = tabData.mode === 'file' && tabData.file?.language === 'markdown'
  const inMdPreview    = isMarkdownFile && mdPreviewMode

  // Per-theme palette for toolbar/container (CSS handles page content)
  const themeTokens = {
    muted: { bg: '#EAEAEC', border: '#D0D2D8', title: '#4A5568', containerBg: '#F4F4F6', color: '#2D3748', isDark: false },
    sepia: { bg: '#E2DFD9', border: '#CCC8C0', title: '#4A4440', containerBg: '#ECEAE5', color: '#3D312A', isDark: false },
    dark:  { bg: '#1a1d23', border: '#2e3440', title: '#7a8896', containerBg: '#1a1d23', color: '#cdd5e0', isDark: true  },
  }
  const tok = themeTokens[mdTheme]

  // Effective toolbar colors — use theme palette in preview, default dark otherwise
  const tbBg     = inMdPreview ? tok.bg     : '#0d1218'
  const tbBorder = inMdPreview ? tok.border : '#1a2030'
  const titleCol = inMdPreview ? tok.title  : undefined

  // Cycle: muted → sepia → dark → muted
  const cycleTheme = () => setMdTheme(t => {
    const next = t === 'muted' ? 'sepia' : t === 'sepia' ? 'dark' : 'muted'
    fetch('/hud/md-theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mdTheme: next }) }).catch(() => {})
    return next
  })
  const themeLabel: Record<typeof mdTheme, string> = { muted: '☀ Muted', sepia: '🌿 Sepia', dark: '🌙 Dark' }
  const nextLabel:  Record<typeof mdTheme, string> = { muted: 'Sepia', sepia: 'Dark', dark: 'Muted' }

  // Button style factory for md toolbar buttons
  const mdBtn = (active: boolean) => ({
    padding: '2px 8px', fontSize: '10px', borderRadius: '3px', cursor: 'pointer',
    border: `1px solid ${active
      ? (tok.isDark ? '#4a6a9a' : '#5a8ad0')
      : (tok.isDark ? '#3a4450' : '#c8d0da')}`,
    background: active
      ? (tok.isDark ? 'rgba(74,106,154,0.2)' : 'rgba(45,95,166,0.1)')
      : 'transparent',
    color: active
      ? (tok.isDark ? '#7ab0e8' : '#2d5fa6')
      : (tok.isDark ? '#5a6878' : '#7a8898'),
    transition: 'all 0.15s',
  })

  return (
    <div style={inMdPreview
      ? { ...styles.container, background: tok.containerBg, color: tok.color }
      : styles.container}>
      {/* Toolbar */}
      <div style={{ ...styles.toolbar, background: tbBg, borderBottom: `1px solid ${tbBorder}` }}>
        <div style={titleCol ? { ...styles.title, color: titleCol } : styles.title}>
          {activeTab.title}
        </div>
        {isMarkdownFile && (
          <>
            <button style={mdBtn(!mdPreviewMode)} onClick={() => setMdPreviewMode(false)} title="Show raw source">⌨ Raw</button>
            <button style={mdBtn(mdPreviewMode)}  onClick={() => setMdPreviewMode(true)}  title="Rendered markdown preview">📖 Preview</button>
            {mdPreviewMode && (
              <button
                style={{
                  padding: '2px 8px', fontSize: '10px', borderRadius: '3px', cursor: 'pointer',
                  border: `1px solid ${tok.isDark ? '#3a4450' : '#c8d0da'}`,
                  background: 'transparent',
                  color: tok.isDark ? '#7a9ab8' : '#6a7a8a',
                  transition: 'all 0.15s',
                }}
                onClick={cycleTheme}
                title={`Current theme: ${themeLabel[mdTheme]} — click for ${nextLabel[mdTheme]}`}
              >{themeLabel[mdTheme]}</button>
            )}
          </>
        )}
        {isDiff && (
          <button style={styles.toggleBtn(viewMode === 'inline')} onClick={toggleView}>
            {viewMode === 'inline' ? '≡ Inline' : '⇔ Side-by-Side'}
          </button>
        )}
      </div>

      {/* Tab bar — always visible when there are tabs */}
      <div style={styles.tabBar}>
        {tabs.map((tab, i) => {
          return (
            <div
              key={tab.id}
              style={styles.tab(i === activeTabIdx, 'pending')}
              onClick={() => setActiveTabIdx(i)}
            >
              <span>{tab.title}</span>
              <span
                style={styles.tabClose}
                onClick={(e) => { e.stopPropagation(); closeTab(i) }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#f88'; (e.target as HTMLElement).style.background = 'rgba(255,80,80,0.15)' }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#4a5a6a'; (e.target as HTMLElement).style.background = 'transparent' }}
                title="Close tab"
              >✕</span>
            </div>
          )
        })}
      </div>

      {/* Content */}
      {tabData.mode === 'file' && tabData.file && isMarkdownFile && mdPreviewMode ? (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <MarkdownPreviewView file={tabData.file} theme={mdTheme} />
        </div>
      ) : tabData.mode === 'file' && tabData.file ? (
        <div style={styles.content}>
          <FileView file={tabData.file} />
        </div>
      ) : isDiff && tabData.diffs ? (
        <DiffContent diffs={tabData.diffs} viewMode={viewMode} mode={tabData.mode} />
      ) : (
        <div style={styles.emptyState}>No content</div>
      )}

      {/* Footer with stats + accept/reject */}
      <div style={inMdPreview
        ? { ...styles.stats, background: tbBg, borderTop: `1px solid ${tbBorder}`, color: tok.isDark ? '#5a6878' : '#8a9aaa' }
        : styles.stats}>
        {tabData.mode === 'file' && tabData.file && (
          <>
            <span>{tabData.file.content.split('\n').length} lines</span>
            <span>{tabData.file.content.length} chars</span>
            <span>{tabData.file.language}</span>
          </>
        )}
        {isDiff && tabData.diffs && (() => {
          const totalAdded = tabData.diffs.reduce((sum, d) =>
            sum + d.newContent.split('\n').length - d.oldContent.split('\n').length, 0)
          return (
            <>
              <span>{tabData.diffs.length} file(s)</span>
              <span style={{ color: totalAdded >= 0 ? '#8fd8a0' : '#f8a0a0' }}>
                {totalAdded >= 0 ? `+${totalAdded}` : totalAdded} lines
              </span>
              <span>{tabData.diffs[0]?.language}</span>
            </>
          )
        })()}

        {/* Accept/Reject buttons — only when interactive */}
        <span style={{ flex: 1 }} />
        {activeTab.interactive && isDiff && (
          <>
            <button
              style={styles.actionBtn('reject')}
              onClick={() => rejectTab(activeTabIdx)}
              title="Reject these changes"
            >✗ Reject</button>
            <button
              style={styles.actionBtn('accept')}
              onClick={() => acceptTab(activeTabIdx)}
              title="Accept these changes"
            >✓ Accept</button>
          </>
        )}
      </div>
    </div>
  )
}
