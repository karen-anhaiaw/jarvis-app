# Mnemosyne v1.3 — Graph Retrieval Design

> Date: 2026-05-21
> Status: APPROVED
> Branch: feat/v1.3-graph-retrieval (to be created)
> Depends on: v1.2 TRIPLET (merged to main at 800befd)

---

## Problem

The current retriever returns flat memories ranked by vector similarity + graph_distance rerank signal. Relations stored in Neo4j (built by v1.2 TRIPLET) are used only as a ranking signal — they are never surfaced to the LLM. The LLM cannot see "M1 contradicts M2" or "M1 relates_to M3" even when those relations exist and are highly relevant.

---

## Goals

1. Surface the relational neighborhood of each retrieved memory in the injected context.
2. Allow the LLM to navigate the graph on-demand via a `memory_fetch` tool.
3. Keep passive injection lightweight — parents + children with child-count only.
4. Keep `memory_fetch` rich — full neighborhood with grandchildren expanded.
5. Feature-flag off by default — v1.2 path unchanged.

---

## Design

### Retrieval output shape

**Passive injection (automatic, per turn):**
- Each retrieved memory shows: parents (all) + children (all) with grandchild count per child.
- Hint injected only when at least one memory has parents or children.

**`memory_fetch(id)` tool:**
- Returns full memory + parents + children + grandchildren of each child expanded.
- Repeats the hint for further navigation.

---

### Types (`lib/types.ts`)

```typescript
interface RelatedMemoryRef {
  id: string;
  title: string;
  category: string;
  relation: RelateRelation;
  direction: "incoming" | "outgoing";
  childCount: number;  // grandchild count (for children) or parent's-parent count (for parents)
}

interface MemoryNeighborhood {
  parents: RelatedMemoryRef[];   // incoming edges to this memory
  children: RelatedMemoryRef[];  // outgoing edges from this memory
}

// Addition to RetrievalHit:
// neighborhood?: MemoryNeighborhood
```

---

### `lib/graph-neighborhood.ts` (new)

```typescript
class GraphNeighborhoodService {
  constructor(neo4j: Neo4jAdapter)
  async enrichBatch(ids: string[]): Promise<Map<string, MemoryNeighborhood>>
  async enrichOne(id: string): Promise<MemoryNeighborhood>  // used by memory_fetch
}
```

**Single batch Cypher query for enrichBatch:**
```cypher
UNWIND $ids AS rootId
MATCH (root:Memory {id: rootId})
OPTIONAL MATCH (parent:Memory)-[rp:RELATES_TO]->(root)
OPTIONAL MATCH (parent)<-[:RELATES_TO]-(parentChild:Memory)
  WHERE parentChild.id <> root.id
OPTIONAL MATCH (root)-[rc:RELATES_TO]->(child:Memory)
OPTIONAL MATCH (child)-[:RELATES_TO]->(grandchild:Memory)
  WHERE grandchild.id <> root.id
RETURN
  rootId,
  parent.id AS parentId, parent.title AS parentTitle,
  parent.category AS parentCategory,
  rp.relation AS parentRelation,
  count(DISTINCT parentChild) AS parentChildCount,
  child.id AS childId, child.title AS childTitle,
  child.category AS childCategory,
  rc.relation AS childRelation,
  count(DISTINCT grandchild) AS childGrandchildCount
```

**enrichOne for memory_fetch** — same query but for a single id, plus expands grandchildren:
```cypher
MATCH (root:Memory {id: $id})
OPTIONAL MATCH (parent:Memory)-[rp:RELATES_TO]->(root)
OPTIONAL MATCH (root)-[rc:RELATES_TO]->(child:Memory)
OPTIONAL MATCH (child)-[rg:RELATES_TO]->(grandchild:Memory)
  WHERE grandchild.id <> root.id
RETURN root, parent, rp.relation, child, rc.relation, grandchild, rg.relation
```

---

### `pieces/retriever.ts` changes

After rerank, if `config.graph_retrieval.enabled`:
1. Collect hit ids.
2. Call `graphNeighborhood.enrichBatch(hitIds)` — one Neo4j round-trip.
3. Attach `neighborhood` to each `RetrievalHit`.
4. Format in `systemContext()`:

```markdown
## Mnemosyne — Relevant memories

**M1** [preference] — "Likes Postgres" (conf: 0.92)
> User prefers Postgres for greenfield projects
  ↑ M3 [architecture-decision] "PG chosen for SAA" — relates_to  (0 filhos)
  ↓ M2 [preference] "PG JSONB support" — relates_to_variant  (8 filhos)
  ↓ M7 [preference] "Prefers SQLite embedded" — contradicts  (0 filhos)

_Se necessário explorar uma memória relacionada, use `memory_fetch(id)`._
```

The hint line appears only when at least one memory has parents or children.

---

### `lib/tools/memory-fetch.ts` (new)

Tool: `memory_fetch`  
Input schema: `{ id: { type: "string", description: "Memory ID to fetch with full neighborhood" } }`

Handler:
1. Fetch `Memory` by id from `MarkdownStore`.
2. Call `graphNeighborhood.enrichOne(id)` — returns parents + children + grandchildren.
3. Format and return as string.

Output format:
```markdown
**M2** [preference] — "PG JSONB support"
> content...
evidence: "PG JSONB is great for semi-structured data"

  ↑ M1 [preference] "Likes Postgres" — relates_to_variant  (2 filhos)
  ↓ M8 [code-pattern] "JSONB query pattern" — relates_to
      → M15 [code-pattern] "GIN index on JSONB" — relates_to
      → M16 [mental-model] "Document vs relational" — relates_to
  ↓ M11 [mental-model] "Document vs relational tradeoff" — relates_to
      (no children)

_Use memory_fetch(id) to continue exploring._
```

---

### Config (`config.default.json`)

```json
"graph_retrieval": {
  "enabled": false,
  "max_parents": 10,
  "max_children": 20
}
```

---

### Files to create/modify

| File | Action |
|---|---|
| `lib/types.ts` | Add `RelatedMemoryRef`, `MemoryNeighborhood`; extend `RetrievalHit` |
| `lib/graph-neighborhood.ts` | New — `GraphNeighborhoodService` with `enrichBatch` + `enrichOne` |
| `lib/neo4j-adapter.ts` | Add `getNeighborhoodBatch(ids)` and `getNeighborhoodOne(id)` methods |
| `pieces/retriever.ts` | Call `enrichBatch` after rerank; update `systemContext()` formatter |
| `lib/tools/memory-fetch.ts` | New — `memory_fetch` tool handler |
| `pieces/index.ts` | Register `memory_fetch` tool when `graph_retrieval.enabled` |
| `config.default.json` | Add `graph_retrieval` section |
| `test/unit/v13/graph-neighborhood.test.ts` | Unit tests for `GraphNeighborhoodService` |
| `test/unit/v13/memory-fetch.test.ts` | Unit tests for tool handler |
| `test/integration/v13/retriever-graph.test.ts` | Integration test for enriched retrieval |
| `functional-test.md` | Append T13-1 through T13-4 BDD scenarios |

---

### BDD Scenarios (T13-*)

**T13-1: Passive injection shows neighborhood**
Given `graph_retrieval.enabled: true` and M1 has 2 children in Neo4j  
When retriever fetches M1  
Then context injection shows `↓ M2 ... (3 filhos)` and `↓ M7 ... (0 filhos)`  
And the hint line appears

**T13-2: Hint absent when no relations**
Given `graph_retrieval.enabled: true` and retrieved memory has no parents or children  
When retriever fetches M1  
Then no hint line is injected

**T13-3: memory_fetch returns expanded neighborhood**
Given M2 has 2 children each with grandchildren  
When LLM calls `memory_fetch("M2")`  
Then response includes M2's parents + children + grandchildren of each child  
And response ends with the navigation hint

**T13-4: Feature flag off keeps v1.2 behavior**
Given `graph_retrieval.enabled: false`  
When retriever fetches memories  
Then no neighborhood is attached  
And `memory_fetch` tool is not registered

---

## Decisions locked

- Approach B: `GraphNeighborhoodService.enrichBatch` — single Cypher for all hits
- Passive injection: parents + children + child-count only (no grandchild listing)
- `memory_fetch`: parents + children + grandchildren expanded
- Hint: conditional (only when relations exist)
- Feature flag: `graph_retrieval.enabled` (default false)
- Caps: `max_parents: 10`, `max_children: 20`
