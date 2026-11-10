/* UI for Power Map Studio. All numbers come from core/studio.js run on data/workloads.js. */
(function () {
  'use strict';
  const S = window.Studio;
  const DATA = window.WORKLOADS;
  // banded palette sampled from the Temp [C] legend on froresystems.com (low -> high)
  const BANDS = ['#3953a4', '#435aa8', '#547ebf', '#2dbce9', '#60c2aa', '#82c664', '#abd036', '#d7e03e', '#f7b731', '#f28123', '#e24924', '#d22727', '#c82026'];
  const STAGE_COLORS = ['#4ec5cf', '#508cc6', '#27344c'];
  const STAGE_NAMES = ['Stage 1 (cold inlet)', 'Stage 2', 'Stage 3 (hot exit)'];
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1) => v.toFixed(d);
  const pct = (v, d = 1) => (v * 100).toFixed(d);

  const defaults = { prefill: 30, decode: 55, training: 15, dia: 4, flow: 1.4, inlet: S.DEFAULTS.inletC, dp: S.DEFAULTS.dpBudgetPsi, target: 'prefill' };
  const state = { ...defaults, variant: 'copper', result: null, params: null };
  const WL = DATA.workloads.map(w => ({ ...w, powerW: Float64Array.from(w.powerW) }));
  const P0 = { ...S.DEFAULTS };
  const LAYOUT = S.makeLayout(P0);
  const A_CM2 = (P0.dx / 10) ** 2;
  const label = (id) => WL.find(w => w.id === id).label;

  // ---------- drawing ----------
  function bandColor(v, lo, step) {
    let b = Math.floor((v - lo) / step);
    if (b < 0) b = 0; if (b >= BANDS.length) b = BANDS.length - 1;
    return BANDS[b];
  }
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  const BAND_RGB = BANDS.map(hexToRgb);

  function outline(ctx, sc) {
    const nx = P0.nx, ny = P0.ny;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
    const rect = (i0, j0, i1, j1) => ctx.strokeRect(i0 * sc + 0.5, j0 * sc + 0.5, (i1 - i0) * sc - 1, (j1 - j0) * sc - 1);
    rect(8, 0, 24, ny); rect(24, 0, 40, ny);
    for (let s = 0; s < 4; s++) { rect(0, s * 6, 7, s * 6 + 6); rect(41, s * 6, 48, s * 6 + 6); }
    ctx.restore();
  }

  function drawField(canvas, values, lo, step) {
    const nx = P0.nx, ny = P0.ny, sc = 8;
    canvas.width = nx * sc; canvas.height = ny * sc;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let py = 0; py < canvas.height; py++) {
      const y = (py + 0.5) / sc - 0.5;
      const j0 = Math.max(0, Math.min(ny - 2, Math.floor(y))), ty = Math.max(0, Math.min(1, y - j0));
      for (let px = 0; px < canvas.width; px++) {
        const x = (px + 0.5) / sc - 0.5;
        const i0 = Math.max(0, Math.min(nx - 2, Math.floor(x))), tx = Math.max(0, Math.min(1, x - i0));
        const k = j0 * nx + i0;
        const v = values[k] * (1 - tx) * (1 - ty) + values[k + 1] * tx * (1 - ty) + values[k + nx] * (1 - tx) * ty + values[k + nx + 1] * tx * ty;
        let b = Math.floor((v - lo) / step); if (b < 0) b = 0; if (b >= BANDS.length) b = BANDS.length - 1;
        const c = BAND_RGB[b], o = (py * canvas.width + px) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    outline(ctx, sc);
  }

  function drawStages(canvas, cellStage, inserts) {
    const nx = P0.nx, ny = P0.ny, sc = 8;
    canvas.width = nx * sc; canvas.height = ny * sc;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      ctx.fillStyle = STAGE_COLORS[cellStage[j * nx + i]];
      ctx.fillRect(i * sc, j * sc, sc, sc);
    }
    // microcell tile grid
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i <= nx; i += P0.tile) { ctx.beginPath(); ctx.moveTo(i * sc + 0.5, 0); ctx.lineTo(i * sc + 0.5, canvas.height); ctx.stroke(); }
    for (let j = 0; j <= ny; j += P0.tile) { ctx.beginPath(); ctx.moveTo(0, j * sc + 0.5); ctx.lineTo(canvas.width, j * sc + 0.5); ctx.stroke(); }
    outline(ctx, sc);
    for (const ins of inserts || []) {
      const x = ins.i0 * sc, y = ins.j0 * sc, w = ins.size * sc;
      ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(x, y, w, w);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, w - 2);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, w); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
      for (let d = -w; d < w; d += 6) { ctx.beginPath(); ctx.moveTo(x + d, y + w); ctx.lineTo(x + d + w, y); ctx.stroke(); }
      ctx.restore();
    }
  }

  function legend(el, title, unit, lo, step, bandPx) {
    const bh = bandPx || 18.6;
    el.style.lineHeight = bh + 'px'; el.style.fontSize = (bh < 15 ? 13 : 17) + 'px';
    const bars = BANDS.slice().reverse().map(c => `<i style="background:${c};height:${bh}px"></i>`).join('');
    const ticks = [];
    for (let b = BANDS.length; b >= 0; b--) ticks.push(`<span>${(lo + b * step).toFixed(step < 1 ? 1 : 0)}</span>`);
    el.innerHTML = `<div class="ttl">${title} <small>${unit}</small></div><div class="scale"><div class="bar">${bars}</div><div class="ticks">${ticks.join('')}</div></div>`;
  }

  const tip = $('tip');
  function attachTip(canvas, fn) {
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left) / r.width * P0.nx), j = Math.floor((e.clientY - r.top) / r.height * P0.ny);
      if (i < 0 || j < 0 || i >= P0.nx || j >= P0.ny) return;
      tip.innerHTML = fn(j * P0.nx + i, i, j);
      tip.style.display = 'block'; tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 12) + 'px';
    });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
  function regionName(k) { const r = LAYOUT.region[k]; return r === 1 ? 'Die A' : r === 2 ? 'Die B' : r === 0 ? 'Underfill gap' : 'HBM stack'; }

  // ---------- static: power maps ----------
  function renderPowerMaps() {
    const host = $('power-maps'); host.innerHTML = '';
    let maxD = 0;
    for (const w of WL) for (const v of w.powerW) maxD = Math.max(maxD, v / A_CM2);
    const step = Math.ceil(maxD / BANDS.length / 10) * 10;
    for (const w of WL) {
      const dens = w.powerW.map(v => v / A_CM2);
      let pk = 0, kpk = 0; dens.forEach((v, k) => { if (v > pk) { pk = v; kpk = k; } });
      const cell = document.createElement('div'); cell.className = 'map-cell';
      cell.innerHTML = `<div class="lbl"><b>${w.label}</b><span class="share">${w.note}</span></div><canvas></canvas><div class="stat">Peak ${fmt(pk, 0)} W/cm² in ${regionName(kpk)} · total ${fmt(w.powerW.reduce((a, b) => a + b, 0), 0)} W</div>`;
      host.appendChild(cell);
      const cv = cell.querySelector('canvas');
      drawField(cv, dens, 0, step);
      attachTip(cv, (k, i, j) => `${w.label} · ${regionName(k)}<br>${fmt(i * P0.dx, 1)}, ${fmt(j * P0.dx, 1)} mm · <b>${fmt(dens[k], 0)} W/cm²</b>`);
    }
    legend($('power-legend'), 'Power', '[W/cm²]', 0, step, 11.5);
    $('tv-power').textContent = DATA.totalW.toLocaleString();
  }

  // ---------- results ----------
  function designsFor(res) {
    const by = Object.fromEntries(res.designs.map(d => [d.key, d]));
    const dia = state.variant === 'diamond' && by.singleD;
    return { skived: by.skived, single: dia ? by.singleD : by.single, robust: dia ? by.robustD : by.robust, by };
  }

  function worst(d) { return d.eval.per.reduce((a, r) => (r.tjMax > a.tjMax ? r : a)); }

  function renderResults() {
    const res = state.result, p = state.params;
    const D = designsFor(res);
    const tgt = label(res.designWorkload);
    const mix = state.mix;
    const mixTxt = WL.map(w => `${Math.round(mix[w.id] * 100)}% ${w.label.toLowerCase()}`).join(', ');
    $('mix-text').textContent = mixTxt;
    $('dp-budget-text').textContent = fmt(p.dpBudgetPsi, 2);
    $('cap-inlet').textContent = fmt(p.inletC, 0); $('cap-flow').textContent = fmt(p.flowLpm, 1);

    // headline bullets (copper designs, the core comparison)
    const sC = D.by.single, rC = D.by.robust;
    const ws = worst(sC), wr = worst(rC);
    const items = [];
    if (ws.tjMax > p.tjLimit) items.push(`Staged to the <b>${tgt}</b> map, <b>${label(ws.id)}</b> reaches <b>${fmt(ws.tjMax)} °C</b> and DVFS must cut <b>${pct(1 - ws.alpha)}%</b> of GPU power.`);
    else items.push(`Staged to the <b>${tgt}</b> map, the hottest workload (${label(ws.id)}) peaks at <b>${fmt(ws.tjMax)} °C</b>.`);
    if (wr.tjMax <= p.tjLimit + 1e-9) items.push(`Staged to the <b>workload mix</b>, every workload stays at or below <b>${fmt(wr.tjMax)} °C</b>.`);
    else items.push(`Staged to the <b>workload mix</b>, the worst case is ${label(wr.id)} at <b>${fmt(wr.tjMax)} °C</b> (DVFS cut ${pct(1 - wr.alpha)}%).`);
    const gain = rC.fleetThroughput / sC.fleetThroughput - 1;
    items.push(`<b>${gain >= 0 ? '+' : ''}${pct(gain)}%</b> fleet token throughput vs single-map staging, at <b>${fmt(rC.dpPsi, 3)} psi</b> vs ${fmt(sC.dpPsi, 3)} psi.`);
    if (D.by.robustD) {
      const g2 = D.by.robustD.fleetThroughput / D.by.singleD.fleetThroughput - 1;
      items.push(`With ${D.by.robustD.inserts.length} diamond inserts placed for the mix: <b>${g2 >= 0 ? '+' : ''}${pct(g2)}%</b> vs inserts placed for ${tgt}.`);
    }
    $('headline-list').innerHTML = items.map(t => `<li>${t}</li>`).join('');

    // stage maps
    const sm = $('stage-maps'); sm.innerHTML = '';
    for (const [d, name] of [[D.single, `Staged to ${tgt} map`], [D.robust, 'Staged to workload mix']]) {
      const n = d.eval.cellStage.length;
      const areas = d.eval.stageArea.map(a => Math.round(a / n * 100) + '%').join(' / ');
      const cell = document.createElement('div'); cell.className = 'map-cell';
      cell.innerHTML = `<div class="lbl"><b>${name}</b></div><canvas></canvas><div class="stat">Stage areas ${areas} · ΔP ${fmt(d.dpPsi, 3)} psi${d.inserts ? ` · ${d.inserts.length} diamond inserts` : ''}</div>`;
      sm.appendChild(cell);
      const cv = cell.querySelector('canvas');
      drawStages(cv, d.eval.cellStage, d.inserts);
      attachTip(cv, (k) => `${regionName(k)} · ${STAGE_NAMES[d.eval.cellStage[k]]}<br>h = ${fmt(d.eval.stageH[d.eval.cellStage[k]] / 1000, 0)} kW/m²K · coolant ${fmt(d.eval.per[0].tStage[d.eval.cellStage[k]], 1)} °C (${label(d.eval.per[0].id)})`);
    }
    $('stage-legend').innerHTML = STAGE_NAMES.map((s, i) => `<span><i style="background:${STAGE_COLORS[i]}"></i>${s}</span>`).join('') + (D.robust.inserts ? '<span><i style="background:rgba(255,255,255,.35);border-color:#fff"></i>Diamond insert</span>' : '');

    // Tj grid
    const lo = 40, step = 5;
    const grid = $('tj-grid'); grid.innerHTML = '';
    const cols = [[D.skived, 'Skived split-flow'], [D.single, `LiquidJet${state.variant === 'diamond' ? ' Diamond' : ''}<br>staged to ${tgt} map`], [D.robust, `LiquidJet${state.variant === 'diamond' ? ' Diamond' : ''}<br>staged to workload mix`]];
    grid.insertAdjacentHTML('beforeend', '<div></div>' + cols.map(c => `<div class="colhead">${c[1]}</div>`).join(''));
    WL.forEach((w, wi) => {
      grid.insertAdjacentHTML('beforeend', `<div class="rowhead">${w.label}<small>${Math.round(mix[w.id] * 100)}% of fleet hours</small></div>`);
      for (const [d] of cols) {
        const r = d.eval.per[wi];
        const cell = document.createElement('div'); cell.className = 'map-cell';
        const flag = r.tjMax > p.tjLimit ? `<span class="over">${fmt(r.tjMax)} °C · DVFS −${pct(1 - r.alpha)}%</span>` : `<span class="ok">${fmt(r.tjMax)} °C</span>`;
        cell.innerHTML = `<canvas></canvas><div class="stat">T<sub>Jmax</sub> ${flag} · T<sub>JA</sub> ${fmt(r.tja)} °C</div>`;
        grid.appendChild(cell);
        const cv = cell.querySelector('canvas');
        drawField(cv, r.Tj, lo, step);
        attachTip(cv, (k, i, j) => `${w.label} · ${regionName(k)}<br>${fmt(i * P0.dx, 1)}, ${fmt(j * P0.dx, 1)} mm · <b>${fmt(r.Tj[k], 1)} °C</b>`);
      }
    });
    legend($('tj-legend'), 'Temp', '[C]', lo, step);

    // table
    const head = `<thead><tr><th style="background:transparent;border-color:transparent"></th><th>Skived<br>split-flow</th><th>LiquidJet${state.variant === 'diamond' ? ' Diamond' : ''}<br>staged to ${tgt}</th><th class="feature">LiquidJet${state.variant === 'diamond' ? ' Diamond' : ''}<br>staged to mix</th></tr></thead>`;
    const ds = [D.skived, D.single, D.robust];
    const rows = [];
    WL.forEach((w, wi) => {
      const vals = ds.map(d => d.eval.per[wi].tjMax);
      const best = Math.min(...vals);
      rows.push(`<tr><th>Max GPU Die Temp<small>${w.label} (${Math.round(mix[w.id] * 100)}%)</small></th>${vals.map(v => `<td class="${v > p.tjLimit ? 'bad' : v === best ? 'best' : ''}">${fmt(v)}°C</td>`).join('')}</tr>`);
    });
    const tjaMix = ds.map(d => d.eval.per.reduce((a, r) => a + (mix[r.id] || 0) * r.tja, 0));
    rows.push(`<tr><th>Weighted Die Temp T<sub>JA</sub><small>fleet-hour weighted</small></th>${tjaMix.map(v => `<td>${fmt(v)}°C</td>`).join('')}</tr>`);
    rows.push(`<tr><th>DVFS Power Cut<small>worst workload</small></th>${ds.map(d => { const wv = d.eval.per.reduce((a, r) => (r.alpha < a.alpha ? r : a)); return wv.alpha < 1 ? `<td class="bad">${pct(1 - wv.alpha)}% (${wv.id})</td>` : '<td>none</td>'; }).join('')}</tr>`);
    rows.push(`<tr><th>Coldplate Pressure Drop<small>@ ${fmt(p.flowLpm, 1)} lpm PG25</small></th>${ds.map(d => `<td>${fmt(d.dpPsi, 3)} psi</td>`).join('')}</tr>`);
    rows.push(`<tr><th>Fleet Token Throughput<small>index, skived = 100</small></th>${ds.map(d => `<td class="${d === D.robust ? 'best' : ''}">${fmt(100 * d.fleetThroughput / D.skived.fleetThroughput)}</td>`).join('')}</tr>`);
    $('perf').innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
    $('perf-note').textContent = `Note: Synthetic ${DATA.totalW} W dual-die test vehicle | Inlet ${fmt(p.inletC, 0)}C PG25 | Flow ${fmt(p.flowLpm, 1)} lpm | ΔP budget ${fmt(p.dpBudgetPsi, 2)} psi | TIM 0.02 K·cm²/W`;
  }

  // ---------- run ----------
  function readControls() {
    const tot = state.prefill + state.decode + state.training || 1;
    state.mix = { prefill: state.prefill / tot, decode: state.decode / tot, training: state.training / tot };
  }
  function syncLabels() {
    $('v-prefill').textContent = state.prefill + '%'; $('v-decode').textContent = state.decode + '%'; $('v-training').textContent = state.training + '%';
    $('v-dia').textContent = state.dia; $('v-flow').textContent = fmt(+state.flow, 1) + ' lpm'; $('v-inlet').textContent = state.inlet + ' °C'; $('v-dp').textContent = fmt(+state.dp, 2) + ' psi';
    for (const [id, k] of [['s-prefill', 'prefill'], ['s-decode', 'decode'], ['s-training', 'training'], ['s-dia', 'dia'], ['s-flow', 'flow'], ['s-inlet', 'inlet'], ['s-dp', 'dp']]) $(id).value = state[k];
    document.querySelectorAll('#target-seg button').forEach(b => b.classList.toggle('on', b.dataset.t === state.target));
  }
  function run() {
    readControls();
    $('status').textContent = 'Optimizing stage maps…';
    $('run').disabled = true;
    setTimeout(() => {
      const t0 = performance.now();
      const p = { ...S.DEFAULTS, flowLpm: +state.flow, inletC: +state.inlet, dpBudgetPsi: +state.dp };
      const res = S.runStudy(p, LAYOUT, WL, state.mix, { designWorkload: state.target, diamonds: +state.dia, seed: 7 });
      state.result = res; state.params = p;
      if (!res.singleD && state.variant === 'diamond') state.variant = 'copper';
      document.querySelectorAll('#variant-seg button').forEach(b => { b.classList.toggle('on', b.dataset.v === state.variant); b.disabled = b.dataset.v === 'diamond' && !res.singleD; });
      renderResults();
      const ev = res.single.evals + res.robust.evals;
      $('status').textContent = `${ev} candidate designs × ${WL.length} workloads evaluated in ${((performance.now() - t0) / 1000).toFixed(1)} s (seed 7).`;
      $('run').disabled = false;
    }, 30);
  }

  function bind() {
    for (const [id, k, num] of [['s-prefill', 'prefill', 1], ['s-decode', 'decode', 1], ['s-training', 'training', 1], ['s-dia', 'dia', 1], ['s-flow', 'flow', 1], ['s-inlet', 'inlet', 1], ['s-dp', 'dp', 1]]) {
      $(id).addEventListener('input', (e) => { state[k] = num ? +e.target.value : e.target.value; syncLabels(); });
    }
    document.querySelectorAll('#target-seg button').forEach(b => b.addEventListener('click', () => { state.target = b.dataset.t; syncLabels(); }));
    document.querySelectorAll('#variant-seg button').forEach(b => b.addEventListener('click', () => {
      if (b.disabled) return; state.variant = b.dataset.v;
      document.querySelectorAll('#variant-seg button').forEach(x => x.classList.toggle('on', x === b)); renderResults();
    }));
    $('run').addEventListener('click', run);
    $('reset').addEventListener('click', () => { Object.assign(state, defaults); syncLabels(); run(); });
  }

  // optional shareable state: ?variant=diamond&prefill=30&decode=55&training=15&flow=1.4&inlet=45&dp=0.3&dia=4&target=prefill
  const qs = new URLSearchParams(location.search);
  for (const k of ['prefill', 'decode', 'training', 'dia', 'flow', 'inlet', 'dp']) if (qs.has(k) && isFinite(+qs.get(k))) state[k] = +qs.get(k);
  if (['prefill', 'decode', 'training'].includes(qs.get('target'))) state.target = qs.get('target');
  if (qs.get('variant') === 'diamond') state.variant = 'diamond';
  renderPowerMaps();
  syncLabels();
  bind();
  run();
})();
