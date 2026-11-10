# LiquidJet Power Map Studio (concept)

**Live demo:** https://mohith26.github.io/frore-power-map-studio/

A concept design tool for Frore Systems' LiquidJet multi-stage coldplates: it assigns die tiles to coolant stages, and places LiquidJet Diamond inserts, for the **mix of workloads** a GPU fleet runs instead of a single power map.

> Unofficial concept demo by Mohith Gajjela. Not affiliated with Frore Systems. Synthetic data. LiquidJet, LiquidJet Diamond and AirJet are Frore trademarks, used only to describe the concept.

## Why

LiquidJet's pitch is that a multi-stage coldplate is customized to the GPU power map: the entire coolant flow hits the hotspots first (stage 1), then the rest of the die. But a GPU does not have one power map. Prefill is compute-bound (tensor-core clusters run hot), decode is memory-bound (HBM PHY, memory controllers and L2 run hot), and training adds die-to-die and NVLink IO bursts. Inference fleets spend most of their hours in decode, while coldplates are usually designed against a compute-heavy TDP map.

A coldplate is a fixed piece of copper. If its stage map is tuned to the prefill map, decode's hotspots end up in the last, warmest stage, and when they cross T<sub>Jmax</sub> the GPU's DVFS has to shed power.

## What the demo shows (default settings, synthetic 1,400 W dual-die test vehicle, 45 °C PG25 inlet, 1.4 lpm, 0.30 psi budget, fleet mix 30% prefill / 55% decode / 15% training)

| | Skived split-flow | LiquidJet staged to prefill map | LiquidJet staged to workload mix |
|---|---|---|---|
| Max die temp, prefill | 109.3 °C | 92.9 °C | 94.7 °C |
| Max die temp, decode | 104.2 °C | 101.5 °C | 93.1 °C |
| Max die temp, training | 87.8 °C | 81.8 °C | 84.1 °C |
| Worst DVFS power cut | 22.3% (prefill) | 11.5% (decode) | none |
| Pressure drop | 0.453 psi | 0.282 psi | 0.245 psi |
| Fleet token throughput (skived = 100) | 100.0 | 111.8 | 118.3 |

Staging for the mix gives up 1.8 °C of prefill peak and 2.3 °C of training peak to take 8.4 °C off decode's peak, so nothing throttles: **+5.8% fleet token throughput** over prefill-only staging, at a lower pressure drop. With four diamond inserts, placing them for the mix (on the HBM-PHY edges) instead of the prefill hotspots is worth **+5.9%**. The page recomputes all of this in the browser; change the mix, flow, inlet temperature, pressure budget or insert count and press Re-optimize.

## How it works

`core/studio.js` (no dependencies, runs in the browser and in Node):

1. **Thermal model.** 48 × 24 cells of 1.5 mm over a 72 × 36 mm active area (two logic dies, eight HBM stacks). Two layers: the die (lateral conduction in silicon, weak coupling across die seams and between stacks) and the copper base plate (diamond inserts add in-plane conductance), connected by package + TIM resistance (un-lidded, 0.047 + 0.02 °C·cm²/W, HBM stacks higher). The base convects to the coolant of the cell's stage.
2. **Stages.** Every tile's stage receives the full flow in order 1 → 2 → 3, so stage *s* sees coolant at T<sub>in</sub> + (heat picked up by earlier stages + half its own)/(ṁc<sub>p</sub>). Heat transfer coefficient h ∝ (flow / stage area)<sup>0.6</sup> with a geometry ceiling; pressure drop ∝ (flow / stage area)<sup>1.75</sup> summed over stages. Smaller stages cool harder but cost pressure drop, which is what makes the assignment a real trade-off.
3. **Solve.** Jacobi-preconditioned conjugate gradient on the 2,304-unknown SPD system, wrapped in a fixed-point loop on the stage coolant temperatures until heat into the coolant equals GPU power.
4. **Metrics.** T<sub>JA</sub> is the power-weighted die temperature, as defined in Frore's white paper *The Thermal Stack's Impact on AI Factory Profitability*. Tokens/W uses the paper's rules of thumb at a fixed power cap: leakage doubles every 10 °C and switching energy rises ~2% per 10 °C, calibrated so the slope is −1.5%/°C at 89 °C (the paper's number). If T<sub>Jmax</sub> > 95 °C, DVFS scales power to α·Q; the network is linear in power with a fixed inlet, so α = (95 − T<sub>in</sub>)/(T<sub>Jmax</sub> − T<sub>in</sub>) exactly.
5. **Optimizer.** Objective: fleet token throughput (time-share weighted) with a pressure-drop penalty. Tiles (4.5 mm microcells) are ranked by power-weighted criticality for the target workloads; a cut search over stage-area fractions picks a start; then seeded boundary moves (move a tile to a neighbour's stage, keep if better) refine it. The mix optimizer is also seeded with the single-map design, so it can never do worse on the mix.
6. **Diamond placement.** Greedy: score every legal 7.5 mm insert position on the logic dies by mix-weighted temperature excess, evaluate the top candidates exactly, place the best, repeat.

`data/generate.js` builds the synthetic power maps from a fixed seed (20261110); every workload totals exactly 1,400 W.

## Tests

```
node data/generate.js
node --test test/studio.test.js
```

10 tests: power-cap totals; an analytic check against the 1-D resistance stack for uniform flux; energy balance (coolant heat = GPU power within 0.2%); coolant warming in stage order; the throttle factor landing T<sub>Jmax</sub> exactly on 95 °C; more flow lowering T<sub>JA</sub> at higher pressure drop; the −1.5%/°C calibration; mix staging never losing to single-map staging on the mix and staying in the pressure budget; seed determinism; diamond inserts on logic die, non-overlapping and improving the objective.

## Honest limitations

- **Synthetic everything.** The floorplan and power maps are made up (loosely shaped like a dual-die accelerator with HBM on the outer edges). Real power maps from a GPU vendor would change every number.
- **First-order physics, not CFD.** The h and pressure-drop scaling laws, the ceiling, and the base constants are calibrated to be in the range of Frore's published figures (hotspot R'' ≈ 0.04 °C·cm²/W, ~0.25 psi), not fitted to measurements. Inside a stage, coolant temperature is the stage mean.
- **Throttle model.** Frequency-only DVFS at fixed voltage (throughput ∝ dynamic power), following the white paper's first-order picture. Real V/f scaling loses less throughput, so the throttle numbers are an upper bound.
- **Manufacturability.** Stage regions are free-form unions of 4.5 mm tiles; real 3D microcell layouts and manifolds add connectivity and routing constraints that are not modeled.
- **Workload mix.** The 30/55/15 split is an assumption for an inference-heavy fleet; the Studio lets you change it.

## Novelty note

Frore's public material (product pages for LiquidJet, LiquidJet Diamond and LiquidJet Nexus, the Oct 2025 and Oct 2026 launch releases, the product cards, the white paper and the Hot Chips 2024 tutorial) describes customizing a coldplate to *a* GPU power map. I could not find any public mention of designing stages or diamond placement against multiple workload power maps, or of a customer-facing design tool. Robust design over multiple load cases is well known in academic topology optimization of cold plates; the contribution here is applying it to LiquidJet's stage ordering and diamond placement with a throughput objective.

## Files

- `index.html`, `styles.css`, `app.js`: the page (styled after froresystems.com; Noto Sans, Frore's colors and banded temperature legend)
- `core/studio.js`: thermal model, metrics, optimizer
- `data/generate.js`, `data/workloads.{js,json}`: seeded synthetic power maps
- `test/studio.test.js`: unit tests
