#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// JARVIS icon generator
//
// Emits the JARVIS icon as SVG. The visual language mirrors the live HUD core
// node view (app/ui/src/components/renderers/core-node/): a blue incandescent
// core with green satellites on faint constellation lines — and, like the real
// HUD, satellites that are themselves hubs with their own children.
//
// Structure is a RECURSIVE TREE, not a single ring:
//   depth 0  the core
//   depth 1  primary satellites, spread around the core
//   depth 2  children of each primary, fanning out in the outward direction
//   depth 3  grandchildren
//
// Radius, node size and line opacity all decay with depth. That decay is what
// makes the hierarchy legible — without it 56 nodes read as uniform noise.
// Children fan out ALONG the parent's outward angle so the tree looks like it
// grows away from the core instead of folding back onto it.
//
// Palette is inherited from the existing brand assets, not invented:
//   background #0a1628 · core #44aaff / #88ccff / #2266aa · accent #00e5b0
//
// SMALL SIZES: a 56-node tree turns to mush below ~64px. Use --depth to prune —
// `--depth 1` keeps only the core and the primary ring, which is what the 32px
// and 16px variants (Windows taskbar, favicon) should be built from.
//
// Usage:
//   node scripts/gen-icon.mjs [variant] [--size N] [--depth N] [--bare] [--count]
//   node scripts/gen-icon.mjs constellation --size 1024 > icon.svg
//   node scripts/gen-icon.mjs constellation --size 32 --depth 1 > icon-32.svg
// ─────────────────────────────────────────────────────────────────────────────

const BG = "#0a1628";

/**
 * Maximum distance from the centre, as a fraction of the icon side, that any
 * node may occupy. Leaves room for the node's own glow so nothing collides with
 * the rounded corners. Enforced as a hard clamp: the per-level `dist` budgets
 * are tuned to stay under it, and this catches any retuning that does not.
 */
const SAFE_R = 0.44;

/** Deterministic PRNG — a given variant always renders identically. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const r1 = (n) => Math.round(n * 10) / 10;

/** Pulls a point back along the centre→point ray so it lands inside SAFE_R. */
function clampToDisc(x, y, c, size) {
  const dx = x - c;
  const dy = y - c;
  const d = Math.hypot(dx, dy);
  const max = size * SAFE_R;
  return d <= max ? [x, y] : [c + (dx * max) / d, c + (dy * max) / d];
}

/**
 * Per-depth shape of the tree.
 *   count/branch — nodes at depth 0 / children per node deeper
 *   dist         — distance from parent, as a fraction of the icon side
 *   spread       — angular cone around the outward direction, radians
 *   scale        — node size multiplier
 *   line         — connecting line opacity multiplier
 */
const VARIANTS = {
  // Closest to the live HUD: dense, irregular, three levels deep.
  // Radius budget closes: 0.29 + 0.075 + 0.040 = 0.405 < SAFE_R
  constellation: {
    seed: 11,
    coreR: 0.115,
    levels: [
      { count: 18, dist: [0.21, 0.29], spread: 0.4, scale: 1.0, line: 0.62 },
      { branch: [0, 2], dist: [0.045, 0.075], spread: 1.05, scale: 0.58, line: 0.4 },
      { branch: [0, 2], dist: [0.022, 0.04], spread: 1.3, scale: 0.36, line: 0.26 },
    ],
  },
  // Balanced spread, two levels — survives downscaling better.
  burst: {
    seed: 3,
    coreR: 0.135,
    levels: [
      { count: 11, dist: [0.25, 0.32], spread: 0.14, scale: 1.0, line: 0.62 },
      { branch: [1, 2], dist: [0.055, 0.09], spread: 0.95, scale: 0.6, line: 0.4 },
    ],
  },
  // Dominant orb, few satellites — closest to the previous icon.
  core: {
    seed: 5,
    coreR: 0.185,
    levels: [
      { count: 6, dist: [0.3, 0.35], spread: 0.1, scale: 1.0, line: 0.62 },
      { branch: [1, 1], dist: [0.07, 0.09], spread: 0.8, scale: 0.62, line: 0.4 },
    ],
  },
};

/** Builds the node tree. Returns a flat list with parent coords attached. */
function buildTree(cfg, size, maxDepth) {
  const rand = rng(cfg.seed);
  const c = size / 2;
  const pick = ([lo, hi]) => lo + rand() * (hi - lo);
  const all = [];
  let frontier = [];

  const L0 = cfg.levels[0];
  for (let i = 0; i < L0.count; i++) {
    const angle = (i / L0.count) * Math.PI * 2 - Math.PI / 2 + (rand() - 0.5) * L0.spread;
    const d = size * pick(L0.dist);
    const [x, y] = clampToDisc(c + Math.cos(angle) * d, c + Math.sin(angle) * d, c, size);
    const node = {
      x: r1(x), y: r1(y), px: c, py: c, depth: 0, angle,
      scale: r1(L0.scale * (0.78 + rand() * 0.44)),
      dim: r1(0.5 + rand() * 0.5),
    };
    all.push(node);
    frontier.push(node);
  }

  const limit = Math.min(cfg.levels.length, maxDepth + 1);
  for (let depth = 1; depth < limit; depth++) {
    const L = cfg.levels[depth];
    const next = [];
    for (const parent of frontier) {
      const [bMin, bMax] = L.branch;
      const n = bMin + Math.floor(rand() * (bMax - bMin + 1));
      for (let k = 0; k < n; k++) {
        const angle = parent.angle + (rand() - 0.5) * L.spread;
        const d = size * pick(L.dist);
        const [x, y] = clampToDisc(parent.x + Math.cos(angle) * d, parent.y + Math.sin(angle) * d, c, size);
        const node = {
          x: r1(x), y: r1(y), px: parent.x, py: parent.y, depth, angle,
          scale: r1(L.scale * (0.8 + rand() * 0.4)),
          dim: r1(0.45 + rand() * 0.5),
        };
        all.push(node);
        next.push(node);
      }
    }
    frontier = next;
  }

  return all;
}

export function buildIcon(variantName = "constellation", size = 512, opts = {}) {
  const cfg = VARIANTS[variantName];
  if (!cfg) throw new Error(`Unknown variant "${variantName}". Expected: ${Object.keys(VARIANTS).join(", ")}`);

  const { depth = 99, idPrefix: p = "j" } = opts;
  const c = size / 2;
  const k = size / 512;
  const coreR = r1(size * cfg.coreR);
  const nodes = buildTree(cfg, size, depth);

  const lines = nodes
    .map((n) =>
      `<line x1="${n.px}" y1="${n.py}" x2="${n.x}" y2="${n.y}" stroke="url(#${p}L)" stroke-width="${r1(k * (1.3 - n.depth * 0.3))}" opacity="${r1(cfg.levels[n.depth].line * n.dim)}"/>`,
    )
    .join("");

  // Waypoint pips midway along depth-0 spokes — present in the live HUD, and
  // what keeps the long primary lines from reading as empty.
  const pips = nodes
    .filter((n) => n.depth === 0)
    .map((n) => {
      const t = 0.45 + (n.dim % 0.2);
      return `<circle cx="${r1(n.px + (n.x - n.px) * t)}" cy="${r1(n.py + (n.y - n.py) * t)}" r="${r1(1.7 * k)}" fill="#3fe8b4" opacity="${r1(n.dim * 0.55)}"/>`;
    })
    .join("");

  // Deeper nodes paint first so shallower (larger, brighter) ones land on top.
  const sats = [...nodes]
    .sort((a, b) => b.depth - a.depth)
    .map((n) => `<use href="#${p}N" transform="translate(${n.x} ${n.y}) scale(${n.scale})" opacity="${r1(0.5 + n.dim * 0.5)}"/>`)
    .join("");

  const inner = `<defs>\
<radialGradient id="${p}B" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#5cb8ff" stop-opacity="0.55"/><stop offset="40%" stop-color="#1e7fd0" stop-opacity="0.2"/><stop offset="100%" stop-color="${BG}" stop-opacity="0"/></radialGradient>\
<radialGradient id="${p}C" cx="42%" cy="38%" r="58%"><stop offset="0%" stop-color="#eaf6ff"/><stop offset="22%" stop-color="#88ccff"/><stop offset="52%" stop-color="#44aaff"/><stop offset="78%" stop-color="#1d5a99"/><stop offset="100%" stop-color="#0d2740" stop-opacity="0.35"/></radialGradient>\
<linearGradient id="${p}L" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#44aaff" stop-opacity="0.55"/><stop offset="100%" stop-color="#00e5b0" stop-opacity="0.3"/></linearGradient>\
<radialGradient id="${p}G" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#7dffd6" stop-opacity="0.85"/><stop offset="35%" stop-color="#00e5b0" stop-opacity="0.4"/><stop offset="100%" stop-color="#00e5b0" stop-opacity="0"/></radialGradient>\
<g id="${p}N"><circle r="${r1(13 * k)}" fill="url(#${p}G)"/><circle r="${r1(3 * k)}" fill="#c6ffee"/><circle cx="${r1(5 * k)}" cy="${r1(-3.5 * k)}" r="${r1(1.8 * k)}" fill="#5fffc6" opacity="0.85"/><circle cx="${r1(-4 * k)}" cy="${r1(4 * k)}" r="${r1(1.4 * k)}" fill="#2fe8ae" opacity="0.6"/></g>\
<clipPath id="${p}K"><rect width="${size}" height="${size}" rx="${Math.round(110 * k)}"/></clipPath>\
</defs>\
<rect width="${size}" height="${size}" rx="${Math.round(110 * k)}" fill="${BG}"/>\
<g clip-path="url(#${p}K)">\
<g stroke-linecap="round">${lines}</g>${pips}\
<circle cx="${c}" cy="${c}" r="${r1(size * 0.4)}" fill="url(#${p}B)"/>\
<g>${sats}</g>\
<circle cx="${c}" cy="${c}" r="${r1(coreR * 1.9)}" fill="url(#${p}B)"/>\
<circle cx="${c}" cy="${c}" r="${coreR}" fill="url(#${p}C)"/>\
<circle cx="${c}" cy="${c}" r="${r1(coreR * 0.86)}" fill="#00e5b0" opacity="0.1"/>\
<circle cx="${c}" cy="${c}" r="${coreR}" fill="none" stroke="#8fd4ff" stroke-width="${r1(1.6 * k)}" opacity="0.35"/>\
<circle cx="${r1(c - coreR * 0.28)}" cy="${r1(c - coreR * 0.3)}" r="${r1(coreR * 0.42)}" fill="#fff" opacity="0.16"/>\
</g>`;

  return { inner, size, nodeCount: nodes.length };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1]?.endsWith("gen-icon.mjs");

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const num = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 ? Number(args[i + 1]) : fallback;
  };
  const variant = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "constellation";
  const size = num("--size", 512);
  const depth = num("--depth", 99);

  const { inner, nodeCount } = buildIcon(variant, size, { depth });
  if (args.includes("--count")) process.stderr.write(`nodes: ${nodeCount}\n`);

  process.stdout.write(
    args.includes("--bare")
      ? inner
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${inner}</svg>\n`,
  );
}
