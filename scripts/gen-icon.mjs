#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// JARVIS icon generator
//
// Emits the JARVIS icon as SVG. The visual language mirrors the live HUD core
// node view (app/ui/src/components/renderers/core-node/) — a blue incandescent
// core with green satellite nodes radiating on faint constellation lines.
//
// Palette is inherited from the existing brand assets, not invented:
//   background #0a1628 · core #44aaff / #88ccff / #2266aa · accent #00e5b0
//
// Variants trade fidelity for legibility at small sizes:
//   constellation — irregular, ~18 nodes, closest to the live HUD
//   burst         — balanced radial spread, ~11 nodes, survives downscaling
//   core          — dominant orb, 6 satellites, closest to the current icon
//
// Usage:
//   node scripts/gen-icon.mjs <variant> [--size N] [--bare]
//   node scripts/gen-icon.mjs burst > icon.svg
//
//   --bare   emit inner markup only (no <svg> wrapper), for embedding
// ─────────────────────────────────────────────────────────────────────────────

const BG = '#0a1628';

/** Deterministic PRNG so a given variant always renders identically. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const VARIANTS = {
  constellation: { count: 18, seed: 7, jitterAngle: 0.42, rMin: 0.30, rMax: 0.46, coreR: 0.135, nodeR: 4.2, glowR: 20 },
  burst:         { count: 11, seed: 3, jitterAngle: 0.12, rMin: 0.33, rMax: 0.42, coreR: 0.150, nodeR: 5.0, glowR: 24 },
  core:          { count: 6,  seed: 5, jitterAngle: 0.08, rMin: 0.34, rMax: 0.39, coreR: 0.200, nodeR: 5.6, glowR: 28 },
};

function nodes(cfg, size) {
  const rand = rng(cfg.seed);
  const c = size / 2;
  const out = [];
  for (let i = 0; i < cfg.count; i++) {
    const base = (i / cfg.count) * Math.PI * 2 - Math.PI / 2;
    const angle = base + (rand() - 0.5) * cfg.jitterAngle;
    const radius = size * (cfg.rMin + rand() * (cfg.rMax - cfg.rMin));
    out.push({
      x: +(c + Math.cos(angle) * radius).toFixed(1),
      y: +(c + Math.sin(angle) * radius).toFixed(1),
      // Satellites vary in weight so the ring does not read as a mechanical dial
      scale: +(0.72 + rand() * 0.55).toFixed(2),
      dim: +(0.45 + rand() * 0.5).toFixed(2),
    });
  }
  return out;
}

export function buildIcon(variantName = 'burst', size = 512, idPrefix = variantName) {
  const cfg = VARIANTS[variantName];
  if (!cfg) throw new Error(`Unknown variant "${variantName}". Expected: ${Object.keys(VARIANTS).join(', ')}`);

  const c = size / 2;
  const p = idPrefix;
  const ns = nodes(cfg, size);
  const coreR = size * cfg.coreR;

  const lines = ns.map(n =>
    `<line x1="${c}" y1="${c}" x2="${n.x}" y2="${n.y}" stroke="url(#${p}Line)" stroke-width="${(size / 512) * 1.1}" opacity="${n.dim * 0.65}"/>`
  ).join('\n    ');

  const sats = ns.map(n =>
    `<use href="#${p}Node" x="${n.x}" y="${n.y}" transform="translate(${n.x} ${n.y}) scale(${n.scale}) translate(${-n.x} ${-n.y})" opacity="${0.55 + n.dim * 0.45}"/>`
  ).join('\n    ');

  const k = size / 512;

  const inner = `
  <defs>
    <radialGradient id="${p}Bloom" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#5cb8ff" stop-opacity="0.55"/>
      <stop offset="40%"  stop-color="#1e7fd0" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${BG}"   stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${p}Core" cx="42%" cy="38%" r="58%">
      <stop offset="0%"   stop-color="#eaf6ff"/>
      <stop offset="22%"  stop-color="#88ccff"/>
      <stop offset="52%"  stop-color="#44aaff"/>
      <stop offset="78%"  stop-color="#1d5a99"/>
      <stop offset="100%" stop-color="#0d2740" stop-opacity="0.35"/>
    </radialGradient>
    <radialGradient id="${p}Halo" cx="50%" cy="50%" r="50%">
      <stop offset="60%"  stop-color="#00e5b0" stop-opacity="0"/>
      <stop offset="88%"  stop-color="#00e5b0" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#00e5b0" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${p}Line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#44aaff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#00e5b0" stop-opacity="0.30"/>
    </linearGradient>
    <radialGradient id="${p}NodeGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#7dffd6" stop-opacity="0.85"/>
      <stop offset="35%"  stop-color="#00e5b0" stop-opacity="0.40"/>
      <stop offset="100%" stop-color="#00e5b0" stop-opacity="0"/>
    </radialGradient>
    <g id="${p}Node">
      <circle r="${(cfg.glowR * k).toFixed(1)}" fill="url(#${p}NodeGlow)"/>
      <circle r="${(cfg.nodeR * k).toFixed(1)}" fill="#c6ffee"/>
      <circle cx="${(7 * k).toFixed(1)}" cy="${(-5 * k).toFixed(1)}" r="${(2.4 * k).toFixed(1)}" fill="#5fffc6" opacity="0.85"/>
      <circle cx="${(-6 * k).toFixed(1)}" cy="${(6 * k).toFixed(1)}" r="${(1.9 * k).toFixed(1)}" fill="#2fe8ae" opacity="0.65"/>
    </g>
  </defs>

  <rect width="${size}" height="${size}" rx="${(110 * k).toFixed(0)}" fill="${BG}"/>
  <circle cx="${c}" cy="${c}" r="${size * 0.47}" fill="url(#${p}Halo)"/>

  <g stroke-linecap="round">
    ${lines}
  </g>

  <circle cx="${c}" cy="${c}" r="${size * 0.40}" fill="url(#${p}Bloom)"/>

  <g>
    ${sats}
  </g>

  <circle cx="${c}" cy="${c}" r="${(coreR * 1.9).toFixed(1)}" fill="url(#${p}Bloom)"/>
  <circle cx="${c}" cy="${c}" r="${coreR.toFixed(1)}" fill="url(#${p}Core)"/>
  <circle cx="${c}" cy="${c}" r="${(coreR * 0.86).toFixed(1)}" fill="#00e5b0" opacity="0.10"/>
  <circle cx="${c}" cy="${c}" r="${coreR.toFixed(1)}" fill="none" stroke="#8fd4ff" stroke-width="${(1.6 * k).toFixed(1)}" opacity="0.35"/>
  <circle cx="${(c - coreR * 0.28).toFixed(1)}" cy="${(c - coreR * 0.30).toFixed(1)}" r="${(coreR * 0.42).toFixed(1)}" fill="#ffffff" opacity="0.16"/>`;

  return { inner, size };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const variant = args.find(a => !a.startsWith('--')) ?? 'burst';
  const sizeArg = args.indexOf('--size');
  const size = sizeArg !== -1 ? Number(args[sizeArg + 1]) : 512;
  const bare = args.includes('--bare');

  const { inner } = buildIcon(variant, size);
  process.stdout.write(
    bare ? inner : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${inner}\n</svg>\n`
  );
}
