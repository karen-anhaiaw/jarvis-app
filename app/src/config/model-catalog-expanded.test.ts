import { describe, it, expect } from "vitest";
import { getModelCatalogExpanded } from "./index.js";

describe("getModelCatalogExpanded", () => {
  it("expands an Anthropic non-Haiku model into 4 effort rows", () => {
    const rows = getModelCatalogExpanded().filter((r) => r.id === "claude-opus-4-8");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.label)).toEqual([
      "Opus 4.8 Max",
      "Opus 4.8 High",
      "Opus 4.8 Medium",
      "Opus 4.8 Low",
    ]);
    expect(rows.map((r) => r.effort)).toEqual(["max", "high", "medium", "low"]);
  });

  it("keeps Haiku as a single row without effort", () => {
    const rows = getModelCatalogExpanded().filter((r) => r.id === "claude-haiku-4-5");
    expect(rows).toHaveLength(1);
    expect(rows[0].effort).toBeUndefined();
  });

  it("keeps OpenAI/DeepSeek as single rows without effort", () => {
    const gpt = getModelCatalogExpanded().filter((r) => r.id === "gpt-4o");
    const ds = getModelCatalogExpanded().filter((r) => r.id === "deepseek-v4-pro");
    expect(gpt).toHaveLength(1);
    expect(ds).toHaveLength(1);
    expect(gpt[0].effort).toBeUndefined();
    expect(ds[0].effort).toBeUndefined();
  });

  it("never exposes rejected API effort values", () => {
    const efforts = getModelCatalogExpanded()
      .map((r) => r.effort)
      .filter(Boolean);
    expect(efforts).not.toContain("minimal");
    expect(efforts).not.toContain("xhigh");
  });
});
