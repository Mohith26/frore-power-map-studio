// Seeded synthetic power maps for a dual-die AI accelerator test vehicle.
// Run: node data/generate.js   -> writes data/workloads.js and data/workloads.json
// Floorplan and densities are synthetic (not any vendor's real power map).
'use strict';
const fs = require('fs');
const path = require('path');
const Studio = require('../core/studio.js');

const SEED = 20261110;
const TOTAL_W = 1400;          // GPU power cap (same total for every workload)
const p = Studio.DEFAULTS;
const layout = Studio.makeLayout(p);
const A_CM2 = (p.dx / 10) ** 2;

// smooth multiplicative noise field from the seeded PRNG
function noiseField(rng) {
  const coarse = [];
  const cx = 9, cy = 5;
  for (let j = 0; j < cy; j++) { coarse.push([]); for (let i = 0; i < cx; i++) coarse[j].push(rng() * 2 - 1); }
  const f = new Float64Array(p.nx * p.ny);
  for (let j = 0; j < p.ny; j++) for (let i = 0; i < p.nx; i++) {
    const x = i / (p.nx - 1) * (cx - 1), y = j / (p.ny - 1) * (cy - 1);
    const x0 = Math.min(cx - 2, Math.floor(x)), y0 = Math.min(cy - 2, Math.floor(y));
    const tx = x - x0, ty = y - y0;
    const v = coarse[y0][x0] * (1 - tx) * (1 - ty) + coarse[y0][x0 + 1] * tx * (1 - ty) + coarse[y0 + 1][x0] * (1 - tx) * ty + coarse[y0 + 1][x0 + 1] * tx * ty;
    f[j * p.nx + i] = v;
  }
  return f;
}

// die-local coordinates: u = 0 at the HBM-facing edge, 15 at the die-to-die seam
function dieLocal(i, j) {
  if (i >= 8 && i <= 23) return { die: 0, u: i - 8, v: j };
  if (i >= 24 && i <= 39) return { die: 1, u: 39 - i, v: j };
  return null;
}
function block(u, v) {
  if (u <= 1) return 'phy';
  if (u >= 14) return 'seam';
  if (v <= 1 || v >= 22) return 'io';
  if (v === 11 || v === 12) return 'l2';
  const col = u <= 7 ? 0 : 1;
  const row = v <= 5 ? 0 : v <= 10 ? 1 : v <= 17 ? 2 : 3;
  return 'gpc' + (row * 2 + col);
}
function gauss(i, j, ci, cj, s) { const d2 = (i - ci) ** 2 + (j - cj) ** 2; return Math.exp(-d2 / (2 * s * s)); }

const SPECS = {
  prefill: {
    label: 'Prefill', share: 0.30, note: 'compute-bound GEMMs: tensor-core GPCs run hot',
    dens: { phy: 60, seam: 80, io: 60, l2: 70, gpc: 120, hbm: 18, gap: 2 },
    hot: [{ die: 0, gpc: 3, amp: 950 }, { die: 0, gpc: 4, amp: 800 }, { die: 1, gpc: 2, amp: 900 }, { die: 1, gpc: 5, amp: 760 }],
  },
  decode: {
    label: 'Decode', share: 0.55, note: 'memory-bound: HBM PHY, memory controllers and L2 run hot',
    dens: { phy: 400, seam: 90, io: 70, l2: 210, gpc: 60, hbm: 34, gap: 2 },
    hot: [{ die: 0, gpc: 1, amp: 110 }, { die: 1, gpc: 6, amp: 110 }],
    phyPeaks: [{ die: 0, v: 8, amp: 520 }, { die: 0, v: 16, amp: 440 }, { die: 1, v: 6, amp: 480 }, { die: 1, v: 17, amp: 540 }],
  },
  training: {
    label: 'Training', share: 0.15, note: 'all-reduce bursts: die-to-die link and NVLink IO run hot',
    dens: { phy: 160, seam: 380, io: 260, l2: 120, gpc: 105, hbm: 26, gap: 2 },
    hot: [{ die: 0, gpc: 6, amp: 650 }, { die: 1, gpc: 1, amp: 600 }],
  },
};

function gpcCenter(die, g) {
  const col = g % 2, row = Math.floor(g / 2);
  const u = col === 0 ? 4.5 : 10.5;
  const v = [3.5, 8, 15, 19.5][row];
  const i = die === 0 ? 8 + u : 39 - u;
  return { i, j: v };
}

function makeWorkload(id, spec, rng) {
  const noise = noiseField(rng);
  const dens = new Float64Array(p.nx * p.ny);
  const jit = () => (rng() - 0.5) * 1.2;
  const hot = spec.hot.map(h => ({ ...gpcCenter(h.die, h.gpc), amp: h.amp, dj: jit(), di: jit() }));
  const phyPeaks = (spec.phyPeaks || []).map(pk => ({ i: pk.die === 0 ? 8.5 : 38.5, j: pk.v + jit(), amp: pk.amp }));
  for (let j = 0; j < p.ny; j++) for (let i = 0; i < p.nx; i++) {
    const k = j * p.nx + i, r = layout.region[k];
    let d;
    if (r === 3 || r === 4) d = spec.dens.hbm;
    else if (r === 0) d = spec.dens.gap;
    else {
      const loc = dieLocal(i, j); const b = block(loc.u, loc.v);
      d = b.startsWith('gpc') ? spec.dens.gpc : spec.dens[b];
      for (const h of hot) if (b.startsWith('gpc')) d += h.amp * gauss(i, j, h.i + h.di, h.j + h.dj, 1.4);
      for (const pk of phyPeaks) if (b === 'phy') d += pk.amp * gauss(i, j, pk.i, pk.j, 2.2);
    }
    dens[k] = d * (1 + 0.08 * noise[k]);
  }
  let tot = 0; for (let k = 0; k < dens.length; k++) tot += dens[k] * A_CM2;
  const scale = TOTAL_W / tot;
  const powerW = Array.from(dens, d => +(d * scale * A_CM2).toFixed(5));
  return { id, label: spec.label, share: spec.share, note: spec.note, powerW };
}

const rng = Studio.mulberry32(SEED);
const workloads = Object.entries(SPECS).map(([id, s]) => makeWorkload(id, s, rng));
const out = { seed: SEED, totalW: TOTAL_W, grid: { nx: p.nx, ny: p.ny, dx: p.dx }, workloads };
fs.writeFileSync(path.join(__dirname, 'workloads.json'), JSON.stringify(out));
fs.writeFileSync(path.join(__dirname, 'workloads.js'), 'window.WORKLOADS = ' + JSON.stringify(out) + ';\n');
for (const w of workloads) {
  const pk = Math.max(...w.powerW) / A_CM2;
  console.log(w.id, 'total', w.powerW.reduce((a, b) => a + b, 0).toFixed(1), 'W  peak', pk.toFixed(0), 'W/cm2');
}
