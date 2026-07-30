import { useMemo } from 'react'
import { marked } from 'marked'

// Configure marked for chat rendering. We let marked do the full block + inline
// parsing (headings, lists, code, tables, AND correct nesting of strong/em/code/
// links inside paragraphs). The previous hand-rolled `paragraph` renderer only
// handled top-level tokens and dumped raw markdown for any nested token
// (e.g. a link inside bold, or code inside bold) — which is what produced the
// garbled "**...** `...` (...)" wall of text in dense answers. marked resolves
// nesting natively, so we no longer override `paragraph`.
//
// We keep ONE override: links must open in the external browser (Electron),
// styled as links. Everything else uses marked's default renderer.
marked.setOptions({
  breaks: true, // single newline -> <br> (chat-friendly)
  gfm: true,
})

const renderer = new marked.Renderer()

// Links open in the external browser, with explicit styling (CSS also covers it).
renderer.link = ({ href, text }) => {
  const safeHref = String(href ?? '')
  return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" style="color:#4af;text-decoration:underline">${text}</a>`
}

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { renderer, async: false }) as string
    // Trim a single trailing newline from block rendering.
    return raw.replace(/\n$/, '')
  }, [text])

  return (
    <div
      className={`md-content ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
