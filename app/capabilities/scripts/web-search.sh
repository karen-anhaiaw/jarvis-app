#!/bin/bash
# Web search — Brave Search (HTML scrape) with DuckDuckGo fallback.
#
# Why this design:
#   - DuckDuckGo's html.duckduckgo.com endpoint frequently flags this IP as
#     a bot ("anomaly.js?cc=botnet") and silently returns the captcha page.
#     The original parser then returned "No results found" with no error.
#   - Brave Search returns rich SERPs with no auth and stable HTML, but the
#     class names are Svelte-hashed. We anchor on the `title=` attribute of
#     the title block and the closest preceding `<a href>`.
#   - If Brave fails (status != 200 or zero results parsed), we fall back to
#     DuckDuckGo. If both fail, we emit an explicit error so the caller
#     knows the engine is blocked (instead of silent empty).

QUERY="$1"
MAX_RESULTS="${2:-5}"

if [ -z "$QUERY" ]; then
  echo "__TYPE__:error"
  echo "Query is required"
  exit 0
fi

# Cap max results
if [ "$MAX_RESULTS" -gt 10 ] 2>/dev/null; then MAX_RESULTS=10; fi

# Realistic Chrome desktop UA — DDG/Brave still serve full HTML to it.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")

parse_with_python() {
  local html_file="$1"
  local engine="$2"
  python3 - <<PY "$html_file" "$engine" "$MAX_RESULTS" "$QUERY"
import html, re, sys
path, engine, max_r, query = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
with open(path, 'r', errors='replace') as f:
    c = f.read()

results = []
if engine == 'brave':
    # Brave wraps each result in a block where the title <div> has
    #     class="title ... svelte-XXXX" title="LITERAL TITLE"
    # and the surrounding clickable <a href="URL" ...> appears EARLIER
    # in the document (Brave puts the URL line above the title block).
    # We find every title anchor and pair it with the nearest preceding
    # external href.
    title_iter = list(re.finditer(
        r'class="title[^"]*svelte-[^"]*"[^>]*title="([^"]+)"',
        c,
    ))
    href_iter = list(re.finditer(
        r'<a [^>]*href="(https?://[^"]+)"',
        c,
    ))
    snippet_iter = list(re.finditer(
        r'class="snippet-content[^"]*"[^>]*>(.*?)</div>',
        c, re.DOTALL,
    ))
    used = set()
    for tm in title_iter:
        title = html.unescape(tm.group(1)).strip()
        if not title:
            continue
        # nearest preceding href that we haven't used yet and isn't brave
        href = None
        for hm in reversed(href_iter):
            if hm.end() > tm.start():
                continue
            url = hm.group(1)
            if 'brave.com' in url or 'brave.app' in url:
                continue
            if url in used:
                continue
            href = url
            break
        if not href:
            continue
        used.add(href)
        # Snippet: nearest following
        snippet = ''
        for sm in snippet_iter:
            if sm.start() > tm.end():
                snippet = re.sub(r'<[^>]+>', '', html.unescape(sm.group(1))).strip()
                break
        results.append((href, title, snippet))
elif engine == 'ddg':
    # Classic DDG /html parser
    pat = re.findall(
        r'<a [^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>',
        c, re.DOTALL,
    )
    for url, title, snippet in pat:
        if 'uddg=' in url:
            import urllib.parse
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            url = qs.get('uddg', [url])[0]
        title = re.sub(r'<[^>]+>', '', html.unescape(title)).strip()
        snippet = re.sub(r'<[^>]+>', '', html.unescape(snippet)).strip()
        if title:
            results.append((url, title, snippet))

if not results:
    print(f'__EMPTY__')
    sys.exit(0)

out = []
for i, (u, t, s) in enumerate(results[:max_r]):
    out.append(f'{i+1}. {t}\n   {u}\n   {s}\n')
print('\n'.join(out))
PY
}

# Try Brave first
TMP_BRAVE=$(mktemp -t websearch.brave.XXXXXX)
HTTP_CODE=$(curl -s -L -A "$UA" \
  -H "Accept: text/html,application/xhtml+xml" \
  -H "Accept-Language: en-US,en;q=0.9" \
  "https://search.brave.com/search?q=${ENCODED}" \
  -o "$TMP_BRAVE" -w "%{http_code}" 2>/dev/null)

PARSED=""
if [ "$HTTP_CODE" = "200" ]; then
  PARSED=$(parse_with_python "$TMP_BRAVE" "brave")
fi
rm -f "$TMP_BRAVE"

if [ -n "$PARSED" ] && [ "$PARSED" != "__EMPTY__" ]; then
  echo "$PARSED"
  exit 0
fi

# Fallback: DuckDuckGo
TMP_DDG=$(mktemp -t websearch.ddg.XXXXXX)
curl -s -L -A "$UA" \
  "https://html.duckduckgo.com/html/?q=${ENCODED}" \
  -o "$TMP_DDG" 2>/dev/null

# Detect botnet block
if grep -q "anomaly.js" "$TMP_DDG" 2>/dev/null; then
  rm -f "$TMP_DDG"
  echo "__TYPE__:error"
  echo "Both Brave (HTTP $HTTP_CODE / no results) and DuckDuckGo (bot challenge) failed. Query: $QUERY"
  exit 0
fi

PARSED=$(parse_with_python "$TMP_DDG" "ddg")
rm -f "$TMP_DDG"

if [ -n "$PARSED" ] && [ "$PARSED" != "__EMPTY__" ]; then
  echo "$PARSED"
else
  echo "__TYPE__:error"
  echo "No results parsed from either engine for: $QUERY"
fi
