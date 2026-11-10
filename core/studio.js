/*
 * Power Map Studio core: a compact thermal model of a staged direct-to-chip
 * coldplate plus an optimizer that assigns die tiles to coolant stages (and
 * places diamond spreader inserts) for a MIX of workload power maps.
 *
 * Works in the browser (window.Studio) and in Node (module.exports).
 * No dependencies. Every number the demo shows is computed here.
 *
 * Units: lengths mm, power W, temperature C, conductance W/K,
 * area-specific resistance C*cm^2/W, heat transfer coefficient W/(m^2 K), flow LPM.
 */
(function (root) {
  'use strict';

  // ---------- defaults (labelled assumptions, see README) ----------
  const DEFAULTS = {
    nx: 48, ny: 24, dx: 1.5,          // 72 mm x 36 mm active area, 1.5 mm cells
    tile: 3,                          // stage map is drawn on 3x3-cell (4.5 mm) microcell tiles
    stages: 3,
    flowLpm: 1.4,                     // PG25 flow rate
    inletC: 45,                       // coolant inlet temperature (Rubin-class spec in the white paper)
    cpPerLpm: 64.17,                  // W per (LPM * C) for PG25 (Frore white paper)
    tjLimit: 95,
    dpBudgetPsi: 0.30,
    // vertical stack (die -> coldplate base): un-lidded package + PTM7950-class TIM
    rDieTim: 0.047 + 0.02,            // C*cm^2/W for logic die cells
    rHbmExtra: 0.12,                  // extra for HBM stacks (DRAM stack + mold)
    kSiT: 120 * 0.6e-3,               // Si conductivity * thickness (W/K per square)
    kHbmT: 20 * 0.6e-3,               // effective in-plane for HBM stacks
    seamFactor: 0.08,                 // die-to-die / die-to-HBM lateral coupling factor
    kCuT: 390 * 1.5e-3,               // copper base plate
    kDiaT: 1500 * 0.6e-3,             // diamond insert (added to copper)
    rDiaRelief: 0.003,                // diamond slightly lowers vertical resistance
    // convection
    hSkived: 1.0e5,                   // split-flow skived reference (R'' = 0.10 C*cm^2/W)
    hLJ0: 1.1e5,                      // LiquidJet single stage (full area) at 1.4 LPM
    hMax: 8.0e5,                      // geometry-limited ceiling
    hExp: 0.6,                        // h ~ (flow per stage area)^0.6, developing flow
    dp0Psi: 0.006,                    // per-stage pressure drop at full-area, 1.4 LPM
    dpExp: 1.75,
    dpManifoldPsi: 0.02,
    skivedDpPsi: 0.94, skivedDpFlow: 2.1, // product card reference point
    // tokens/watt model (Frore white paper rules of thumb)
    tpwRefC: 89, leakFracRef: 0.158, leakDoubleC: 10, switchPer10C: 0.02,
    diamondInsertCells: 5,            // 7.5 mm square inserts
  };

  // ---------- seeded PRNG ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- geometry ----------
  // Region codes: 0 gap/underfill, 1 die A, 2 die B, 3 HBM left, 4 HBM right
  function makeLayout(p) {
    const { nx, ny } = p;
    const region = new Uint8Array(nx * ny);
    const hbmStack = new Int8Array(nx * ny).fill(-1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (i <= 6) { region[k] = 3; hbmStack[k] = Math.floor(j / 6); }
        else if (i === 7 || i === 40) region[k] = 0;
        else if (i <= 23) region[k] = 1;
        else if (i <= 39) region[k] = 2;
        else { region[k] = 4; hbmStack[k] = 4 + Math.floor(j / 6); }
      }
    }
    return { region, hbmStack };
  }

  function isDie(r) { return r === 1 || r === 2; }

  // ---------- thermal model ----------
  function buildConductances(p, layout, diamondMask) {
    const { nx, ny } = p;
    const n = nx * ny;
    const A_cm2 = (p.dx / 10) * (p.dx / 10);
    const gv = new Float64Array(n);
    // lateral conductances to east (gx) and north (gy) neighbour, die layer and base layer
    const gdx = new Float64Array(n), gdy = new Float64Array(n);
    const gbx = new Float64Array(n), gby = new Float64Array(n);
    const reg = layout.region, stack = layout.hbmStack;
    function dieK(k) { return reg[k] === 3 || reg[k] === 4 ? p.kHbmT : reg[k] === 0 ? p.kSiT * 0.1 : p.kSiT; }
    function baseK(k) { return p.kCuT + (diamondMask && diamondMask[k] ? p.kDiaT : 0); }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        let r = p.rDieTim + ((reg[k] === 3 || reg[k] === 4) ? p.rHbmExtra : 0) + (reg[k] === 0 ? 0.05 : 0);
        if (diamondMask && diamondMask[k]) r -= p.rDiaRelief;
        gv[k] = A_cm2 / r;
        if (i < nx - 1) {
          const k2 = k + 1;
          let g = 2 / (1 / dieK(k) + 1 / dieK(k2));
          const same = reg[k] === reg[k2] && (stack[k] === stack[k2]);
          if (!same) g *= p.seamFactor;
          gdx[k] = g;
          gbx[k] = 2 / (1 / baseK(k) + 1 / baseK(k2));
        }
        if (j < ny - 1) {
          const k2 = k + nx;
          let g = 2 / (1 / dieK(k) + 1 / dieK(k2));
          const same = reg[k] === reg[k2] && (stack[k] === stack[k2]);
          if (!same) g *= p.seamFactor;
          gdy[k] = g;
          gby[k] = 2 / (1 / baseK(k) + 1 / baseK(k2));
        }
      }
    }
    return { gv, gdx, gdy, gbx, gby, A_cm2 };
  }

  // Convective model for a design. design = {kind:'skived'} or {kind:'staged', tileStage:Int8Array}
  function stageOfCell(p, design) {
    const n = p.nx * p.ny;
    const s = new Int8Array(n);
    if (design.kind === 'skived') return s;
    const tilesX = Math.ceil(p.nx / p.tile);
    for (let j = 0; j < p.ny; j++) for (let i = 0; i < p.nx; i++) {
      const t = Math.floor(j / p.tile) * tilesX + Math.floor(i / p.tile);
      s[j * p.nx + i] = design.tileStage[t];
    }
    return s;
  }

  function hydraulics(p, design, cellStage) {
    const n = p.nx * p.ny;
    const flowRatio = p.flowLpm / 1.4;
    if (design.kind === 'skived') {
      const h = p.hSkived * Math.pow(p.flowLpm / 2.1, 0.6) / Math.pow(1 / 1.5, 0.0); // reference at card flow
      const hc = new Float64Array(n).fill(h);
      const dp = p.skivedDpPsi * Math.pow(p.flowLpm / p.skivedDpFlow, 1.8);
      return { hc, dpPsi: dp, stageArea: [n], stageH: [h], nStages: 1 };
    }
    const S = p.stages;
    const area = new Array(S).fill(0);
    for (let k = 0; k < n; k++) area[cellStage[k]]++;
    const stageH = new Array(S).fill(0);
    let dp = p.dpManifoldPsi;
    for (let s = 0; s < S; s++) {
      if (area[s] === 0) continue;
      const r = (n / area[s]) * flowRatio;
      const hRaw = p.hLJ0 * Math.pow(r, p.hExp);
      stageH[s] = 1 / (1 / hRaw + 1 / p.hMax);
      dp += p.dp0Psi * Math.pow(r, p.dpExp);
    }
    const hc = new Float64Array(n);
    for (let k = 0; k < n; k++) hc[k] = stageH[cellStage[k]];
    return { hc, dpPsi: dp, stageArea: area, stageH, nStages: S };
  }

  // Solve the 2-layer network with staged coolant temperatures.
  // powerW: Float64Array of watts per cell. Returns Tj, Tb, stage heat, coolant temps.
  function solve(p, cond, hyd, cellStage, powerW, warm) {
    const { nx, ny } = p;
    const n = nx * ny;
    const A_m2 = (p.dx * 1e-3) * (p.dx * 1e-3);
    const gc = new Float64Array(n);
    for (let k = 0; k < n; k++) gc[k] = hyd.hc[k] * A_m2;
    const S = hyd.nStages;
    const mcp = p.cpPerLpm * p.flowLpm;
    let tStage = new Array(S).fill(p.inletC);
    // initial guess for stage coolant: spread total power by area share
    const totalP = powerW.reduce((a, b) => a + b, 0);
    let qStage = new Array(S).fill(0);
    for (let k = 0; k < n; k++) qStage[cellStage[k]] += powerW[k];
    const N = 2 * n;
    let x = warm && warm.length === N ? Float64Array.from(warm) : new Float64Array(N).fill(p.inletC + 20);
    const diag = new Float64Array(N);
    const { gv, gdx, gdy, gbx, gby } = cond;
    // diagonal
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let dd = gv[k], db = gv[k] + gc[k];
      if (i < nx - 1) { dd += gdx[k]; db += gbx[k]; }
      if (i > 0) { dd += gdx[k - 1]; db += gbx[k - 1]; }
      if (j < ny - 1) { dd += gdy[k]; db += gby[k]; }
      if (j > 0) { dd += gdy[k - nx]; db += gby[k - nx]; }
      diag[k] = dd; diag[n + k] = db;
    }
    function matvec(v, out) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const tj = v[k], tb = v[n + k];
        let od = gv[k] * (tj - tb);
        let ob = gv[k] * (tb - tj) + gc[k] * tb;
        if (i < nx - 1) { od += gdx[k] * (tj - v[k + 1]); ob += gbx[k] * (tb - v[n + k + 1]); }
        if (i > 0) { od += gdx[k - 1] * (tj - v[k - 1]); ob += gbx[k - 1] * (tb - v[n + k - 1]); }
        if (j < ny - 1) { od += gdy[k] * (tj - v[k + nx]); ob += gby[k] * (tb - v[n + k + nx]); }
        if (j > 0) { od += gdy[k - nx] * (tj - v[k - nx]); ob += gby[k - nx] * (tb - v[n + k - nx]); }
        out[k] = od; out[n + k] = ob;
      }
    }
    const b = new Float64Array(N), r = new Float64Array(N), z = new Float64Array(N), d = new Float64Array(N), q = new Float64Array(N);
    let cgIters = 0, outer = 0;
    for (outer = 0; outer < 30; outer++) {
      // coolant mean temperature seen by each stage (flow passes stages in order 0,1,2...)
      let up = 0;
      const prevT = tStage.slice();
      for (let s = 0; s < S; s++) { tStage[s] = p.inletC + (up + 0.5 * qStage[s]) / mcp; up += qStage[s]; }
      for (let k = 0; k < n; k++) { b[k] = powerW[k]; b[n + k] = gc[k] * tStage[cellStage[k]]; }
      // PCG
      matvec(x, q);
      let rz = 0, bnorm = 0;
      for (let m = 0; m < N; m++) { r[m] = b[m] - q[m]; z[m] = r[m] / diag[m]; d[m] = z[m]; rz += r[m] * z[m]; bnorm += b[m] * b[m]; }
      const tol = 1e-20 * bnorm + 1e-18;
      for (let it = 0; it < 4000; it++) {
        let rr = 0; for (let m = 0; m < N; m++) rr += r[m] * r[m];
        if (rr <= tol) break;
        matvec(d, q);
        let dq = 0; for (let m = 0; m < N; m++) dq += d[m] * q[m];
        const alpha = rz / dq;
        let rzNew = 0;
        for (let m = 0; m < N; m++) { x[m] += alpha * d[m]; r[m] -= alpha * q[m]; z[m] = r[m] / diag[m]; rzNew += r[m] * z[m]; }
        const beta = rzNew / rz; rz = rzNew;
        for (let m = 0; m < N; m++) d[m] = z[m] + beta * d[m];
        cgIters++;
      }
      // stage heat from solution
      const newQ = new Array(S).fill(0);
      for (let k = 0; k < n; k++) newQ[cellStage[k]] += gc[k] * (x[n + k] - tStage[cellStage[k]]);
      let change = 0;
      for (let s = 0; s < S; s++) change = Math.max(change, Math.abs(newQ[s] - qStage[s]));
      qStage = newQ;
      let tChange = 0; for (let s = 0; s < S; s++) tChange = Math.max(tChange, Math.abs(tStage[s] - prevT[s]));
      if (change < 1e-3 * Math.max(1, totalP / 100) && outer > 0 && tChange < 1e-4) break;
    }
    const Tj = x.subarray(0, n), Tb = x.subarray(n, N);
    return { x, Tj: Float64Array.from(Tj), Tb: Float64Array.from(Tb), qStage, tStage, cgIters, outer };
  }

  // Frore white paper definition: TjA = integral(q' * Tj) / Q over the GPU die
  function metrics(p, layout, powerW, sol) {
    let qa = 0, qt = 0, tmax = -Infinity, kmax = -1, dieMax = -Infinity;
    for (let k = 0; k < powerW.length; k++) {
      if (isDie(layout.region[k])) {
        qa += powerW[k] * sol.Tj[k]; qt += powerW[k];
        if (sol.Tj[k] > dieMax) dieMax = sol.Tj[k];
      }
      if (sol.Tj[k] > tmax) { tmax = sol.Tj[k]; kmax = k; }
    }
    return { tja: qa / qt, tjMax: tmax, tjMaxCell: kmax, dieTjMax: dieMax };
  }

  // Relative tokens per watt at fixed GPU power (power-capped):
  // leakage doubles every 10 C, switching energy +2% per 10 C (white paper).
  function tokensPerWatt(p, tja) {
    const leak = p.leakFracRef * Math.pow(2, (tja - p.tpwRefC) / p.leakDoubleC);
    const eSwitch = 1 + p.switchPer10C * (tja - p.tpwRefC) / 10;
    return Math.max(0, 1 - leak) / eSwitch;
  }
  // Thermal throttling: the network is linear in power with a fixed inlet, so every
  // temperature rise scales with power. DVFS must cut power to alpha*Q where
  // T_in + alpha*(TjMax - T_in) = TjLimit. Throughput follows the white paper's
  // first-order model: tokens/s ~ (alpha*Q - leakage(TjA')) / switching energy(TjA').
  function throttle(p, m) {
    const alpha = m.tjMax > p.tjLimit ? (p.tjLimit - p.inletC) / (m.tjMax - p.inletC) : 1;
    const tjaT = p.inletC + alpha * (m.tja - p.inletC);
    const leak = p.leakFracRef * Math.pow(2, (tjaT - p.tpwRefC) / p.leakDoubleC);
    const eSwitch = 1 + p.switchPer10C * (tjaT - p.tpwRefC) / 10;
    const thr = Math.max(0, alpha - alpha * leak) / eSwitch; // leakage scales ~ with V*I at the throttled point
    return { alpha, tjaThrottled: tjaT, throughput: thr, tpwThrottled: thr / alpha };
  }
  function tpwSlopeAt(p, t) { // % change per C, for checking calibration
    const a = tokensPerWatt(p, t - 0.05), b = tokensPerWatt(p, t + 0.05);
    return ((b - a) / 0.1) / tokensPerWatt(p, t) * 100;
  }

  // ---------- evaluation of a design over a workload set ----------
  function makeEvaluator(p, layout, workloads) {
    const condCache = new Map();
    const warm = new Map();
    function cond(mask) {
      const key = mask ? Array.from(mask).join('') : 'none';
      if (!condCache.has(key)) condCache.set(key, buildConductances(p, layout, mask));
      return condCache.get(key);
    }
    function evaluate(design, which) {
      const cellStage = stageOfCell(p, design);
      const hyd = hydraulics(p, design, cellStage);
      const c = cond(design.diamond || null);
      const per = [];
      for (const w of workloads) {
        if (which && !which.includes(w.id)) continue;
        const wk = w.id + (design.kind === 'skived' ? 's' : 'l');
        const sol = solve(p, c, hyd, cellStage, w.powerW, warm.get(wk));
        warm.set(wk, sol.x);
        const m = metrics(p, layout, w.powerW, sol);
        const th = throttle(p, m);
        per.push({ id: w.id, share: w.share, ...m, tpw: tokensPerWatt(p, m.tja), ...th, Tj: sol.Tj, qStage: sol.qStage, tStage: sol.tStage, cgIters: sol.cgIters });
      }
      return { per, dpPsi: hyd.dpPsi, stageArea: hyd.stageArea, stageH: hyd.stageH, cellStage };
    }
    return { evaluate };
  }

  function objective(p, ev, weights) {
    let j = 0, wsum = 0, pen = 0;
    for (const r of ev.per) {
      const w = weights[r.id] || 0;
      j += w * r.throughput; wsum += w;
    }
    const dpOver = ev.dpPsi - p.dpBudgetPsi; if (dpOver > 0) pen += dpOver * dpOver * 50;
    return (wsum > 0 ? j / wsum : 0) - pen;
  }

  // ---------- optimizer ----------
  function tileGrid(p) {
    const tilesX = Math.ceil(p.nx / p.tile), tilesY = Math.ceil(p.ny / p.tile);
    return { tilesX, tilesY, nTiles: tilesX * tilesY };
  }

  // power-weighted criticality of each tile for the targeted workloads
  function tileCriticality(p, workloads, weights) {
    const { tilesX, nTiles } = tileGrid(p);
    const c = new Float64Array(nTiles);
    const peak = new Float64Array(nTiles);
    let wsum = 0; for (const w of workloads) wsum += weights[w.id] || 0;
    for (const w of workloads) {
      const wt = (weights[w.id] || 0) / wsum; if (!wt) continue;
      const tileP = new Float64Array(nTiles);
      for (let j = 0; j < p.ny; j++) for (let i = 0; i < p.nx; i++) {
        const t = Math.floor(j / p.tile) * tilesX + Math.floor(i / p.tile);
        tileP[t] = Math.max(tileP[t], w.powerW[j * p.nx + i]);
      }
      for (let t = 0; t < nTiles; t++) { c[t] += wt * tileP[t]; peak[t] = Math.max(peak[t], tileP[t]); }
    }
    for (let t = 0; t < nTiles; t++) c[t] = c[t] + 0.5 * peak[t];
    return c;
  }

  function designFromCuts(p, order, f1, f2) {
    const { nTiles } = tileGrid(p);
    const ts = new Int8Array(nTiles).fill(2);
    const n1 = Math.max(1, Math.round(f1 * nTiles)), n2 = Math.max(n1 + 1, Math.round(f2 * nTiles));
    for (let r = 0; r < nTiles; r++) ts[order[r]] = r < n1 ? 0 : r < n2 ? 1 : 2;
    return { kind: 'staged', tileStage: ts };
  }

  function optimizeStages(p, layout, workloads, weights, opts) {
    opts = opts || {};
    const rng = mulberry32(opts.seed || 7);
    const targets = workloads.filter(w => (weights[w.id] || 0) > 0);
    const E = makeEvaluator(p, layout, targets);
    const crit = tileCriticality(p, targets, weights);
    const { tilesX, tilesY, nTiles } = tileGrid(p);
    const order = Array.from({ length: nTiles }, (_, i) => i).sort((a, b) => crit[b] - crit[a]);
    let best = null, bestJ = -Infinity, evals = 0;
    const tryDesign = (d) => { const ev = E.evaluate(d); evals++; const j = objective(p, ev, weights); if (j > bestJ) { bestJ = j; best = d; } return j; };
    // 1) coarse search over stage cut fractions
    const f1s = opts.f1s || [0.06, 0.10, 0.14, 0.18, 0.24, 0.30];
    const f2s = opts.f2s || [0.30, 0.40, 0.50, 0.62];
    for (const f1 of f1s) for (const f2 of f2s) if (f2 > f1 + 0.05) tryDesign(designFromCuts(p, order, f1, f2));
    if (opts.extraStart) for (const d of opts.extraStart) tryDesign(d);
    const cutJ = bestJ;
    // 2) boundary-move local search (greedy, seeded)
    const iters = opts.iters == null ? 160 : opts.iters;
    let cur = { kind: 'staged', tileStage: Int8Array.from(best.tileStage) }, curJ = bestJ;
    let accepted = 0;
    for (let it = 0; it < iters; it++) {
      const t = Math.floor(rng() * nTiles);
      const tx = t % tilesX, ty = Math.floor(t / tilesX);
      const nb = [];
      if (tx > 0) nb.push(t - 1); if (tx < tilesX - 1) nb.push(t + 1);
      if (ty > 0) nb.push(t - tilesX); if (ty < tilesY - 1) nb.push(t + tilesX);
      const cands = [...new Set(nb.map(u => cur.tileStage[u]).filter(s => s !== cur.tileStage[t]))];
      if (!cands.length) { continue; }
      const ns = cands[Math.floor(rng() * cands.length)];
      const trial = { kind: 'staged', tileStage: Int8Array.from(cur.tileStage) };
      trial.tileStage[t] = ns;
      const ev = E.evaluate(trial); evals++;
      const j = objective(p, ev, weights);
      if (j > curJ + 1e-9) { cur = trial; curJ = j; accepted++; }
    }
    if (curJ > bestJ) { best = cur; bestJ = curJ; }
    return { design: best, objective: bestJ, cutObjective: cutJ, evals, accepted, criticality: crit, order };
  }

  // greedy placement of k diamond inserts (s x s cells) on logic-die area
  function placeDiamonds(p, layout, workloads, weights, design, k, opts) {
    opts = opts || {};
    const s = p.diamondInsertCells;
    const n = p.nx * p.ny;
    const targets = workloads.filter(w => (weights[w.id] || 0) > 0);
    const E = makeEvaluator(p, layout, targets);
    let mask = new Uint8Array(n);
    let cur = { ...design, diamond: null };
    let ev = E.evaluate(cur); let curJ = objective(p, ev, weights);
    const placed = [];
    for (let m = 0; m < k; m++) {
      // heat-excess score per candidate window from current solution
      const cands = [];
      for (let j0 = 0; j0 + s <= p.ny; j0++) for (let i0 = 0; i0 + s <= p.nx; i0++) {
        let ok = true, score = 0;
        for (let j = j0; j < j0 + s && ok; j++) for (let i = i0; i < i0 + s; i++) {
          const kk = j * p.nx + i;
          if (!isDie(layout.region[kk]) || mask[kk]) { ok = false; break; }
          for (const r of ev.per) {
            const w = weights[r.id] || 0;
            const ex = r.Tj[kk] - (r.tja - 2);
            if (ex > 0) score += w * ex * (1 + (r.Tj[kk] >= r.tjMax - 3 ? 2 : 0));
          }
        }
        if (ok) cands.push({ i0, j0, score });
      }
      cands.sort((a, b) => b.score - a.score);
      // keep spatially distinct top candidates
      const top = [];
      for (const c of cands) {
        if (top.every(t => Math.abs(t.i0 - c.i0) >= 2 || Math.abs(t.j0 - c.j0) >= 2)) top.push(c);
        if (top.length >= (opts.topK || 8)) break;
      }
      let bestC = null, bestJ = curJ, bestEv = null, bestMask = null;
      for (const c of top) {
        const mk = Uint8Array.from(mask);
        for (let j = c.j0; j < c.j0 + s; j++) for (let i = c.i0; i < c.i0 + s; i++) mk[j * p.nx + i] = 1;
        const d = { ...design, diamond: mk };
        const e2 = E.evaluate(d); const j2 = objective(p, e2, weights);
        if (j2 > bestJ) { bestJ = j2; bestC = c; bestEv = e2; bestMask = mk; }
      }
      if (!bestC) break;
      mask = bestMask; curJ = bestJ; ev = bestEv; placed.push({ i0: bestC.i0, j0: bestC.j0, size: s });
    }
    return { design: { ...design, diamond: placed.length ? mask : null }, inserts: placed, objective: curJ };
  }

  // ---------- full study ----------
  function runStudy(p, layout, workloads, mix, opts) {
    opts = opts || {};
    const designWorkload = opts.designWorkload || workloads[0].id; // what "customized to the power map" uses
    const all = makeEvaluator(p, layout, workloads);
    const single = optimizeStages(p, layout, workloads, { [designWorkload]: 1 }, opts);
    const robust = optimizeStages(p, layout, workloads, mix, { ...opts, extraStart: [single.design] });
    const nIns = opts.diamonds == null ? 4 : opts.diamonds;
    const singleD = nIns ? placeDiamonds(p, layout, workloads, { [designWorkload]: 1 }, single.design, nIns, opts) : null;
    const robustD = nIns ? placeDiamonds(p, layout, workloads, mix, robust.design, nIns, opts) : null;
    const designs = [
      { key: 'skived', label: 'Skived split-flow', design: { kind: 'skived' } },
      { key: 'single', label: 'LiquidJet, staged to ' + designWorkload + ' map', design: single.design },
      { key: 'robust', label: 'LiquidJet, staged to workload mix', design: robust.design },
    ];
    if (nIns) {
      designs.push({ key: 'singleD', label: 'Diamond, placed for ' + designWorkload, design: singleD.design, inserts: singleD.inserts });
      designs.push({ key: 'robustD', label: 'Diamond, placed for workload mix', design: robustD.design, inserts: robustD.inserts });
    }
    for (const d of designs) {
      const ev = all.evaluate(d.design);
      d.eval = ev;
      let wsum = 0, tpw = 0, thr = 0, worstTj = -Infinity;
      for (const r of ev.per) { const w = mix[r.id] || 0; wsum += w; tpw += w * r.tpw; thr += w * r.throughput; worstTj = Math.max(worstTj, r.tjMax); }
      d.fleetTpw = tpw / wsum; d.fleetThroughput = thr / wsum; d.worstTjMax = worstTj; d.dpPsi = ev.dpPsi;
    }
    const base = designs[0];
    for (const d of designs) { d.tpwGainVsSkived = d.fleetTpw / base.fleetTpw - 1; d.thrGainVsSkived = d.fleetThroughput / base.fleetThroughput - 1; }
    return { designs, single, robust, singleD, robustD, designWorkload };
  }

  const Studio = { DEFAULTS, mulberry32, makeLayout, buildConductances, stageOfCell, hydraulics, solve, metrics, tokensPerWatt, throttle, tpwSlopeAt, makeEvaluator, objective, optimizeStages, placeDiamonds, runStudy, tileGrid, isDie };
  if (typeof module !== 'undefined' && module.exports) module.exports = Studio;
  else root.Studio = Studio;
})(typeof window !== 'undefined' ? window : globalThis);
