'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/studio.js');
const DATA = require('../data/workloads.json');

const P = { ...S.DEFAULTS };
const LAYOUT = S.makeLayout(P);
const WL = DATA.workloads.map(w => ({ ...w, powerW: Float64Array.from(w.powerW) }));
const MIX = Object.fromEntries(WL.map(w => [w.id, w.share]));

function uniformLayout(p) {
  const n = p.nx * p.ny;
  return { region: new Uint8Array(n).fill(1), hbmStack: new Int8Array(n).fill(-1) };
}

test('synthetic workloads are power-capped at the same total', () => {
  for (const w of WL) {
    const tot = w.powerW.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(tot - DATA.totalW) < 0.5, `${w.id} total ${tot}`);
  }
  const shares = WL.reduce((a, w) => a + w.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
});

test('uniform heat flux matches the 1-D resistance stack analytically', () => {
  const p = { ...P };
  const L = uniformLayout(p);
  const n = p.nx * p.ny;
  const q = 1000 / n;
  const powerW = new Float64Array(n).fill(q);
  const cond = S.buildConductances(p, L, null);
  const design = { kind: 'skived' };
  const cs = S.stageOfCell(p, design);
  const hyd = S.hydraulics(p, design, cs);
  const sol = S.solve(p, cond, hyd, cs, powerW);
  const A_cm2 = (p.dx / 10) ** 2;
  const qpp = q / A_cm2;                         // W/cm^2
  const rConv = 1 / hyd.hc[0] * 1e4;             // C*cm^2/W
  const tCool = p.inletC + 1000 / (2 * p.cpPerLpm * p.flowLpm);
  const expected = tCool + qpp * (p.rDieTim + rConv);
  for (const k of [0, 100, n - 1]) assert.ok(Math.abs(sol.Tj[k] - expected) < 1e-3, `${sol.Tj[k]} vs ${expected}`);
});

test('energy balance: heat into the coolant equals GPU power for every design', () => {
  const ev = S.makeEvaluator(P, LAYOUT, WL);
  const tiles = S.tileGrid(P).nTiles;
  const ts = new Int8Array(tiles).map((_, i) => i % 3);
  for (const d of [{ kind: 'skived' }, { kind: 'staged', tileStage: ts }]) {
    const r = ev.evaluate(d);
    for (const w of r.per) {
      const q = w.qStage.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(q - DATA.totalW) / DATA.totalW < 2e-3, `${w.id}: ${q}`);
    }
  }
});

test('coolant warms stage by stage in flow order', () => {
  const ev = S.makeEvaluator(P, LAYOUT, WL);
  const ts = new Int8Array(S.tileGrid(P).nTiles).map((_, i) => i % 3);
  const r = ev.evaluate({ kind: 'staged', tileStage: ts });
  for (const w of r.per) { assert.ok(w.tStage[0] < w.tStage[1] && w.tStage[1] < w.tStage[2]); }
});

test('throttle factor brings TjMax exactly to the limit (linearity check)', () => {
  const ev = S.makeEvaluator(P, LAYOUT, WL);
  const r = ev.evaluate({ kind: 'skived' });
  const hot = r.per.find(x => x.alpha < 1);
  assert.ok(hot, 'expected the skived reference to throttle on at least one workload');
  const w = WL.find(x => x.id === hot.id);
  const scaled = { ...w, powerW: w.powerW.map(v => v * hot.alpha) };
  const ev2 = S.makeEvaluator(P, LAYOUT, [scaled]).evaluate({ kind: 'skived' });
  assert.ok(Math.abs(ev2.per[0].tjMax - P.tjLimit) < 0.05, `${ev2.per[0].tjMax}`);
});

test('more flow lowers TjA, at higher pressure drop', () => {
  const ts = new Int8Array(S.tileGrid(P).nTiles).map((_, i) => i % 3);
  const lo = S.makeEvaluator({ ...P, flowLpm: 1.0 }, LAYOUT, WL).evaluate({ kind: 'staged', tileStage: ts });
  const hi = S.makeEvaluator({ ...P, flowLpm: 2.0 }, LAYOUT, WL).evaluate({ kind: 'staged', tileStage: ts });
  for (let i = 0; i < WL.length; i++) assert.ok(hi.per[i].tja < lo.per[i].tja);
  assert.ok(hi.dpPsi > lo.dpPsi);
});

test('tokens/watt model reproduces the white paper slope (-1.5%/C at 89 C)', () => {
  assert.ok(Math.abs(S.tpwSlopeAt(P, 89) + 1.5) < 0.02);
  assert.ok(S.tokensPerWatt(P, 70) > S.tokensPerWatt(P, 80));
});

test('mix-optimized staging is never worse than single-map staging on the mix, and respects the pressure budget', () => {
  const opts = { iters: 40, seed: 3 };
  const single = S.optimizeStages(P, LAYOUT, WL, { prefill: 1 }, opts);
  const robust = S.optimizeStages(P, LAYOUT, WL, MIX, { ...opts, extraStart: [single.design] });
  const ev = S.makeEvaluator(P, LAYOUT, WL);
  const jS = S.objective(P, ev.evaluate(single.design), MIX);
  const jR = S.objective(P, ev.evaluate(robust.design), MIX);
  assert.ok(jR >= jS - 1e-12, `${jR} < ${jS}`);
  assert.ok(ev.evaluate(robust.design).dpPsi <= P.dpBudgetPsi + 1e-9);
});

test('optimizer is deterministic for a seed', () => {
  const a = S.optimizeStages(P, LAYOUT, WL, MIX, { iters: 20, seed: 11 });
  const b = S.optimizeStages(P, LAYOUT, WL, MIX, { iters: 20, seed: 11 });
  assert.deepEqual(Array.from(a.design.tileStage), Array.from(b.design.tileStage));
});

test('diamond inserts sit on logic die, do not overlap, and improve the objective', () => {
  const base = S.optimizeStages(P, LAYOUT, WL, MIX, { iters: 0 });
  const res = S.placeDiamonds(P, LAYOUT, WL, MIX, base.design, 3, {});
  assert.ok(res.inserts.length >= 1);
  const seen = new Set();
  for (const ins of res.inserts) for (let j = ins.j0; j < ins.j0 + ins.size; j++) for (let i = ins.i0; i < ins.i0 + ins.size; i++) {
    const k = j * P.nx + i;
    assert.ok(S.isDie(LAYOUT.region[k]));
    assert.ok(!seen.has(k)); seen.add(k);
  }
  const ev = S.makeEvaluator(P, LAYOUT, WL);
  assert.ok(S.objective(P, ev.evaluate(res.design), MIX) > S.objective(P, ev.evaluate(base.design), MIX));
});
