# Mnemosyne v1.3 — Graph Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the Neo4j relational neighborhood (parents + children + grandchild count) in the Mnemosyne context injection, and expose a `memory_fetch` tool for on-demand graph traversal.

**Architecture:** `GraphNeighborhoodService` runs a single batch Cypher query for all retrieved memory IDs. `RetrieverPiece` calls it after rerank and formats the neighborhood inline. `memory_fetch` tool returns expanded neighborhood (grandchildren listed). Feature-flagged off by default.

**Tech Stack:** TypeScript, Neo4j Bolt, Vitest, existing `Neo4jAdapter` + `RetrieverPiece` + `MarkdownStore`.

---

## File Structure

**New files:**
- `lib/graph-neighborhood.ts` — `GraphNeighborhoodService` (enrichBatch + enrichOne)
- `lib/tools/memory-fetch.ts` — `memory_fetch` tool builder
- `test/unit/v13/graph-neighborhood.test.ts`
- `test/unit/v13/memory-fetch.test.ts`
- `test/integration/v13/retriever-graph.test.ts`

**Modified files:**
- `lib/types.ts` — add `RelatedMemoryRef`, `MemoryNeighborhood`, extend `RetrievalHit`
- `lib/neo4j-adapter.ts` — add `getNeighborhoodBatch(ids)` and `getNeighborhoodOne(id)`
- `pieces/retriever.ts` — call `enrichBatch`, update `systemContext()` formatter
- `pieces/index.ts` — register `memory_fetch` tool when `graph_retrieval.enabled`
- `config.default.json` — add `graph_retrieval` section
- `functional-test.md` — append T13-1 through T13-4

---

## Task 1: Types + config scaffold

**Files:**
- Modify: `lib/types.ts`
- Modify: `config.default.json`

- [ ] **Step 1: Write failing test**

Create `test/unit/v13/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { RelatedMemoryRef, MemoryNeighborhood, RetrievalHit } from "../../../lib/types";
import type { RelateRelation } from "../../../lib/types";

describe("v1.3 types", () => {
  it("RelatedMemoryRef has required fields", () => {
    const ref: RelatedMemoryRef = {
      id: "m1", title: "t", category: "preference",
      relation: "relates_to", direction: "outgoing", childCount: 3,
    };
    expect(ref.childCount).toBe(3);
    expect(ref.direction).toBe("outgoing");
  });

  it("MemoryNeighborhood has parents and children arrays", () => {
    const n: MemoryNeighborhood = { parents: [], children: [] };
    expect(n.parents).toHaveLength(0);
    expect(n.children).toHaveLength(0);
  });

  it("RetrievalHit accepts optional neighborhood field", () => {
    // type check only — compiles = passes
    const hit: Partial<RetrievalHit> = {
      neighborhood: { parents: [], children: [] },
    };
    expect(hit.neighborhood).toBeDefined();
  });

  it("config.default.json has graph_retrieval section", async () => {
    const { promises: fs } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const raw = await fs.readFile(join(__dirname, "../../../config.default.json"), "utf8");
    const cfg = JSON.parse(raw);
    expect(cfg.graph_retrieval).toBeDefined();
    expect(cfg.graph_retrieval.enabled).toBe(false);
    expect(cfg.graph_retrieval.max_parents).toBe(10);
    expect(cfg.graph_retrieval.max_children).toBe(20);
  });
});
```

Run: `npm test -- test/unit/v13/types.test.ts 2>&1 | tail -10`
Expected: FAIL (types not defined yet)

- [ ] **Step 2: Add types to `lib/types.ts`**

Append after the existing v1.2 types block:

```typescript
// ---- v1.3 Graph Retrieval ----

export interface RelatedMemoryRef {
  id: string;
  title: string;
  category: string;
  relation: RelateRelation;
  direction: "incoming" | "outgoing";
  childCount: number;
}

export interface MemoryNeighborhood {
  parents: RelatedMemoryRef[];
  children: RelatedMemoryRef[];
}
```

Then add to `RetrievalHit` interface:
```typescript
neighborhood?: MemoryNeighborhood;
```

- [ ] **Step 3: Add config section to `config.default.json`**

Add before the closing `}`:
```json
"graph_retrieval": {
  "enabled": false,
  "max_parents": 10,
  "max_children": 20
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `npm test -- test/unit/v13/types.test.ts 2>&1 | tail -10`
Expected: 4/4 PASS

- [ ] **Step 5: Run full unit suite (no regressions)**

Run: `npm test -- test/unit 2>&1 | tail -8`
Expected: all green

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts config.default.json test/unit/v13/types.test.ts
git commit -m "feat(v13): add RelatedMemoryRef, MemoryNeighborhood types + graph_retrieval config"
```

---

## Task 2: Neo4jAdapter — batch and single neighborhood queries

**Files:**
- Modify: `lib/neo4j-adapter.ts`
- Test: `test/unit/v13/neo4j-adapter.test.ts`

- [ ] **Step 1: Read existing adapter**

```bash
head -60 lib/neo4j-adapter.ts
grep -n "async\|getRelations\|oneHop" lib/neo4j-adapter.ts | head -20
```

Understand: how `runQuery(cypher, params)` works, how results are mapped.

- [ ] **Step 2: Write failing test**

Create `test/unit/v13/neo4j-adapter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock the neo4j-driver at module level
vi.mock("neo4j-driver", () => ({
  default: {
    driver: vi.fn(() => ({
      session: vi.fn(() => ({
        run: vi.fn(),
        close: vi.fn(),
      })),
      close: vi.fn(),
    })),
    auth: { basic: vi.fn(() => ({})) },
    integer: { toNumber: (n: any) => typeof n === "object" ? n.low ?? 0 : n },
  },
}));

import { Neo4jAdapter } from "../../../lib/neo4j-adapter";

describe("Neo4jAdapter v1.3 methods", () => {
  it("getNeighborhoodBatch returns empty map for empty input", async () => {
    const adapter = new Neo4jAdapter("bolt://127.0.0.1:7687", "none");
    // Patch runQuery to avoid real connection
    (adapter as any).runQuery = vi.fn().mockResolvedValue([]);
    const result = await adapter.getNeighborhoodBatch([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("getNeighborhoodBatch parses parent rows correctly", async () => {
    const adapter = new Neo4jAdapter("bolt://127.0.0.1:7687", "none");
    (adapter as any).runQuery = vi.fn().mockResolvedValue([
      {
        rootId: "m1",
        parentId: "p1", parentTitle: "Parent", parentCategory: "preference",
        parentRelation: "relates_to", parentChildCount: { low: 3, high: 0 },
        childId: null, childTitle: null, childCategory: null,
        childRelation: null, childGrandchildCount: { low: 0, high: 0 },
      },
    ]);
    const result = await adapter.getNeighborhoodBatch(["m1"]);
    const n = result.get("m1")!;
    expect(n.parents).toHaveLength(1);
    expect(n.parents[0]).toMatchObject({ id: "p1", title: "Parent", childCount: 3, direction: "incoming" });
    expect(n.children).toHaveLength(0);
  });

  it("getNeighborhoodBatch parses child rows correctly", async () => {
    const adapter = new Neo4jAdapter("bolt://127.0.0.1:7687", "none");
    (adapter as any).runQuery = vi.fn().mockResolvedValue([
      {
        rootId: "m1",
        parentId: null, parentTitle: null, parentCategory: null,
        parentRelation: null, parentChildCount: { low: 0, high: 0 },
        childId: "c1", childTitle: "Child", childCategory: "code-pattern",
        childRelation: "contradicts", childGrandchildCount: { low: 5, high: 0 },
      },
    ]);
    const result = await adapter.getNeighborhoodBatch(["m1"]);
    const n = result.get("m1")!;
    expect(n.children).toHaveLength(1);
    expect(n.children[0]).toMatchObject({ id: "c1", childCount: 5, direction: "outgoing", relation: "contradicts" });
  });

  it("getNeighborhoodOne returns expanded neighborhood with grandchildren", async () => {
    const adapter = new Neo4jAdapter("bolt://127.0.0.1:7687", "none");
    (adapter as any).runQuery = vi.fn().mockResolvedValue([
      {
        parentId: "p1", parentTitle: "P", parentCategory: "pref", parentRelation: "relates_to",
        parentChildCount: { low: 0, high: 0 },
        childId: "c1", childTitle: "C", childCategory: "code-pattern", childRelation: "merge",
        grandchildId: "g1", grandchildTitle: "G", grandchildCategory: "pattern", grandchildRelation: "relates_to",
      },
    ]);
    const n = await adapter.getNeighborhoodOne("m1");
    expect(n.parents).toHaveLength(1);
    expect(n.children).toHaveLength(1);
    // children have grandchildren array
    expect((n.children[0] as any).grandchildren).toHaveLength(1);
  });
});
```

Run: `npm test -- test/unit/v13/neo4j-adapter.test.ts 2>&1 | tail -15`
Expected: FAIL (methods not defined yet)

- [ ] **Step 3: Implement `getNeighborhoodBatch` and `getNeighborhoodOne` in `lib/neo4j-adapter.ts`**

Add after existing methods:

```typescript
async getNeighborhoodBatch(ids: string[]): Promise<Map<string, MemoryNeighborhood>> {
  if (ids.length === 0) return new Map();
  const rows = await this.runQuery(`
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
      parent.category AS parentCategory, rp.relation AS parentRelation,
      count(DISTINCT parentChild) AS parentChildCount,
      child.id AS childId, child.title AS childTitle,
      child.category AS childCategory, rc.relation AS childRelation,
      count(DISTINCT grandchild) AS childGrandchildCount
  `, { ids });

  const result = new Map<string, MemoryNeighborhood>();
  for (const row of rows) {
    const rootId = row.rootId as string;
    if (!result.has(rootId)) result.set(rootId, { parents: [], children: [] });
    const n = result.get(rootId)!;
    const toNum = (v: any) => typeof v === "object" && v !== null ? (v.low ?? 0) : (v ?? 0);

    if (row.parentId) {
      const alreadyAdded = n.parents.some((p) => p.id === row.parentId);
      if (!alreadyAdded) {
        n.parents.push({
          id: row.parentId, title: row.parentTitle ?? "",
          category: row.parentCategory ?? "", relation: (row.parentRelation ?? "relates_to") as RelateRelation,
          direction: "incoming", childCount: toNum(row.parentChildCount),
        });
      }
    }
    if (row.childId) {
      const alreadyAdded = n.children.some((c) => c.id === row.childId);
      if (!alreadyAdded) {
        n.children.push({
          id: row.childId, title: row.childTitle ?? "",
          category: row.childCategory ?? "", relation: (row.childRelation ?? "relates_to") as RelateRelation,
          direction: "outgoing", childCount: toNum(row.childGrandchildCount),
        });
      }
    }
  }
  return result;
}

async getNeighborhoodOne(id: string): Promise<MemoryNeighborhood & { childrenExpanded: ExpandedChild[] }> {
  const rows = await this.runQuery(`
    MATCH (root:Memory {id: $id})
    OPTIONAL MATCH (parent:Memory)-[rp:RELATES_TO]->(root)
    OPTIONAL MATCH (root)-[rc:RELATES_TO]->(child:Memory)
    OPTIONAL MATCH (child)-[rg:RELATES_TO]->(grandchild:Memory)
      WHERE grandchild.id <> root.id
    RETURN
      parent.id AS parentId, parent.title AS parentTitle,
      parent.category AS parentCategory, rp.relation AS parentRelation,
      child.id AS childId, child.title AS childTitle,
      child.category AS childCategory, rc.relation AS childRelation,
      grandchild.id AS grandchildId, grandchild.title AS grandchildTitle,
      grandchild.category AS grandchildCategory, rg.relation AS grandchildRelation
  `, { id });

  const parents: RelatedMemoryRef[] = [];
  const childMap = new Map<string, ExpandedChild>();

  for (const row of rows) {
    if (row.parentId && !parents.some((p) => p.id === row.parentId)) {
      parents.push({ id: row.parentId, title: row.parentTitle ?? "", category: row.parentCategory ?? "",
        relation: (row.parentRelation ?? "relates_to") as RelateRelation, direction: "incoming", childCount: 0 });
    }
    if (row.childId) {
      if (!childMap.has(row.childId)) {
        childMap.set(row.childId, { id: row.childId, title: row.childTitle ?? "",
          category: row.childCategory ?? "", relation: (row.childRelation ?? "relates_to") as RelateRelation,
          direction: "outgoing", childCount: 0, grandchildren: [] });
      }
      if (row.grandchildId) {
        const child = childMap.get(row.childId)!;
        if (!child.grandchildren.some((g) => g.id === row.grandchildId)) {
          child.grandchildren.push({ id: row.grandchildId, title: row.grandchildTitle ?? "",
            category: row.grandchildCategory ?? "", relation: (row.grandchildRelation ?? "relates_to") as RelateRelation,
            direction: "outgoing", childCount: 0 });
        }
      }
    }
  }

  const childrenExpanded = Array.from(childMap.values());
  const children: RelatedMemoryRef[] = childrenExpanded.map((c) => ({ ...c, childCount: c.grandchildren.length }));
  return { parents, children, childrenExpanded };
}
```

Also add the `ExpandedChild` type locally in the adapter (or `lib/types.ts`):
```typescript
export interface ExpandedChild extends RelatedMemoryRef {
  grandchildren: RelatedMemoryRef[];
}
```

- [ ] **Step 4: Add imports** — import `RelatedMemoryRef`, `MemoryNeighborhood`, `ExpandedChild`, `RelateRelation` from `../types`

- [ ] **Step 5: Run test, verify PASS**

Run: `npm test -- test/unit/v13/neo4j-adapter.test.ts 2>&1 | tail -15`
Expected: 4/4 PASS

- [ ] **Step 6: Run full unit suite**

Run: `npm test -- test/unit 2>&1 | tail -8`

- [ ] **Step 7: Commit**

```bash
git add lib/neo4j-adapter.ts lib/types.ts test/unit/v13/neo4j-adapter.test.ts
git commit -m "feat(v13): add getNeighborhoodBatch + getNeighborhoodOne to Neo4jAdapter"
```

---

## Task 3: GraphNeighborhoodService

**Files:**
- Create: `lib/graph-neighborhood.ts`
- Test: `test/unit/v13/graph-neighborhood.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/unit/v13/graph-neighborhood.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { GraphNeighborhoodService } from "../../../lib/graph-neighborhood";

const makeAdapter = (batchResult: Map<string, any>, oneResult?: any) => ({
  getNeighborhoodBatch: vi.fn().mockResolvedValue(batchResult),
  getNeighborhoodOne: vi.fn().mockResolvedValue(oneResult ?? { parents: [], children: [], childrenExpanded: [] }),
});

describe("GraphNeighborhoodService", () => {
  it("enrichBatch returns empty map for empty input", async () => {
    const svc = new GraphNeighborhoodService(makeAdapter(new Map()) as any);
    const result = await svc.enrichBatch([]);
    expect(result.size).toBe(0);
  });

  it("enrichBatch delegates to adapter and returns map", async () => {
    const m = new Map([["m1", { parents: [], children: [] }]]);
    const adapter = makeAdapter(m);
    const svc = new GraphNeighborhoodService(adapter as any);
    const result = await svc.enrichBatch(["m1"]);
    expect(adapter.getNeighborhoodBatch).toHaveBeenCalledWith(["m1"]);
    expect(result.get("m1")).toMatchObject({ parents: [], children: [] });
  });

  it("enrichOne returns expanded neighborhood", async () => {
    const oneResult = {
      parents: [{ id: "p1", title: "P", category: "pref", relation: "relates_to", direction: "incoming", childCount: 0 }],
      children: [{ id: "c1", title: "C", category: "code-pattern", relation: "merge", direction: "outgoing", childCount: 1 }],
      childrenExpanded: [{ id: "c1", title: "C", category: "code-pattern", relation: "merge", direction: "outgoing", childCount: 1,
        grandchildren: [{ id: "g1", title: "G", category: "pattern", relation: "relates_to", direction: "outgoing", childCount: 0 }] }],
    };
    const adapter = makeAdapter(new Map(), oneResult);
    const svc = new GraphNeighborhoodService(adapter as any);
    const result = await svc.enrichOne("m1");
    expect(result.parents).toHaveLength(1);
    expect(result.childrenExpanded).toHaveLength(1);
    expect(result.childrenExpanded[0].grandchildren).toHaveLength(1);
  });

  it("enrichBatch caps parents and children to config limits", async () => {
    const manyParents = Array.from({ length: 15 }, (_, i) => ({
      id: `p${i}`, title: `P${i}`, category: "pref", relation: "relates_to", direction: "incoming", childCount: 0,
    }));
    const m = new Map([["m1", { parents: manyParents, children: [] }]]);
    const svc = new GraphNeighborhoodService(makeAdapter(m) as any, { maxParents: 10, maxChildren: 20 });
    const result = await svc.enrichBatch(["m1"]);
    expect(result.get("m1")!.parents).toHaveLength(10);
  });
});
```

Run: `npm test -- test/unit/v13/graph-neighborhood.test.ts 2>&1 | tail -15`
Expected: FAIL

- [ ] **Step 2: Implement `lib/graph-neighborhood.ts`**

```typescript
import type { Neo4jAdapter } from "./neo4j-adapter";
import type { MemoryNeighborhood, ExpandedChild, RelatedMemoryRef } from "./types";

export interface GraphNeighborhoodConfig {
  maxParents: number;
  maxChildren: number;
}

const DEFAULTS: GraphNeighborhoodConfig = { maxParents: 10, maxChildren: 20 };

export interface EnrichedNeighborhood extends MemoryNeighborhood {
  childrenExpanded: ExpandedChild[];
}

export class GraphNeighborhoodService {
  private readonly cfg: GraphNeighborhoodConfig;

  constructor(
    private readonly neo4j: Neo4jAdapter,
    cfg: Partial<GraphNeighborhoodConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async enrichBatch(ids: string[]): Promise<Map<string, MemoryNeighborhood>> {
    if (ids.length === 0) return new Map();
    const raw = await this.neo4j.getNeighborhoodBatch(ids);
    const result = new Map<string, MemoryNeighborhood>();
    for (const [id, n] of raw) {
      result.set(id, {
        parents: n.parents.slice(0, this.cfg.maxParents),
        children: n.children.slice(0, this.cfg.maxChildren),
      });
    }
    return result;
  }

  async enrichOne(id: string): Promise<EnrichedNeighborhood> {
    const raw = await this.neo4j.getNeighborhoodOne(id);
    return {
      parents: raw.parents.slice(0, this.cfg.maxParents),
      children: raw.children.slice(0, this.cfg.maxChildren),
      childrenExpanded: raw.childrenExpanded.slice(0, this.cfg.maxChildren),
    };
  }
}
```

- [ ] **Step 3: Run test, verify PASS**

Run: `npm test -- test/unit/v13/graph-neighborhood.test.ts 2>&1 | tail -15`
Expected: 4/4 PASS

- [ ] **Step 4: Full suite**

Run: `npm test -- test/unit 2>&1 | tail -8`

- [ ] **Step 5: Commit**

```bash
git add lib/graph-neighborhood.ts test/unit/v13/graph-neighborhood.test.ts
git commit -m "feat(v13): add GraphNeighborhoodService with enrichBatch + enrichOne"
```

---

## Task 4: Extend RetrieverPiece — enrich + format

**Files:**
- Modify: `pieces/retriever.ts`
- Test: `test/integration/v13/retriever-graph.test.ts`

- [ ] **Step 1: Read the retriever**

```bash
grep -n "systemContext\|retrieve\|format\|inject\|neighborhood" pieces/retriever.ts | head -30
```

Understand where `systemContext()` renders the memory list and where `retrieve()` returns hits.

- [ ] **Step 2: Write failing test**

Create `test/integration/v13/retriever-graph.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Test that RetrieverPiece enriches hits with neighborhood when flag is on
// and that systemContext() includes parent/child lines and hint

describe("RetrieverPiece graph enrichment", () => {
  it("attaches neighborhood to RetrievalHit when graph_retrieval.enabled=true", async () => {
    // Minimal smoke test — verifies the enrichBatch call path
    // Full integration requires live Neo4j; this test mocks the service
    const mockEnrichBatch = vi.fn().mockResolvedValue(
      new Map([["m1", {
        parents: [{ id: "p1", title: "Parent", category: "pref", relation: "relates_to", direction: "incoming", childCount: 0 }],
        children: [{ id: "c1", title: "Child", category: "code-pattern", relation: "contradicts", direction: "outgoing", childCount: 5 }],
      }]])
    );
    // Import and instantiate RetrieverPiece with mocked deps
    const { RetrieverPiece } = await import("../../../pieces/retriever.js");
    // Build a minimal hit
    const hit = { memory: { id: "m1", title: "T", content: "c", category: "pref", confidence: 0.9,
      created_at: new Date().toISOString(), evidence: "", origin_source: "user",
      tags: [], project: null, visibility: "open", pinned: false, reinforcements: 0,
      last_accessed: null, source_session: "s", promoted_at: null },
      score: 0.9, source: "vector" as const };
    // Access private enrichHits method via any cast
    const piece = new RetrieverPiece({} as any, {} as any, {} as any, { graph_retrieval: { enabled: true } } as any);
    (piece as any).graphNeighborhood = { enrichBatch: mockEnrichBatch };
    await (piece as any).enrichHits([hit]);
    expect(mockEnrichBatch).toHaveBeenCalledWith(["m1"]);
    expect(hit.neighborhood).toBeDefined();
    expect(hit.neighborhood!.parents).toHaveLength(1);
    expect(hit.neighborhood!.children).toHaveLength(1);
    expect(hit.neighborhood!.children[0].childCount).toBe(5);
  });

  it("formats neighborhood in context injection", async () => {
    const { formatNeighborhood } = await import("../../../pieces/retriever.js");
    const neighborhood = {
      parents: [{ id: "p1", title: "Parent mem", category: "preference", relation: "relates_to", direction: "incoming", childCount: 2 }],
      children: [{ id: "c1", title: "Child mem", category: "code-pattern", relation: "contradicts", direction: "outgoing", childCount: 0 }],
    };
    const result = formatNeighborhood(neighborhood);
    expect(result).toContain("↑");
    expect(result).toContain("Parent mem");
    expect(result).toContain("relates_to");
    expect(result).toContain("(2 filhos)");
    expect(result).toContain("↓");
    expect(result).toContain("Child mem");
    expect(result).toContain("contradicts");
    expect(result).toContain("(0 filhos)");
  });

  it("hint is injected when neighborhood exists", async () => {
    const { buildHint } = await import("../../../pieces/retriever.js");
    const hitsWithNeighborhood = [{ neighborhood: { parents: [{ id: "p1" }], children: [] } }];
    expect(buildHint(hitsWithNeighborhood as any)).toContain("memory_fetch");
  });

  it("hint is NOT injected when no relations exist", async () => {
    const { buildHint } = await import("../../../pieces/retriever.js");
    const hitsNoRelations = [{ neighborhood: { parents: [], children: [] } }];
    expect(buildHint(hitsNoRelations as any)).toBe("");
  });
});
```

Run: `npm test -- test/integration/v13/retriever-graph.test.ts 2>&1 | tail -15`
Expected: FAIL

- [ ] **Step 3: Add `enrichHits`, `formatNeighborhood`, `buildHint` to `pieces/retriever.ts`**

Key additions:

**`formatNeighborhood(n: MemoryNeighborhood): string`** — exported pure function:
```typescript
export function formatNeighborhood(n: MemoryNeighborhood): string {
  const lines: string[] = [];
  for (const p of n.parents) {
    lines.push(`  ↑ ${p.id} [${p.category}] "${p.title}" — ${p.relation}  (${p.childCount} filhos)`);
  }
  for (const c of n.children) {
    lines.push(`  ↓ ${c.id} [${c.category}] "${c.title}" — ${c.relation}  (${c.childCount} filhos)`);
  }
  return lines.join("\n");
}
```

**`buildHint(hits: RetrievalHit[]): string`** — exported pure function:
```typescript
export function buildHint(hits: RetrievalHit[]): string {
  const hasRelations = hits.some(
    (h) => h.neighborhood && (h.neighborhood.parents.length > 0 || h.neighborhood.children.length > 0)
  );
  return hasRelations ? "\n_Se necessário explorar uma memória relacionada, use `memory_fetch(id)`._" : "";
}
```

**`enrichHits(hits, graphNeighborhood)`** — private method:
```typescript
private async enrichHits(hits: RetrievalHit[]): Promise<void> {
  const ids = hits.map((h) => h.memory.id);
  const map = await this.graphNeighborhood.enrichBatch(ids);
  for (const hit of hits) {
    hit.neighborhood = map.get(hit.memory.id);
  }
}
```

In `retrieve()`, after rerank slice, if `config.graph_retrieval?.enabled`:
```typescript
if (this.config.graph_retrieval?.enabled && this.graphNeighborhood) {
  await this.enrichHits(hits);
}
```

In `systemContext()`, after rendering each memory, append `formatNeighborhood(hit.neighborhood)` and append `buildHint(hits)` at the end of the block.

In constructor / `start()`, if `config.graph_retrieval?.enabled`, instantiate:
```typescript
this.graphNeighborhood = new GraphNeighborhoodService(neo4j, {
  maxParents: config.graph_retrieval.max_parents,
  maxChildren: config.graph_retrieval.max_children,
});
```

- [ ] **Step 4: Run test, verify PASS**

Run: `npm test -- test/integration/v13/retriever-graph.test.ts 2>&1 | tail -15`
Expected: 4/4 PASS

- [ ] **Step 5: Full suite**

Run: `npm test -- test/unit test/integration/v13 2>&1 | tail -8`

- [ ] **Step 6: Commit**

```bash
git add pieces/retriever.ts test/integration/v13/retriever-graph.test.ts
git commit -m "feat(v13): enrich RetrievalHit with neighborhood + format parents/children in context"
```

---

## Task 5: `memory_fetch` tool

**Files:**
- Create: `lib/tools/memory-fetch.ts`
- Modify: `pieces/index.ts`
- Test: `test/unit/v13/memory-fetch.test.ts`

- [ ] **Step 1: Read existing tool pattern**

```bash
head -50 lib/tools/memory-search.ts
grep -n "register\|memory_" pieces/index.ts | head -20
```

Understand the `build*Tool` factory pattern and how tools are registered.

- [ ] **Step 2: Write failing test**

Create `test/unit/v13/memory-fetch.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildMemoryFetchTool } from "../../../lib/tools/memory-fetch";

const makeStore = (memory: any) => ({
  get: vi.fn().mockResolvedValue(memory),
});

const makeGraphSvc = (result: any) => ({
  enrichOne: vi.fn().mockResolvedValue(result),
});

describe("memory_fetch tool", () => {
  it("returns memory + neighborhood on valid id", async () => {
    const memory = { id: "m1", title: "Likes PG", content: "User likes Postgres",
      category: "preference", confidence: 0.9, evidence: "I like PG",
      created_at: "2026-05-21T10:00:00Z", origin_source: "user",
      tags: [], project: null, visibility: "open", pinned: false,
      reinforcements: 0, last_accessed: null, source_session: "s", promoted_at: null };
    const neighborhood = {
      parents: [],
      children: [{ id: "c1", title: "PG JSONB", category: "preference",
        relation: "relates_to_variant", direction: "outgoing", childCount: 2 }],
      childrenExpanded: [{ id: "c1", title: "PG JSONB", category: "preference",
        relation: "relates_to_variant", direction: "outgoing", childCount: 2,
        grandchildren: [{ id: "g1", title: "JSONB query pattern", category: "code-pattern",
          relation: "relates_to", direction: "outgoing", childCount: 0 }] }],
    };
    const tool = buildMemoryFetchTool(makeStore(memory) as any, makeGraphSvc(neighborhood) as any);
    const result = await tool.handler({ id: "m1" });
    expect(result).toContain("Likes PG");
    expect(result).toContain("PG JSONB");
    expect(result).toContain("relates_to_variant");
    expect(result).toContain("JSONB query pattern");
    expect(result).toContain("memory_fetch");
  });

  it("returns not found message for missing id", async () => {
    const store = { get: vi.fn().mockResolvedValue(null) };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc({}) as any);
    const result = await tool.handler({ id: "missing" });
    expect(result).toContain("not found");
  });

  it("tool definition has correct name and input schema", () => {
    const tool = buildMemoryFetchTool({} as any, {} as any);
    expect(tool.name).toBe("memory_fetch");
    expect(tool.input_schema.properties.id).toBeDefined();
  });
});
```

Run: `npm test -- test/unit/v13/memory-fetch.test.ts 2>&1 | tail -15`
Expected: FAIL

- [ ] **Step 3: Implement `lib/tools/memory-fetch.ts`**

```typescript
import type { MarkdownStore } from "../markdown-store";
import type { GraphNeighborhoodService, EnrichedNeighborhood } from "../graph-neighborhood";
import type { ExpandedChild, RelatedMemoryRef } from "../types";

export function buildMemoryFetchTool(store: MarkdownStore, graphSvc: GraphNeighborhoodService) {
  return {
    name: "memory_fetch",
    description: "Fetch a memory by ID with its full relational neighborhood (parents, children, grandchildren). Use when you want to explore a related memory found in the context.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The memory ID to fetch (e.g. the id shown in context like 'M1' or a UUID)" },
      },
      required: ["id"],
    },
    handler: async ({ id }: { id: string }): Promise<string> => {
      const memory = await store.get(id);
      if (!memory) return `Memory "${id}" not found.`;

      const n = await graphSvc.enrichOne(id);
      const lines: string[] = [
        `**${memory.id}** [${memory.category}] — "${memory.title}"`,
        `> ${memory.content}`,
        memory.evidence ? `evidence: "${memory.evidence}"` : "",
        "",
      ];

      for (const p of n.parents) {
        lines.push(`  ↑ ${p.id} [${p.category}] "${p.title}" — ${p.relation}  (${p.childCount} filhos)`);
      }
      for (const c of n.childrenExpanded) {
        lines.push(`  ↓ ${c.id} [${c.category}] "${c.title}" — ${c.relation}`);
        for (const g of c.grandchildren) {
          lines.push(`      → ${g.id} [${g.category}] "${g.title}" — ${g.relation}`);
        }
        if (c.grandchildren.length === 0) lines.push(`      (no children)`);
      }

      if (n.parents.length > 0 || n.childrenExpanded.length > 0) {
        lines.push("");
        lines.push("_Use memory_fetch(id) to continue exploring._");
      }

      return lines.filter((l) => l !== undefined).join("\n");
    },
  };
}
```

- [ ] **Step 4: Register tool in `pieces/index.ts`**

In `registerTools()` (or equivalent), inside the `graph_retrieval.enabled` block:

```typescript
if (config.graph_retrieval?.enabled && graphNeighborhood) {
  reg.register(buildMemoryFetchTool(markdownStore, graphNeighborhood));
}
```

- [ ] **Step 5: Run test, verify PASS**

Run: `npm test -- test/unit/v13/memory-fetch.test.ts 2>&1 | tail -15`
Expected: 3/3 PASS

- [ ] **Step 6: Full suite**

Run: `npm test -- test/unit test/integration/v13 2>&1 | tail -8`

- [ ] **Step 7: Commit**

```bash
git add lib/tools/memory-fetch.ts pieces/index.ts test/unit/v13/memory-fetch.test.ts
git commit -m "feat(v13): add memory_fetch tool with expanded neighborhood"
```

---

## Task 6: BDD scenarios + smoke test

**Files:**
- Modify: `functional-test.md`

- [ ] **Step 1: Append T13-1 through T13-4 to `functional-test.md`**

```markdown
---

## v1.3 Graph Retrieval BDD scenarios

All scenarios assume `graph_retrieval.enabled: true` in config.

### Scenario T13-1: Passive injection shows neighborhood

**Given** `graph_retrieval.enabled: true`
**And** memory M1 has 2 children in Neo4j (M2 with 3 grandchildren, M7 with 0)
**And** M1 has 1 parent P1 with 0 grandchildren
**When** the retriever fetches M1
**Then** context injection contains `↑ P1 ... (0 filhos)`
**And** context injection contains `↓ M2 ... (3 filhos)`
**And** context injection contains `↓ M7 ... (0 filhos)`
**And** the hint line `memory_fetch` appears

### Scenario T13-2: Hint absent when no relations

**Given** `graph_retrieval.enabled: true`
**And** retrieved memory M1 has no parents or children in Neo4j
**When** the retriever fetches M1
**Then** no `↑` or `↓` lines appear
**And** the hint line is NOT injected

### Scenario T13-3: memory_fetch returns expanded neighborhood

**Given** memory M2 has 2 children (C1 with 2 grandchildren, C2 with 0)
**And** M2 has 1 parent P1
**When** the LLM calls `memory_fetch("M2")`
**Then** response includes `↑ P1 ...`
**And** response includes `↓ C1 ...`
**And** response includes `→ G1 ...` and `→ G2 ...` (grandchildren of C1)
**And** response includes `↓ C2 ... (no children)`
**And** response ends with `memory_fetch` navigation hint

### Scenario T13-4: Feature flag off keeps v1.2 behavior

**Given** `graph_retrieval.enabled: false` (default)
**When** retriever fetches memories
**Then** no neighborhood is attached to any RetrievalHit
**And** no `↑`/`↓` lines appear in context injection
**And** `memory_fetch` tool is not registered
**And** `memory_fetch` is not listed as an available capability
```

- [ ] **Step 2: Run full suite one final time**

Run: `npm test -- test/unit test/integration/v13 2>&1 | tail -10`
Expected: all green

- [ ] **Step 3: Commit**

```bash
git add functional-test.md
git commit -m "test(v13): add BDD scenarios T13-1 through T13-4"
```

- [ ] **Step 4: Push branch**

```bash
git push -u origin feat/v1.3-graph-retrieval
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-mnemosyne-v1.3-graph-retrieval.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, spec+quality review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

**Which approach?**
