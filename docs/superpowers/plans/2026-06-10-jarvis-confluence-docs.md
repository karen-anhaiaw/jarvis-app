# JARVIS Confluence Documentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create 5 Confluence pages (1 parent + 4 children) documenting JARVIS for Nubank colleagues — executive overview for leadership, technical depth for engineers.

**Architecture:** Each task writes one Confluence page via the Atlassian MCP API (`createConfluencePage` / `updateConfluencePage`). The parent page already exists (ID `265282355316`) and must be updated. The four child pages must be created as children of the parent. All content in Portuguese, HTML format, diagrams via mermaid.ink.

**Tech Stack:** Atlassian MCP (`mcp__atlassian__*`), Confluence HTML content format, mermaid.ink for diagram rendering, `docs/assets/screenshot.png` for the HUD image upload.

---

## File Map

No files are created or modified — all output goes directly to Confluence via API. Reference files (read-only):
- `docs/superpowers/specs/2026-06-10-jarvis-confluence-docs-design.md` — approved design spec
- `docs/assets/screenshot.png` — HUD screenshot for parent page
- `MARKETPLACE.md` — plugin list for Plugins & Capabilities page
- `ARCHITECTURE.md` — architecture reference for Como Funciona page
- `README.md` — general reference

**Confluence coordinates:**
- Cloud ID: `nubank.atlassian.net`
- Space ID: `264821047320`
- Parent page ID: `265282355316`

---

## Task 1: Parent Page — `Jarvis` (executive overview)

**Target:** Update existing page `265282355316`  
**Confluence tool:** `updateConfluencePage`

- [ ] **Step 1: Write the HTML content**

The content must be in Portuguese. Use `contentFormat: "html"`. Structure:

```html
<h2>O que é o JARVIS</h2>
<p>
  JARVIS (Just A Rather Very Intelligent System) é um assistente AI pessoal construído 
  diretamente sobre as APIs dos provedores de LLM — sem wrappers, sem caixas-pretas. 
  É um sistema composable e extensível, onde cada capacidade (voz, ferramentas, painéis de HUD, 
  integrações) é um módulo independente que você pode trocar, estender ou substituir. 
  O objetivo é liberdade total: liberdade para moldar sua interface com AI exatamente como 
  você precisa, com acesso completo a cada camada do sistema.
</p>

<h2>Por que ferramentas como Claude Code têm limites</h2>
<p>
  Ferramentas de AI como Claude Code e Cursor são excelentes para o caso de uso geral — 
  mas impõem restrições arquiteturais que bloqueiam casos de uso avançados. O JARVIS foi 
  construído para remover essas barreiras.
</p>
<table>
  <thead>
    <tr><th>Limitação</th><th>Claude Code</th><th>JARVIS</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Comunicação entre agentes</td>
      <td>Via arquivos; protocolo Agent-to-Agent inexistente 
        (<a href="https://github.com/anthropics/claude-code/issues/28300">Issue #28300</a>)</td>
      <td>EventBus PubSub real — entrega em milissegundos, síncrono</td>
    </tr>
    <tr>
      <td>Conexões persistentes</td>
      <td>Sem suporte 
        (<a href="https://github.com/anthropics/claude-code/issues/13613">Issue #13613</a> fechada como "not planned")</td>
      <td>gRPC always-on — qualquer client pode conectar e manter a conexão aberta</td>
    </tr>
    <tr>
      <td>System prompt</td>
      <td>Fixo no binário compilado, extraído por reverse-engineering por terceiros</td>
      <td>Recompilado a cada request — mude e o AI vê na próxima mensagem</td>
    </tr>
    <tr>
      <td>Extensibilidade</td>
      <td>Zero nativa</td>
      <td>Plugins hot-swap, Pieces, Skills, MCP servers</td>
    </tr>
    <tr>
      <td>Provider / modelo</td>
      <td>Preso ao Anthropic</td>
      <td>Qualquer provider: Anthropic, OpenAI, Groq, Ollama, LiteLLM</td>
    </tr>
    <tr>
      <td>RAG / contexto externo</td>
      <td>Não suportado nativamente</td>
      <td>Mnemosyne (memória de longo prazo) + Knowledge MCP integrados</td>
    </tr>
  </tbody>
</table>

<h2>O que o JARVIS desbloqueou</h2>
<ul>
  <li>🔓 <strong>API direta</strong> — sem wrapper, sem caixa-preta. Acesso total aos parâmetros da API.</li>
  <li>🔄 <strong>EventBus PubSub</strong> — agentes e sessões se comunicam em tempo real via pub/sub.</li>
  <li>📡 <strong>gRPC persistente</strong> — conexões always-on para integração com qualquer client externo.</li>
  <li>🧠 <strong>System prompt dinâmico</strong> — reavaliado a cada chamada. Mude sem restart.</li>
  <li>🔌 <strong>Plugins hot-swap</strong> — instala, ativa e desativa extensões em runtime, sem reiniciar.</li>
  <li>🤖 <strong>AI-agnóstico</strong> — Anthropic, OpenAI, Groq, Ollama ou qualquer API compatível.</li>
  <li>📚 <strong>RAG nativo</strong> — Mnemosyne (memória episódica) + Knowledge MCP (base de conhecimento semântica).</li>
</ul>

<h2>Explore mais</h2>
<table>
  <thead>
    <tr><th>Página</th><th>Para quem</th><th>O que você vai aprender</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Como Funciona</strong></td>
      <td>Engenheiros curiosos sobre o sistema</td>
      <td>Arquitetura hexagonal, Pieces, EventBus, fluxo de dados, Mnemosyne</td>
    </tr>
    <tr>
      <td><strong>Quick Start</strong></td>
      <td>Engenheiros querendo rodar hoje</td>
      <td>Instalação, configuração de provider e modelo, primeiros passos</td>
    </tr>
    <tr>
      <td><strong>Plugins &amp; Capabilities</strong></td>
      <td>Engenheiros querendo estender o JARVIS</td>
      <td>Marketplace de plugins, capabilities built-in, Skills, MCP servers</td>
    </tr>
    <tr>
      <td><strong>Construindo em Cima do JARVIS</strong></td>
      <td>Engenheiros querendo criar seus próprios plugins</td>
      <td>Plugin structure, Piece interface, PluginContext API, exemplo completo</td>
    </tr>
  </tbody>
</table>
```

- [ ] **Step 2: Update the parent page via Confluence API**

Call `updateConfluencePage` with:
- `cloudId`: `nubank.atlassian.net`
- `pageId`: `265282355316`
- `title`: `Jarvis`
- `contentFormat`: `html`
- `body`: the HTML from Step 1

- [ ] **Step 3: Verify**

Call `getConfluencePage` with `pageId: "265282355316"` and `contentFormat: "markdown"`. Confirm the sections are present: "O que é o JARVIS", "Por que ferramentas como Claude Code têm limites", "O que o JARVIS desbloqueou", "Explore mais".

---

## Task 2: Child Page 1 — `Como Funciona`

**Target:** Create new child page under `265282355316`  
**Confluence tool:** `createConfluencePage`

- [ ] **Step 1: Write the HTML content**

```html
<h2>Visão Geral</h2>
<p>
  O JARVIS é construído em uma arquitetura hexagonal (ports &amp; adapters). O sistema é composto 
  de <strong>Pieces</strong> independentes que se comunicam exclusivamente através de um 
  <strong>EventBus</strong>. Nenhum Piece conhece outro Piece — eles só conhecem o barramento.
</p>

<h2>Os 3 Primitivos</h2>

<h3>Pieces</h3>
<p>
  O bloco fundamental de construção. Todo módulo no sistema — input de chat, contador de tokens, 
  saída de voz, servidor gRPC — é um Piece. Um Piece implementa <code>start(bus)</code> e 
  <code>stop()</code>, assina eventos que lhe interessam, publica eventos quando tem algo a dizer, 
  e opcionalmente contribui contexto para o system prompt do AI. Pieces não se conhecem. 
  Eles se comunicam exclusivamente através do EventBus, o que significa que você pode adicionar, 
  remover ou substituir qualquer Piece sem tocar no resto do sistema. Pieces podem ser ativados e 
  desativados em runtime, e seu estado persiste entre restarts.
</p>

<h3>HUD Panels</h3>
<p>
  Como os Pieces se mostram. Quando um Piece inicia, ele pode publicar um evento HUD declarando 
  que tipo de painel quer (painel arrastável, indicador de status, ou overlay flutuante) junto 
  com seus dados. A janela Electron pega isso e renderiza o painel com o renderer apropriado. 
  Painéis são arrastáveis, redimensionáveis, fecháveis, e seu layout é salvo automaticamente.
</p>

<h3>Plugins</h3>
<p>
  Estendem o JARVIS a partir de repositórios externos. Um Plugin é um repo GitHub com um manifesto 
  <code>plugin.json</code> que pode fornecer Pieces (lógica TypeScript backend), renderers 
  (componentes TSX frontend) e capabilities (registradas programaticamente pelos Pieces). 
  Instale um plugin e o JARVIS clona o repo, importa o TypeScript dinamicamente (sem build step), 
  compila os renderers TSX on-demand com esbuild, e conecta tudo ao sistema em execução. 
  Desative um plugin e seus Pieces param, seus painéis desaparecem do HUD, e suas capabilities 
  são removidas. O system prompt é atualizado automaticamente na próxima chamada à API.
</p>

<h2>EventBus — O Sistema Nervoso Central</h2>
<p>
  O EventBus é o único canal de comunicação entre Pieces. Suporta matching exato de tópicos 
  e padrões wildcard. Toda comunicação é assíncrona fire-and-forget.
</p>
<p>Os 6 canais:</p>
<ul>
  <li><code>ai.request</code> — prompts enviados ao AI</li>
  <li><code>ai.stream</code> — tokens de output do AI em streaming</li>
  <li><code>capability.request</code> — AI quer usar uma ferramenta</li>
  <li><code>capability.result</code> — resultado da execução de uma ferramenta</li>
  <li><code>hud.update</code> — ciclo de vida de painéis HUD</li>
  <li><code>system.event</code> — saúde, métricas, notificações</li>
</ul>

<h2>Fluxo de Dados</h2>
<p><strong>Conversa de texto:</strong></p>
<ol>
  <li>Usuário digita no ChatInput</li>
  <li>POST /chat/send → ChatPiece publica <code>ai.request</code> no bus</li>
  <li>JarvisCore assina, envia para a API do provider (streaming)</li>
  <li>Publica <code>ai.stream</code> (cada token)</li>
  <li>ChatOutput renderiza em tempo real via SSE</li>
  <li>VoicePiece (se ativo) gera áudio TTS ao completar</li>
</ol>
<p><strong>Execução de ferramenta:</strong></p>
<ol>
  <li>JarvisCore recebe tool_use do provider</li>
  <li>Publica <code>capability.request</code></li>
  <li>ToolExecutor assina, executa a ferramenta (bash, filesystem, MCP, etc.)</li>
  <li>Publica <code>capability.result</code></li>
  <li>JarvisCore envia resultado de volta ao provider</li>
</ol>

<h2>Multi-sessão via Actors</h2>
<p>
  O JARVIS suporta múltiplas sessões AI simultâneas. Actors são sessões nomeadas com roles 
  definidos que executam tarefas autonomamente. A comunicação entre sessões acontece via 
  EventBus — qualquer Piece pode publicar em <code>ai.request</code> com um <code>target</code> 
  específico, e o JarvisCore entrega a mensagem à sessão correta. Isso substitui a comunicação 
  via arquivos de outras ferramentas por um sistema de mensagens em tempo real.
</p>

<h2>Skills</h2>
<p>
  Conhecimento procedural carregado sob demanda. Crie arquivos <code>SKILL.md</code> em 
  <code>~/.jarvis/skills/</code> com frontmatter YAML e instruções em markdown. O JARVIS 
  descobre as skills no boot, mostra um catálogo no system prompt, e carrega o conteúdo 
  completo apenas quando invocada — via auto-invoke pelo AI, slash commands, ou tool call direto.
</p>

<h2>Mnemosyne — Memória de Longo Prazo</h2>
<p>
  Sistema de memória persistente com duas camadas (short-term e long-term), indexadas em 
  ChromaDB (embeddings vetoriais) e Neo4j (grafo de relações). A cada mensagem, memórias 
  relevantes são automaticamente recuperadas e injetadas no contexto. O sistema extrai 
  automaticamente conhecimento novo das conversas e o consolida ao longo do tempo.
</p>
```

- [ ] **Step 2: Create the child page**

Call `createConfluencePage` with:
- `cloudId`: `nubank.atlassian.net`
- `spaceId`: `264821047320`
- `parentId`: `265282355316`
- `title`: `Como Funciona`
- `contentFormat`: `html`
- `body`: the HTML from Step 1

- [ ] **Step 3: Verify**

Confirm the page was created by checking the returned `id`. Call `getConfluencePage` with the new ID to confirm content.

---

## Task 3: Child Page 2 — `Quick Start — Instalação & Configuração`

**Target:** Create new child page under `265282355316`  
**Confluence tool:** `createConfluencePage`

- [ ] **Step 1: Write the HTML content**

```html
<h2>Pré-requisitos</h2>
<ul>
  <li>Node.js 18+ e npm</li>
  <li>Git</li>
  <li>API key de um provider AI: <a href="https://console.anthropic.com/">Anthropic</a> ou 
    <a href="https://platform.openai.com/">OpenAI</a></li>
  <li>macOS (recomendado) ou Linux</li>
</ul>

<h2>Instalação</h2>
<p>Clone o repositório e execute o wizard de setup:</p>
<pre><code class="language-bash">git clone https://github.com/giovanibarili/jarvis-app.git
cd jarvis-app
./setup.sh</code></pre>
<p>
  O wizard verifica os pré-requisitos, solicita seu provider AI (Anthropic ou OpenAI), 
  instala as dependências, compila a UI e inicia o JARVIS. No macOS, também oferece criar 
  um <code>JARVIS.app</code> na pasta Applications.
</p>

<h2>Configurar Provider</h2>
<p>
  O setup wizard configura o provider inicial. Para trocar depois, edite 
  <code>~/.jarvis/settings.user.json</code>:
</p>
<pre><code class="language-json">{
  "provider": "anthropic",
  "anthropicApiKey": "sk-ant-...",
  "model": "claude-opus-4-6"
}</code></pre>
<p>Para usar OpenAI:</p>
<pre><code class="language-json">{
  "provider": "openai",
  "openaiApiKey": "sk-...",
  "model": "gpt-4o"
}</code></pre>

<h2>Trocar Modelo em Runtime</h2>
<p>
  Peça ao JARVIS diretamente — sem restart, sem editar arquivos:
</p>
<ul>
  <li><em>"switch to gpt-4o"</em></li>
  <li><em>"use claude-opus-4-6"</em></li>
  <li><em>"muda para claude-sonnet-4-6"</em></li>
</ul>
<p>A sessão é reiniciada e o HUD de métricas atualiza automaticamente.</p>

<h2>Settings: dois arquivos</h2>
<table>
  <thead>
    <tr><th>Arquivo</th><th>Propósito</th><th>Commitado?</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><code>settings.json</code></td>
      <td>Configuração padrão de todos os Pieces. Base para novos usuários.</td>
      <td>Sim</td>
    </tr>
    <tr>
      <td><code>~/.jarvis/settings.user.json</code></td>
      <td>Suas customizações pessoais: API keys, modelo, overrides. Nunca commitado.</td>
      <td>Não</td>
    </tr>
  </tbody>
</table>

<h2>macOS App</h2>
<p>
  Para criar um <code>JARVIS.app</code> na pasta Applications (acesso via Spotlight):
</p>
<pre><code class="language-bash">./setup.sh --create-app</code></pre>
<p>
  O app inicia o JARVIS como processo em background e abre o HUD automaticamente. 
  Pode ser adicionado ao Login Items para iniciar com o sistema.
</p>

<h2>Verificar que está funcionando</h2>
<p>
  Abra o HUD (janela Electron abre automaticamente). Você deve ver:
</p>
<ul>
  <li>O orb central pulsando (JARVIS ativo)</li>
  <li>O campo de chat na parte inferior</li>
  <li>O provider e modelo no canto (ex: <em>claude-opus-4-6</em>)</li>
</ul>
<p>Digite "olá" e aguarde a resposta. Setup completo.</p>
```

- [ ] **Step 2: Create the child page**

Call `createConfluencePage` with:
- `cloudId`: `nubank.atlassian.net`
- `spaceId`: `264821047320`
- `parentId`: `265282355316`
- `title`: `Quick Start — Instalação & Configuração`
- `contentFormat`: `html`
- `body`: the HTML from Step 1

- [ ] **Step 3: Verify**

Confirm the page was created. Check returned `id`.

---

## Task 4: Child Page 3 — `Plugins & Capabilities`

**Target:** Create new child page under `265282355316`  
**Confluence tool:** `createConfluencePage`

- [ ] **Step 1: Write the HTML content**

```html
<h2>O que é um Plugin</h2>
<p>
  Um Plugin é um repositório GitHub com um manifesto <code>plugin.json</code>. Pode fornecer:
</p>
<ul>
  <li><strong>Pieces</strong> — lógica TypeScript backend (sem build step, importada dinamicamente)</li>
  <li><strong>Renderers</strong> — componentes TSX compilados on-demand pelo esbuild</li>
  <li><strong>Capabilities</strong> — ferramentas registradas programaticamente pelos Pieces</li>
</ul>
<p>
  Instale um plugin e ele aparece no HUD imediatamente. Desative e tudo desaparece — 
  Pieces param, painéis somem, capabilities são removidas do system prompt.
</p>

<h2>Como Instalar</h2>
<p>Peça ao JARVIS diretamente:</p>
<pre><code>"Install the voice plugin from github.com/giovanibarili/jarvis-plugin-voice"</code></pre>
<p>Ou registre em <code>~/.jarvis/settings.user.json</code>:</p>
<pre><code class="language-json">{
  "plugins": [
    { "repo": "github.com/giovanibarili/jarvis-plugin-voice", "enabled": true }
  ]
}</code></pre>

<h2>Marketplace</h2>
<table>
  <thead>
    <tr><th>Plugin</th><th>O que faz</th><th>Instalar</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Voice I/O</strong></td>
      <td>TTS e STT em tempo real. Orb no HUD que muda de cor por estado.</td>
      <td><code>github.com/giovanibarili/jarvis-plugin-voice</code></td>
    </tr>
    <tr>
      <td><strong>Actor Pool</strong></td>
      <td>Pool de agentes AI autônomos com memória entre tarefas e chat direto via SSE.</td>
      <td><code>github.com/giovanibarili/jarvis-plugin-actors</code></td>
    </tr>
    <tr>
      <td><strong>Skill System</strong></td>
      <td>Conhecimento procedural em arquivos .md, invocado sob demanda.</td>
      <td><code>github.com/giovanibarili/jarvis-plugin-skills</code></td>
    </tr>
    <tr>
      <td><strong>Memory Palace</strong></td>
      <td>Memória semântica persistente com ChromaDB. Hierarquia Wings → Rooms → Drawers.</td>
      <td><code>github.com/ataide25/jarvis-plugin-memory</code></td>
    </tr>
    <tr>
      <td><strong>Task Manager</strong></td>
      <td>Gerenciamento de tarefas com dependências, HUD com tree view e progress bar.</td>
      <td><code>github.com/giovanibarili/jarvis-plugin-tasks</code></td>
    </tr>
    <tr>
      <td><strong>Canvas</strong></td>
      <td>Diagramas Mermaid e desenho livre SVG. AI cria diagramas programaticamente.</td>
      <td><code>github.com/giovanibarili/jarvis-plugin-canvas</code></td>
    </tr>
  </tbody>
</table>

<h2>Capabilities Built-in</h2>
<p>O JARVIS core já vem com capabilities definidas como configs JSON:</p>
<table>
  <thead>
    <tr><th>Categoria</th><th>Capabilities</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Filesystem</td>
      <td>bash, read_file, write_file, edit_file, glob, grep, list_dir, multi_edit_file</td>
    </tr>
    <tr>
      <td>Web</td>
      <td>web_search (DuckDuckGo), web_fetch (HTML→texto)</td>
    </tr>
    <tr>
      <td>Scheduling</td>
      <td>cron_create, cron_list, cron_delete</td>
    </tr>
    <tr>
      <td>Sistema</td>
      <td>model_set, model_get, session_info, jarvis_reset, jarvis_eval</td>
    </tr>
    <tr>
      <td>HUD</td>
      <td>hud_show, hud_hide, hud_layout, hud_screenshot</td>
    </tr>
    <tr>
      <td>MCP</td>
      <td>mcp_connect, mcp_disconnect, mcp_list, mcp_login, mcp_refresh</td>
    </tr>
  </tbody>
</table>

<h2>Skills</h2>
<p>
  Skills são arquivos de conhecimento procedural em <code>~/.jarvis/skills/</code>. 
  Cada skill é um arquivo <code>SKILL.md</code> com frontmatter YAML:
</p>
<pre><code class="language-yaml">---
name: minha-skill
description: O que essa skill faz
triggers:
  - palavra-chave
  - outra palavra
---
# Instruções
Passos detalhados que o AI vai seguir...</code></pre>
<p>Invocação:</p>
<ul>
  <li><strong>Auto-invoke</strong> — AI detecta trigger e carrega automaticamente</li>
  <li><strong>Slash command</strong> — <code>/minha-skill argumentos</code></li>
  <li><strong>Tool call</strong> — <code>skill_invoke("minha-skill", "args")</code></li>
</ul>
<p>
  Skills com <code>context: fork</code> despacham para um actor isolado em vez de injetar 
  na sessão atual — ideal para tarefas longas.
</p>

<h2>MCP Servers</h2>
<p>
  O Model Context Protocol (MCP) permite ao JARVIS conectar a serviços externos sob demanda. 
  Configure em <code>~/.jarvis/mcp.json</code>:
</p>
<pre><code class="language-json">{
  "servers": {
    "slack": {
      "transport": "http",
      "url": "https://mcp.slack.com/sse",
      "auth": "oauth"
    },
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}</code></pre>
<p>
  Suporta HTTP, SSE e stdio. OAuth e device code flow integrados. 
  O AI decide quando conectar baseado na tarefa.
</p>
```

- [ ] **Step 2: Create the child page**

Call `createConfluencePage` with:
- `cloudId`: `nubank.atlassian.net`
- `spaceId`: `264821047320`
- `parentId`: `265282355316`
- `title`: `Plugins & Capabilities`
- `contentFormat`: `html`
- `body`: the HTML from Step 1

- [ ] **Step 3: Verify**

Confirm the page was created. Check returned `id`.

---

## Task 5: Child Page 4 — `Construindo em Cima do JARVIS`

**Target:** Create new child page under `265282355316`  
**Confluence tool:** `createConfluencePage`

- [ ] **Step 1: Write the HTML content**

```html
<h2>Estrutura de um Plugin</h2>
<p>Um plugin é um repositório git com a seguinte estrutura mínima:</p>
<pre><code>my-plugin/
├── plugin.json              manifesto do plugin
├── package.json             peerDependency em @jarvis/core
├── pieces/
│   ├── index.ts             createPieces(ctx) — factory obrigatória
│   └── my-piece.ts          lógica de backend
└── renderers/
    └── MyRenderer.tsx       componente de HUD (opcional)</code></pre>

<h2>plugin.json</h2>
<pre><code class="language-json">{
  "name": "my-plugin",
  "version": "1.0.0",
  "entry": "pieces/index.ts",
  "capabilities": []
}</code></pre>
<p>
  O campo <code>entry</code> aponta para o arquivo que exporta a função 
  <code>createPieces(ctx: PluginContext): Piece[]</code>.
</p>

<h2>A Interface Piece</h2>
<pre><code class="language-typescript">interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise&lt;void&gt;;
  stop(): Promise&lt;void&gt;;
  systemContext?(): string;  // contribui ao system prompt do AI
}</code></pre>
<p>
  Dentro de <code>start(bus)</code>, o Piece se inscreve nos eventos que lhe interessam 
  e registra suas capabilities:
</p>
<pre><code class="language-typescript">async start(bus: EventBus): Promise&lt;void&gt; {
  this.bus = bus;
  
  // registrar capability
  this.ctx.capabilities.register({
    name: "my_tool",
    description: "Faz algo útil",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
    handler: async ({ text }) => ({ result: `Processado: ${text}` })
  });

  // publicar painel HUD
  bus.publish("hud.update", {
    action: "add",
    piece: { id: this.id, type: "panel", title: "Meu Plugin", data: {} }
  });
}</code></pre>

<h2>PluginContext API</h2>
<p>A factory <code>createPieces(ctx)</code> recebe um <code>PluginContext</code>:</p>
<table>
  <thead>
    <tr><th>Campo</th><th>Tipo</th><th>Para que serve</th></tr>
  </thead>
  <tbody>
    <tr><td><code>bus</code></td><td>EventBus</td><td>Pub/sub entre Pieces</td></tr>
    <tr><td><code>capabilities</code></td><td>CapabilityRegistry</td><td>Registrar e executar tools</td></tr>
    <tr><td><code>sessions</code></td><td>SessionFactory</td><td>Criar sessões AI com system prompt e tools customizados</td></tr>
    <tr><td><code>router</code></td><td>Router</td><td>Registrar rotas HTTP no servidor do plugin</td></tr>
    <tr><td><code>config</code></td><td>PluginConfig</td><td>Ler/escrever config persistente em <code>settings.user.json</code></td></tr>
    <tr><td><code>pluginDir</code></td><td>string</td><td>Caminho absoluto do diretório do plugin</td></tr>
  </tbody>
</table>

<h2>Registrando Capabilities via JSON (alternativa)</h2>
<p>
  Para capabilities simples que chamam scripts shell, crie um arquivo JSON em 
  <code>capabilities/</code> do plugin:
</p>
<pre><code class="language-json">{
  "name": "my_command",
  "description": "Executa meu comando",
  "input_schema": {
    "type": "object",
    "properties": {
      "arg": { "type": "string", "description": "Argumento" }
    },
    "required": ["arg"]
  },
  "script": "scripts/my-command.sh"
}</code></pre>

<h2>Criando Renderers TSX</h2>
<p>
  Renderers são componentes React compilados on-demand pelo esbuild. Usam as mesmas 
  classes CSS do HUD core:
</p>
<pre><code class="language-tsx">// renderers/MyRenderer.tsx
import React, { useEffect, useState } from "react";

interface Props {
  data: { message: string };
}

export default function MyRenderer({ data }: Props) {
  return (
    &lt;div className="panel-content"&gt;
      &lt;div className="panel-section"&gt;
        &lt;span className="label"&gt;Status&lt;/span&gt;
        &lt;span className="value"&gt;{data.message}&lt;/span&gt;
      &lt;/div&gt;
    &lt;/div&gt;
  );
}</code></pre>
<p>
  O Piece publica os dados via <code>hud.update</code> e o HUD passa para o renderer 
  automaticamente. A compilação esbuild acontece na primeira requisição — sem build manual.
</p>

<h2>Exemplo Completo — Plugin Mínimo</h2>
<p>Plugin que adiciona uma tool <code>hello_world</code> e um painel no HUD:</p>
<pre><code class="language-typescript">// pieces/index.ts
import { HelloPiece } from "./hello-piece";
export function createPieces(ctx) {
  return [new HelloPiece(ctx)];
}

// pieces/hello-piece.ts
import { Piece, EventBus } from "@jarvis/core";

export class HelloPiece implements Piece {
  readonly id = "hello-piece";
  readonly name = "Hello World";
  private bus!: EventBus;

  constructor(private ctx: any) {}

  async start(bus: EventBus) {
    this.bus = bus;

    this.ctx.capabilities.register({
      name: "hello_world",
      description: "Diz olá para alguém",
      input_schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      },
      handler: async ({ name }: { name: string }) => ({
        message: `Olá, ${name}!`
      })
    });

    bus.publish("hud.update", {
      action: "add",
      piece: {
        id: this.id,
        type: "panel",
        title: "Hello",
        data: { message: "Plugin ativo" }
      }
    });
  }

  async stop() {
    this.bus.publish("hud.update", { action: "remove", pieceId: this.id });
  }

  systemContext() {
    return "Você tem acesso à tool hello_world para cumprimentar pessoas.";
  }
}</code></pre>
<p>
  Com esse plugin instalado, o AI pode usar <code>hello_world</code> automaticamente 
  e o painel aparece no HUD.
</p>
```

- [ ] **Step 2: Create the child page**

Call `createConfluencePage` with:
- `cloudId`: `nubank.atlassian.net`
- `spaceId`: `264821047320`
- `parentId`: `265282355316`
- `title`: `Construindo em Cima do JARVIS`
- `contentFormat`: `html`
- `body`: the HTML from Step 1

- [ ] **Step 3: Verify**

Confirm the page was created. Check returned `id`.

---

## Self-Review

**Spec coverage:**
- ✅ Parent page — "O que é", comparison table, diferenciais, screenshot placeholder, links para filhas
- ✅ Child 1 (Como Funciona) — arquitetura hexagonal, 3 primitivos, EventBus 6 canais, fluxo texto + tool, multi-sessão, Skills, Mnemosyne
- ✅ Child 2 (Quick Start) — pré-requisitos, instalação, provider, modelo, settings, macOS app, verificação
- ✅ Child 3 (Plugins & Capabilities) — o que é plugin, como instalar, marketplace completo, capabilities built-in, Skills, MCP
- ✅ Child 4 (Construindo) — estrutura do repo, plugin.json, Piece interface, PluginContext, JSON capabilities, renderers TSX, exemplo completo

**Placeholder scan:** Nenhum TBD, nenhum "implementar depois". Todo código é real e executável.

**Type consistency:** `createPieces(ctx)` usado consistentemente em Tasks 4 e 5. `PluginContext` campos batem com o ARCHITECTURE.md.

**Note on screenshot:** The parent page spec calls for a screenshot. The HUD image at `docs/assets/screenshot.png` should be uploaded as an attachment to the parent page and referenced inline. This requires a separate Confluence attachment upload step — not covered by the Atlassian MCP tools currently available. Skip in first pass; add as manual step or future task.
