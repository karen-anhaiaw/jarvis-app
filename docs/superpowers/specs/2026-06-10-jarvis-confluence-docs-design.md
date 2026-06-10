# JARVIS Confluence Documentation — Design Spec

**Date:** 2026-06-10  
**Status:** Approved  
**Target:** https://nubank.atlassian.net/wiki/spaces/CISGBAB/pages/265282355316/Jarvis

---

## Context

Document JARVIS on Confluence with a parent-child hierarchy that serves two audiences:
- **Executive / curious colleagues** — what it is, why it exists, what it unlocks
- **Engineers** — how to install, understand the architecture, and extend the system

The parent page stays executive. Four child pages go deep on each axis.

---

## Positioning

**Central message:** *JARVIS is the LLM API without barriers — you control everything, from system prompt to hardware.*

Tools like Claude Code and Cursor impose structural limits. JARVIS removes them.

---

## Page Structure (Option B — approved)

```
📄 Jarvis  (parent — executive)
   ├── 📄 Como Funciona
   │      Architecture: Pieces, EventBus, HUD, Plugins, data flow
   ├── 📄 Quick Start — Instalação & Configuração
   │      setup.sh, providers, models, voice, MCP
   ├── 📄 Plugins & Capabilities
   │      Install plugins, marketplace, built-in capabilities, Skills
   └── 📄 Construindo em Cima do JARVIS
          Plugin structure, Piece interface, Capabilities, PluginContext API
```

---

## Parent Page: `Jarvis`

**Audience:** Leadership, engineers hearing about JARVIS for the first time  
**Tone:** Executive, visual, no code  
**Language:** Portuguese (Nubank internal)

### Sections

#### 1. O que é o JARVIS
One paragraph. JARVIS is a personal AI assistant built directly on top of provider APIs, with no intermediaries. Composable, extensible, fully owned by the developer.

#### 2. Por que ferramentas como Claude Code têm limites
Short bulleted comparison table. Documented limitations with references.

| Limitação | Claude Code | JARVIS |
|---|---|---|
| Comunicação entre agentes | Via arquivos; Agent-to-Agent protocol inexistente ([Issue #28300](https://github.com/anthropics/claude-code/issues/28300)) | EventBus PubSub real — ms latency, síncrono |
| Conexões persistentes | Sem suporte ([Issue #13613](https://github.com/anthropics/claude-code/issues/13613) fechada como "not planned") | gRPC always-on — qualquer client pode conectar e manter aberto |
| System prompt | Fixo no binário compilado (reverse-engineered por terceiros) | Recompilado a cada request — mude e o AI vê imediatamente |
| Extensibilidade | Zero nativa | Plugins hot-swap, Pieces, Skills, MCP servers |
| Provider / modelo | Preso ao Anthropic | Qualquer provider: Anthropic, OpenAI, Groq, Ollama, LiteLLM |
| RAG / contexto externo | Não suportado nativamente | Mnemosyne + Knowledge MCP integrados |

#### 3. O que o JARVIS desbloqueou
Visual bullets with icons:
- 🔓 **API direta** — sem wrapper, sem caixa-preta
- 🔄 **EventBus PubSub** — agentes se comunicam em tempo real
- 📡 **gRPC persistente** — conexões sempre abertas
- 🧠 **System prompt dinâmico** — muda sem restart, reavaliado a cada chamada
- 🔌 **Plugins hot-swap** — instala, ativa, desativa em runtime sem restart
- 🤖 **AI-agnóstico** — Anthropic, OpenAI, Groq, Ollama, qualquer API compatível
- 📚 **RAG nativo** — Mnemosyne (memória de longo prazo) + Knowledge MCP

#### 4. Screenshot do HUD
Single image showing the HUD in action.

#### 5. Explore mais
Table linking to the four child pages with one-line descriptions each.

---

## Child Page 1: `Como Funciona`

**Audience:** Engineers wanting to understand the system internals  
**Tone:** Technical but accessible  

### Sections
1. **Arquitetura hexagonal** — ports & adapters, no piece knows about any other
2. **Os 3 primitivos**
   - **Pieces** — the building block: `start(bus)` / `stop()`, publishes HUD events, contributes system context
   - **HUD Panels** — how pieces show themselves (draggable, resizable, layout persisted)
   - **Plugins** — external GitHub repos: pieces + renderers + capabilities, hot-loaded with no build step
3. **EventBus** — 6 channels: `ai.request`, `ai.stream`, `capability.request`, `capability.result`, `hud.update`, `system.event`
4. **Fluxo de dados** — text conversation flow, tool execution flow (sequence diagrams)
5. **Skills** — procedural knowledge loaded on demand from `~/.jarvis/skills/`
6. **Mnemosyne** — long-term memory: short/long-term layers, ChromaDB + Neo4j, automatic injection
7. **Multi-sessão via Actors** — how actors communicate via EventBus, session routing

---

## Child Page 2: `Quick Start — Instalação & Configuração`

**Audience:** Engineer wanting to run JARVIS today  
**Tone:** Step-by-step guide  

### Sections
1. **Pré-requisitos** — Node 18+, Git, API key (Anthropic or OpenAI)
2. **Instalação** — `git clone` + `./setup.sh` walkthrough
3. **Configurar provider** — Anthropic vs OpenAI, how to switch at runtime
4. **Trocar modelo** — ask JARVIS directly ("switch to gpt-4o")
5. **Instalar plugin de voz** — voice plugin quick-install
6. **MCP servers** — `mcp.json` config, connecting external services
7. **settings.json vs settings.user.json** — two-layer settings system
8. **macOS app** — creating JARVIS.app in Applications folder

---

## Child Page 3: `Plugins & Capabilities`

**Audience:** Engineer wanting to install or discover extensions  
**Tone:** Reference + discovery  

### Sections
1. **O que é um Plugin** — GitHub repo with `plugin.json`, hot-loaded, no build step
2. **Como instalar** — ask JARVIS or register in `settings.user.json`
3. **Marketplace** — available plugins (voice, skills, etc.)
4. **Capabilities built-in** — filesystem (bash, read/write/edit, glob, grep), web (search, fetch), scheduling (cron), model switching, restart
5. **Skills** — what they are, how to invoke, how to create in `~/.jarvis/skills/`
6. **MCP** — connecting external services (Slack, Jira, Prometheus, etc.)

---

## Child Page 4: `Construindo em Cima do JARVIS`

**Audience:** Engineer wanting to create plugins or capabilities  
**Tone:** Technical reference  

### Sections
1. **Estrutura do plugin repo**
   ```
   my-plugin/
   ├── plugin.json
   ├── package.json
   ├── pieces/
   │   ├── index.ts          createPieces(ctx) factory
   │   └── my-piece.ts
   └── renderers/
       └── MyRenderer.tsx
   ```
2. **plugin.json manifest** — name, entry, capabilities fields
3. **Piece interface** — `start(bus)`, `stop()`, `systemContext()`, HUD events
4. **PluginContext API** — EventBus, CapabilityRegistry, SessionFactory, HTTP route registration, config storage
5. **Registrando capabilities** — JSON config + shell script pattern
6. **Criando renderers** — TSX compiled by esbuild, same CSS classes as core HUD
7. **Exemplo completo** — minimal plugin from zero to running

---

## Spec Self-Review

- ✅ No TBDs or placeholders
- ✅ Internal consistency: architecture in Child 1, usage in Child 2, extension in Child 4
- ✅ Scope: 1 parent + 4 children = well-bounded, executable in one pass
- ✅ Every section has a clear target reader
- ✅ Parent page has no code blocks or technical diagrams
- ✅ Comparison table cites real GitHub issues for credibility
- ✅ AI-agnostic positioning captured in both parent table and key differentials

---

## Implementation Notes

- **Language:** Portuguese for all pages (Nubank internal audience)
- **Format:** Confluence HTML via API
- **Diagrams:** Mermaid rendered via mermaid.ink (base64 encoded), vertical layout (TD)
- **Parent page ID:** `265282355316` (already exists, currently empty)
- **Space ID:** `264821047320`
- **Child pages:** Create as children of `265282355316`
- **Screenshot:** Use `docs/assets/screenshot.png` from repo
- **Model for writing phase:** claude-fable-5
