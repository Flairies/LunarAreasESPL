import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import GIF from "gif.js";
import gifWorkerUrl from "gif.js/dist/gif.worker.js?url";

// ── Embedded map data ─────────────────────────────────────────────────────────
const MAP_SRC     = "/basemap.jpg";
let CRATER_DATA = [];
const ILLUMINATION_SRC = "/ILLUM.jpg";


const W = 700, H = 700;

// Build typed masks
let PSR_MASK   = new Uint8Array(W * H);
let RIDGE_MASK = new Uint8Array(W * H);
let TOTAL_PSR  = 0;

// Pixel → crater index lookup (−1 = no crater)
let PIXEL_CRATER = new Int16Array(W * H).fill(-1);
// PIXEL_CRATER populated by loadMapData()


// Illumination map: grayscale 0.0–1.0 per pixel, used to scale solar panel output
let ILLUM_MAP = new Float32Array(W * H);

// ── Map data extraction from JPGs ─────────────────────────────────────────────
function loadImagePixels(src) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      resolve(ctx.getImageData(0, 0, W, H).data);
    };
    img.src = src;
  });
}

function pixLum(px, i) { return px[i*4]*0.299 + px[i*4+1]*0.587 + px[i*4+2]*0.114; }

function extractCraters(pixels) {
  const visited = new Uint8Array(W * H);
  const craters = [];
  const FG = (i) => pixLum(pixels, i) < 128; // dark pixels = crater
  for (let i = 0; i < W * H; i++) {
    if (visited[i] || !FG(i)) continue;
    const stack = [i];
    visited[i] = 1;
    const component = [];
    while (stack.length) {
      const idx = stack.pop();
      component.push(idx);
      const x = idx % W, y = (idx / W) | 0;
      if (x > 0     && !visited[idx-1] && FG(idx-1)) { visited[idx-1] = 1; stack.push(idx-1); }
      if (x < W - 1 && !visited[idx+1] && FG(idx+1)) { visited[idx+1] = 1; stack.push(idx+1); }
      if (y > 0     && !visited[idx-W] && FG(idx-W)) { visited[idx-W] = 1; stack.push(idx-W); }
      if (y < H - 1 && !visited[idx+W] && FG(idx+W)) { visited[idx+W] = 1; stack.push(idx+W); }
    }
    if (component.length < 10) continue;
    let sumX = 0, sumY = 0;
    for (const idx of component) { sumX += idx % W; sumY += (idx / W) | 0; }
    const cx = Math.round(sumX / component.length);
    const cy = Math.round(sumY / component.length);
    craters.push({ cx, cy, size: component.length, pixels: component });
  }
  return craters;
}

async function loadMapData() {
  const [psrPx, ridgePx, craterPx, illumPx] = await Promise.all([
    loadImagePixels('/PSR.jpg'),
    loadImagePixels('/RIDGE.jpg'),
    loadImagePixels('/CRATER.jpg'),
    loadImagePixels('/ILLUM.jpg'),
  ]);
  for (let i = 0; i < W * H; i++) {
    if (pixLum(psrPx, i) < 128) { PSR_MASK[i] = 1; TOTAL_PSR++; }
  }
  for (let i = 0; i < W * H; i++) {
    if (pixLum(ridgePx, i) < 128) RIDGE_MASK[i] = 1;
  }
  CRATER_DATA = extractCraters(craterPx);
  PIXEL_CRATER.fill(-1);
  CRATER_DATA.forEach((c, ci) => { for (const px of c.pixels) PIXEL_CRATER[px] = ci; });
  for (let i = 0; i < W * H; i++) {
    ILLUM_MAP[i] = pixLum(illumPx, i) / 255;
  }
}
// ── Constants ─────────────────────────────────────────────────────────────────
// Real-world target: 15 km/hr sustained, matching the Intuitive Machines RACER lunar terrain vehicle.
// https://www.collectspace.com/news/news-110724a-intuitive-machines-racer-lunar-terrain-vehicle-reveal.html
// 15 km/hr × 24 hr/day = 360 km/day. At W=700 / MAP_KM=288.678 → ≈ 2.4248 px/km.
// 360 × 2.4248 ≈ 872.93 px/day. (Inlined here because PIXELS_PER_KM is declared later.)
const ROVER_SPEED      = 15 * 24 * (700 / 288.678);
// Operational cap: a rover can cover at most 1/5 of its theoretical daily
// range in a single turn (charging, navigation, terrain, mission planning).
// All in-game movement and proximity checks use this capped value.
const ROVER_STEP       = ROVER_SPEED / 5;
// "At target" tolerance — independent of step size. Roughly 2 km, the radius
// within which a rover counts as having arrived at a waypoint, habitat, or pad.
const ROVER_REACH      = 2 * (700 / 288.678); // ~4.85 px
// Real-world mining rate, derived from published lunar ISRU figures:
//   • Excavation rate: 4.8 L/day of regolith
//     https://www.mdpi.com/2313-7673/9/11/680
//   • Lunar regolith bulk density: 1.5 g/cm³
//     https://www.sciencedirect.com/topics/physics-and-astronomy/regolith#:~:text=The%20density%20is%20about%201.5,or%20gardened%20by%20meteorite%20impact.
//   • Water-ice mass fraction in mined regolith: 5.6 %
//     https://www.mdpi.com/2313-7673/9/11/680
// 4.8 L = 4800 cm³; 4800 cm³ × 1.5 g/cm³ = 7200 g = 7.2 kg of regolith/day.
// 7.2 kg × 0.056 = 0.4032 kg of ice/day at quality=1.0.
// PROJECTED ADVANCES: an 80× multiplier is applied because near-future lunar
// rovers will be engineered for industrial-scale extraction rather than the
// scientific-prototype throughput captured in today's published figures, and
// also because gameplay needs ice production to feel meaningful within a
// short mission rather than literal-real-time across decades.
const REGOLITH_VOLUME_PER_DAY_L = 4.8;
const REGOLITH_DENSITY_G_PER_CM3 = 1.5;
const ICE_MASS_FRACTION         = 0.056;
const PROJECTED_ADVANCES_FACTOR = 80;
const BASE_MINE_RATE = REGOLITH_VOLUME_PER_DAY_L * 1000 * REGOLITH_DENSITY_G_PER_CM3 / 1000 * ICE_MASS_FRACTION * PROJECTED_ADVANCES_FACTOR; // ≈ 0.8064 kg/day
const POWER_BASE_DRAIN = 1.5;
// Per full ROVER_STEP of travel for an EMPTY rover. Loaded rovers multiply by
// the loadFactor (up to 3×). Sized so that crossing the whole map in a single
// laden trip outpaces typical solar recharge — players have to plan routes.
const POWER_MOVE_DRAIN = 25;
const POWER_MINE_DRAIN = 2.2;
const PANEL_FLAT       = 7;
const PANEL_RIDGE      = 22;
const REACTOR_OUTPUT   = PANEL_RIDGE * 1.5;
// Asset costs (budget credits) — base values before allocation modifiers
const BASE_ASSET_COSTS  = { solar: 40, habitat: 90, rover: 60, pad: 150, reactor: 280 };
const ASSET_POINTS      = { solar: 2,  habitat: 10, rover: 3,  pad: 5, reactor: 15 }; // infrastructure points per structure
const BASE_MAINT_COSTS = { solar: 0,  habitat: 0,  rover: 0,  pad: 0, reactor: 0 }; // deprecated — replaced by resupply
// Resupply: each step, if a player owns ≥1 functional landing pad, this much
// total health is distributed across damaged assets, prioritizing the lowest
// health first so that asset health stays balanced. Roughly offsets passive
// decay across a typical base; hostile decay still wins out.
const RESUPPLY_CHUNK       = 0.005;
const RESUPPLY_COST        = 35;   // credits per resupply order
const RESUPPLY_POOL        = 2.0;  // total HP distributed per order
// Starting budget — large enough that turn 1 can buy a habitat + solar + pad
// (90 + 40 + 150 = 280) with a comfortable margin for a second build.
const STARTING_BUDGET      = 380;
// Bonus credits per allocation point per round when "BUD" slider is used.
// I_B (alloc.budget fraction × spendable) flows directly into next round budget
// rather than building any stock.
// Asset limits removed — players can build as many of each structure as they
// can afford. The old caps (6 panels / 3 habitats / 2 rovers / 1 pad) are kept
// here as comments for reference but Infinity disables the gate everywhere.
const MAX_PANELS       = Infinity; // was 6
const MAX_HABITATS     = Infinity; // was 3
const MAX_ROVERS       = Infinity; // was 2
const MAX_PADS         = Infinity; // was 1
const MAX_REACTORS     = 1;
const POWER_CAP        = 120;
const HABITAT_POWER_CAP   = 80;   // max power per habitat
const HABITAT_POWER_DRAIN = 2.0;  // power consumed per habitat per day
const HABITAT_POWER_INIT  = HABITAT_POWER_CAP * 0.65; // starting charge
const POWER_LOW        = 20;
// Rover payload capacity. NASA's Artemis lunar logistics mobility call targets
// unpressurized rovers capable of moving 800 kg of cargo across the surface,
// which we use as the per-rover ice cap.
// https://www.nasa.gov/general/nasa-seeks-innovative-artemis-lunar-logistics-mobility-solutions/
const ICE_CAP          = 800;
const DAYS_PER_ROUND   = 7;
const NIGHT_CYCLE      = 14;     // days — non-ridge panels produce 0 during night
const DEPLETION_RATE   = 0.004;  // fraction of crater remaining lost per kg mined, at the reference crater size
// Reference crater size in pixels. A crater at this size yields ~1/DEPLETION_RATE
// kg of ice before exhausting (= 250 kg). Bigger craters hold proportionally
// more (a 2× size crater holds 2× the ice) and deplete proportionally slower.
// The median crater in the generated map is ~150 px, so median-sized deposits
// match the original single-fixed-rate behavior.
const CRATER_REFERENCE_SIZE = 150;
// Economy system — new model
const ALPHA              = 15;    // α: base productivity scalar — Budget = α * E
const E_INIT             = 8;     // starting economy score for each player
const ALPHA_R            = 0.4;   // α_R: R&D decay rate multiplier when falling behind
const ALPHA_M            = 0.15;  // α_M: military decay fraction per round (ΔM = I_M − α_M*M)
const RD_MINE_BONUS      = 0.5;   // +50% mine rate per 100 R&D points accumulated
const MIL_DAMAGE_SCALE   = 2.0;   // military score multiplies hostile damage output
const MIL_DEFENSE_SCALE  = 0.5;   // military score reduces incoming hostile damage
// Competitiveness weights (w1+w2+w3 = 1 → C is bounded [0,1])
const C_W1               = 0.4;   // weight for economy component  √(E/E_max)
const C_W2               = 0.3;   // weight for ice-mined component √(T/T_max)
const C_W3               = 0.3;   // weight for military component  √(M/M_max)
const MAP_KM           = 288.678;        // map covers 288.678 km × 288.678 km
const PIXELS_PER_KM    = W / MAP_KM;      // ≈ 2.4248 px/km (W = 700 px)
// Safety radii in real km — these are the pixel sizes that gameplay was
// tuned around, expressed honestly in km using the corrected scale.
const SAFETY_RADIUS = {
  pad:     7.22  * PIXELS_PER_KM,   // ~17.5 px
  solar:   2.89  * PIXELS_PER_KM,   // ~7 px
  reactor: 5.78  * PIXELS_PER_KM,   // ~14 px
  habitat: 14.43 * PIXELS_PER_KM,   // ~35 px
  rover:   1.44  * PIXELS_PER_KM,   // ~3.5 px
};
const PASSIVE_DECAY    = 0.01;   // 1% per turn
const HOSTILE_DECAY    = 0.05;   // 5% per turn if enemy in safety zone (excluding pads)
const LANDING_DAMAGE   = 0.18;   // chunk knocked off any enemy structure whose safety zone receives a friendly landing

// ── Utility ──────────────────────────────────────────────────────────────────
const d2 = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function stepToward(from, to, speed) {
  const dist = d2(from, to);
  if (dist <= speed) return { x: to.x, y: to.y, arrived: true };
  const t = speed / dist;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, arrived: false };
}

function snapToPSR(x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && x < W && y >= 0 && y < H && PSR_MASK[y * W + x]) return { x, y };
  for (let r = 1; r < 400; r++) {
    for (let dx = -r; dx <= r; dx++) for (const dy of [-r, r]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && PSR_MASK[ny * W + nx]) return { x: nx, y: ny };
    }
    for (let dy = -r + 1; dy < r; dy++) for (const dx of [-r, r]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && PSR_MASK[ny * W + nx]) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

// Is it lunar night for non-ridge panels at this global day?
const isNight = (globalDay) => (globalDay % NIGHT_CYCLE) >= 7;
const hasPlacementGrace = (arrivalDay = 0, globalDay = 0) => globalDay < ((arrivalDay ?? 0) + DAYS_PER_ROUND);
const getCraterIceCapacity = (crater, depletionRate = DEPLETION_RATE) => crater.size / (Math.max(1e-6, depletionRate) * CRATER_REFERENCE_SIZE);
const getTotalMapIce = (po = {}) => {
  const depRate = po.DEPLETION_RATE != null ? po.DEPLETION_RATE : DEPLETION_RATE;
  return CRATER_DATA.reduce((sum, crater) => sum + getCraterIceCapacity(crater, depRate), 0);
};
const DEPLETION_END_THRESHOLD = 0.005;
const GIF_FPS = 2;
const GIF_FRAME_DELAY = Math.round(1000 / GIF_FPS);
const GIF_OVERLAY_HEIGHT = 78;

// ── Player factory ────────────────────────────────────────────────────────────
function makePlayer(base, id, color, opts = {}) {
  const active = opts.active ?? true;
  return {
    id, color,
    active,
    arrivalDay: opts.arrivalDay ?? 0,
    base: { ...base },
    x: base.x, y: base.y,
    power: POWER_CAP * 0.65,
    ice: 0, iceDeposited: 0,
    panels: [],
    reactors: [],
    habitats: [],
    habitatPower: [],  // power level per habitat (index-matched); 0 = unpowered
    extraRovers: [],   // each: { x, y, waypoints, currentWaypoint, ice, carrying, status }
    landingPads: [],
    returning: false,
    pendingDeliveries: [], // { id, type, padIdx } — waiting at a landing pad
    carrying: null,        // { id, type } — structure rover is transporting
    scoreAdjustments: 0,
    safetyViolations: 0,
    generatorRangeEntries: {}, // per-generator arrival timestamps for charging tie breaks
    generatorSupplyTotals: {},
    generatorSupplyByRecipient: { 1: 0, 2: 0 },
    structureHealth: {     // health per structure type: { panels:[], reactors:[], habitats:[], extraRovers:[], landingPads:[] }
      panels: [], reactors: [], habitats: [], extraRovers: [], landingPads: [],
    },
    waypoints: [],          // queued waypoint list
    currentWaypoint: null,
    status: "idle",
    mineMap: {},            // px_idx → total kg mined there
    assetPts: active ? ASSET_POINTS.rover : 0, // primary rover counts toward infrastructure total once player is active
    depositLog: [],         // per-round deposits for chart
    forecast: 0,            // projected end total
    // Economy
    budget: STARTING_BUDGET, // generous turn-1 pool so player can buy initial assets at cost
    econ: E_INIT,          // E: accumulated economy score
    rdAccum: 0,            // R: accumulated R&D stock
    milScore: 1.0,         // M: accumulated military stock (1 = baseline)
    milStock: 1.0,         // alias kept for combat system compatibility
    alloc: { mil: 15, rd: 15, econ: 50, budget: 20 }, // % allocation sliders
  };
}

// ── Economy helpers ──────────────────────────────────────────────────────────
// Returns credits generated this round based on economy allocation
// ── New economy helpers ───────────────────────────────────────────────────────
// Budget = α * E
function calcBudget(econ) {
  return Math.round(ALPHA * (econ ?? E_INIT));
}
// Asset costs — fixed base costs (no longer allocation-dependent)
function calcAssetCosts(_alloc) {
  const costs = {}, maint = {};
  for (const k of Object.keys(BASE_ASSET_COSTS)) {
    costs[k] = BASE_ASSET_COSTS[k];
    maint[k]  = BASE_MAINT_COSTS[k];
  }
  return { costs, maint };
}
// Contentness: C = w1*√(E/E_max) + w2*√(T/T_max) + w3*√(M/M_max)
// T = asset points, T_max = highest asset points between players
// Weights sum to 1 so C ∈ [0,1]
function calcCompetitiveness(E, T, M, E_max, T_max, M_max) {
  return C_W1 * Math.sqrt(E  / Math.max(1, E_max))
       + C_W2 * Math.sqrt(T  / Math.max(1, T_max))
       + C_W3 * Math.sqrt(M  / Math.max(1, M_max));
}
// ΔE = I_E * √C * (1 + log(1+R))
function calcDeltaE(I_E, C, R) {
  return I_E * Math.sqrt(Math.max(0, C)) * (1 + Math.log1p(Math.max(0, R)));
}
// ΔR = I_R * √C − α_R * (1−C)²
function calcDeltaR(I_R, C) {
  return I_R * Math.sqrt(Math.max(0, C)) - ALPHA_R * Math.pow(1 - Math.max(0, C), 2);
}
// ΔM = I_M − α_M * M
function calcDeltaM(I_M, M) {
  return I_M - ALPHA_M * Math.max(0, M);
}
// R&D mine bonus (unchanged)
function calcRdMineBonus(rdAccum) {
  return 1 + (rdAccum / 200) * RD_MINE_BONUS;
}
// Military score from stock (unchanged interface)
function calcMilScore(milStock) {
  return Math.max(0.1, milStock / 20);
}

function activatePlayer(player) {
  if (!player || player.active) return player;
  return {
    ...player,
    active: true,
    assetPts: Math.max(player.assetPts ?? 0, ASSET_POINTS.rover),
    status: "idle",
  };
}

function getGeneratorOutput(generator, night) {
  if (generator.kind === "solar" && night) return 0;
  const px = Math.round(generator.y) * W + Math.round(generator.x);
  const illum = (px >= 0 && px < W * H) ? ILLUM_MAP[px] : 1.0;
  return generator.kind === "reactor" ? REACTOR_OUTPUT : PANEL_RIDGE * illum;
}

function allocateDailyPower(players, globalDay, sharedGrid=false) {
  const night = isNight(globalDay);
  const states = players.map((player, idx) => {
    if (!player || player.active === false || globalDay < (player.arrivalDay ?? 0)) return null;
    return {
      playerId: idx + 1,
      player: { ...player },
      habitatPower: [...(player.habitatPower || (player.habitats || []).map(() => HABITAT_POWER_INIT))],
      extraRovers: [...(player.extraRovers || [])],
      structureHealth: {
        panels:      [...(player.structureHealth?.panels      || (player.panels || []).map(() => 1.0))],
        reactors:    [...(player.structureHealth?.reactors    || (player.reactors || []).map(() => 1.0))],
        habitats:    [...(player.structureHealth?.habitats    || (player.habitats || []).map(() => 1.0))],
        extraRovers: [...(player.structureHealth?.extraRovers || (player.extraRovers || []).map(() => 1.0))],
        landingPads: [...(player.structureHealth?.landingPads || (player.landingPads || []).map(() => 1.0))],
      },
      generatorRangeEntries: { ...(player.generatorRangeEntries || {}) },
      generatorSupplyTotals: { ...(player.generatorSupplyTotals || {}) },
      generatorSupplyByRecipient: { 1: player.generatorSupplyByRecipient?.[1] || 0, 2: player.generatorSupplyByRecipient?.[2] || 0 },
    };
  });

  const allocateNetwork = (networkStates, networkTargets) => {
    const generators = networkStates.flatMap(state => ([
      ...(state.player.panels || []).map((panel, idx) => ({ ...panel, kind: "solar", idx, owner: state })),
      ...(state.player.reactors || []).map((reactor, idx) => ({ ...reactor, kind: "reactor", idx, owner: state })),
    ]));

    for (const generator of generators) {
      const healthKey = generator.kind === "reactor" ? "reactors" : "panels";
      if ((generator.owner.structureHealth[healthKey]?.[generator.idx] ?? 1.0) <= 0) continue;

      const output = getGeneratorOutput(generator, night);
      if (output <= 0) continue;

      const generatorId = `${generator.kind}-${generator.idx}`;
      const previousEntries = { ...(generator.owner.generatorRangeEntries[generatorId] || {}) };
      const currentEntries = {};
      const candidates = [];

      for (const target of networkTargets) {
        if (target.destroyed) continue;
        if (d2(generator, target) > SAFETY_RADIUS[generator.kind]) continue;

        const firstSeen = previousEntries[target.id] ?? globalDay;
        currentEntries[target.id] = firstSeen;

        const currentPower = target.getPower();
        if (currentPower >= target.capacity) continue;
        candidates.push({ target, currentPower, firstSeen });
      }

      generator.owner.generatorRangeEntries[generatorId] = currentEntries;
      if (!candidates.length) continue;

      candidates.sort((a, b) =>
        a.currentPower - b.currentPower
        || a.firstSeen - b.firstSeen
        || a.target.id.localeCompare(b.target.id)
      );

      const chosen = candidates[0];
      const supplied = Math.min(output, Math.max(0, chosen.target.capacity - chosen.currentPower));
      chosen.target.setPower(Math.min(chosen.target.capacity, chosen.currentPower + supplied));
      generator.owner.generatorSupplyTotals[generatorId] = (generator.owner.generatorSupplyTotals[generatorId] || 0) + supplied;
      const recipientId = Number(String(chosen.target.id || "").match(/^p(\d+)-/)?.[1] || generator.owner.playerId);
      generator.owner.generatorSupplyByRecipient[recipientId] = (generator.owner.generatorSupplyByRecipient[recipientId] || 0) + supplied;
    }
  };

  const buildTargets = (networkStates) => networkStates.flatMap(state => ([
    {
      id: `p${state.playerId}-rover-primary`,
      x: state.player.x,
      y: state.player.y,
      capacity: POWER_CAP,
      getPower: () => state.player.power ?? 0,
      setPower: (value) => { state.player.power = value; },
    },
    ...state.extraRovers.map((rover, idx) => ({
      id: `p${state.playerId}-rover-extra-${idx}`,
      x: rover.x,
      y: rover.y,
      capacity: POWER_CAP,
      getPower: () => state.extraRovers[idx].power ?? POWER_CAP,
      setPower: (value) => { state.extraRovers[idx] = { ...state.extraRovers[idx], power: value }; },
    })),
    ...(state.player.habitats || []).map((habitat, idx) => ({
      id: `p${state.playerId}-habitat-${idx}`,
      x: habitat.x,
      y: habitat.y,
      capacity: HABITAT_POWER_CAP,
      destroyed: (state.structureHealth.habitats[idx] ?? 1.0) <= 0,
      getPower: () => state.habitatPower[idx] ?? HABITAT_POWER_INIT,
      setPower: (value) => { state.habitatPower[idx] = value; },
    })),
  ]));

  if (sharedGrid) {
    const activeStates = states.filter(Boolean);
    allocateNetwork(activeStates, buildTargets(activeStates));
  } else {
    states.forEach(state => {
      if (!state) return;
      allocateNetwork([state], buildTargets([state]));
    });
  }

  states.forEach(state => {
    if (!state) return;
    for (let i = 0; i < (state.player.habitats || []).length; i++) {
      if ((state.structureHealth.habitats[i] ?? 1.0) <= 0) continue;
      state.habitatPower[i] = Math.max(0, Math.min(HABITAT_POWER_CAP, (state.habitatPower[i] ?? HABITAT_POWER_INIT) - HABITAT_POWER_DRAIN));
    }
  });

  return states.map((state, idx) => {
    if (!state) return players[idx];
    return {
      ...state.player,
      habitatPower: state.habitatPower,
      extraRovers: state.extraRovers,
      generatorRangeEntries: state.generatorRangeEntries,
      generatorSupplyTotals: state.generatorSupplyTotals,
      generatorSupplyByRecipient: state.generatorSupplyByRecipient,
    };
  });
}

// ── Simulation step (one day) ─────────────────────────────────────────────────
function simDay(s, craterHealth, globalDay, po={}) {
  if (s?.active === false || globalDay < (s?.arrivalDay ?? 0)) {
    return { ...s, status: "idle" };
  }
  // Physics values: use override if provided, else fall back to module constant
  const _ROVER_STEP       = po.ROVER_STEP       != null ? po.ROVER_STEP       : ROVER_STEP;
  const _POWER_MOVE_DRAIN = po.POWER_MOVE_DRAIN != null ? po.POWER_MOVE_DRAIN : POWER_MOVE_DRAIN;
  const _POWER_MINE_DRAIN = po.POWER_MINE_DRAIN != null ? po.POWER_MINE_DRAIN : POWER_MINE_DRAIN;
  const _BASE_MINE_RATE   = po.BASE_MINE_RATE   != null ? po.BASE_MINE_RATE   : BASE_MINE_RATE;
  const _DEPLETION_RATE   = po.DEPLETION_RATE   != null ? po.DEPLETION_RATE   : DEPLETION_RATE;

  let { x, y, power, ice, base, panels, reactors, habitats, pendingDeliveries, carrying, waypoints, currentWaypoint, mineMap } = s;
  let habitatPower = [...(s.habitatPower || (habitats||[]).map(() => HABITAT_POWER_INIT))];
  let structureHealth = {
    panels:      [...(s.structureHealth?.panels      || panels.map(() => 1.0))],
    reactors:    [...(s.structureHealth?.reactors    || (reactors||[]).map(() => 1.0))],
    habitats:    [...(s.structureHealth?.habitats    || habitats.map(() => 1.0))],
    extraRovers: [...(s.structureHealth?.extraRovers || (s.extraRovers||[]).map(() => 1.0))],
    landingPads: [...(s.structureHealth?.landingPads || (s.landingPads||[]).map(() => 1.0))],
  };
  x = Math.round(x); y = Math.round(y);
  pendingDeliveries = [...(pendingDeliveries||[])];
  reactors = [...(reactors||[])];

  const night = isNight(globalDay);

  // ── Per-panel power routing ──────────────────────────────────────────────
  // Each generator routes its output strictly by proximity:
  //   • Rover within generator radius → charge rover
  //   • Habitat within habitat radius → charge nearest habitat
  //   • Otherwise                     → no charge delivered this turn
  let roverChargePool = 0;
  const habitatChargePool = habitatPower.map(() => HABITAT_POWER_DRAIN); // cancel per-pass drain; daily charging/drain happens in allocateDailyPower
  const generators = [];

  for (const generator of generators) {
    if (generator.kind === "solar" && night) continue; // panels do not charge during lunar night
    // Power is now entirely illumination-driven during the day.
    const px = Math.round(generator.y) * W + Math.round(generator.x);
    const illum = (px >= 0 && px < W * H) ? ILLUM_MAP[px] : 1.0;
    const pwr = generator.kind === "reactor" ? REACTOR_OUTPUT : PANEL_RIDGE * illum;
    if (pwr <= 0) continue;
    const healthKey = generator.kind === "reactor" ? "reactors" : "panels";
    if ((structureHealth[healthKey]?.[generator.idx] ?? 1.0) <= 0) continue;

    const roverNear = d2({ x, y }, generator) <= SAFETY_RADIUS[generator.kind];

    // Find which habitat(s) this panel is in range of (use closest one)
    let closestHabIdx = -1, closestHabDist = Infinity;
    for (let hi = 0; hi < (habitats||[]).length; hi++) {
      if ((structureHealth.habitats[hi] ?? 1.0) <= 0) continue;
      const dist = d2(generator, habitats[hi]);
      if (dist <= SAFETY_RADIUS.habitat && dist < closestHabDist) {
        closestHabDist = dist;
        closestHabIdx = hi;
      }
    }

    const inHabitatZone = closestHabIdx >= 0;

    if (roverNear) {
      // Rover priority: fill rover first, overflow to habitat
      const roverDeficit = Math.max(0, POWER_CAP - (power + roverChargePool));
      const toRover = Math.min(pwr, roverDeficit);
      roverChargePool += toRover;
    } else if (inHabitatZone) {
      // Habitat priority: fill habitat first, overflow to rover
      const habDeficit = Math.max(0, HABITAT_POWER_CAP - (habitatPower[closestHabIdx] + habitatChargePool[closestHabIdx]));
      const toHab = Math.min(pwr, habDeficit);
      habitatChargePool[closestHabIdx] += toHab;
      // No proximity rules — goes to rover
    }
  }

  // Apply accumulated charges and daily drain to habitats
  for (let i = 0; i < (habitats||[]).length; i++) {
    if ((structureHealth.habitats[i] ?? 1.0) <= 0) continue;
    habitatPower[i] = Math.max(0, Math.min(HABITAT_POWER_CAP,
      (habitatPower[i] ?? HABITAT_POWER_INIT) + habitatChargePool[i] - HABITAT_POWER_DRAIN
    ));
  }
  power = Math.min(POWER_CAP, power + roverChargePool);

  const onPSR = PSR_MASK[y * W + x] === 1;
  const craterIdx = PIXEL_CRATER[y * W + x];

  let status = "idle";
  const events = [];

  // Deposit ice if rover is at any functional habitat (health > 0 AND power > 0)
  const habitatHealths = s.structureHealth?.habitats || [];
  const functionalHabitats = (habitats && habitats.length > 0)
    ? habitats.filter((_, i) => (habitatHealths[i] ?? 1.0) > 0 && (habitatPower[i] ?? HABITAT_POWER_INIT) > 0)
    : [];
  const atHabitat = functionalHabitats.some(h => d2({ x, y }, h) < ROVER_REACH);
  if (atHabitat && ice > 0) {
    const dep = ice; ice = 0;
    status = "depositing";
    events.push({ type: "deposit", kg: dep });
  }

  // Pick up from landing pad if rover is there, not already carrying, and pad health > 0
  let justPickedUp = false;
  if (!carrying) {
    const pads = s.landingPads || [];
    const padHealths = s.structureHealth?.landingPads || [];
    for (let pi2 = 0; pi2 < pads.length; pi2++) {
      const pad = pads[pi2];
      const padHealth = padHealths[pi2] ?? 1.0;
      if (padHealth <= 0) continue; // pad destroyed — can't use
      if (d2({ x, y }, pad) < ROVER_REACH) {
        const idx = pendingDeliveries.findIndex(d => d.padIdx === pi2 && d.type !== "rover");
        if (idx >= 0) {
          carrying = { ...pendingDeliveries[idx] };
          pendingDeliveries.splice(idx, 1);
          events.push({ type: "pickup", itemType: carrying.type });
          status = "carrying";
          justPickedUp = true;
          break;
        }
      }
    }
  }

  // Advance waypoint queue
  if (!currentWaypoint && waypoints.length > 0) {
    currentWaypoint = waypoints[0];
    waypoints = waypoints.slice(1);
  }
  const target = currentWaypoint || null;
  const dTgt = target ? d2({ x, y }, target) : Infinity;

  if (target && dTgt > ROVER_REACH) {
    const fromX = x, fromY = y;
    const step = stepToward({ x, y }, target, _ROVER_STEP);
    x = step.x; y = step.y;
    const distMoved = Math.hypot(x - fromX, y - fromY);
    const loadFactor = Math.min(3.0, 1.0 + (ice / 100) + (carrying ? 0.5 : 0));
    const moveCost = _POWER_MOVE_DRAIN * (distMoved / _ROVER_STEP) * loadFactor;
    power -= POWER_BASE_DRAIN + moveCost;
    status = carrying ? "carrying" : (status === "depositing" ? status : "moving");
  } else {
    x = Math.round(x); y = Math.round(y);
    if (currentWaypoint && d2({ x, y }, currentWaypoint) <= ROVER_REACH) {
      if (carrying && !justPickedUp) {
        events.push({ type: "place", itemType: carrying.type, x, y });
        const onRidge = RIDGE_MASK[y * W + x] === 1;
        if (carrying.type === "solar") {
          panels = [...panels, { x, y, onRidge }];
          structureHealth.panels = [...structureHealth.panels, 1.0];
        } else if (carrying.type === "reactor") {
          reactors = [...reactors, { x, y }];
          structureHealth.reactors = [...structureHealth.reactors, 1.0];
        } else if (carrying.type === "habitat") {
          habitats = [...(habitats||[]), { x, y }];
          structureHealth.habitats = [...structureHealth.habitats, 1.0];
          habitatPower = [...habitatPower, HABITAT_POWER_INIT];
        } else if (carrying.type === "rover") {
          s = { ...s, extraRovers: [...(s.extraRovers||[]), { x, y }] };
          structureHealth.extraRovers = [...structureHealth.extraRovers, 1.0];
        } else if (carrying.type === "pad") {
          s = { ...s, landingPads: [...(s.landingPads||[]), { x, y }] };
          structureHealth.landingPads = [...structureHealth.landingPads, 1.0];
        }
        carrying = null;
      }
      currentWaypoint = waypoints.length > 0 ? waypoints[0] : null;
      if (waypoints.length > 0) waypoints = waypoints.slice(1);
    }

    if (onPSR && craterIdx >= 0 && power > 0) {
      const health = craterHealth[craterIdx] ?? 1.0;
      const quality = CRATER_DATA[craterIdx]?.quality ?? 0.5;
      const craterSize = CRATER_DATA[craterIdx]?.size ?? CRATER_REFERENCE_SIZE;
      const rdBonus = calcRdMineBonus(s.rdAccum ?? 0);
      const effectiveMine = Math.min(_BASE_MINE_RATE * quality * health * rdBonus, ICE_CAP - ice);
      if (effectiveMine > 0) {
        ice += effectiveMine;
        power -= POWER_BASE_DRAIN + _POWER_MINE_DRAIN;
        status = "mining";
        const idx2 = y * W + x;
        mineMap = { ...mineMap, [idx2]: (mineMap[idx2] || 0) + effectiveMine };
        const sizeFactor = CRATER_REFERENCE_SIZE / craterSize;
        craterHealth[craterIdx] = Math.max(0, health - _DEPLETION_RATE * sizeFactor * effectiveMine);
        events.push({ type: "mine", kg: effectiveMine, craterIdx });
      } else {
        status = carrying ? "carrying" : (status === "depositing" ? status : "depleted");
        power -= POWER_BASE_DRAIN;
      }
    } else {
      power -= POWER_BASE_DRAIN;
      if (status !== "depositing" && !carrying) status = onPSR ? "idle" : "idle_nopsr";
      else if (carrying) status = "carrying";
    }
  }

  power = Math.max(0, power);
  return { ...s, x: Math.round(x), y: Math.round(y), power, ice, panels, reactors, habitats, habitatPower, pendingDeliveries, carrying, waypoints, currentWaypoint, mineMap, status, events, structureHealth };
}

// ── Claim map ─────────────────────────────────────────────────────────────────
function computeClaims(p1, p2, r1, r2) {
  const c = new Int8Array(W * H);
  const p1Active = p1?.active !== false;
  const p2Active = p2?.active !== false;
  for (let i = 0; i < W * H; i++) { if (!PSR_MASK[i]) continue;
    const px = i % W, py = (i / W) | 0;
    const d1 = p1Active ? Math.sqrt((px - p1.x) ** 2 + (py - p1.y) ** 2) : Infinity;
    const d2_ = p2Active ? Math.sqrt((px - p2.x) ** 2 + (py - p2.y) ** 2) : Infinity;
    const in1 = d1 <= r1, in2 = d2_ <= r2;
    if (in1 && in2) c[i] = d1 < d2_ ? 1 : 2;
    else if (in1) c[i] = 1;
    else if (in2) c[i] = 2;
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
const PHASE = { SETTINGS:"settings", BATCH:"batch", SETUP1:"s1", SETUP1_HAB:"s1h", SETUP1_SOL:"s1s", SETUP1_PAD:"s1p", SETUP2:"s2", SETUP2_HAB:"s2h", SETUP2_SOL:"s2s", SETUP2_PAD:"s2p", PLAYING:"play", DONE:"done" };
const STATUS_INFO = {
  moving:    { icon:"🚗", label:"Moving",    col:"#ffd040" },
  mining:    { icon:"⛏",  label:"Mining",    col:"#40e0ff" },
  returning: { icon:"↩",  label:"Returning", col:"#ff8860" },
  depositing:{ icon:"📦", label:"Depositing",col:"#80ff90" },
  carrying:  { icon:"🚚", label:"Carrying",  col:"#ffaa44" },
  depleted:  { icon:"⚠",  label:"Depleted",  col:"#ff6020" },
  idle:      { icon:"·",  label:"Idle",       col:"#446070" },
  idle_nopsr:{ icon:"⚠",  label:"Off-PSR",   col:"#ff7040" },
};

export default function App() {
  const canvasRef = useRef(null);
  const mapRef    = useRef(null);
  const illumRef  = useRef(null);
  const liveTimelineKeyRef = useRef("");
  const gifSavedSnapshotRef = useRef(null);
  const saveFileInputRef = useRef(null);
  const plotCanvasRefs = useRef({});
  const [mapLoaded, setMapLoaded] = useState(false);
  const [illumLoaded, setIllumLoaded] = useState(false);
  const [dataReady, setDataReady] = useState(false);

  // Settings
  const [totalRounds, setTotalRounds] = useState(12);
  const [missionEndMode, setMissionEndMode] = useState("fixed");
  const [scenarioPreset, setScenarioPreset] = useState("standard");
  const [arrivalDelay, setArrivalDelay] = useState(5);
  const [gridSharingEnabled, setGridSharingEnabled] = useState(true);
  const [gridSharingPermanent, setGridSharingPermanent] = useState(false);

  // ── Tool-mode features ────────────────────────────────────────────────────
  const [simMode, setSimMode]         = useState("competitive"); // "competitive" | "solo" | "analysis"
  const [autoAdvance, setAutoAdvance] = useState(false);         // auto-step turns
  const [autoSpeed, setAutoSpeed]     = useState(800);           // ms per turn
  const [missionLog, setMissionLog]   = useState([]);            // full structured event log
  const [annotations, setAnnotations] = useState([]);            // { x, y, label, color, ts }
  const [annotating, setAnnotating]   = useState(false);         // annotation placement mode
  const [annotNote, setAnnotNote]     = useState("");            // pending annotation text
  const [showLog, setShowLog]         = useState(false);         // mission log panel open
  const [showParams, setShowParams]   = useState(false);         // physics params panel open
  const [showAnalytics, setShowAnalytics] = useState(false);     // analytics panel open
  // Live-editable physics overrides (null = use constant)
  const [physOverrides, setPhysOverrides] = useState({});
  // Helper to get a physics value, respecting overrides
  const phys = (key, defaultVal) => physOverrides[key] != null ? physOverrides[key] : defaultVal;

  // Game state
  const [phase, setPhase]         = useState(PHASE.SETTINGS);
  const [p1, setP1]               = useState(null);
  const [p2, setP2]               = useState(null);
  const [craterHealth, setCraterHealth] = useState(() => new Float32Array(CRATER_DATA.length).fill(1.0));
  const [round, setRound]         = useState(1);
  const [day, setDay]             = useState(0);       // 0..DAYS_PER_ROUND-1
  const [globalDay, setGlobalDay] = useState(0);
  const [history, setHistory]     = useState([]);
  const [claimR, setClaimR]       = useState([80, 80]);
  const [hover, setHover]         = useState(null);
  const [showLayers, setShowLayers] = useState({ mine:true, claims:true, craters:true, night:true });

  // Turn-based state
  // activeTurn: 0 = P1's turn to plan, 1 = P2's turn to plan
  // "planning" = player setting their waypoint/action
  // After both players have ended their turn for a day, we advance globalDay
  const [activeTurn, setActiveTurn]   = useState(0);   // whose turn it is to plan
  const [p1Done, setP1Done]           = useState(false); // P1 confirmed their action this step
  const [p2Done, setP2Done]           = useState(false); // P2 confirmed their action this step
  const [selectingFor, setSelectingFor] = useState(null); // null | 0 | 1
  const [placingFor, setPlacingFor]   = useState(null); // null | 0 | 1 — turn-1 manual placement
  const [placingType, setPlacingType] = useState(null); // 'solar' | 'reactor' | 'habitat' | 'pad'
  const [selectedRover, setSelectedRover] = useState([0, 0]); // per-player: 0=primary, 1+=extra rover index
  const [addingWaypoint, setAddingWaypoint] = useState(false);
  const [lastEvents, setLastEvents]     = useState([]);   // events from last step for toast display
  const [selectedBuild, setSelectedBuild] = useState([null, null]); // per-player selected build type
  const [selectedDiplomacy, setSelectedDiplomacy] = useState([null, null]); // per-player grid-sharing action
  const [selectedPad, setSelectedPad]     = useState([0, 0]);       // per-player selected landing pad index
  const [mapLayer, setMapLayer]           = useState("base");        // active map overlay
  const [powerGridState, setPowerGridState] = useState({ mode:"independent", offeredBy:null, offeredTo:null });
  const [batchRunCount, setBatchRunCount] = useState(100);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ completed:0, total:100, currentSeed:null });
  const [batchResult, setBatchResult] = useState(null);
  const [replayRun, setReplayRun] = useState(null);
  const [replayFrameIndex, setReplayFrameIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [liveTimeline, setLiveTimeline] = useState([]);
  const [gifExporting, setGifExporting] = useState(false);
  const [showPlots, setShowPlots] = useState(false);
  const [separatePlotsOpen, setSeparatePlotsOpen] = useState({});
  const [undoStack, setUndoStack] = useState([]);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => { mapRef.current = img; setMapLoaded(true); };
    img.src = MAP_SRC;
  }, []);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => { illumRef.current = img; setIllumLoaded(true); };
    img.src = ILLUMINATION_SRC;
  }, []);

  useEffect(() => {
    loadMapData().then(() => {
      setCraterHealth(new Float32Array(CRATER_DATA.length).fill(1.0));
      setDataReady(true);
    });
  }, []);

  // ── Auto-advance: when enabled, automatically end both players' turns ────
  useEffect(() => {
    if (!autoAdvance || phase !== PHASE.PLAYING) return;
    if (p1Done && p2Done) return; // resolution in progress

    const delay = simMode === "analysis" ? autoSpeed : autoSpeed;
    const timer = setTimeout(() => {
      if (!p1Done) endTurn(0);
      if (!p2Done) endTurn(1);
    }, delay);
    return () => clearTimeout(timer);
  }, [autoAdvance, phase, p1Done, p2Done, simMode, autoSpeed]);

  // In solo mode: auto-end P2's turn immediately after P1 confirms
  useEffect(() => {
    if (simMode !== "solo" || !p1Done || p2Done || phase !== PHASE.PLAYING) return;
    // Auto-commit P2 with no waypoint change (stay and mine)
    const timer = setTimeout(() => endTurn(1), 120);
    return () => clearTimeout(timer);
  }, [simMode, p1Done, p2Done, phase]);

  useEffect(() => {
    if (scenarioPreset !== "unevenArrival" || phase !== PHASE.PLAYING || p2 || globalDay < arrivalDelay) return;
    setPhase(PHASE.SETUP2);
    setP1Done(false);
    setP2Done(false);
    setActiveTurn(1);
  }, [scenarioPreset, phase, p2, globalDay, arrivalDelay]);

  // ── Mission log: append structured log entries on each day resolution ────
  useEffect(() => {
    if (phase !== PHASE.PLAYING || lastEvents.length === 0) return;
    const ts = `R${round}D${day}`;
    const entries = lastEvents.map(ev => ({
      ts, round, day, globalDay,
      type: ev.type,
      actor: ev.actor,
      roverId: ev.roverId,
      kg: ev.kg,
      craterIdx: ev.craterIdx,
      itemType: ev.itemType,
      x: ev.x,
      y: ev.y,
      label:
        ev.type === "mine" ? `Ice mined: ${Number(ev.kg || 0).toFixed(1)} kg from crater ${ev.craterIdx ?? "?"}` :
        ev.type === "deposit" ? `Ice deposited: ${Number(ev.kg || 0).toFixed(1)} kg scored at a powered habitat` :
        ev.type === "pickup" ? `${structureLabel(ev.itemType)} picked up from a landing pad` :
        ev.type === "place" ? `${structureLabel(ev.itemType)} placed at (${Math.round(ev.x ?? 0)}, ${Math.round(ev.y ?? 0)})` :
        undefined,
    }));
    setMissionLog(prev => [...prev, ...entries]);
  }, [lastEvents]);

  useEffect(() => {
    if (!replayRun || !replayPlaying) return;
    if (replayFrameIndex >= (replayRun.frames?.length ?? 1) - 1) {
      setReplayPlaying(false);
      return;
    }
    const timer = setTimeout(() => loadReplayFrame(replayRun, replayFrameIndex + 1), 420);
    return () => clearTimeout(timer);
  }, [replayRun, replayPlaying, replayFrameIndex]);

  useEffect(() => {
    if (!mapLoaded || replayRun || batchRunning || gifExporting || !p1) return;
    if (phase !== PHASE.PLAYING && phase !== PHASE.DONE) return;
    const key = [
      phase, round, day, globalDay, missionLog.length,
      p1Done ? 1 : 0, p2Done ? 1 : 0, !!p2 ? 1 : 0,
      powerGridState.mode, powerGridState.offeredBy ?? "-", powerGridState.offeredTo ?? "-",
    ].join("|");
    if (liveTimelineKeyRef.current === key) return;
    liveTimelineKeyRef.current = key;
    setLiveTimeline(prev => {
      if (prev.length && prev[prev.length - 1]?.__key === key) return prev;
      const frame = { ...snapshotLiveFrame(), __key: key };
      return [...prev, frame];
    });
  }, [
    mapLoaded, replayRun, batchRunning, gifExporting, p1, p2, phase,
    round, day, globalDay, missionLog.length, p1Done, p2Done, powerGridState,
  ]);

  // ── Canvas rendering ─────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapLoaded) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(mapRef.current, 0, 0, W, H);

    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;
    const night = showLayers.night && isNight(globalDay);

    for (let i = 0; i < W * H; i++) { if (!PSR_MASK[i]) continue;
      const pi = i * 4;
      const ci = PIXEL_CRATER[i];
      const health = ci >= 0 ? (craterHealth[ci] ?? 1.0) : 1.0;
      const r = Math.round(lerp(120, 5, health));
      const g = Math.round(lerp(40, 25, health));
      const b = Math.round(lerp(10, 45, health));
      d[pi]   = Math.round(d[pi]   * 0.25 + r);
      d[pi+1] = Math.round(d[pi+1] * 0.25 + g);
      d[pi+2] = Math.round(d[pi+2] * 0.25 + b);
    }

    if (showLayers.claims && p1 && p2) {
      const claims = computeClaims(p1, p2, claimR[0], claimR[1]);
      for (let i = 0; i < W * H; i++) {
        if (!claims[i] || !PSR_MASK[i]) continue;
        const pi = i * 4;
        if (claims[i] === 1) { d[pi] = Math.min(255, d[pi]+50); d[pi+1] = Math.min(255, d[pi+1]+30); }
        else                 { d[pi] = Math.min(255, d[pi]+30); d[pi+2] = Math.min(255, d[pi+2]+60); }
      }
    }

    if (showLayers.mine) {
      for (const p of [p1, p2]) {
        if (!p || p.active === false) continue;
        const col = p.id === 1 ? [255,195,0] : [155,0,255];
        const entries = Object.entries(p.mineMap);
        if (!entries.length) continue;
        const maxVal = Math.max(...entries.map(([,v]) => v));
        for (const [idxStr, amt] of entries) {
          const idx = parseInt(idxStr);
          const frac = clamp(amt / maxVal, 0, 1);
          const pi = idx * 4;
          d[pi]   = Math.min(255, Math.round(d[pi]   * (1-frac*0.7) + col[0]*frac*0.9));
          d[pi+1] = Math.min(255, Math.round(d[pi+1] * (1-frac*0.7) + col[1]*frac*0.9));
          d[pi+2] = Math.min(255, Math.round(d[pi+2] * (1-frac*0.7) + col[2]*frac*0.9));
        }
      }
    }

    if (night) {
      for (let i = 0; i < W * H; i++) {
        if (RIDGE_MASK[i]) continue;
        const pi = i * 4;
        d[pi]   = Math.round(d[pi]   * 0.4);
        d[pi+1] = Math.round(d[pi+1] * 0.4);
        d[pi+2] = Math.round(d[pi+2] * 0.45);
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Ridge glow
    for (let i = 0; i < W * H; i++) { if (!RIDGE_MASK[i]) continue;
      const x = i % W, y = (i / W) | 0;
      ctx.fillStyle = night ? "rgba(255,230,40,0.22)" : "rgba(255,230,40,0.10)";
      ctx.fillRect(x, y, 1, 1);
    }

    // Crater badges
    if (showLayers.craters) {
      CRATER_DATA.forEach((c, ci) => {
        const h = craterHealth[ci] ?? 1.0;
        if (h > 0.95) return;
        const col = h > 0.6 ? "#88ffcc" : h > 0.3 ? "#ffcc44" : "#ff5533";
        ctx.beginPath();
        ctx.arc(c.cx, c.cy, 5, 0, Math.PI*2);
        ctx.fillStyle = col + "cc"; ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(c.cx-8, c.cy+7, 16, 3);
        ctx.fillStyle = col;
        ctx.fillRect(c.cx-8, c.cy+7, Math.round(16*h), 3);
      });
    }

    // Helper: draw health bar above a structure
    const drawHealthBar = (ctx, health, width=14) => {
      const col = health > 0.6 ? "#44ff88" : health > 0.3 ? "#ffcc44" : "#ff4444";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(-width/2, -12, width, 4);
      ctx.fillStyle = col;
      ctx.fillRect(-width/2, -12, width * Math.max(0, health), 4);
    };

    // Safety zone circles (drawn first, behind everything)
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      const sh = p.structureHealth || {};
      const structList = [
        { list: p.panels||[],       type:'solar',   key:'panels' },
        { list: p.reactors||[],     type:'reactor', key:'reactors' },
        { list: p.habitats||[],     type:'habitat', key:'habitats' },
        { list: p.landingPads||[], type:'pad',     key:'landingPads' },
      ];
      for (const { list, type, key } of structList) {
        list.forEach((s, idx) => {
          const health = (sh[key] && sh[key][idx] != null) ? sh[key][idx] : 1.0;
          const r = SAFETY_RADIUS[type];
          ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2);
          const alpha = health > 0.6 ? "18" : health > 0.3 ? "28" : "38";
          ctx.fillStyle = p.color + alpha;
          ctx.fill();
          ctx.strokeStyle = p.color + "33";
          ctx.lineWidth = 0.5;
          ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]);
        });
      }
    }

    // Solar panels
    // Draw faint lines from panels that are in a habitat's safety zone to that habitat
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      p.panels.forEach((pn) => {
        let closestHab = null, closestDist = Infinity;
        for (const h of (p.habitats||[])) {
          const dist = d2(pn, h);
          if (dist <= SAFETY_RADIUS.habitat && dist < closestDist) {
            closestDist = dist; closestHab = h;
          }
        }
        if (!closestHab) return;
        const active = !night && (ILLUM_MAP[pn.y * W + pn.x] || 0) > 0.05;
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = active ? p.color + "55" : p.color + "22";
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(pn.x, pn.y); ctx.lineTo(closestHab.x, closestHab.y);
        ctx.stroke();
        ctx.restore();
      });
    }

    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      p.panels.forEach((pn, idx) => {
        const health = p.structureHealth?.panels?.[idx] ?? 1.0;
        const active = !night && (ILLUM_MAP[pn.y * W + pn.x] || 0) > 0.05;
        ctx.save(); ctx.translate(pn.x, pn.y);
        ctx.fillStyle = pn.onRidge ? (active?"rgba(255,235,50,0.95)":"rgba(180,160,20,0.7)") : (active?"rgba(190,190,60,0.9)":"rgba(80,80,40,0.6)");
        ctx.fillRect(-5,-5,10,10);
        ctx.strokeStyle = active ? p.color : p.color+"66";
        ctx.lineWidth=1.5; ctx.strokeRect(-5,-5,10,10);
        ctx.strokeStyle = p.color + (active?"cc":"44");
        ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(-4,0); ctx.lineTo(4,0); ctx.moveTo(0,-4); ctx.lineTo(0,4); ctx.stroke();
        if (pn.onRidge) {
          ctx.fillStyle = active ? "#ffee44" : "#666633";
          ctx.font="7px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
          ctx.fillText("★",0,-6);
        }
        if (health < 0.99) drawHealthBar(ctx, health);
        ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 2;
        ctx.fillStyle = "#ffffff"; ctx.font = "bold 8px monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(String(idx + 1), 0, pn.onRidge ? -22 : -17);
        ctx.shadowBlur = 0;
        ctx.restore();
      });
    }

    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      (p.reactors||[]).forEach((rx, idx) => {
        const health = p.structureHealth?.reactors?.[idx] ?? 1.0;
        const destroyed = health <= 0;
        ctx.save(); ctx.translate(rx.x, rx.y);
        ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI*2);
        ctx.fillStyle = destroyed ? "#333333cc" : p.color + "cc";
        ctx.fill();
        ctx.strokeStyle = destroyed ? "#555" : "#000";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = destroyed ? "#888" : "#000";
        ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("☢", 0, 0);
        if (health < 0.99) drawHealthBar(ctx, health, 18);
        ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 2;
        ctx.fillStyle = "#ffffff"; ctx.font = "bold 8px monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(String(idx + 1), 0, -17);
        ctx.shadowBlur = 0;
        ctx.restore();
      });
    }

    // Habitats
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      (p.habitats||[]).forEach((h, idx) => {
        const health = p.structureHealth?.habitats?.[idx] ?? 1.0;
        const hPwr   = (p.habitatPower ?? [])[idx] ?? HABITAT_POWER_INIT;
        const destroyed = health <= 0;
        const unpowered = !destroyed && hPwr <= 0;
        ctx.save(); ctx.translate(h.x, h.y);
        ctx.fillStyle = destroyed ? "#333333cc" : unpowered ? "#884400cc" : p.color + "cc";
        ctx.beginPath();
        ctx.moveTo(-7, 5); ctx.lineTo(7, 5); ctx.lineTo(7, -1); ctx.lineTo(0, -7); ctx.lineTo(-7, -1); ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = destroyed ? "#555" : unpowered ? "#ff8800" : "#000"; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = destroyed ? "#888" : "#000"; ctx.font = "6px monospace"; ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.fillText(destroyed ? "X" : unpowered ? "!" : "H", 0, 0);
        if (!destroyed && health < 0.99) drawHealthBar(ctx, health);
        ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 2;
        ctx.fillStyle = "#ffffff"; ctx.font = "bold 8px monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(String(idx + 1), 0, -17);
        ctx.shadowBlur = 0;
        // Power bar below habitat
        if (!destroyed) {
          const barW = 14, barH = 2, barX = -7, barY = 7;
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(barX, barY, barW, barH);
          const pwrFrac = Math.max(0, hPwr / HABITAT_POWER_CAP);
          ctx.fillStyle = pwrFrac > 0.4 ? "#44ff88" : pwrFrac > 0.15 ? "#ffcc44" : "#ff4444";
          ctx.fillRect(barX, barY, barW * pwrFrac, barH);
        }
        ctx.restore();
      });
    }

    // Extra rovers
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      (p.extraRovers||[]).forEach((r, idx) => {
        const health = p.structureHealth?.extraRovers?.[idx] ?? 1.0;
        const erSi = STATUS_INFO[r.status] || STATUS_INFO.idle;
        ctx.save(); ctx.translate(r.x, r.y);
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI*2);
        ctx.fillStyle = p.color; ctx.fill();
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = "#000"; ctx.font = "bold 8px monospace"; ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.fillText(`${idx+2}`, 0, 0);
        // Status icon
        ctx.font="10px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
        ctx.fillText(erSi.icon, 0, -9);
        // Ice bubble
        if ((r.ice??0) > 5) {
          ctx.fillStyle="rgba(3,8,20,0.85)"; ctx.fillRect(7,-18,38,11);
          ctx.fillStyle="#88ccff"; ctx.font="7px monospace"; ctx.textAlign="left"; ctx.textBaseline="top";
          ctx.fillText(`❄${(r.ice??0).toFixed(0)}`, 9, -17);
        }
        // Carrying bubble
        if (r.carrying) {
          const icons = { solar:"☀", reactor:"☢", habitat:"🏠", rover:"🚗", pad:"🛬" };
          ctx.fillStyle="rgba(3,8,20,0.85)"; ctx.fillRect(-18,-30,36,12);
          ctx.fillStyle="#ffaa44"; ctx.font="7px monospace"; ctx.textAlign="center"; ctx.textBaseline="middle";
          ctx.fillText((icons[r.carrying.type]||"?")+" CARGO", 0, -24);
        }
        if (health < 0.99) drawHealthBar(ctx, health);
        ctx.restore();
      });
    }

    // Landing pads — with pending delivery badges and health bar
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      (p.landingPads||[]).forEach((lp, lpIdx) => {
        const health = p.structureHealth?.landingPads?.[lpIdx] ?? 1.0;
        const destroyed = health <= 0;
        ctx.save(); ctx.translate(lp.x, lp.y);
        ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI*2);
        ctx.fillStyle = destroyed ? "rgba(30,30,30,0.6)" : p.color + "22"; ctx.fill();
        ctx.strokeStyle = destroyed ? "#444" : p.color + "cc"; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.strokeStyle = destroyed ? "#333" : p.color + "88"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-9,0); ctx.lineTo(9,0); ctx.moveTo(0,-9); ctx.lineTo(0,9); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI*2);
        ctx.fillStyle = destroyed ? "#444" : p.color + "cc"; ctx.fill();
        if (destroyed) {
          ctx.strokeStyle = "#ff444488"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(-6,-6); ctx.lineTo(6,6); ctx.moveTo(6,-6); ctx.lineTo(-6,6); ctx.stroke();
        } else {
          const pending = (p.pendingDeliveries||[]).filter(d => d.padIdx === lpIdx);
          if (pending.length > 0) {
            const icons = { solar:"*", reactor:"☢", habitat:"H", rover:"R", pad:"P" };
            ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
            pending.forEach((d, i) => {
              ctx.fillStyle = "rgba(3,8,18,0.85)";
              ctx.fillRect(-7, -26 - i*11, 14, 10);
              ctx.fillStyle = "#ffcc44";
              ctx.fillText(icons[d.type]||"?", 0, -17 - i*11);
            });
            ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI*2);
            ctx.strokeStyle = "#ffcc4466"; ctx.lineWidth = 1.5;
            ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
          }
          if (health < 0.99) drawHealthBar(ctx, health, 18);
        }
        ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 2;
        ctx.fillStyle = "#ffffff"; ctx.font = "bold 8px monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(String(lpIdx + 1), 0, 13);
        ctx.shadowBlur = 0;
        ctx.restore();
      });
    }

    for (let pi2 = 0; pi2 < 2; pi2++) {
      const p = pi2 === 0 ? p1 : p2;
      if (!p || p.active === false) continue;

      // Primary rover waypoints
      const wps = [p.currentWaypoint, ...(p.waypoints||[])].filter(Boolean);
      if (wps.length) {
        ctx.save();
        ctx.strokeStyle = p.color + "55"; ctx.lineWidth=1.5; ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        for (const wp of wps) ctx.lineTo(wp.x, wp.y);
        ctx.stroke(); ctx.setLineDash([]);
        wps.forEach((wp, wi) => {
          ctx.beginPath(); ctx.arc(wp.x, wp.y, wi===0?6:4, 0, Math.PI*2);
          ctx.strokeStyle = p.color + (wi===0?"cc":"77"); ctx.lineWidth=1.5; ctx.stroke();
          ctx.fillStyle = p.color + (wi===0?"44":"22"); ctx.fill();
          if (wi===0) {
            ctx.beginPath(); ctx.moveTo(wp.x-5,wp.y); ctx.lineTo(wp.x+5,wp.y);
            ctx.moveTo(wp.x,wp.y-5); ctx.lineTo(wp.x,wp.y+5);
            ctx.strokeStyle = p.color+"aa"; ctx.stroke();
          }
        });
        ctx.restore();
      }

      // Extra rover waypoints
      (p.extraRovers||[]).forEach(er => {
        const erWps = [er.currentWaypoint, ...(er.waypoints||[])].filter(Boolean);
        if (!erWps.length) return;
        ctx.save();
        ctx.strokeStyle = p.color + "44"; ctx.lineWidth=1.2; ctx.setLineDash([3,4]);
        ctx.beginPath(); ctx.moveTo(er.x, er.y);
        for (const wp of erWps) ctx.lineTo(wp.x, wp.y);
        ctx.stroke(); ctx.setLineDash([]);
        erWps.forEach((wp, wi) => {
          ctx.beginPath(); ctx.arc(wp.x, wp.y, wi===0?5:3, 0, Math.PI*2);
          ctx.strokeStyle = p.color + (wi===0?"bb":"66"); ctx.lineWidth=1.2; ctx.stroke();
          ctx.fillStyle = p.color + "22"; ctx.fill();
        });
        ctx.restore();
      });
    }

    // (no auto-return trails)

    // Hover tooltip
    if (hover && selectingFor !== null) {
      const sp = selectingFor===0 ? p1 : p2;
      if (sp) {
        const dist = d2(sp, hover).toFixed(0);
        const ci = PIXEL_CRATER[hover.y*W+hover.x];
        const onPSR = PSR_MASK[hover.y*W+hover.x];
        const onRidgeH = RIDGE_MASK[hover.y*W+hover.x];
        ctx.save();
        ctx.fillStyle = "rgba(2,5,14,0.93)";
        const ttW = 80, ttH = 30;
        const ttX = hover.x+8, ttY = hover.y-ttH-4;
        ctx.fillRect(ttX, ttY, ttW, ttH);
        ctx.strokeStyle = sp.color+"55"; ctx.lineWidth = 0.8;
        ctx.strokeRect(ttX, ttY, ttW, ttH);
        ctx.fillStyle = "#6a8fa8"; ctx.font="7px 'JetBrains Mono',monospace";
        ctx.textAlign="left"; ctx.textBaseline="top";
        ctx.fillText(`dist: ${dist}px`, ttX+4, ttY+4);
        if (onPSR && ci>=0) {
          const h=(craterHealth[ci]??1.0);
          ctx.fillStyle = h>0.5?"#33cc99":h>0.2?"#ccaa33":"#cc4422";
          ctx.fillText(`crater: ${(h*100).toFixed(0)}%${onRidgeH?" ★":""}`, ttX+4, ttY+15);
        } else if (onPSR) {
          ctx.fillStyle="#2a5070"; ctx.fillText(`PSR${onRidgeH?" ★":""}`,ttX+4,ttY+15);
        } else {
          ctx.fillStyle="#3a4a55"; ctx.fillText("off-PSR",ttX+4,ttY+15);
        }
        ctx.restore();
      }
    }

    // Rovers
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      const si = STATUS_INFO[p.status] || STATUS_INFO.idle;

      // Turn indicator ring — drawn around the currently selected rover
      const isActive = (activeTurn===0 && p.id===1) || (activeTurn===1 && p.id===2);
      const isDone   = (p.id===1 && p1Done) || (p.id===2 && p2Done);
      if (phase===PHASE.PLAYING) {
        const selIdx = selectedRover[p.id - 1] ?? 0;
        const selRover = selIdx === 0 ? p : (p.extraRovers||[])[selIdx - 1];
        const rx = selRover?.x ?? p.x;
        const ry = selRover?.y ?? p.y;
        ctx.beginPath(); ctx.arc(rx, ry, 14, 0, Math.PI*2);
        ctx.strokeStyle = isDone ? "#44ff66cc" : p.color+"cc";
        ctx.lineWidth = isDone ? 1.5 : isActive ? 2 : 1.5;
        ctx.stroke();
      }

      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI*2);
      ctx.fillStyle = p.color; ctx.fill();
      ctx.strokeStyle="#000"; ctx.lineWidth=1.5; ctx.stroke();
      ctx.fillStyle="#000"; ctx.font="bold 8px monospace";
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText("1", p.x, p.y);

      // Status icon above
      ctx.font="10px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
      ctx.fillText(si.icon, p.x, p.y-9);

      // Ice bubble
      if (p.ice > 5) {
        ctx.fillStyle="rgba(3,8,20,0.85)"; ctx.fillRect(p.x+9,p.y-20,44,13);
        ctx.fillStyle="#88ccff"; ctx.font="8px monospace"; ctx.textAlign="left";
        ctx.fillText("❄"+p.ice.toFixed(0)+"kg", p.x+11, p.y-13);
      }

      // Carrying badge
      if (p.carrying) {
        const icons = { solar:"☀", reactor:"☢", habitat:"🏠", rover:"🚗", pad:"🛬" };
        ctx.fillStyle="rgba(255,170,40,0.92)"; ctx.fillRect(p.x-14,p.y-32,28,11);
        ctx.fillStyle="#000"; ctx.font="bold 7px monospace"; ctx.textAlign="center"; ctx.textBaseline="top";
        ctx.fillText((icons[p.carrying.type]||"?")+" CARGO", p.x, p.y-31);
      }

      // Power dot
      const pwrFrac = p.power/POWER_CAP;
      const pwrCol = pwrFrac>0.4?"#88ff44":pwrFrac>0.18?"#ffdd00":"#ff4444";
      ctx.beginPath(); ctx.arc(p.x+9,p.y+9,4,0,Math.PI*2);
      ctx.fillStyle=pwrCol; ctx.fill();
      ctx.strokeStyle="#000"; ctx.lineWidth=0.5; ctx.stroke();
    }

    // Rover safety zones (drawn after sprites so they appear on top as visible rings)
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      const sh = p.structureHealth || {};
      const drawRoverZone = (cx, cy, health) => {
        const r = SAFETY_RADIUS.rover;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
        const alpha = health > 0.6 ? "18" : health > 0.3 ? "28" : "38";
        ctx.fillStyle = p.color + alpha;
        ctx.fill();
        ctx.strokeStyle = p.color + "55";
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
      };
      const primaryHealth = 1.0;
      drawRoverZone(p.x, p.y, primaryHealth);
      (p.extraRovers||[]).forEach((er, idx) => {
        const health = sh.extraRovers?.[idx] ?? 1.0;
        drawRoverZone(er.x, er.y, health);
      });
    }

    // ── Power-in-range ⚡ indicators on consumer safety rings ─────────────
    {
      const physNight = isNight(globalDay);
      // Gather every functional generator across both players
      const generators = [];
      for (const gp of [p1, p2]) {
        if (!gp || gp.active === false) continue;
        (gp.panels || []).forEach((pn, idx) => {
          if ((gp.structureHealth?.panels?.[idx] ?? 1.0) <= 0) return;
          if (physNight && (ILLUM_MAP[pn.y * W + pn.x] || 0) < 0.05) return;
          generators.push({ x: pn.x, y: pn.y, range: SAFETY_RADIUS.solar });
        });
        (gp.reactors || []).forEach((rx, idx) => {
          if ((gp.structureHealth?.reactors?.[idx] ?? 1.0) <= 0) return;
          generators.push({ x: rx.x, y: rx.y, range: SAFETY_RADIUS.reactor });
        });
      }
      const inPowerRange = (cx, cy) =>
        generators.some(g => d2({ x: cx, y: cy }, g) <= g.range);

      const drawPowerBolt = (cx, cy, ringR) => {
        const arm = Math.max(ringR, 14) * 0.707;
        ctx.save();
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(inPowerRange(cx, cy) ? "⚡" : "🔋", cx - arm, cy - arm);
        ctx.restore();
      };

      for (const p of [p1, p2]) {
        if (!p || p.active === false) continue;
        drawPowerBolt(p.x, p.y, SAFETY_RADIUS.rover);
        (p.extraRovers || []).forEach((er, idx) => {
          if ((p.structureHealth?.extraRovers?.[idx] ?? 1.0) <= 0) return;
          drawPowerBolt(er.x, er.y, SAFETY_RADIUS.rover);
        });
        (p.habitats || []).forEach((h, idx) => {
          if ((p.structureHealth?.habitats?.[idx] ?? 1.0) <= 0) return;
          drawPowerBolt(h.x, h.y, SAFETY_RADIUS.habitat);
        });
      }
    }

    // Night overlay text
    if (night) {
      ctx.fillStyle="rgba(20,10,60,0.25)"; ctx.fillRect(0,0,W,H);
      ctx.fillStyle="rgba(180,160,255,0.7)"; ctx.font="bold 10px monospace";
      ctx.textAlign="right"; ctx.textBaseline="top";
      ctx.fillText("LUNAR NIGHT", W-8, 8);
    }

    // Map layer overlays
    if (mapLayer !== "base") {
      if (mapLayer === "illumination" && illumRef.current) {
        // Draw real illumination image as semi-transparent overlay
        ctx.globalAlpha = 0.72;
        ctx.drawImage(illumRef.current, 0, 0, W, H);
        ctx.globalAlpha = 1.0;
        // Label
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(4, 4, 108, 16);
        ctx.fillStyle = "rgba(255,220,80,0.85)";
        ctx.font = "bold 8px monospace";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText("ILLUMINATION MAP", 8, 12);
      } else if (mapLayer !== "illumination") {
        const layerMeta = {
          altitude:       { label: "ALTITUDE MAP",        color: "rgba(80,160,255,0.12)",  text: "rgba(80,160,255,0.7)" },
          slope:          { label: "SLOPE MAP",           color: "rgba(255,100,80,0.12)",  text: "rgba(255,100,80,0.7)" },
          earthvisibility:{ label: "EARTH VISIBILITY MAP",color: "rgba(80,255,160,0.12)",  text: "rgba(80,255,160,0.7)" },
        };
        const meta = layerMeta[mapLayer];
        if (meta) {
          ctx.fillStyle = meta.color;
          ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = meta.text;
          ctx.font = "bold 11px monospace";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText("[PLACEHOLDER] " + meta.label, W/2, H/2 - 8);
          ctx.font = "8px monospace";
          ctx.fillStyle = meta.text.replace("0.7", "0.45");
          ctx.fillText("Data not yet loaded", W/2, H/2 + 10);
        }
      }
    }

    // "DONE" checkmark on rover who finished their turn
    for (const p of [p1, p2]) {
      if (!p || p.active === false) continue;
      const isDone = (p.id===1&&p1Done)||(p.id===2&&p2Done);
      if (isDone && phase===PHASE.PLAYING) {
        ctx.fillStyle="#44ff66"; ctx.font="bold 11px monospace";
        ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.fillText("✓", p.x, p.y-22);
      }
    }

    // ── Annotation pins ──────────────────────────────────────────────────────
    annotations.forEach((ann, ai) => {
      ctx.save();
      ctx.translate(ann.x, ann.y);
      const col = ann.color || "#ffcc00";
      // Pin stem
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, -18);
      ctx.strokeStyle = col+"cc"; ctx.lineWidth = 1.5; ctx.stroke();
      // Pin head
      ctx.beginPath(); ctx.arc(0, -22, 5, 0, Math.PI*2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = "#000"; ctx.lineWidth = 0.8; ctx.stroke();
      // Label bubble
      if (ann.label) {
        const lw = Math.min(ann.label.length * 5 + 8, 90);
        ctx.fillStyle = "rgba(2,5,14,0.92)";
        ctx.fillRect(6, -30, lw, 11);
        ctx.strokeStyle = col + "44"; ctx.lineWidth = 0.7;
        ctx.strokeRect(6, -30, lw, 11);
        ctx.fillStyle = col; ctx.font = "6px 'JetBrains Mono',monospace";
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(ann.label.substring(0, 16), 9, -29);
      }
      ctx.restore();
    });

    // Annotation placement crosshair when in annotation mode
    if (annotating && hover) {
      ctx.save();
      ctx.strokeStyle = "#ffcc00aa"; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(hover.x - 12, hover.y); ctx.lineTo(hover.x + 12, hover.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hover.x, hover.y - 12); ctx.lineTo(hover.x, hover.y + 12); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }, [p1, p2, craterHealth, hover, selectingFor, claimR, globalDay, mapLoaded, showLayers, activeTurn, p1Done, p2Done, phase, mapLayer, annotations, annotating, selectedRover]);

  useEffect(() => { draw(); }, [draw]);

  // ── Canvas input ─────────────────────────────────────────────────────────
  const getXY = e => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: Math.round((e.clientX-r.left)*W/r.width), y: Math.round((e.clientY-r.top)*H/r.height) };
  };

  const handleClick = e => {
    if (replayRun) return;
    const { x, y } = getXY(e);
    if (x<0||x>=W||y<0||y>=H) return;

    // Annotation mode: place a pin
    if (annotating) {
      const label = annotNote.trim() || `Pin ${annotations.length + 1}`;
      const colors = ["#ffcc00","#00d4ff","#44ff88","#ff6644","#cc88ff"];
      setAnnotations(prev => [...prev, { x, y, label, color: colors[prev.length % colors.length], ts: Date.now() }]);
      setAnnotNote("");
      return;
    }

    if (phase===PHASE.SETUP1) {
      recordUndoCheckpoint();
      const s = snapToPSR(x,y);
      setP1(makePlayer(s,1,"#ffdc00"));
      appendMissionLog({ type:"setup", actor:1, label:`P1 placed base at (${s.x}, ${s.y})` });
      if (scenarioPreset === "unevenArrival") {
        setPhase(PHASE.PLAYING);
        setActiveTurn(0); setP1Done(false); setP2Done(false);
      } else {
        setPhase(PHASE.SETUP2);
      }
    } else if (phase===PHASE.SETUP1_HAB) {
      // legacy — unreachable
      setPhase(PHASE.SETUP1_SOL);
    } else if (phase===PHASE.SETUP1_SOL) {
      setPhase(PHASE.SETUP1_PAD);
    } else if (phase===PHASE.SETUP1_PAD) {
      setPhase(PHASE.SETUP2);
    } else if (phase===PHASE.SETUP2) {
      recordUndoCheckpoint();
      const s = snapToPSR(x,y);
      setP2(makePlayer(s,2,"#b000ff", {
        arrivalDay: scenarioPreset === "unevenArrival" ? globalDay : 0,
      }));
      appendMissionLog({ type:"setup", actor:2, label:`P2 placed base at (${s.x}, ${s.y})` });
      setPhase(PHASE.PLAYING);
      setActiveTurn(0); setP1Done(false); setP2Done(false);
    } else if (phase===PHASE.SETUP2_HAB) {
      setPhase(PHASE.SETUP2_SOL);
    } else if (phase===PHASE.SETUP2_SOL) {
      setPhase(PHASE.SETUP2_PAD);
    } else if (phase===PHASE.SETUP2_PAD) {
      setPhase(PHASE.PLAYING);
      setActiveTurn(0); setP1Done(false); setP2Done(false);
    } else if (placingFor !== null && placingType) {
      recordUndoCheckpoint();
      const pi = placingFor;
      const setFn = pi===0 ? setP1 : setP2;
      const type = placingType;
      setFn(p => {
        if (!p) return p;
        const { costs } = calcAssetCosts(p.alloc || { mil:15, rd:15, econ:50, budget:20 });
        const cost = costs[type] ?? 999;
        if ((p.budget ?? 0) < cost) return p;
        const pts = ASSET_POINTS[type] ?? 0;
        const sh = { ...(p.structureHealth || {}) };
        const at = { x, y };
        if (type === "solar") {
          const onRidge = RIDGE_MASK[y * W + x] === 1;
          return { ...p, budget: (p.budget??0)-cost, assetPts: (p.assetPts??0)+pts,
                   panels: [...p.panels, { x, y, onRidge }],
                   structureHealth: { ...sh, panels: [...(sh.panels||[]), 1.0] } };
        } else if (type === "reactor") {
          return { ...p, budget: (p.budget??0)-cost, assetPts: (p.assetPts??0)+pts,
                   reactors: [...(p.reactors||[]), at],
                   structureHealth: { ...sh, reactors: [...(sh.reactors||[]), 1.0] } };
        } else if (type === "habitat") {
          return { ...p, budget: (p.budget??0)-cost, assetPts: (p.assetPts??0)+pts,
                   habitats: [...(p.habitats||[]), at],
                   habitatPower: [...(p.habitatPower||[]), HABITAT_POWER_INIT],
                   structureHealth: { ...sh, habitats: [...(sh.habitats||[]), 1.0] } };
        } else if (type === "pad") {
          return { ...p, budget: (p.budget??0)-cost, assetPts: (p.assetPts??0)+pts,
                   landingPads: [...(p.landingPads||[]), at],
                   structureHealth: { ...sh, landingPads: [...(sh.landingPads||[]), 1.0] } };
        }
        return p;
      });
      if (type === "reactor") {
        const enemyP = pi === 0 ? p2 : p1;
        setFn(prev => applyReactorPlacementPenalty(prev, enemyP, x, y));
      } else {
        landingImpact(pi, x, y);
      }
      appendMissionLog({ type:"placement", actor:pi + 1, itemType:type, label:`P${pi+1} placed ${structureLabel(type)} at (${x}, ${y})` });
      setPlacingFor(null);
      setPlacingType(null);
    } else if (selectingFor !== null) {
      recordUndoCheckpoint();
      const wp = { x, y };
      const rIdx = selectedRover[selectingFor];
      const setFn = selectingFor===0 ? setP1 : setP2;
      setFn(p => {
        if (!p) return p;
        if (rIdx === 0) {
          // Primary rover
          return { ...p, waypoints: addingWaypoint?[...(p.waypoints||[]),wp]:[wp], currentWaypoint: null };
        } else {
          // Extra rover
          const erIdx = rIdx - 1;
          const newER = [...(p.extraRovers||[])];
          if (!newER[erIdx]) return p;
          newER[erIdx] = { ...newER[erIdx], waypoints: addingWaypoint?[...(newER[erIdx].waypoints||[]),wp]:[wp], currentWaypoint: null };
          return { ...p, extraRovers: newER };
        }
      });
      appendMissionLog({
        type:"waypoint",
        actor: selectingFor + 1,
        rover: rIdx + 1,
        label:`P${selectingFor+1} set ${addingWaypoint ? "an additional" : "a"} waypoint for R${rIdx + 1} to (${x}, ${y})`,
      });
      if (!addingWaypoint) setSelectingFor(null);
    }
  };

  const handleRightClick = e => {
    if (replayRun) return;
    e.preventDefault();
    const { x, y } = getXY(e);
    if (selectingFor !== null) {
      recordUndoCheckpoint();
      const wp = { x, y };
      const rIdx2 = selectedRover[selectingFor];
      const setFn2 = selectingFor===0 ? setP1 : setP2;
      setFn2(p => {
        if (!p) return p;
        if (rIdx2 === 0) return { ...p, waypoints:[...(p.waypoints||[]),wp] };
        const erIdx2 = rIdx2 - 1;
        const newER2 = [...(p.extraRovers||[])];
        if (!newER2[erIdx2]) return p;
        newER2[erIdx2] = { ...newER2[erIdx2], waypoints:[...(newER2[erIdx2].waypoints||[]),wp] };
        return { ...p, extraRovers: newER2 };
      });
      appendMissionLog({
        type:"waypoint",
        actor: selectingFor + 1,
        rover: rIdx2 + 1,
        label:`P${selectingFor+1} queued an additional waypoint for R${rIdx2 + 1} to (${x}, ${y})`,
      });
    }
  };

  const handleMouseMove = e => {
    const { x, y } = getXY(e);
    setHover(x>=0&&x<W&&y>=0&&y<H ? {x,y} : null);
  };

  // ── Core: advance one day for a single player ────────────────────────────
  // Returns [newPlayerState, newCraterHealth, events]
  function stepPlayer(s, ch, gDay) {
    const newHealth = new Float32Array(ch);
    const po = physOverrides; // capture current overrides for this step

    // Simulate primary rover
    const result = simDay(
      { ...s, waypoints:[...(s.waypoints||[])], mineMap:{...s.mineMap} },
      newHealth, gDay, po
    );
    result.events = (result.events || []).map(ev => ({ ...ev, roverId: 1 }));

    // Simulate each extra rover independently, sharing the same habitat/structure state
    const newExtraRovers = (s.extraRovers||[]).map((er, erIdx) => {
      const erState = {
        ...s,
        x: er.x, y: er.y,
        ice: er.ice ?? 0,
        carrying: er.carrying ?? null,
        waypoints: [...(er.waypoints || [])],
        currentWaypoint: er.currentWaypoint ?? null,
        power: er.power ?? POWER_CAP,
        mineMap: result.mineMap,
      };
      const erResult = simDay(erState, newHealth, gDay, po);
      erResult.events = (erResult.events || []).map(ev => ({ ...ev, roverId: erIdx + 2 }));
      return {
        x: erResult.x, y: erResult.y,
        ice: erResult.ice,
        carrying: erResult.carrying,
        waypoints: erResult.waypoints,
        currentWaypoint: erResult.currentWaypoint,
        status: erResult.status,
        events: erResult.events,
        power: erResult.power,         // write the drained value back
        // carry forward panels/habitats/pads placed by this rover
        _panels: erResult.panels,
        _reactors: erResult.reactors,
        _habitats: erResult.habitats,
        _habitatPower: erResult.habitatPower,
        _landingPads: erResult.landingPads,
        _structureHealth: erResult.structureHealth,
        _pendingDeliveries: erResult.pendingDeliveries,
      };
    });

    // Merge extra rover results: collect all deposits, placed structures, updated mineMap
    let mergedResult = { ...result };
    let totalDep = 0;
    for (const ev of result.events) if (ev.type==="deposit") totalDep+=ev.kg;

    const allEvents = [...result.events];
    for (const er of newExtraRovers) {
      for (const ev of (er.events||[])) {
        if (ev.type==="deposit") totalDep+=ev.kg;
        allEvents.push(ev);
      }
      // Merge any structures placed by extra rover
      if (er._panels && er._panels.length > mergedResult.panels.length) {
        mergedResult = { ...mergedResult, panels: er._panels,
          structureHealth: { ...mergedResult.structureHealth, panels: er._structureHealth.panels } };
      }
      if (er._reactors && er._reactors.length > (mergedResult.reactors||[]).length) {
        mergedResult = { ...mergedResult, reactors: er._reactors,
          structureHealth: { ...mergedResult.structureHealth, reactors: er._structureHealth.reactors } };
      }
      if (er._habitats && er._habitats.length > mergedResult.habitats.length) {
        mergedResult = { ...mergedResult, habitats: er._habitats,
          habitatPower: er._habitatPower,
          structureHealth: { ...mergedResult.structureHealth, habitats: er._structureHealth.habitats } };
      }
      if (er._landingPads && er._landingPads.length > (mergedResult.landingPads||[]).length) {
        mergedResult = { ...mergedResult, landingPads: er._landingPads,
          structureHealth: { ...mergedResult.structureHealth, landingPads: er._structureHealth.landingPads } };
      }
      // Remove items from pendingDeliveries that this extra rover picked up
      if (er._pendingDeliveries && er._pendingDeliveries.length < s.pendingDeliveries.length) {
        const pickedUpIds = new Set(
          s.pendingDeliveries
            .filter(d => !er._pendingDeliveries.some(pd => pd.id === d.id))
            .map(d => d.id)
        );
        mergedResult = {
          ...mergedResult,
          pendingDeliveries: mergedResult.pendingDeliveries.filter(d => !pickedUpIds.has(d.id)),
        };
      }
    }

    // Strip internal merge fields from extraRovers
    const cleanExtraRovers = newExtraRovers.map(({ _panels, _reactors, _habitats, _habitatPower, _landingPads, _structureHealth, _pendingDeliveries, events: _ev, ...clean }) => clean);

    const finalResult = { ...mergedResult, extraRovers: cleanExtraRovers, events: allEvents };
    return [{ ...finalResult, iceDeposited: s.iceDeposited + totalDep }, newHealth, allEvents];
  }

  // ── End Turn for the active player ───────────────────────────────────────
  const endTurn = (pi) => {
    if (replayRun) return;
    if (phase !== PHASE.PLAYING) return;
    const p2Present = !!p2;
    // pi is 0-indexed player index
    if (pi===0 && !p1Done) {
      recordUndoCheckpoint();
      setP1Done(true);
      appendMissionLog({ type:"turn", actor:1, label:"P1 committed its plan and ended turn" });
      if (p2Present && !p2Done) { setActiveTurn(1); } // P2 still needs to go
    } else if (pi===1 && p2Present && !p2Done) {
      recordUndoCheckpoint();
      setP2Done(true);
      appendMissionLog({ type:"turn", actor:2, label:"P2 committed its plan and ended turn" });
      if (!p1Done) { setActiveTurn(0); } // P1 still needs to go
    }
  };

  // When both players are done, resolve the day
  useEffect(() => {
    if (!p1Done || !p1 || phase!==PHASE.PLAYING) return;
    if (p2 && !p2Done) return;

    // Both players committed — simulate the day simultaneously
    // Use the same starting craterHealth for both, then merge depletions
    const sharedGridActive = powerGridState.mode === "shared";
    const [chargedP1, chargedP2] = allocateDailyPower([p1, p2], globalDay, sharedGridActive);
    const ch = new Float32Array(craterHealth);
    const [np1, _ch2, evs1] = stepPlayer(chargedP1, ch, globalDay);
    let np2 = p2;
    let ch3 = _ch2;
    let evs2 = [];
    if (p2) {
      [np2, ch3, evs2] = stepPlayer(chargedP2, ch, globalDay);
      // ch3 reflects p2's mining; _ch2 reflects p1's mining. Merge by taking min of both depletions.
      for (let i = 0; i < ch3.length; i++) {
        ch3[i] = Math.min(_ch2[i], ch3[i]);
      }
    }

    // ── Safety zone decay ──────────────────────────────────────────────────
    const applyDecay = (owner, enemyPos, attackMil, defenseMil) => {
      const sh = { ...owner.structureHealth };
      const structTypes = [
        { key: 'panels',      list: owner.panels,             type: 'solar'   },
        { key: 'reactors',    list: owner.reactors||[],       type: 'reactor' },
        { key: 'habitats',    list: owner.habitats||[],       type: 'habitat' },
        { key: 'extraRovers', list: owner.extraRovers||[],   type: 'rover'   },
        { key: 'landingPads', list: owner.landingPads||[],   type: 'pad'     },
      ];
      const newSH = {};
      let damageDone = 0;
      const _PASSIVE_DECAY  = physOverrides.PASSIVE_DECAY  != null ? physOverrides.PASSIVE_DECAY  : PASSIVE_DECAY;
      const _HOSTILE_DECAY  = physOverrides.HOSTILE_DECAY  != null ? physOverrides.HOSTILE_DECAY  : HOSTILE_DECAY;
      const defMul = MIL_DEFENSE_SCALE + (1 - MIL_DEFENSE_SCALE) * (1 / Math.max(0.1, defenseMil));
      const hostileDecayEff = _HOSTILE_DECAY * attackMil * defMul;
      let violationCount = 0;
      for (const { key, list, type } of structTypes) {
        const healths = [...(sh[key] || list.map(() => 1.0))];
        for (let idx = 0; idx < list.length; idx++) {
          const struct = list[idx];
          const radius = SAFETY_RADIUS[type];
          const generatorSharedSafe = sharedGridActive && (type === "solar" || type === "reactor");
          const inZone = !generatorSharedSafe && d2(enemyPos, struct) < radius;
          const decay = inZone ? hostileDecayEff : _PASSIVE_DECAY;
          if (inZone) {
            damageDone += hostileDecayEff;
            violationCount += 1;
          }
          healths[idx] = Math.max(0, (healths[idx] ?? 1.0) - decay);
        }
        newSH[key] = healths;
      }
      return {
        updatedOwner: {
          ...owner,
          structureHealth: newSH,
          safetyViolations: (owner.safetyViolations ?? 0) + violationCount,
        },
        damageDone,
      };
    };

    const mil1 = np1.milScore ?? 1.0;
    const mil2 = np2?.milScore ?? 1.0;
    const { updatedOwner: dnp1, damageDone: dmgByP2 } = p2
      ? applyDecay(np1, { x: np2.x, y: np2.y }, mil2, mil1)
      : { updatedOwner: np1, damageDone: 0 };
    const { updatedOwner: dnp2, damageDone: dmgByP1 } = p2
      ? applyDecay(np2, { x: np1.x, y: np1.y }, mil1, mil2)
      : { updatedOwner: np2, damageDone: 0 };
    const fnp1base = dnp1;
    const fnp2base = dnp2;

    // ── Direct score updates now come from safety violations and grid actions.
    let fnp1 = { ...fnp1base };
    let fnp2 = fnp2base ? { ...fnp2base } : null;


    const newGlobalDay = globalDay + 1;
    const newDay = day + 1;
    let newRound = round;
    let newCR = [...claimR];
    const events = [
      ...evs1.map(ev => ({ ...ev, actor: 1 })),
      ...evs2.map(ev => ({ ...ev, actor: 2 })),
    ];
    setLastEvents(events);

    let roundEnded = false;
    let efnp1 = null, efnp2 = null;
    if (newDay >= DAYS_PER_ROUND) {
      const dep1 = evs1.filter(e=>e.type==="deposit").reduce((s,e)=>s+e.kg,0);
      const dep2 = evs2.filter(e=>e.type==="deposit").reduce((s,e)=>s+e.kg,0);
      newCR[0] = Math.min(220, newCR[0] + Math.min(18, dep1/18));
      if (p2) newCR[1] = Math.min(220, newCR[1] + Math.min(18, dep2/18));
      // ── Economy: process round budget (new model) ─────────────────────────
      // Compute cross-player maximums for contentness C
      const E1 = fnp1.econ ?? E_INIT, E2 = fnp2?.econ ?? E_INIT;
      const T1 = fnp1.assetPts ?? 0,  T2 = fnp2?.assetPts ?? 0;  // T = asset points
      const M1 = fnp1.milStock ?? 1,  M2 = fnp2?.milStock ?? 1;
      const E_max = Math.max(E1, E2), T_max = Math.max(T1, T2), M_max = Math.max(M1, M2);

      const processEconomy = (p, E, T, M) => {
        if (p.active === false) return p;
        const alloc = p.alloc || { mil: 20, rd: 20, econ: 60 };
        const budget = calcBudget(E);

        // I_A = asset maintenance this round (new purchase costs are deducted on buy)
        const { maint } = calcAssetCosts(alloc);
        const I_A = (p.panels.length           * maint.solar)
                  + (((p.reactors||[]).length) * maint.reactor)
                  + ((p.habitats||[]).length    * maint.habitat)
                  + ((p.extraRovers||[]).length * maint.rover)
                  + ((p.landingPads||[]).length * maint.pad);

        // Investments as fractions of budget (0–1) so delta equations are scale-stable
        // I_A is paid first; remainder is split by slider proportions
        const spendableFrac = Math.max(0, 1 - I_A / Math.max(1, budget));
        const totalPct      = (alloc.mil + alloc.rd + alloc.econ + (alloc.budget||0)) || 1;
        const I_E = (alloc.econ / totalPct) * spendableFrac;  // fraction → ΔE
        const I_R = (alloc.rd   / totalPct) * spendableFrac;  // fraction → ΔR
        const I_M = (alloc.mil  / totalPct) * spendableFrac;  // fraction → ΔM
        const I_B = ((alloc.budget||0) / totalPct) * spendableFrac; // fraction → bonus credits
        const bonusCredits = Math.round(budget * I_B);

        // Contentness for this player
        const C = calcCompetitiveness(E, T, M, E_max, T_max, M_max);

        // Update stocks
        const newE       = Math.max(0.5, E + calcDeltaE(I_E, C, p.rdAccum ?? 0));
        const newR       = Math.max(0,   (p.rdAccum  ?? 0) + calcDeltaR(I_R, C));
        const newM       = Math.max(0.1, M           + calcDeltaM(I_M, M));
        const newBudget  = Math.max(0, calcBudget(newE) + bonusCredits); // next round's budget preview
        const newMilScore = calcMilScore(newM);

        return { ...p, econ: newE, rdAccum: newR, milStock: newM, milScore: newMilScore,
                 budget: newBudget };
      };
      efnp1 = processEconomy(fnp1, E1, T1, M1);
      efnp2 = p2 ? processEconomy(fnp2, E2, T2, M2) : null;

      setHistory(h => [...h, {
        r: round,
        d1: Math.round(efnp1.iceDeposited),
        d2: Math.round(efnp2?.iceDeposited ?? 0),
        dep1: Math.round(dep1),
        dep2: Math.round(dep2),
        bud1: Math.round(efnp1.budget),
        bud2: Math.round(efnp2?.budget ?? 0),
      }]);
      newRound = round + 1;
      roundEnded = true;
    }

    setGlobalDay(newGlobalDay);
    setP1(roundEnded ? efnp1 : fnp1);
    setP2(p2 ? (roundEnded ? efnp2 : fnp2) : null);
    setCraterHealth(ch3); setClaimR(newCR);

    const missionEndsOnDepletion = missionEndMode === "depletion" && isMapDepleted(ch3);
    if (roundEnded) {
      if ((missionEndMode === "fixed" && newRound > totalRounds) || missionEndsOnDepletion) {
        setPhase(PHASE.DONE);
        setP1Done(false); setP2Done(false);
        return;
      }
      setRound(newRound); setDay(0);
    } else {
      if (missionEndsOnDepletion) {
        setPhase(PHASE.DONE);
        setP1Done(false); setP2Done(false);
        return;
      }
      setDay(newDay);
    }

    // Reset for next day — P1 goes first
    setP1Done(false); setP2Done(false);
    setActiveTurn(0);
  }, [p1Done, p2Done, phase, p1, p2, craterHealth, globalDay, round, day, totalRounds, powerGridState, missionEndMode]);

  // ── UI helpers ───────────────────────────────────────────────────────────
  // Apply landing damage to every enemy structure whose safety zone contains
  // the landing point (lx, ly). Used by both click-placed structures and
  // rover deployments at base.
  const landingImpact = (pi, lx, ly) => {
    const enemyPi = pi === 0 ? 1 : 0;
    const enemyP = enemyPi === 0 ? p1 : p2;
    if (!enemyP) return;
    const setEnemy = enemyPi === 0 ? setP1 : setP2;
    const setSelf  = pi === 0 ? setP1 : setP2;
    const eSh = { ...(enemyP.structureHealth || {}) };
    const eLists = {
      panels:      enemyP.panels        || [],
      reactors:    enemyP.reactors      || [],
      habitats:    enemyP.habitats      || [],
      extraRovers: enemyP.extraRovers   || [],
      landingPads: enemyP.landingPads   || [],
    };
    const typeFor = { panels:'solar', reactors:'reactor', habitats:'habitat', extraRovers:'rover', landingPads:'pad' };
    let totalDamage = 0;
    for (const k of Object.keys(eLists)) {
      const arr = [...(eSh[k] || eLists[k].map(()=>1.0))];
      const radius = SAFETY_RADIUS[typeFor[k]];
      for (let ei = 0; ei < eLists[k].length; ei++) {
        const before = arr[ei] ?? 1.0;
        if (before <= 0) continue;
        if (d2({x:lx, y:ly}, eLists[k][ei]) < radius) {
          const after = Math.max(0, before - LANDING_DAMAGE);
          totalDamage += (before - after);
          arr[ei] = after;
        }
      }
      eSh[k] = arr;
    }
    if (totalDamage > 0) {
      setEnemy(prev => prev ? { ...prev, structureHealth: eSh } : prev);
    }
  };

  const countNearbyEnemyStructures = (enemyP, x, y, radius = SAFETY_RADIUS.reactor) => {
    if (!enemyP) return 0;
    const eLists = [
      { list: enemyP.panels || [], key: "panels" },
      { list: enemyP.reactors || [], key: "reactors" },
      { list: enemyP.habitats || [], key: "habitats" },
      { list: enemyP.extraRovers || [], key: "extraRovers" },
      { list: enemyP.landingPads || [], key: "landingPads" },
    ];
    let count = 0;
    for (const { list, key } of eLists) {
      const healths = enemyP.structureHealth?.[key] || list.map(() => 1.0);
      for (let i = 0; i < list.length; i++) {
        if ((healths[i] ?? 1.0) <= 0) continue;
        if (d2({ x, y }, list[i]) < radius) count++;
      }
    }
    return count;
  };

  const applyReactorPlacementPenalty = (playerState, enemyState, x, y) => {
    const nearby = countNearbyEnemyStructures(enemyState, x, y);
    if (nearby <= 0 || !playerState) return playerState;
    return playerState;
  };

  const appendMissionLog = (entry) => {
    setMissionLog(prev => [...prev, { round, day, globalDay, ...entry }]);
  };

  const structureLabel = (type) => ({
    solar: "Solar Panel",
    reactor: "Nuclear Reactor",
    habitat: "Habitat",
    rover: "Rover",
    pad: "Landing Pad",
    resupply: "Resupply Order",
  }[type] || type);

  const getDiplomacyOptions = (pi) => {
    const actor = pi === 0 ? p1 : p2;
    const other = pi === 0 ? p2 : p1;
    if (!gridSharingEnabled || !actor || !other) return [];
    const actorId = pi + 1;
    const otherId = actorId === 1 ? 2 : 1;
    if (powerGridState.mode === "shared") {
      if (gridSharingPermanent) return [];
      return [{ type: "decouple", label: "Decouple Power Grid" }];
    }
    if (powerGridState.mode === "offered") {
      if (powerGridState.offeredTo === actorId) {
        return [{ type: "join", label: `Join P${powerGridState.offeredBy} Power Grid` }];
      }
      if (powerGridState.offeredBy === actorId) {
        return [];
      }
    }
    return [{ type: "open", label: `Open Power Grid to P${otherId}` }];
  };

  const applyScoreDelta = (pi, delta) => {
    const setter = pi === 0 ? setP1 : setP2;
    setter(player => player ? {
      ...player,
      scoreAdjustments: (player.scoreAdjustments ?? 0) + delta,
    } : player);
  };

  const executeDiplomaticDecision = (pi) => {
    if (replayRun) return;
    if (phase !== PHASE.PLAYING) return;
    if (!gridSharingEnabled) return;
    if ((pi === 0 ? p1Done : p2Done)) return;
    const actor = pi === 0 ? p1 : p2;
    const other = pi === 0 ? p2 : p1;
    if (!actor || !other) return;

    const action = selectedDiplomacy[pi];
    const actorId = pi + 1;
    const otherId = actorId === 1 ? 2 : 1;
    if (!action) return;
    recordUndoCheckpoint();

    if (action === "open" && powerGridState.mode !== "shared") {
      setPowerGridState({ mode:"offered", offeredBy: actorId, offeredTo: otherId });
      applyScoreDelta(pi, 30);
      appendMissionLog({ type:"grid", actor: actorId, other: otherId, label: `P${actorId} opened its power grid to P${otherId}` });
    } else if (action === "join" && powerGridState.mode === "offered" && powerGridState.offeredTo === actorId) {
      setPowerGridState({ mode:"shared", offeredBy: powerGridState.offeredBy, offeredTo: actorId });
      applyScoreDelta(pi, 20);
      appendMissionLog({ type:"grid", actor: actorId, other: powerGridState.offeredBy, label: `P${actorId} joined P${powerGridState.offeredBy}'s power grid` });
    } else if (action === "decouple" && powerGridState.mode === "shared" && !gridSharingPermanent) {
      setPowerGridState({ mode:"independent", offeredBy: null, offeredTo: null });
      applyScoreDelta(pi, -20);
      appendMissionLog({ type:"grid", actor: actorId, other: otherId, label: `P${actorId} decoupled the shared power grid` });
    }

    setSelectedDiplomacy([null, null]);
  };

  const buildStructure = (pi, type) => {
    if (replayRun) return;
    const p = pi===0 ? p1 : p2;
    if (!p) return;
    // ── Resupply order: not a structure, an instant healing action ──
    if (type === "resupply") {
      const pads = p.landingPads || [];
      const sh0 = p.structureHealth || {};
      const padHealths = sh0.landingPads || pads.map(() => 1.0);
      const hasFunctionalPad = pads.some((_, i) => (padHealths[i] ?? 1.0) > 0);
      if (!hasFunctionalPad) return;
      if ((p.budget ?? 0) < RESUPPLY_COST) return;
      recordUndoCheckpoint();
      const keys = ['panels','reactors','habitats','extraRovers','landingPads'];
      const lists = { panels:p.panels||[], reactors:p.reactors||[], habitats:p.habitats||[], extraRovers:p.extraRovers||[], landingPads:pads };
      const newSH = {};
      for (const k of keys) newSH[k] = [...(sh0[k] || lists[k].map(()=>1.0))];
      const refs = [];
      for (const k of keys) for (let i=0;i<lists[k].length;i++) {
        const h = newSH[k][i] ?? 1.0;
        if (h > 0 && h < 1.0) refs.push({k,i});
      }
      let pool = RESUPPLY_POOL, safety = 600;
      while (pool > 1e-6 && refs.length && safety-- > 0) {
        let minH = Infinity, pick = -1;
        for (let r=0;r<refs.length;r++){const {k,i}=refs[r];const h=newSH[k][i];if(h<1.0&&h<minH){minH=h;pick=r;}}
        if (pick === -1) break;
        const {k,i} = refs[pick];
        const give = Math.min(RESUPPLY_CHUNK, pool, 1.0 - newSH[k][i]);
        newSH[k][i] += give;
        pool -= give;
      }
      const np = { ...p, budget:(p.budget??0)-RESUPPLY_COST, structureHealth:newSH };
      if (pi===0) setP1(np); else setP2(np);
      appendMissionLog({ type:"purchase", actor: pi + 1, itemType:"resupply", cost:RESUPPLY_COST, label:`P${pi+1} purchased ${structureLabel("resupply")} for ${RESUPPLY_COST}cr` });
      // Each functional pad receiving this resupply triggers a landing impact
      // at its own coordinates — so a forward pad sitting in enemy zones acts
      // like a missile strike every time you order resupply.
      pads.forEach((pad, pi2) => {
        if ((padHealths[pi2] ?? 1.0) > 0) landingImpact(pi, pad.x, pad.y);
      });
      return;
    }
    const pads = p.landingPads || [];
    const placementGrace = hasPlacementGrace(p.arrivalDay, globalDay);
    const padFree = placementGrace || type === "pad"; // arrival grace + pads can always be click-placed (anti-softlock)
    if (pads.length === 0 && !padFree && type !== "rover") return; // need a landing pad first
    const padIdx = pads.length > 0 ? Math.min(selectedPad[pi], pads.length - 1) : 0;
    const { costs } = calcAssetCosts(p.alloc || { mil:20, rd:20, econ:60 });
    const cost = costs[type] ?? 999;

    const maxes = { solar: MAX_PANELS, reactor: MAX_REACTORS, habitat: MAX_HABITATS, rover: MAX_ROVERS, pad: MAX_PADS };
    const counts = {
      solar:   p.panels.length,
      reactor: (p.reactors||[]).length,
      habitat: (p.habitats||[]).length,
      rover:   (p.extraRovers||[]).length,
      pad:     (p.landingPads||[]).length,
    };
    if (counts[type] >= maxes[type]) return;
    if ((p.budget ?? 0) < cost) return;
    recordUndoCheckpoint();
    const id = Date.now() + Math.random();
    const pts = ASSET_POINTS[type] ?? 0;
    let np;
    if (type === "rover") {
      // Rovers spawn immediately at the player's base — no pad pickup needed
      np = { ...p,
             budget:   (p.budget   ?? 0) - cost,
             assetPts: (p.assetPts ?? 0) + pts,
             extraRovers: [...(p.extraRovers||[]), {
               x: p.base.x, y: p.base.y,
               waypoints: [], currentWaypoint: null,
               ice: 0, carrying: null, status: "idle",
               power: POWER_CAP,
             }],
             structureHealth: {
               ...p.structureHealth,
               extraRovers: [...(p.structureHealth?.extraRovers || []), 1.0],
             },
            };
      landingImpact(pi, p.base.x, p.base.y);
      appendMissionLog({ type:"purchase", actor: pi + 1, itemType:type, cost, label:`P${pi+1} purchased ${structureLabel(type)} for ${cost}cr and deployed it at base` });
    } else if (padFree) {
      // During a player's first 7 days after arrival, all non-rover builds can
      // use manual click placement. After that, non-pad structures must flow
      // through landing-pad delivery.
      setPlacingFor(pi);
      setPlacingType(type);
      appendMissionLog({ type:"purchase", actor: pi + 1, itemType:type, cost, label:`P${pi+1} purchased ${structureLabel(type)} for ${cost}cr and is selecting a placement site` });
      return;
    } else {
      np = { ...p, budget: (p.budget ?? 0) - cost,
                   assetPts: (p.assetPts ?? 0) + pts,
                    pendingDeliveries: [...(p.pendingDeliveries||[]), { id, type, padIdx }] };
      appendMissionLog({ type:"purchase", actor: pi + 1, itemType:type, cost, label:`P${pi+1} purchased ${structureLabel(type)} for ${cost}cr and routed it to Landing Pad ${padIdx + 1}` });
    }
    if (pi===0) setP1(np); else setP2(np);
  };

  const setAlloc = (pi, key, val) => {
    if (replayRun) return;
    recordUndoCheckpoint();
    const setter = pi===0 ? setP1 : setP2;
    setter(p => {
      if (!p) return p;
      const alloc = { ...(p.alloc || { mil:15, rd:15, econ:50, budget:20 }) };
      // Ensure all 4 keys exist (migration for old saves / pre-edit players)
      if (alloc.budget == null) alloc.budget = 0;
      alloc[key] = val;
      const allKeys = ['mil','rd','econ','budget'];
      const others = allKeys.filter(k => k !== key);
      const remaining = Math.max(0, 100 - val);
      const otherSum = others.reduce((s,k) => s + (alloc[k]||0), 0);
      if (otherSum > 0) {
        for (const k of others) alloc[k] = Math.round((alloc[k]||0) / otherSum * remaining);
      } else {
        const each = Math.floor(remaining / 3);
        alloc[others[0]] = each; alloc[others[1]] = each; alloc[others[2]] = remaining - 2*each;
      }
      for (const k of allKeys) alloc[k] = Math.max(0, alloc[k]);
      return { ...p, alloc };
    });
  };

  const clearWaypoints = pi => {
    if (replayRun) return;
    recordUndoCheckpoint();
    const rIdx = selectedRover[pi];
    const setFn = pi===0 ? setP1 : setP2;
    setFn(p => {
      if (!p) return p;
      if (rIdx === 0) return { ...p, waypoints:[], currentWaypoint:null };
      const erIdx = rIdx - 1;
      const newER = [...(p.extraRovers||[])];
      if (!newER[erIdx]) return p;
      newER[erIdx] = { ...newER[erIdx], waypoints:[], currentWaypoint:null };
      return { ...p, extraRovers: newER };
    });
    appendMissionLog({
      type:"waypoint",
      actor: pi + 1,
      rover: rIdx + 1,
      label:`P${pi+1} cleared the route for R${rIdx + 1}`,
    });
  };

  const exportMissionData = () => {
    const rows = [
      ["round","day","globalDay","type","kg","craterIdx","label"],
      ...missionLog.map(e => [e.round, e.day, e.globalDay, e.type, (e.kg||0).toFixed(2), e.craterIdx||"", e.label||""])
    ];
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `psr_mission_log_R${round}D${day}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportStateJSON = () => {
    const data = {
      meta: { round, day, globalDay, totalRounds, simMode, timestamp: new Date().toISOString() },
      p1: p1 ? { iceDeposited: p1.iceDeposited, assetPts: p1.assetPts, budget: p1.budget,
                  econ: p1.econ, rdAccum: p1.rdAccum, milStock: p1.milStock,
                  panels: p1.panels.length, reactors: (p1.reactors||[]).length, habitats: (p1.habitats||[]).length,
                  rovers: 1 + (p1.extraRovers||[]).length, pads: (p1.landingPads||[]).length } : null,
      p2: p2 ? { iceDeposited: p2.iceDeposited, assetPts: p2.assetPts, budget: p2.budget,
                  econ: p2.econ, rdAccum: p2.rdAccum, milStock: p2.milStock,
                  panels: p2.panels.length, reactors: (p2.reactors||[]).length, habitats: (p2.habitats||[]).length,
                  rovers: 1 + (p2.extraRovers||[]).length, pads: (p2.landingPads||[]).length } : null,
      history, missionLog, annotations,
      powerGridState,
      cratersTotal: CRATER_DATA.length,
      cratersHeavilyDepleted: CRATER_DATA.filter((_,ci)=>(craterHealth[ci]||1)<0.2).length,
      physOverrides,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `psr_mission_state_R${round}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setUndoStack([]);
    setPhase(PHASE.SETTINGS); setP1(null); setP2(null);
    setCraterHealth(new Float32Array(CRATER_DATA.length).fill(1.0));
    setRound(1); setDay(0); setGlobalDay(0); setHistory([]);
    setClaimR([80,80]); setSelectingFor(null); setPlacingFor(null); setPlacingType(null);
    setActiveTurn(0); setP1Done(false); setP2Done(false); setLastEvents([]);
    setSelectedBuild([null, null]);
    setSelectedDiplomacy([null, null]);
    setSelectedPad([0, 0]);
    setSelectedRover([0, 0]);
    setMapLayer("base");
    setPowerGridState({ mode:"independent", offeredBy:null, offeredTo:null });
    setBatchRunning(false);
    setBatchProgress({ completed:0, total:batchRunCount, currentSeed:null });
    setBatchResult(null);
    setReplayRun(null);
    setReplayFrameIndex(0);
    setReplayPlaying(false);
    setReplayLoading(false);
    setLiveTimeline([]);
    liveTimelineKeyRef.current = "";
    setShowPlots(false);
    setSeparatePlotsOpen({});
    setMissionLog([]); setAnnotations([]); setAnnotating(false); setAnnotNote("");
    setAutoAdvance(false); setShowLog(false); setShowParams(false); setShowAnalytics(false);
  };

  function makeSeededRng(seed) {
    let t = seed >>> 0;
    return () => {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isMapDepleted(ch) {
    if (!ch) return false;
    for (let i = 0; i < ch.length; i++) {
      if ((ch[i] ?? 0) > DEPLETION_END_THRESHOLD) return false;
    }
    return true;
  }

  function clonePlayerState(player) {
    if (!player) return null;
    return {
      ...player,
      base: player.base ? { ...player.base } : player.base,
      panels: (player.panels || []).map(p => ({ ...p })),
      reactors: (player.reactors || []).map(r => ({ ...r })),
      habitats: (player.habitats || []).map(h => ({ ...h })),
      habitatPower: [...(player.habitatPower || [])],
      extraRovers: (player.extraRovers || []).map(r => ({ ...r, waypoints:[...(r.waypoints||[])] })),
      landingPads: (player.landingPads || []).map(p => ({ ...p })),
      pendingDeliveries: (player.pendingDeliveries || []).map(d => ({ ...d, target:d.target ? { ...d.target } : d.target })),
      carrying: player.carrying ? { ...player.carrying, target: player.carrying.target ? { ...player.carrying.target } : player.carrying.target } : null,
      structureHealth: {
        panels: [...(player.structureHealth?.panels || [])],
        reactors: [...(player.structureHealth?.reactors || [])],
        habitats: [...(player.structureHealth?.habitats || [])],
        extraRovers: [...(player.structureHealth?.extraRovers || [])],
        landingPads: [...(player.structureHealth?.landingPads || [])],
      },
      waypoints: [...(player.waypoints || [])],
      currentWaypoint: player.currentWaypoint ? { ...player.currentWaypoint } : null,
      mineMap: { ...(player.mineMap || {}) },
      depositLog: [...(player.depositLog || [])],
      alloc: { ...(player.alloc || {}) },
      generatorRangeEntries: JSON.parse(JSON.stringify(player.generatorRangeEntries || {})),
      generatorSupplyTotals: { ...(player.generatorSupplyTotals || {}) },
      generatorSupplyByRecipient: { 1: player.generatorSupplyByRecipient?.[1] || 0, 2: player.generatorSupplyByRecipient?.[2] || 0 },
      botMemory: player.botMemory ? JSON.parse(JSON.stringify(player.botMemory)) : undefined,
    };
  }

  function scorePlayerState(player) {
    if (!player) return 0;
    return (player.iceDeposited ?? 0) + (player.assetPts ?? 0) * 15 + (player.scoreAdjustments ?? 0) - (player.safetyViolations ?? 0) * 25;
  }

  function structureCounts(player) {
    return player ? {
      habitats: (player.habitats || []).length,
      panels: (player.panels || []).length,
      reactors: (player.reactors || []).length,
      rovers: 1 + (player.extraRovers || []).length,
      pads: (player.landingPads || []).length,
    } : { habitats:0, panels:0, reactors:0, rovers:0, pads:0 };
  }

  function snapshotSimState(sim) {
    return {
      round: sim.round,
      day: sim.day,
      globalDay: sim.globalDay,
      claimR: [...sim.claimR],
      powerGridState: { ...sim.powerGridState },
      p1: clonePlayerState(sim.p1),
      p2: clonePlayerState(sim.p2),
      craterHealth: Array.from(sim.craterHealth || []),
      history: [...(sim.history || [])].map(h => ({ ...h })),
      logLength: (sim.missionLog || []).length,
      phase: sim.phase || PHASE.PLAYING,
    };
  }

  function snapshotLiveFrame() {
    return {
      round,
      day,
      globalDay,
      claimR: [...claimR],
      powerGridState: { ...powerGridState },
      p1: clonePlayerState(p1),
      p2: clonePlayerState(p2),
      craterHealth: Array.from(craterHealth || []),
      history: history.map(h => ({ ...h })),
      logLength: missionLog.length,
      phase,
    };
  }

  function applyFrameSnapshot(frame, logSource = []) {
    if (!frame) return;
    setP1(clonePlayerState(frame.p1));
    setP2(clonePlayerState(frame.p2));
    setCraterHealth(new Float32Array(frame.craterHealth || []));
    setRound(frame.round);
    setDay(frame.day);
    setGlobalDay(frame.globalDay);
    setClaimR([...(frame.claimR || [80, 80])]);
    setPowerGridState({ ...(frame.powerGridState || { mode:"independent", offeredBy:null, offeredTo:null }) });
    setHistory((frame.history || []).map(h => ({ ...h })));
    setLastEvents([]);
    setMissionLog((logSource || []).slice(0, frame.logLength || 0).map(ev => ({ ...ev })));
    setPhase(frame.phase === PHASE.DONE ? PHASE.DONE : PHASE.PLAYING);
  }

  function getUndoSegmentKey(snapshot = {}) {
    const phaseValue = snapshot.phase ?? phase;
    const roundValue = snapshot.round ?? round;
    const dayValue = snapshot.day ?? day;
    const globalDayValue = snapshot.globalDay ?? globalDay;
    const activeTurnValue = snapshot.activeTurn ?? activeTurn;
    const p1DoneValue = snapshot.p1Done ?? p1Done;
    const p2DoneValue = snapshot.p2Done ?? p2Done;
    if (phaseValue === PHASE.PLAYING || phaseValue === PHASE.DONE) {
      return `play|${roundValue}|${dayValue}|${globalDayValue}|${activeTurnValue}|${p1DoneValue ? 1 : 0}|${p2DoneValue ? 1 : 0}`;
    }
    return `phase|${phaseValue}|${roundValue}|${dayValue}|${globalDayValue}`;
  }

  function captureUndoSnapshot() {
    return {
      segmentKey: getUndoSegmentKey(),
      phase,
      p1: clonePlayerState(p1),
      p2: clonePlayerState(p2),
      craterHealth: Array.from(craterHealth || []),
      round,
      day,
      globalDay,
      history: history.map(h => ({ ...h })),
      claimR: [...claimR],
      activeTurn,
      p1Done,
      p2Done,
      selectingFor,
      placingFor,
      placingType,
      selectedRover: [...selectedRover],
      addingWaypoint,
      lastEvents: lastEvents.map(ev => ({ ...ev })),
      selectedBuild: [...selectedBuild],
      selectedDiplomacy: [...selectedDiplomacy],
      selectedPad: [...selectedPad],
      mapLayer,
      powerGridState: { ...powerGridState },
      missionLog: missionLog.map(ev => ({ ...ev })),
      annotations: annotations.map(ann => ({ ...ann })),
    };
  }

  function applyUndoSnapshot(snapshot) {
    if (!snapshot) return;
    setPhase(snapshot.phase);
    setP1(clonePlayerState(snapshot.p1));
    setP2(clonePlayerState(snapshot.p2));
    setCraterHealth(new Float32Array(snapshot.craterHealth || []));
    setRound(snapshot.round);
    setDay(snapshot.day);
    setGlobalDay(snapshot.globalDay);
    setHistory((snapshot.history || []).map(h => ({ ...h })));
    setClaimR([...(snapshot.claimR || [80, 80])]);
    setActiveTurn(snapshot.activeTurn ?? 0);
    setP1Done(!!snapshot.p1Done);
    setP2Done(!!snapshot.p2Done);
    setSelectingFor(snapshot.selectingFor ?? null);
    setPlacingFor(snapshot.placingFor ?? null);
    setPlacingType(snapshot.placingType ?? null);
    setSelectedRover([...(snapshot.selectedRover || [0, 0])]);
    setAddingWaypoint(!!snapshot.addingWaypoint);
    setLastEvents((snapshot.lastEvents || []).map(ev => ({ ...ev })));
    setSelectedBuild([...(snapshot.selectedBuild || [null, null])]);
    setSelectedDiplomacy([...(snapshot.selectedDiplomacy || [null, null])]);
    setSelectedPad([...(snapshot.selectedPad || [0, 0])]);
    setMapLayer(snapshot.mapLayer || "base");
    setPowerGridState({ ...(snapshot.powerGridState || { mode:"independent", offeredBy:null, offeredTo:null }) });
    setMissionLog((snapshot.missionLog || []).map(ev => ({ ...ev })));
    setAnnotations((snapshot.annotations || []).map(ann => ({ ...ann })));
  }

  const exportSaveGame = () => {
    const snapshot = captureUndoSnapshot();
    const data = {
      format: "psr-savegame-v1",
      savedAt: new Date().toISOString(),
      config: { simMode, totalRounds, missionEndMode, arrivalDelay, scenarioPreset,
                gridSharingEnabled, gridSharingPermanent },
      snapshot,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `psr_save_R${round}D${globalDay + 1}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSaveGame = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data?.snapshot) { alert("Invalid save file: missing snapshot data."); return; }
        const cfg = data.config || {};
        if (cfg.simMode)               setSimMode(cfg.simMode);
        if (cfg.totalRounds)           setTotalRounds(cfg.totalRounds);
        if (cfg.missionEndMode)        setMissionEndMode(cfg.missionEndMode);
        if (cfg.arrivalDelay != null)  setArrivalDelay(cfg.arrivalDelay);
        if (cfg.scenarioPreset)        setScenarioPreset(cfg.scenarioPreset);
        if (cfg.gridSharingEnabled != null) setGridSharingEnabled(cfg.gridSharingEnabled);
        if (cfg.gridSharingPermanent != null) setGridSharingPermanent(cfg.gridSharingPermanent);
        setUndoStack([]);
        setReplayRun(null);
        setReplayFrameIndex(0);
        setReplayPlaying(false);
        applyUndoSnapshot(data.snapshot);
      } catch (err) {
        alert(`Failed to load save file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const recordUndoCheckpoint = () => {
    if (replayRun || batchRunning || phase === PHASE.SETTINGS || phase === PHASE.BATCH) return;
    const snapshot = captureUndoSnapshot();
    setUndoStack(prev => {
      if (prev[prev.length - 1]?.segmentKey === snapshot.segmentKey) return prev;
      return [...prev, snapshot];
    });
  };

  const undoLastTurn = () => {
    if (replayRun || batchRunning) return;
    const snapshot = undoStack[undoStack.length - 1];
    if (!snapshot) return;
    applyUndoSnapshot(snapshot);
    setUndoStack(prev => prev.slice(0, -1));
  };

  function countNearbyEnemyStructuresState(enemyP, x, y, radius = SAFETY_RADIUS.reactor) {
    if (!enemyP) return 0;
    const eLists = [
      { list: enemyP.panels || [], key: "panels" },
      { list: enemyP.reactors || [], key: "reactors" },
      { list: enemyP.habitats || [], key: "habitats" },
      { list: enemyP.extraRovers || [], key: "extraRovers" },
      { list: enemyP.landingPads || [], key: "landingPads" },
    ];
    let count = 0;
    for (const { list, key } of eLists) {
      const healths = enemyP.structureHealth?.[key] || list.map(() => 1.0);
      for (let i = 0; i < list.length; i++) {
        if ((healths[i] ?? 1.0) <= 0) continue;
        if (d2({ x, y }, list[i]) < radius) count++;
      }
    }
    return count;
  }

  function applyPureReactorPlacementPenalty(playerState, enemyState, x, y) {
    const nearby = countNearbyEnemyStructuresState(enemyState, x, y);
    if (nearby <= 0 || !playerState) return playerState;
    return playerState;
  }

  function applyPureLandingImpact(players, actorIdx, lx, ly) {
    const nextPlayers = players.map(p => clonePlayerState(p));
    const enemyIdx = actorIdx === 0 ? 1 : 0;
    const enemyP = nextPlayers[enemyIdx];
    const actorP = nextPlayers[actorIdx];
    if (!enemyP || !actorP) return nextPlayers;
    const eSh = { ...(enemyP.structureHealth || {}) };
    const eLists = {
      panels: enemyP.panels || [],
      reactors: enemyP.reactors || [],
      habitats: enemyP.habitats || [],
      extraRovers: enemyP.extraRovers || [],
      landingPads: enemyP.landingPads || [],
    };
    const typeFor = { panels:"solar", reactors:"reactor", habitats:"habitat", extraRovers:"rover", landingPads:"pad" };
    let totalDamage = 0;
    for (const k of Object.keys(eLists)) {
      const arr = [...(eSh[k] || eLists[k].map(() => 1.0))];
      const radius = SAFETY_RADIUS[typeFor[k]];
      for (let ei = 0; ei < eLists[k].length; ei++) {
        const before = arr[ei] ?? 1.0;
        if (before <= 0) continue;
        if (d2({ x: lx, y: ly }, eLists[k][ei]) < radius) {
          const after = Math.max(0, before - LANDING_DAMAGE);
          totalDamage += before - after;
          arr[ei] = after;
        }
      }
      eSh[k] = arr;
    }
    nextPlayers[enemyIdx] = { ...enemyP, structureHealth: eSh };
    if (totalDamage > 0) nextPlayers[actorIdx] = { ...actorP };
    return nextPlayers;
  }

  function findBestIllumSiteNear(x, y, maxRadius = Math.ceil(SAFETY_RADIUS.solar) + 2) {
    let best = { x: Math.round(x), y: Math.round(y), illum: 0 };
    for (let dy = -maxRadius; dy <= maxRadius; dy++) {
      for (let dx = -maxRadius; dx <= maxRadius; dx++) {
        const nx = Math.round(x + dx), ny = Math.round(y + dy);
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const dist = Math.hypot(dx, dy);
        if (dist > maxRadius) continue;
        const illum = ILLUM_MAP[ny * W + nx] || 0;
        if (illum > best.illum) best = { x: nx, y: ny, illum };
      }
    }
    return best;
  }

  function getCraterClusterScore(ci) {
    const c = CRATER_DATA[ci];
    if (!c) return 0;
    let score = c.size / 18;
    for (let oi = 0; oi < CRATER_DATA.length; oi++) {
      if (oi === ci) continue;
      const other = CRATER_DATA[oi];
      const dist = Math.hypot(c.cx - other.cx, c.cy - other.cy);
      if (dist > 120) continue;
      score += (other.size / 45) / Math.max(1, dist / 20);
    }
    return score;
  }

  function chooseStartCrater(otherBase, rng) {
    const ranked = CRATER_DATA.map((crater, ci) => {
      const illum = findBestIllumSiteNear(crater.cx, crater.cy, 10).illum;
      const cluster = getCraterClusterScore(ci);
      const otherPenalty = otherBase ? Math.max(0, 30 - Math.hypot(crater.cx - otherBase.x, crater.cy - otherBase.y)) * 2 : 0;
      return {
        ci,
        score: crater.size / 10 + cluster + illum * 60 - otherPenalty,
      };
    }).sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, Math.min(12, ranked.length));
    const weighted = top.map((item, idx) => ({
      ...item,
      pickWeight: Math.max(1, item.score - idx * 6 + rng() * 10),
    }));
    const totalWeight = weighted.reduce((sum, item) => sum + item.pickWeight, 0);
    let roll = rng() * Math.max(1, totalWeight);
    for (const item of weighted) {
      roll -= item.pickWeight;
      if (roll <= 0) return item.ci;
    }
    return weighted[0]?.ci ?? ranked[0]?.ci ?? 0;
  }

  function chooseBasePositionForCrater(craterIdx, rng) {
    const crater = CRATER_DATA[craterIdx];
    if (!crater) return snapToPSR(W / 2, H / 2);
    const jitter = 3 + Math.floor(rng() * 5);
    const dx = Math.round((rng() - 0.5) * jitter * 2);
    const dy = Math.round((rng() - 0.5) * jitter * 2);
    return snapToPSR(crater.cx + dx, crater.cy + dy);
  }

  function findTopIllumSitesNear(x, y, radius, limit = 8) {
    const candidates = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = Math.round(x + dx), ny = Math.round(y + dy);
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;
        const illum = ILLUM_MAP[ny * W + nx] ?? 0;
        candidates.push({ x:nx, y:ny, illum, dist });
      }
    }
    return candidates
      .sort((a, b) => b.illum - a.illum || a.dist - b.dist)
      .slice(0, limit);
  }

  function jitterToward(crater, site, rng, minDist = 2, maxDist = 7) {
    const angle = rng() * Math.PI * 2;
    const dist = minDist + rng() * (maxDist - minDist);
    const raw = {
      x: Math.round(site.x + Math.cos(angle) * dist),
      y: Math.round(site.y + Math.sin(angle) * dist),
    };
    const clamped = {
      x: clamp(raw.x, 0, W - 1),
      y: clamp(raw.y, 0, H - 1),
    };
    return d2(clamped, crater) < maxDist + 10 ? clamped : { x:site.x, y:site.y };
  }

  function chooseHubPlanForCrater(craterIdx, rng) {
    const crater = CRATER_DATA[craterIdx];
    if (!crater) return { habitatTarget:{ x:W/2, y:H/2 }, generatorType:"reactor", generatorTarget:{ x:W/2, y:H/2 } };
    const illumChoices = findTopIllumSitesNear(crater.cx, crater.cy, Math.ceil(SAFETY_RADIUS.solar) + 16, 10);
    const weighted = illumChoices
      .map((site, idx) => ({
        ...site,
        rankScore: (site.illum * 100) - site.dist * 1.4 - idx * 1.2 + (rng() - 0.5) * 8,
      }))
      .sort((a, b) => b.rankScore - a.rankScore);
    const site = weighted[Math.floor(rng() * Math.min(4, weighted.length || 1))] || { x:crater.cx, y:crater.cy, illum:0 };
    const habitatTarget = jitterToward(crater, site, rng, 2, 8);
    const generatorTarget = { x:site.x, y:site.y };
    const padTarget = jitterToward(crater, habitatTarget, rng, 8, 16);
    return {
      habitatTarget,
      generatorType: "solar",
      generatorTarget,
      padTarget,
      fallbackReactorTarget: { x: crater.cx, y: crater.cy },
      illumScore: site.illum,
    };
  }

  function updateSimPlayer(sim, pi, updater) {
    const key = pi === 0 ? "p1" : "p2";
    return { ...sim, [key]: updater(sim[key]) };
  }

  function getBotHub(player) {
    if (!player) return null;
    if ((player.habitats || []).length > 0) return player.habitats[0];
    return player.botMemory?.hubPlan?.habitatTarget || player.base;
  }

  function getAllRoverStates(player) {
    if (!player) return [];
    return [
      { roverIdx:0, rover:player },
      ...((player.extraRovers || []).map((rover, idx) => ({ roverIdx:idx + 1, rover }))),
    ];
  }

  function getRechargeCoverageScore(player, point) {
    if (!player || !point) return 0;
    const generators = [
      ...(player.panels || []).map(p => ({ ...p, kind:"solar" })),
      ...(player.reactors || []).map(r => ({ ...r, kind:"reactor" })),
    ];
    let score = 0;
    for (const generator of generators) {
      if (d2(generator, point) <= SAFETY_RADIUS[generator.kind]) {
        score += generator.kind === "reactor" ? 2.5 : 1;
      }
    }
    return score;
  }

  function chooseExpansionPlan(sim, actor, rng) {
    if (!actor) return null;
    const roverEntries = getAllRoverStates(actor);
    const weakestRover = roverEntries
      .map(entry => ({ ...entry, power: entry.rover.power ?? POWER_CAP }))
      .sort((a, b) => a.power - b.power)[0];
    const ranked = selectOperationalCraters(sim, actor, weakestRover?.rover ? { x:weakestRover.rover.x, y:weakestRover.rover.y } : getBotHub(actor));
    const targetCraterIdx = ranked[0]?.ci ?? actor.botMemory?.homeCraterIdx;
    const crater = CRATER_DATA[targetCraterIdx];
    if (!crater) return null;
    const illumChoices = findTopIllumSitesNear(crater.cx, crater.cy, Math.ceil(SAFETY_RADIUS.solar) + 20, 12);
    const pick = illumChoices[Math.floor(rng() * Math.min(5, illumChoices.length || 1))] || { x:crater.cx, y:crater.cy, illum:0 };
    const solarTarget = { x:pick.x, y:pick.y };
    const habitatTarget = jitterToward(crater, pick, rng, 2, 9);
    const padTarget = jitterToward(crater, habitatTarget, rng, 10, 18);
    return { craterIdx:targetCraterIdx, solarTarget, habitatTarget, padTarget, illum:pick.illum };
  }

  function tryBotPurchase(sim, pi, type, target, opts = {}) {
    const nextSim = buildHeadlessStructure(sim, pi, type, target, opts);
    return nextSim;
  }

  function estimateTravelPowerCost(dist, ice = 0, carrying = false) {
    const loadFactor = Math.min(3.0, 1.0 + (ice / 100) + (carrying ? 0.5 : 0));
    return POWER_BASE_DRAIN + POWER_MOVE_DRAIN * (dist / Math.max(1, ROVER_STEP)) * loadFactor;
  }

  function getPendingPickupTarget(player, roverPos) {
    if (!player) return null;
    const pads = player.landingPads || [];
    const pending = player.pendingDeliveries || [];
    if (!pads.length || !pending.length) return null;
    const grouped = pending
      .map(item => ({ item, pad: pads[item.padIdx], dist: pads[item.padIdx] ? d2(roverPos, pads[item.padIdx]) : Infinity }))
      .filter(entry => entry.pad)
      .sort((a, b) => a.dist - b.dist);
    return grouped[0]?.pad || null;
  }

  function pointInGeneratorCoverage(targets, point) {
    if (!point) return false;
    return (targets || []).some(target => d2(point, target) <= SAFETY_RADIUS[target.kind]);
  }

  function getRoverState(player, roverIdx) {
    return roverIdx === 0 ? player : (player.extraRovers || [])[roverIdx - 1];
  }

  function setRoverWaypointForPlayer(player, roverIdx, target) {
    if (!player || !target) return player;
    const waypoint = { x: Math.round(target.x), y: Math.round(target.y) };
    if (roverIdx === 0) {
      return { ...player, waypoints:[waypoint], currentWaypoint:null };
    }
    const extraRovers = [...(player.extraRovers || [])];
    const rover = extraRovers[roverIdx - 1];
    if (!rover) return player;
    extraRovers[roverIdx - 1] = { ...rover, waypoints:[waypoint], currentWaypoint:null };
    return { ...player, extraRovers };
  }

  function buildHeadlessStructure(sim, pi, type, target, opts = {}) {
    const players = [clonePlayerState(sim.p1), clonePlayerState(sim.p2)];
    const player = players[pi];
    if (!player) return sim;
    const pads = player.landingPads || [];
    const padFree = hasPlacementGrace(player.arrivalDay, sim.globalDay) || type === "pad" || opts.forceDirect === true;
    if (pads.length === 0 && !padFree && type !== "rover") return sim;
    const { costs } = calcAssetCosts(player.alloc || { mil:20, rd:20, econ:60, budget:20 });
    const cost = costs[type] ?? 999;
    const maxes = { solar: MAX_PANELS, reactor: MAX_REACTORS, habitat: MAX_HABITATS, rover: MAX_ROVERS, pad: MAX_PADS };
    const counts = {
      solar: player.panels.length,
      reactor: (player.reactors || []).length,
      habitat: (player.habitats || []).length,
      rover: (player.extraRovers || []).length,
      pad: (player.landingPads || []).length,
    };
    if ((counts[type] ?? 0) >= (maxes[type] ?? Infinity)) return sim;
    if ((player.budget ?? 0) < cost) return sim;

    let nextPlayer = clonePlayerState(player);
    nextPlayer.budget = (nextPlayer.budget ?? 0) - cost;
    nextPlayer.assetPts = (nextPlayer.assetPts ?? 0) + (ASSET_POINTS[type] ?? 0);

    if (type === "rover") {
      nextPlayer.extraRovers = [
        ...(nextPlayer.extraRovers || []),
        { x: nextPlayer.base.x, y: nextPlayer.base.y, waypoints:[], currentWaypoint:null, ice:0, carrying:null, status:"idle", power:POWER_CAP },
      ];
      nextPlayer.structureHealth = {
        ...nextPlayer.structureHealth,
        extraRovers: [...(nextPlayer.structureHealth?.extraRovers || []), 1.0],
      };
      players[pi] = nextPlayer;
      const impacted = applyPureLandingImpact(players, pi, nextPlayer.base.x, nextPlayer.base.y);
      return { ...sim, p1: impacted[0], p2: impacted[1], nextId: sim.nextId + 1 };
    }

    if (padFree) {
      const placed = { x: Math.round(target.x), y: Math.round(target.y) };
      if (type === "solar") {
        nextPlayer.panels = [...nextPlayer.panels, { ...placed, onRidge: RIDGE_MASK[placed.y * W + placed.x] === 1 }];
        nextPlayer.structureHealth = { ...nextPlayer.structureHealth, panels: [...(nextPlayer.structureHealth?.panels || []), 1.0] };
      } else if (type === "reactor") {
        nextPlayer.reactors = [...(nextPlayer.reactors || []), placed];
        nextPlayer.structureHealth = { ...nextPlayer.structureHealth, reactors: [...(nextPlayer.structureHealth?.reactors || []), 1.0] };
      } else if (type === "habitat") {
        nextPlayer.habitats = [...(nextPlayer.habitats || []), placed];
        nextPlayer.habitatPower = [...(nextPlayer.habitatPower || []), HABITAT_POWER_INIT];
        nextPlayer.structureHealth = { ...nextPlayer.structureHealth, habitats: [...(nextPlayer.structureHealth?.habitats || []), 1.0] };
      } else if (type === "pad") {
        nextPlayer.landingPads = [...(nextPlayer.landingPads || []), placed];
        nextPlayer.structureHealth = { ...nextPlayer.structureHealth, landingPads: [...(nextPlayer.structureHealth?.landingPads || []), 1.0] };
      }
      players[pi] = nextPlayer;
      if (type === "reactor") {
        players[pi] = applyPureReactorPlacementPenalty(players[pi], players[pi === 0 ? 1 : 0], placed.x, placed.y);
        return { ...sim, p1: players[0], p2: players[1], nextId: sim.nextId + 1 };
      }
      const impacted = applyPureLandingImpact(players, pi, placed.x, placed.y);
      return { ...sim, p1: impacted[0], p2: impacted[1], nextId: sim.nextId + 1 };
    }

    const padIdx = Math.min(opts.padIdx ?? 0, Math.max(0, pads.length - 1));
    nextPlayer.pendingDeliveries = [
      ...(nextPlayer.pendingDeliveries || []),
      { id: sim.nextId, type, padIdx, target: target ? { x: Math.round(target.x), y: Math.round(target.y) } : null },
    ];
    players[pi] = nextPlayer;
    return { ...sim, p1: players[0], p2: players[1], nextId: sim.nextId + 1 };
  }

  function ensureBotInitialSetup(sim, pi) {
    let nextSim = sim;
    let actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    if (!actor) return nextSim;
    const hubPlan = actor.botMemory?.hubPlan;
    if (!hubPlan) return nextSim;

    if ((actor.landingPads || []).length === 0 && (actor.budget ?? 0) >= BASE_ASSET_COSTS.pad) {
      nextSim = buildHeadlessStructure(nextSim, pi, "pad", hubPlan.padTarget || actor.base, { forceDirect:true });
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    }
    if ((actor.habitats || []).length === 0) {
      nextSim = buildHeadlessStructure(nextSim, pi, "habitat", hubPlan.habitatTarget, { forceDirect:true });
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    }
    if (((actor.reactors || []).length + actor.panels.length) === 0) {
      nextSim = buildHeadlessStructure(nextSim, pi, hubPlan.generatorType, hubPlan.generatorTarget, { forceDirect:true });
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    }
    if ((1 + ((actor.extraRovers || []).length)) < 2 && hubPlan.generatorType === "solar" && (actor.budget ?? 0) >= BASE_ASSET_COSTS.rover) {
      nextSim = buildHeadlessStructure(nextSim, pi, "rover", actor.base);
    }
    return updateSimPlayer(nextSim, pi, p => ({
      ...p,
      botMemory: {
        ...(p.botMemory || {}),
        initialSetupDone: (p.landingPads || []).length > 0 && (p.habitats || []).length > 0 && (((p.reactors || []).length + (p.panels || []).length) > 0),
      },
    }));
  }

  function getAccessibleRechargeTargets(sim, pi) {
    const actor = pi === 0 ? sim.p1 : sim.p2;
    const other = pi === 0 ? sim.p2 : sim.p1;
    if (!actor) return [];
    const shared = sim.powerGridState.mode === "shared";
    const sourcePlayers = shared && other ? [actor, other] : [actor];
    const targets = [];
    for (const source of sourcePlayers) {
      (source.panels || []).forEach((panel, idx) => {
        if ((source.structureHealth?.panels?.[idx] ?? 1.0) <= 0) return;
        targets.push({ x:panel.x, y:panel.y, kind:"solar", ownerId:source.id });
      });
      (source.reactors || []).forEach((reactor, idx) => {
        if ((source.structureHealth?.reactors?.[idx] ?? 1.0) <= 0) return;
        targets.push({ x:reactor.x, y:reactor.y, kind:"reactor", ownerId:source.id });
      });
    }
    return targets;
  }

  function getHostileZoneCountAtPoint(enemy, point, sharedGridActive) {
    if (!enemy || !point) return 0;
    const structures = [
      { list: enemy.habitats || [], type:"habitat", healths: enemy.structureHealth?.habitats || [] },
      { list: enemy.landingPads || [], type:"pad", healths: enemy.structureHealth?.landingPads || [] },
      { list: enemy.extraRovers || [], type:"rover", healths: enemy.structureHealth?.extraRovers || [] },
      ...(sharedGridActive ? [] : [
        { list: enemy.panels || [], type:"solar", healths: enemy.structureHealth?.panels || [] },
        { list: enemy.reactors || [], type:"reactor", healths: enemy.structureHealth?.reactors || [] },
      ]),
    ];
    let count = 0;
    for (const { list, type, healths } of structures) {
      list.forEach((struct, idx) => {
        if ((healths[idx] ?? 1.0) <= 0) return;
        if (d2(point, struct) < SAFETY_RADIUS[type]) count++;
      });
    }
    return count;
  }

  function estimateSharedGridBenefit(receiver, donor) {
    if (!receiver || !donor) return 0;
    const targets = [
      { x: receiver.x, y: receiver.y },
      ...(receiver.extraRovers || []).map(r => ({ x:r.x, y:r.y })),
      ...(receiver.habitats || []).map(h => ({ x:h.x, y:h.y })),
    ];
    const generators = [
      ...(donor.panels || []).map(p => ({ ...p, kind:"solar" })),
      ...(donor.reactors || []).map(r => ({ ...r, kind:"reactor" })),
    ];
    let count = 0;
    for (const target of targets) {
      if (generators.some(g => d2(g, target) <= SAFETY_RADIUS[g.kind])) count++;
    }
    return count;
  }

  function applyHeadlessDiplomacyDecision(sim, pi, action) {
    if (!sim.allowGridSharing) return sim;
    const players = [clonePlayerState(sim.p1), clonePlayerState(sim.p2)];
    const actor = players[pi];
    const other = players[pi === 0 ? 1 : 0];
    if (!actor || !other || !action) return sim;
    const actorId = pi + 1;
    const otherId = actorId === 1 ? 2 : 1;
    let powerGrid = { ...sim.powerGridState };
    const flags = { ...(sim.batchFlags || {}) };
    const keepReplayData = sim.keepReplayData !== false;
    if (action === "open" && powerGrid.mode !== "shared") {
      powerGrid = { mode:"offered", offeredBy: actorId, offeredTo: otherId };
      actor.scoreAdjustments = (actor.scoreAdjustments ?? 0) + 30;
      flags.offers = (flags.offers || 0) + 1;
      return {
        ...sim,
        p1: players[0],
        p2: players[1],
        powerGridState: powerGrid,
        batchFlags: flags,
        missionLog: keepReplayData ? [...(sim.missionLog || []), { round:sim.round, day:sim.day, globalDay:sim.globalDay, type:"grid", label:`P${actorId} opened its power grid to P${otherId}` }] : (sim.missionLog || []),
      };
    }
    if (action === "join" && powerGrid.mode === "offered" && powerGrid.offeredTo === actorId) {
      powerGrid = { mode:"shared", offeredBy: powerGrid.offeredBy, offeredTo: actorId };
      actor.scoreAdjustments = (actor.scoreAdjustments ?? 0) + 20;
      flags.joins = (flags.joins || 0) + 1;
      return {
        ...sim,
        p1: players[0],
        p2: players[1],
        powerGridState: powerGrid,
        batchFlags: flags,
        missionLog: keepReplayData ? [...(sim.missionLog || []), { round:sim.round, day:sim.day, globalDay:sim.globalDay, type:"grid", label:`P${actorId} joined P${powerGrid.offeredBy}'s power grid` }] : (sim.missionLog || []),
      };
    }
    if (action === "decouple" && powerGrid.mode === "shared" && !sim.permanentGridSharing) {
      powerGrid = { mode:"independent", offeredBy:null, offeredTo:null };
      actor.scoreAdjustments = (actor.scoreAdjustments ?? 0) - 20;
      flags.decouples = (flags.decouples || 0) + 1;
      return {
        ...sim,
        p1: players[0],
        p2: players[1],
        powerGridState: powerGrid,
        batchFlags: flags,
        missionLog: keepReplayData ? [...(sim.missionLog || []), { round:sim.round, day:sim.day, globalDay:sim.globalDay, type:"grid", label:`P${actorId} decoupled the shared power grid` }] : (sim.missionLog || []),
      };
    }
    return sim;
  }

  function selectOperationalCraters(sim, player, roverPos) {
    const anchor = getBotHub(player);
    const enemy = player?.id === 1 ? sim.p2 : sim.p1;
    const sharedGridActive = sim.powerGridState.mode === "shared";
    const homeCraterIdx = player?.botMemory?.homeCraterIdx ?? PIXEL_CRATER[Math.round(player.base.y) * W + Math.round(player.base.x)];
    const ranked = CRATER_DATA.map((crater, ci) => {
      const health = sim.craterHealth?.[ci] ?? 1.0;
      if (health <= 0.08) return null;
      const distHub = Math.max(1, d2(anchor, crater));
      const distRover = Math.max(1, d2(roverPos, crater));
      const distEnemy = enemy ? d2(enemy.base, crater) : distHub + 10;
      const illum = findBestIllumSiteNear(crater.cx, crater.cy, 8).illum;
       const hazard = getHostileZoneCountAtPoint(enemy, crater, sharedGridActive);
      const score = (health * crater.size * 2.5) / (10 + distHub * 0.8 + distRover * 0.4)
        + (distEnemy - distHub) * 0.08
        + illum * 18
        - hazard * 18
        + (ci === homeCraterIdx ? 15 : 0);
      return { ci, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return ranked;
  }

  function chooseBotDiplomacyAction(sim, pi) {
    const actor = pi === 0 ? sim.p1 : sim.p2;
    const other = pi === 0 ? sim.p2 : sim.p1;
    if (!sim.allowGridSharing || !actor || !other) return null;
    const selfBenefit = estimateSharedGridBenefit(actor, other);
    const otherBenefit = estimateSharedGridBenefit(other, actor);
    const actorGenerators = (actor.panels || []).length + (actor.reactors || []).length;
    if (sim.powerGridState.mode === "shared") {
      if (sim.permanentGridSharing) return null;
      if (otherBenefit - selfBenefit >= 2) return "decouple";
      return null;
    }
    if (sim.powerGridState.mode === "offered") {
      if (sim.powerGridState.offeredTo === actor.id && (selfBenefit >= 1 || actorGenerators === 0)) {
        return "join";
      }
      return null;
    }
    if (actorGenerators > 0 && otherBenefit >= 1) {
      if (actor.id === 1 || scorePlayerState(actor) >= scorePlayerState(other) - 25) {
        return "open";
      }
    }
    return null;
  }

  function planBotTurn(sim, pi, rng) {
    let nextSim = sim;
    const player = pi === 0 ? nextSim.p1 : nextSim.p2;
    if (!player || player.active === false || nextSim.globalDay < (player.arrivalDay ?? 0)) return nextSim;

    if (!player.botMemory?.initialized) {
      const homeCraterIdx = PIXEL_CRATER[Math.round(player.base.y) * W + Math.round(player.base.x)];
      const hubPlan = chooseHubPlanForCrater(homeCraterIdx, rng);
      nextSim = updateSimPlayer(nextSim, pi, p => ({
        ...p,
        botMemory: { ...(p.botMemory || {}), initialized:true, homeCraterIdx, hubPlan },
      }));
    }

    const updatedPlayer = pi === 0 ? nextSim.p1 : nextSim.p2;
    const action = chooseBotDiplomacyAction(nextSim, pi);
    if (action) nextSim = applyHeadlessDiplomacyDecision(nextSim, pi, action);

    let actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    const roverEntries = getAllRoverStates(actor);
    const weakestRover = roverEntries
      .map(entry => ({ ...entry, power: entry.rover.power ?? POWER_CAP, ice: entry.rover.ice ?? 0 }))
      .sort((a, b) => a.power - b.power || b.ice - a.ice)[0];
    const expansionPlan = chooseExpansionPlan(nextSim, actor, rng);
    const roverCount = getAllRoverStates(actor).length;
    const generatorCount = (actor.panels || []).length + (actor.reactors || []).length;
    const habitatCount = (actor.habitats || []).length;
    const effectiveDemand = roverCount + habitatCount;

    if (!actor.botMemory?.initialSetupDone || (actor.habitats || []).length === 0 || (((actor.reactors || []).length + actor.panels.length) === 0)) {
      nextSim = ensureBotInitialSetup(nextSim, pi);
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    } else if ((actor.landingPads || []).length === 0 && (actor.budget ?? 0) >= BASE_ASSET_COSTS.pad) {
      nextSim = buildHeadlessStructure(nextSim, pi, "pad", actor.botMemory?.hubPlan?.padTarget || actor.base, { forceDirect: hasPlacementGrace(actor.arrivalDay, nextSim.globalDay) });
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    }

    if ((actor.reactors || []).length === 0 && (actor.landingPads || []).length > 0 && (actor.budget ?? 0) >= (BASE_ASSET_COSTS.reactor + 30)) {
      const lowIllumHub = (actor.botMemory?.hubPlan?.illumScore ?? 0) < 0.48;
      const reactorNeed = lowIllumHub || (actor.panels || []).length >= Math.max(3, (actor.habitats || []).length + 1);
      if (nextSim.round >= 4 && reactorNeed) {
        nextSim = buildHeadlessStructure(nextSim, pi, "reactor", actor.botMemory?.hubPlan?.fallbackReactorTarget || getBotHub(actor));
        actor = pi === 0 ? nextSim.p1 : nextSim.p2;
      }
    }

    const panelTarget = Math.max(2, roverCount + (actor.habitats || []).length - ((actor.reactors || []).length * 2));
    const expansionNeed = expansionPlan && getRechargeCoverageScore(actor, expansionPlan.habitatTarget) < 1.4;
    if (expansionNeed && (actor.budget ?? 0) >= BASE_ASSET_COSTS.solar && (actor.panels || []).length < panelTarget) {
      nextSim = tryBotPurchase(nextSim, pi, "solar", expansionPlan.solarTarget, { forceDirect: hasPlacementGrace(actor.arrivalDay, nextSim.globalDay) });
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    }
    if (expansionPlan && generatorCount > effectiveDemand && (actor.habitats || []).length < Math.max(2, Math.ceil(roverCount / 2)) && (actor.budget ?? 0) >= BASE_ASSET_COSTS.habitat && nextSim.round >= 3) {
      const farFromHub = d2(expansionPlan.habitatTarget, getBotHub(actor)) > SAFETY_RADIUS.habitat * 0.7;
      if (farFromHub) {
        nextSim = tryBotPurchase(nextSim, pi, "habitat", expansionPlan.habitatTarget, { forceDirect: hasPlacementGrace(actor.arrivalDay, nextSim.globalDay) });
        actor = pi === 0 ? nextSim.p1 : nextSim.p2;
      }
    }
    if ((actor.landingPads || []).length < 2 && generatorCount > effectiveDemand && expansionPlan && (actor.budget ?? 0) >= BASE_ASSET_COSTS.pad && nextSim.round >= 3) {
      const farPad = d2(expansionPlan.padTarget, getBotHub(actor)) > SAFETY_RADIUS.pad * 0.8;
      if (farPad) {
        nextSim = tryBotPurchase(nextSim, pi, "pad", expansionPlan.padTarget, { forceDirect: hasPlacementGrace(actor.arrivalDay, nextSim.globalDay) });
        actor = pi === 0 ? nextSim.p1 : nextSim.p2;
      }
    }
    if (generatorCount > effectiveDemand && (1 + (actor.extraRovers || []).length) < Math.min(4, (actor.habitats || []).length + 2) && (actor.budget ?? 0) >= BASE_ASSET_COSTS.rover && (((actor.reactors || []).length + actor.panels.length) > 0)) {
      nextSim = buildHeadlessStructure(nextSim, pi, "rover", actor.base);
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
    }

    const totalRovers = 1 + ((actor.extraRovers || []).length);
    for (let roverIdx = 0; roverIdx < totalRovers; roverIdx++) {
      actor = pi === 0 ? nextSim.p1 : nextSim.p2;
      const rover = getRoverState(actor, roverIdx);
      if (!rover) continue;
      const roverPos = { x: rover.x, y: rover.y };
      const roverPower = rover.power ?? actor.power ?? POWER_CAP;
      const roverIce = rover.ice ?? actor.ice ?? 0;
      const pendingPickup = getPendingPickupTarget(actor, roverPos);
      const rechargeTargets = getAccessibleRechargeTargets(nextSim, pi);
      const enemy = pi === 0 ? nextSim.p2 : nextSim.p1;
      const sharedGridActive = nextSim.powerGridState.mode === "shared";
      const inRechargeZone = pointInGeneratorCoverage(rechargeTargets, roverPos);
      const nearestRecharge = rechargeTargets
        .map(target => {
          const hazard = getHostileZoneCountAtPoint(enemy, target, sharedGridActive);
          const foreignPenalty = target.ownerId !== actor.id ? (roverPower < POWER_LOW * 0.35 ? 4 : 18) : 0;
          const hazardPenalty = hazard * (roverPower < POWER_LOW * 0.35 ? 8 : 48);
          const powerBias = target.kind === "reactor" ? -10 : 0;
          return { ...target, score: d2(roverPos, target) + foreignPenalty + hazardPenalty + powerBias };
        })
        .sort((a, b) => a.score - b.score)[0];
      const nearestRechargeDist = nearestRecharge ? d2(roverPos, nearestRecharge) : Infinity;
      const rechargeReserve = nearestRecharge ? estimateTravelPowerCost(nearestRechargeDist, roverIce, !!rover.carrying) + 14 : POWER_LOW * 2.2;
      const departureFloor = Math.max(POWER_CAP * 0.82, rechargeReserve + 16);
      if (rover.carrying?.target) {
        nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, rover.carrying.target));
        continue;
      }
      if (inRechargeZone && roverPower < departureFloor) {
        nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, nearestRecharge || roverPos));
        continue;
      }
      if (pendingPickup && roverIce <= ICE_CAP * 0.05 && roverPower > rechargeReserve * 1.1) {
        nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, pendingPickup));
        continue;
      }
      if (nearestRecharge && roverPower <= rechargeReserve) {
        nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, nearestRecharge));
        continue;
      }
      if (roverIce > ICE_CAP * 0.3 && actor.habitats?.length) {
        nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, getBotHub(p)));
        continue;
      }
      if (roverPower < Math.max(POWER_LOW * 1.6, 38) && nearestRecharge) {
        nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, nearestRecharge));
        continue;
      }
      const ranked = selectOperationalCraters(nextSim, actor, roverPos);
      const targetCrater = CRATER_DATA[ranked[Math.min(roverIdx, Math.max(0, ranked.length - 1))]?.ci ?? actor.botMemory.homeCraterIdx];
      if (targetCrater) {
        const targetPoint = { x: targetCrater.cx, y: targetCrater.cy };
        const toMine = estimateTravelPowerCost(d2(roverPos, targetPoint), roverIce, !!rover.carrying);
        const toRechargeAfterMine = nearestRecharge ? estimateTravelPowerCost(d2(targetPoint, nearestRecharge), Math.min(ICE_CAP, roverIce + 40), false) : POWER_LOW * 2.5;
        const projectedMineTrip = toMine + toRechargeAfterMine + 14;
        if (nearestRecharge && roverPower <= projectedMineTrip) {
          nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, nearestRecharge));
        } else {
          nextSim = updateSimPlayer(nextSim, pi, p => setRoverWaypointForPlayer(p, roverIdx, targetPoint));
        }
      }
    }

    return nextSim;
  }

  function resolveHeadlessDay(sim) {
    const keepReplayData = sim.keepReplayData !== false;
    const sharedGridActive = sim.powerGridState.mode === "shared";
    const [chargedP1, chargedP2] = allocateDailyPower([sim.p1, sim.p2], sim.globalDay, sharedGridActive);
    const ch = new Float32Array(sim.craterHealth);
    const [np1, _ch2, evs1] = stepPlayer(chargedP1, ch, sim.globalDay);
    let np2 = sim.p2;
    let ch3 = _ch2;
    let evs2 = [];
    if (sim.p2) {
      [np2, ch3, evs2] = stepPlayer(chargedP2, ch, sim.globalDay);
      for (let i = 0; i < ch3.length; i++) ch3[i] = Math.min(_ch2[i], ch3[i]);
    }

    const applyDecayToOwner = (owner, enemyPos, attackMil, defenseMil) => {
      const sh = { ...owner.structureHealth };
      const structTypes = [
        { key: "panels", list: owner.panels, type: "solar" },
        { key: "reactors", list: owner.reactors || [], type: "reactor" },
        { key: "habitats", list: owner.habitats || [], type: "habitat" },
        { key: "extraRovers", list: owner.extraRovers || [], type: "rover" },
        { key: "landingPads", list: owner.landingPads || [], type: "pad" },
      ];
      const newSH = {};
      let damageDone = 0;
      const _PASSIVE_DECAY = physOverrides.PASSIVE_DECAY != null ? physOverrides.PASSIVE_DECAY : PASSIVE_DECAY;
      const _HOSTILE_DECAY = physOverrides.HOSTILE_DECAY != null ? physOverrides.HOSTILE_DECAY : HOSTILE_DECAY;
      const defMul = MIL_DEFENSE_SCALE + (1 - MIL_DEFENSE_SCALE) * (1 / Math.max(0.1, defenseMil));
      const hostileDecayEff = _HOSTILE_DECAY * attackMil * defMul;
      let violationCount = 0;
      for (const { key, list, type } of structTypes) {
        const healths = [...(sh[key] || list.map(() => 1.0))];
        for (let idx = 0; idx < list.length; idx++) {
          const struct = list[idx];
          const radius = SAFETY_RADIUS[type];
          const generatorSharedSafe = sharedGridActive && (type === "solar" || type === "reactor");
          const inZone = !generatorSharedSafe && d2(enemyPos, struct) < radius;
          const decay = inZone ? hostileDecayEff : _PASSIVE_DECAY;
          if (inZone) {
            damageDone += hostileDecayEff;
            violationCount += 1;
          }
          healths[idx] = Math.max(0, (healths[idx] ?? 1.0) - decay);
        }
        newSH[key] = healths;
      }
      return {
        updatedOwner: {
          ...owner,
          structureHealth: newSH,
          safetyViolations: (owner.safetyViolations ?? 0) + violationCount,
        },
        damageDone,
      };
    };

    const mil1 = np1.milScore ?? 1.0;
    const mil2 = np2?.milScore ?? 1.0;
    const { updatedOwner: dnp1, damageDone: dmgByP2 } = sim.p2
      ? applyDecayToOwner(np1, { x: np2.x, y: np2.y }, mil2, mil1)
      : { updatedOwner: np1, damageDone: 0 };
    const { updatedOwner: dnp2, damageDone: dmgByP1 } = sim.p2
      ? applyDecayToOwner(np2, { x: np1.x, y: np1.y }, mil1, mil2)
      : { updatedOwner: np2, damageDone: 0 };
    let fnp1 = { ...dnp1 };
    let fnp2 = dnp2 ? { ...dnp2 } : null;

    const events = [
      ...evs1.map(ev => ({ ...ev, actor: 1 })),
      ...evs2.map(ev => ({ ...ev, actor: 2 })),
    ];
    const mined1 = evs1.filter(e => e.type === "mine").map(e => e.craterIdx);
    const mined2 = evs2.filter(e => e.type === "mine").map(e => e.craterIdx);
    const contestedToday = mined1.some(ci => mined2.includes(ci));
    const missionLog = keepReplayData
      ? [
          ...(sim.missionLog || []),
          ...events.map(ev => ({
            round: sim.round, day: sim.day, globalDay: sim.globalDay,
            type: ev.type, actor: ev.actor, roverId: ev.roverId,
            kg: ev.kg, craterIdx: ev.craterIdx, itemType: ev.itemType
          })),
        ]
      : (sim.missionLog || []);

    const newGlobalDay = sim.globalDay + 1;
    const newDay = sim.day + 1;
    let newRound = sim.round;
    let newCR = [...sim.claimR];
    let roundEnded = false;
    let history = keepReplayData ? [...(sim.history || [])] : (sim.history || []);
    let efnp1 = null, efnp2 = null;

    if (newDay >= DAYS_PER_ROUND) {
      const dep1 = evs1.filter(e => e.type === "deposit").reduce((s, e) => s + e.kg, 0);
      const dep2 = evs2.filter(e => e.type === "deposit").reduce((s, e) => s + e.kg, 0);
      newCR[0] = Math.min(220, newCR[0] + Math.min(18, dep1 / 18));
      if (sim.p2) newCR[1] = Math.min(220, newCR[1] + Math.min(18, dep2 / 18));

      const E1 = fnp1.econ ?? E_INIT, E2 = fnp2?.econ ?? E_INIT;
      const T1 = fnp1.assetPts ?? 0, T2 = fnp2?.assetPts ?? 0;
      const M1 = fnp1.milStock ?? 1, M2 = fnp2?.milStock ?? 1;
      const E_max = Math.max(E1, E2), T_max = Math.max(T1, T2), M_max = Math.max(M1, M2);
      const processEconomy = (p, E, T, M) => {
        if (p.active === false) return p;
        const alloc = p.alloc || { mil:15, rd:15, econ:50, budget:20 };
        const totalPct = (alloc.mil + alloc.rd + alloc.econ + (alloc.budget || 0)) || 1;
        const I_E = alloc.econ / totalPct;
        const I_R = alloc.rd / totalPct;
        const I_M = alloc.mil / totalPct;
        const I_B = (alloc.budget || 0) / totalPct;
        const C = calcCompetitiveness(E, T, M, E_max, T_max, M_max);
        const bonusCredits = Math.round(I_B * (p.budget ?? 0));
        const newE = Math.max(0.5, E + calcDeltaE(I_E, C, p.rdAccum ?? 0));
        const newR = Math.max(0, (p.rdAccum ?? 0) + calcDeltaR(I_R, C));
        const newM = Math.max(0.1, M + calcDeltaM(I_M, M));
        const newBudget = Math.max(0, calcBudget(newE) + bonusCredits);
        return { ...p, econ: newE, rdAccum: newR, milStock: newM, milScore: calcMilScore(newM), budget: newBudget };
      };
      efnp1 = processEconomy(fnp1, E1, T1, M1);
      efnp2 = sim.p2 ? processEconomy(fnp2, E2, T2, M2) : null;
      if (keepReplayData) {
        history = [...history, {
          r: sim.round,
          d1: Math.round(efnp1.iceDeposited),
          d2: Math.round(efnp2?.iceDeposited ?? 0),
          dep1: Math.round(dep1),
          dep2: Math.round(dep2),
          bud1: Math.round(efnp1.budget),
          bud2: Math.round(efnp2?.budget ?? 0),
        }];
      }
      newRound = sim.round + 1;
      roundEnded = true;
    }

    const batchFlags = {
      ...(sim.batchFlags || {}),
      sharedDays: (sim.batchFlags?.sharedDays || 0) + (sharedGridActive ? 1 : 0),
      contestedDays: (sim.batchFlags?.contestedDays || 0) + (contestedToday ? 1 : 0),
    };

    const depletedOut = isMapDepleted(ch3);
    const fixedOut = sim.missionEndMode === "fixed" && roundEnded && newRound > sim.totalRounds;
    const nextPhase = fixedOut || depletedOut ? PHASE.DONE : PHASE.PLAYING;
    return {
      ...sim,
      p1: roundEnded ? efnp1 : fnp1,
      p2: sim.p2 ? (roundEnded ? efnp2 : fnp2) : null,
      craterHealth: ch3,
      claimR: newCR,
      round: roundEnded ? Math.min(newRound, sim.totalRounds) : sim.round,
      day: roundEnded ? 0 : newDay,
      globalDay: newGlobalDay,
      phase: nextPhase,
      missionLog,
      lastEvents: keepReplayData ? events : [],
      history,
      batchFlags,
    };
  }

  function simulateBotGame(config, seed, opts = {}) {
    const storeReplay = opts.storeReplay !== false;
    const rng = makeSeededRng(seed);
    const p1Crater = chooseStartCrater(null, rng);
    const p1Base = chooseBasePositionForCrater(p1Crater, rng);
    let sim = {
      phase: PHASE.PLAYING,
      keepReplayData: storeReplay,
      totalRounds: config.totalRounds,
      missionEndMode: config.missionEndMode,
      allowGridSharing: config.gridSharingEnabled,
      permanentGridSharing: config.gridSharingPermanent,
      p1: makePlayer(p1Base, 1, "#ffdc00"),
      p2: config.scenarioPreset === "unevenArrival" ? null : makePlayer(chooseBasePositionForCrater(chooseStartCrater(p1Base, rng), rng), 2, "#b000ff"),
      craterHealth: new Float32Array(CRATER_DATA.length).fill(1.0),
      round: 1,
      day: 0,
      globalDay: 0,
      history: [],
      missionLog: [],
      lastEvents: [],
      claimR: [80, 80],
      powerGridState: { mode:"independent", offeredBy:null, offeredTo:null },
      batchFlags: { offers:0, joins:0, decouples:0, sharedDays:0, contestedDays:0 },
      nextId: 1,
    };
    const frames = storeReplay ? [snapshotSimState(sim)] : null;
    const maxDays = config.missionEndMode === "depletion" ? 2500 : config.totalRounds * DAYS_PER_ROUND + 2;

    while (sim.phase !== PHASE.DONE && sim.globalDay < maxDays) {
      if (config.scenarioPreset === "unevenArrival" && !sim.p2 && sim.globalDay >= config.arrivalDelay) {
        const p2Crater = chooseStartCrater(sim.p1?.base, rng);
        const p2Base = chooseBasePositionForCrater(p2Crater, rng);
        sim = {
          ...sim,
          p2: makePlayer(p2Base, 2, "#b000ff", { arrivalDay: config.arrivalDelay }),
          missionLog: storeReplay ? [...sim.missionLog, { round:sim.round, day:sim.day, globalDay:sim.globalDay, type:"arrival", label:"P2 arrived and established a base" }] : sim.missionLog,
        };
        if (storeReplay) frames.push(snapshotSimState(sim));
      }
      sim = planBotTurn(sim, 0, rng);
      sim = planBotTurn(sim, 1, rng);
      sim = resolveHeadlessDay(sim);
      if (storeReplay) frames.push(snapshotSimState(sim));
    }

    const score1 = scorePlayerState(sim.p1);
    const score2 = scorePlayerState(sim.p2);
    const totalMapIce = getTotalMapIce(config.physOverrides);
    const totalExtracted = CRATER_DATA.reduce((sum, crater, ci) => {
      const remaining = sim.craterHealth[ci] ?? 1;
      return sum + (1 - remaining) * getCraterIceCapacity(crater, config.physOverrides?.DEPLETION_RATE);
    }, 0);
    return {
      seed,
      config,
      frames: frames || undefined,
      missionLog: storeReplay ? [...sim.missionLog] : undefined,
      summary: {
        winner: score1 > score2 ? 1 : score2 > score1 ? 2 : 0,
        score1, score2,
        ice1: sim.p1?.iceDeposited ?? 0,
        ice2: sim.p2?.iceDeposited ?? 0,
        ap1: sim.p1?.assetPts ?? 0,
        ap2: sim.p2?.assetPts ?? 0,
        vio1: sim.p1?.safetyViolations ?? 0,
        vio2: sim.p2?.safetyViolations ?? 0,
        counts1: structureCounts(sim.p1),
        counts2: structureCounts(sim.p2),
        offers: sim.batchFlags.offers || 0,
        joins: sim.batchFlags.joins || 0,
        decouples: sim.batchFlags.decouples || 0,
        sharedDays: sim.batchFlags.sharedDays || 0,
        contestedDays: sim.batchFlags.contestedDays || 0,
        cratersDepleted: CRATER_DATA.filter((_, ci) => (sim.craterHealth[ci] ?? 1) < 0.2).length,
        durationDays: sim.globalDay,
        totalExtracted,
        totalMapIce,
        extractedPct: totalExtracted / Math.max(1, totalMapIce),
      },
    };
  }

  function summarizeBatchRuns(config, runs) {
    const avg = fn => runs.reduce((sum, run) => sum + fn(run), 0) / Math.max(1, runs.length);
    const p1Wins = runs.filter(r => r.summary.winner === 1).length;
    const p2Wins = runs.filter(r => r.summary.winner === 2).length;
    const draws = runs.length - p1Wins - p2Wins;
    return {
      config,
      runs: runs.map(run => ({ seed:run.seed, config:run.config, summary:run.summary })),
      totalRuns: runs.length,
      p1WinRate: p1Wins / Math.max(1, runs.length),
      p2WinRate: p2Wins / Math.max(1, runs.length),
      drawRate: draws / Math.max(1, runs.length),
      avgScore1: avg(r => r.summary.score1),
      avgScore2: avg(r => r.summary.score2),
      avgIce1: avg(r => r.summary.ice1),
      avgIce2: avg(r => r.summary.ice2),
      avgAp1: avg(r => r.summary.ap1),
      avgAp2: avg(r => r.summary.ap2),
      avgVio1: avg(r => r.summary.vio1),
      avgVio2: avg(r => r.summary.vio2),
      avgDepleted: avg(r => r.summary.cratersDepleted),
      avgSharedDays: avg(r => r.summary.sharedDays),
      avgContestedDays: avg(r => r.summary.contestedDays),
      avgExtracted: avg(r => r.summary.totalExtracted),
      avgExtractedPct: avg(r => r.summary.extractedPct),
      totalMapIce: runs[0]?.summary.totalMapIce ?? getTotalMapIce(config.physOverrides),
      offerRate: runs.filter(r => r.summary.offers > 0).length / Math.max(1, runs.length),
      joinRate: runs.filter(r => r.summary.joins > 0).length / Math.max(1, runs.length),
      decoupleRate: runs.filter(r => r.summary.decouples > 0).length / Math.max(1, runs.length),
    };
  }

  function loadReplayFrame(run, frameIdx) {
    const frame = run?.frames?.[frameIdx];
    if (!frame) return;
    setReplayFrameIndex(frameIdx);
    applyFrameSnapshot(frame, run.missionLog || []);
  }

  async function watchReplayRun(run) {
    if (!run) return;
    setUndoStack([]);
    setReplayLoading(true);
    setReplayPlaying(false);
    setSimMode("analysis");
    setScenarioPreset(run.config?.scenarioPreset || "standard");
    setTotalRounds(run.config?.totalRounds || 12);
    setMissionEndMode(run.config?.missionEndMode || "fixed");
    setArrivalDelay(run.config?.arrivalDelay || 5);
    setGridSharingEnabled(run.config?.gridSharingEnabled ?? true);
    setGridSharingPermanent(run.config?.gridSharingPermanent ?? false);
    await new Promise(resolve => setTimeout(resolve, 0));
    const replayData = run.frames ? run : simulateBotGame(run.config, run.seed, { storeReplay:true });
    setReplayRun(replayData);
    loadReplayFrame(replayData, 0);
    setReplayLoading(false);
  }

  function exitReplay() {
    setReplayPlaying(false);
    setReplayRun(null);
    setReplayFrameIndex(0);
    setPhase(PHASE.BATCH);
  }

  async function startBatchRunner() {
    const config = {
      scenarioPreset,
      totalRounds,
      missionEndMode,
      arrivalDelay,
      gridSharingEnabled,
      gridSharingPermanent,
      physOverrides: { ...physOverrides },
      runCount: batchRunCount,
    };
    setBatchRunning(true);
    setUndoStack([]);
    setBatchResult(null);
    setBatchProgress({ completed:0, total:batchRunCount, currentSeed:null });
    setReplayRun(null);
    setReplayPlaying(false);
    setPhase(PHASE.BATCH);
    const baseSeed = Date.now() & 0xffffffff;
    const runs = [];
    for (let i = 0; i < batchRunCount; i++) {
      const seed = (baseSeed + i * 9973) >>> 0;
      setBatchProgress({ completed:i, total:batchRunCount, currentSeed:seed });
      runs.push(simulateBotGame(config, seed));
      if (i % 2 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const summary = summarizeBatchRuns(config, runs);
    setBatchProgress({ completed:batchRunCount, total:batchRunCount, currentSeed:null });
    setBatchResult(summary);
    setBatchRunning(false);
  }

  const waitForPaint = async (frames = 2) => {
    for (let i = 0; i < frames; i++) {
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
  };

  const gridStatusLabel = (gridState) => {
    if (gridState?.mode === "shared") return "GRID SHARED";
    if (gridState?.mode === "offered" && gridState?.offeredBy && gridState?.offeredTo) {
      return `GRID OFFER P${gridState.offeredBy}\u2192P${gridState.offeredTo}`;
    }
    return "GRID INDEPENDENT";
  };

  const infrastructureInline = (player) => {
    const counts = structureCounts(player);
    return `🏠×${counts.habitats} ☀×${counts.panels} ☢×${counts.reactors} 🚗×${counts.rovers} 🛬×${counts.pads}`;
  };

  const padNum = (value, width=4) => String(Math.round(value ?? 0)).padStart(width, " ");

  const composeGifFrame = (frame) => {
    const mapCanvas = canvasRef.current;
    const composed = document.createElement("canvas");
    composed.width = W;
    composed.height = H + GIF_OVERLAY_HEIGHT;
    const ctx = composed.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, composed.width, composed.height);
    ctx.drawImage(mapCanvas, 0, 0, W, H);

    const overlayY = H;
    ctx.fillStyle = "#020914";
    ctx.fillRect(0, overlayY, W, GIF_OVERLAY_HEIGHT);
    ctx.strokeStyle = "rgba(90,140,200,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, overlayY + 0.5);
    ctx.lineTo(W, overlayY + 0.5);
    ctx.stroke();

    const p1Frame = frame.p1;
    const p2Frame = frame.p2;
    const score1Frame = Math.round(scorePlayerState(p1Frame));
    const score2Frame = Math.round(scorePlayerState(p2Frame));
    const totalMapIce = getTotalMapIce(physOverrides);
    const totalExtracted = CRATER_DATA.reduce((sum, crater, ci) => {
      const remaining = frame.craterHealth?.[ci] ?? 1;
      return sum + getCraterIceCapacity(crater, physOverrides.DEPLETION_RATE != null ? physOverrides.DEPLETION_RATE : DEPLETION_RATE) * (1 - remaining);
    }, 0);
    const extractionPct = (totalExtracted / Math.max(1, totalMapIce)) * 100;
    const leftMaxWidth = W - 250;
    const p2ArrivalDays = scenarioPreset === "unevenArrival" && !p2Frame && frame.globalDay < arrivalDelay
      ? Math.max(0, arrivalDelay - frame.globalDay)
      : null;

    ctx.textBaseline = "top";
    ctx.font = "12px 'Orbitron', 'JetBrains Mono', monospace";
    ctx.fillStyle = "#466882";
    ctx.fillText("PSR ICE MINING MISSION SNAPSHOT", 14, overlayY + 8, leftMaxWidth);

    ctx.font = "14px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#ffd700";
    ctx.fillText(
      `P1 ${padNum(score1Frame, 5)} | ICE ${padNum(p1Frame?.iceDeposited, 4)}kg | VIO ${padNum(p1Frame?.safetyViolations, 2)} | ${infrastructureInline(p1Frame)}`,
      14,
      overlayY + 28,
      leftMaxWidth,
    );
    ctx.fillStyle = "#d274ff";
    ctx.fillText(
      `P2 ${padNum(score2Frame, 5)} | ICE ${padNum(p2Frame?.iceDeposited, 4)}kg | VIO ${padNum(p2Frame?.safetyViolations, 2)} | ${infrastructureInline(p2Frame)}`,
      14,
      overlayY + 48,
      leftMaxWidth,
    );

    ctx.textAlign = "right";
    ctx.fillStyle = "#7fd9ff";
    ctx.fillText(`EXTRACTED ${padNum(totalExtracted, 5)} / ${padNum(totalMapIce, 5)} kg`, W - 14, overlayY + 8);
    ctx.fillText(`MAP DEPLETION ${String(extractionPct.toFixed(1)).padStart(5, " ")}%`, W - 14, overlayY + 28);
    ctx.fillText(gridStatusLabel(frame.powerGridState), W - 14, overlayY + 48);

    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.font = "13px 'JetBrains Mono', monospace";
    ctx.fillStyle = "rgba(230,245,255,0.92)";
    const stamp = `R${frame.round} • D${frame.day + 1}/${DAYS_PER_ROUND} • DAY ${frame.globalDay + 1}`;
    const stampW = ctx.measureText(stamp).width;
    const boxW = stampW + 16;
    const boxH = 24;
    const boxX = W - boxW - 12;
    const boxY = H - boxH - 10;
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = "rgba(120,180,255,0.24)";
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
    ctx.fillStyle = "rgba(230,245,255,0.92)";
    ctx.fillText(stamp, W - 20, H - 16);

    if (p2ArrivalDays != null) {
      const arrivalText = `P2 ARRIVES IN ${p2ArrivalDays} DAY${p2ArrivalDays === 1 ? "" : "S"}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.font = "13px 'JetBrains Mono', monospace";
      const arrivalW = ctx.measureText(arrivalText).width;
      const arrivalBoxW = arrivalW + 16;
      const arrivalBoxH = 24;
      const arrivalBoxX = 12;
      const arrivalBoxY = H - arrivalBoxH - 10;
      ctx.fillStyle = "rgba(2,8,18,0.78)";
      ctx.fillRect(arrivalBoxX, arrivalBoxY, arrivalBoxW, arrivalBoxH);
      ctx.strokeStyle = "rgba(120,180,255,0.24)";
      ctx.strokeRect(arrivalBoxX + 0.5, arrivalBoxY + 0.5, arrivalBoxW - 1, arrivalBoxH - 1);
      ctx.fillStyle = "#7fd9ff";
      ctx.fillText(arrivalText, arrivalBoxX + 8, H - 16);
    }

    return composed;
  };

  async function exportMissionGif() {
    if (gifExporting || !canvasRef.current || !p1) return;
    setGifExporting(true);
    const savedSnapshot = captureUndoSnapshot();
    gifSavedSnapshotRef.current = savedSnapshot;
    const savedReplayRun = replayRun;
    const savedReplayFrameIndex = replayFrameIndex;
    const savedReplayPlaying = replayPlaying;
    try {
      setReplayPlaying(false);
      const sourceFrames = replayRun?.frames?.length
        ? replayRun.frames
        : liveTimeline.map(({ __key, ...frame }) => frame);
      const logSource = replayRun?.missionLog?.length ? replayRun.missionLog : missionLog;
      const framesToExport = sourceFrames.length ? sourceFrames : [snapshotLiveFrame()];
      const gif = new GIF({
        workers: 2,
        quality: 10,
        width: W,
        height: H + GIF_OVERLAY_HEIGHT,
        workerScript: gifWorkerUrl,
      });

      // Phase 1: render each frame and compress to a PNG blob (~10x smaller than raw pixels).
      // This keeps our own accumulation cheap while the browser can GC the composed canvases immediately.
      const frameBlobs = [];
      for (const frame of framesToExport) {
        applyFrameSnapshot(frame, logSource);
        await waitForPaint(2);
        const composed = composeGifFrame(frame);
        const blob = await new Promise(resolve => composed.toBlob(resolve, "image/png"));
        frameBlobs.push(blob);
      }

      // Phase 2: decode blobs one at a time into a single reusable canvas and feed GIF.js.
      // Only one decoded frame lives in memory at a time on our side.
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = W;
      tempCanvas.height = H + GIF_OVERLAY_HEIGHT;
      const tempCtx = tempCanvas.getContext("2d");
      for (let i = 0; i < frameBlobs.length; i++) {
        const bitmap = await createImageBitmap(frameBlobs[i]);
        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(bitmap, 0, 0);
        bitmap.close();
        frameBlobs[i] = null; // release blob reference so GC can reclaim it
        gif.addFrame(tempCanvas, { copy: true, delay: GIF_FRAME_DELAY });
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on("finished", resolve);
        gif.on("abort", () => reject(new Error("GIF export aborted")));
        gif.render();
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `psr_mission_${replayRun ? "replay" : "live"}_day${globalDay + 1}.gif`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      if (savedReplayRun?.frames?.[savedReplayFrameIndex]) {
        setReplayRun(savedReplayRun);
        setReplayFrameIndex(savedReplayFrameIndex);
        applyFrameSnapshot(savedReplayRun.frames[savedReplayFrameIndex], savedReplayRun.missionLog || []);
        setReplayPlaying(savedReplayPlaying);
      } else {
        setReplayRun(null);
        setReplayFrameIndex(0);
        setReplayPlaying(false);
        applyUndoSnapshot(savedSnapshot);
      }
      setGifExporting(false);
    }
  }

  const plotSource = useMemo(() => {
    const frames = replayRun?.frames?.length
      ? replayRun.frames
      : liveTimeline.length
        ? liveTimeline.map(({ __key, ...frame }) => frame)
        : (p1 ? [snapshotLiveFrame()] : []);
    const log = replayRun?.missionLog?.length ? replayRun.missionLog : missionLog;
    return { frames, log };
  }, [
    replayRun, liveTimeline, missionLog, p1, p2, round, day, globalDay,
    claimR, history, powerGridState, craterHealth, phase
  ]);

  const plotDefinitions = useMemo(() => {
    // Collapse to one frame per global day (last frame wins — has the most log
    // entries and the most up-to-date player state for that day).
    const allFrames = plotSource.frames || [];
    const dayMap = new Map();
    allFrames.forEach(f => dayMap.set(f.globalDay ?? 0, f));
    const frames = Array.from(dayMap.values());
    const log = plotSource.log || [];
    if (!frames.length) return [];

    const xLabels = frames.map(f => `D${(f.globalDay ?? 0) + 1}`);
    const PLAYER_PALETTES = {
      1: {
        solar: ["#00c2d1", "#34d8eb", "#00a7b5", "#6fe7f2", "#00e5ff", "#4dd0e1"],
        reactor: ["#1fb8a5", "#39c9b8", "#0f9484", "#74dfd2", "#26a69a", "#80cbc4"],
        habitat: ["#4aa3ff", "#6db6ff", "#2f87e6", "#8fc8ff", "#2979ff", "#82b1ff"],
        rover: ["#008fd5", "#29a6ea", "#0076b3", "#63bff2", "#00b0ff", "#40c4ff"],
        score: ["#00b8d9"],
        violation: ["#008fd5"],
      },
      2: {
        solar: ["#ff6b6b", "#ff8b7a", "#e85a5a", "#ffb0a3", "#ff5252", "#ef9a9a"],
        reactor: ["#ff8c42", "#ff9f5c", "#e67324", "#ffc08a", "#ff7043", "#ffab91"],
        habitat: ["#ff7f50", "#ff9666", "#e76b3c", "#ffb28f", "#ff6e40", "#ffab91"],
        rover: ["#f25f5c", "#ff7a73", "#d94d4a", "#ffaaa6", "#ff5252", "#ff8a80"],
        score: ["#ff6b6b"],
        violation: ["#ff8c42"],
      },
    };
    const hexToRgba = (hex, alpha = 1) => {
      const h = hex.replace("#", "");
      const bigint = parseInt(h.length === 3 ? h.split("").map(ch => ch + ch).join("") : h, 16);
      const r = (bigint >> 16) & 255;
      const g = (bigint >> 8) & 255;
      const b = bigint & 255;
      return `rgba(${r},${g},${b},${alpha})`;
    };
    const seriesColor = (playerId, type = "score", assetIdx = 1, alpha = 1) => {
      const paletteSet = PLAYER_PALETTES[playerId] || {};
      const palette = paletteSet[type] || ["#7fd9ff"];
      const hex = palette[(Math.max(1, assetIdx) - 1) % palette.length];
      return hexToRgba(hex, alpha);
    };
    const consumerPowerSeriesMap = new Map();
    const generatorPowerSeriesMap = new Map();

    const ensureSeries = (map, key, meta, frameCount) => {
      if (!map.has(key)) map.set(key, { key, data: new Array(frameCount).fill(null), ...meta });
      return map.get(key);
    };

    frames.forEach((frame, frameIdx) => {
      [frame.p1, frame.p2].forEach((player, pi) => {
        if (!player) return;
        const playerId = pi + 1;
        (player.panels || []).forEach((panel, idx) => {
          const key = `P${playerId}-solar-${idx+1}`;
          const series = ensureSeries(generatorPowerSeriesMap, key, {
            label: `P${playerId} Solar ${idx+1}`,
            color: seriesColor(playerId, "solar", idx + 1, 0.95),
            playerId,
            assetIdx: idx + 1,
          }, frames.length);
          series.data[frameIdx] = player.generatorSupplyTotals?.[`solar-${idx}`] ?? 0;
        });
        (player.reactors || []).forEach((reactor, idx) => {
          const key = `P${playerId}-reactor-${idx+1}`;
          const series = ensureSeries(generatorPowerSeriesMap, key, {
            label: `P${playerId} Reactor ${idx+1}`,
            color: seriesColor(playerId, "reactor", idx + 1, 0.95),
            playerId,
            assetIdx: idx + 1,
          }, frames.length);
          series.data[frameIdx] = player.generatorSupplyTotals?.[`reactor-${idx}`] ?? 0;
        });
        (player.habitats || []).forEach((habitat, idx) => {
          const key = `P${playerId}-habitat-${idx+1}`;
          const series = ensureSeries(consumerPowerSeriesMap, key, {
            label: `P${playerId} Habitat ${idx+1}`,
            color: seriesColor(playerId, "habitat", idx + 1, 0.9),
            playerId,
            assetIdx: idx + 1,
          }, frames.length);
          series.data[frameIdx] = player.habitatPower?.[idx] ?? 0;
        });
        const roverEntries = [player, ...((player.extraRovers || []))];
        roverEntries.forEach((rover, idx) => {
          const key = `P${playerId}-rover-${idx+1}`;
          const series = ensureSeries(consumerPowerSeriesMap, key, {
            label: `P${playerId} Rover ${idx+1}`,
            color: seriesColor(playerId, "rover", idx + 1, 1),
            playerId,
            assetIdx: idx + 1,
          }, frames.length);
          series.data[frameIdx] = rover?.power ?? null;
        });
      });
    });

    const consumerPowerSeries = [...consumerPowerSeriesMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.assetIdx - b.assetIdx
    );
    const generatorPowerSeries = [...generatorPowerSeriesMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.assetIdx - b.assetIdx
    );

    const roverIceMap = new Map();
    const roverIceTotals = {};
    const ensureRoverIceSeries = (playerId, roverId) => {
      const key = `P${playerId}-rover-${roverId}`;
      if (!roverIceMap.has(key)) {
        roverIceMap.set(key, {
          key,
          label: `P${playerId} Rover ${roverId}`,
          color: seriesColor(playerId, "rover", roverId, 1),
          playerId,
          assetIdx: roverId,
          data: new Array(frames.length).fill(null),
        });
      }
      return key;
    };
    let logCursor = 0;
    frames.forEach((frame, frameIdx) => {
      [frame.p1, frame.p2].forEach((player, pi) => {
        if (!player) return;
        const playerId = pi + 1;
        const roverCount = 1 + ((player.extraRovers || []).length);
        for (let roverId = 1; roverId <= roverCount; roverId++) {
          const key = ensureRoverIceSeries(playerId, roverId);
          if (roverIceTotals[key] == null) roverIceTotals[key] = 0;
          roverIceMap.get(key).data[frameIdx] = roverIceTotals[key];
        }
      });
      while (logCursor < log.length && logCursor < (frame.logLength || 0)) {
        const ev = log[logCursor];
        if (ev?.type === "mine" && ev.actor && ev.roverId) {
          const key = ensureRoverIceSeries(ev.actor, ev.roverId);
          roverIceTotals[key] = (roverIceTotals[key] || 0) + (ev.kg || 0);
          roverIceMap.get(key).data[frameIdx] = roverIceTotals[key];
        }
        logCursor += 1;
      }
    });
    const roverIceSeries = [...roverIceMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.assetIdx - b.assetIdx
    );

    const roverDeliveredMap = new Map();
    const roverDeliveredTotals = {};
    const ensureRoverDeliveredSeries = (playerId, roverId) => {
      const key = `P${playerId}-delivered-rover-${roverId}`;
      if (!roverDeliveredMap.has(key)) {
        roverDeliveredMap.set(key, {
          key,
          label: `P${playerId} Rover ${roverId}`,
          color: seriesColor(playerId, "rover", roverId, 1),
          playerId,
          assetIdx: roverId,
          data: new Array(frames.length).fill(null),
        });
      }
      return key;
    };
    let deliveredLogCursor = 0;
    frames.forEach((frame, frameIdx) => {
      [frame.p1, frame.p2].forEach((player, pi) => {
        if (!player) return;
        const playerId = pi + 1;
        const roverCount = 1 + ((player.extraRovers || []).length);
        for (let roverId = 1; roverId <= roverCount; roverId++) {
          const key = ensureRoverDeliveredSeries(playerId, roverId);
          if (roverDeliveredTotals[key] == null) roverDeliveredTotals[key] = 0;
          roverDeliveredMap.get(key).data[frameIdx] = roverDeliveredTotals[key];
        }
      });
      while (deliveredLogCursor < log.length && deliveredLogCursor < (frame.logLength || 0)) {
        const ev = log[deliveredLogCursor];
        if (ev?.type === "deposit" && ev.actor && ev.roverId) {
          const key = ensureRoverDeliveredSeries(ev.actor, ev.roverId);
          roverDeliveredTotals[key] = (roverDeliveredTotals[key] || 0) + (ev.kg || 0);
          roverDeliveredMap.get(key).data[frameIdx] = roverDeliveredTotals[key];
        }
        deliveredLogCursor += 1;
      }
    });
    const roverDeliveredSeries = [...roverDeliveredMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.assetIdx - b.assetIdx
    );

    const roverMoveMap = new Map();
    const ensureRoverMoveSeries = (playerId, roverId) => {
      const key = `P${playerId}-move-rover-${roverId}`;
      if (!roverMoveMap.has(key)) {
        roverMoveMap.set(key, {
          key,
          label: `P${playerId} Rover ${roverId}`,
          color: seriesColor(playerId, "rover", roverId, 1),
          playerId,
          assetIdx: roverId,
          data: new Array(frames.length).fill(null),
        });
      }
      return roverMoveMap.get(key);
    };
    const roverMoveTotals = {};
    frames.forEach((frame, frameIdx) => {
      [frame.p1, frame.p2].forEach((player, pi) => {
        if (!player) return;
        const playerId = pi + 1;
        const rovers = [player, ...((player.extraRovers || []))];
        rovers.forEach((rover, idx) => {
          const roverId = idx + 1;
          const key = `P${playerId}-move-rover-${roverId}`;
          const series = ensureRoverMoveSeries(playerId, roverId);
          if (roverMoveTotals[key] == null) roverMoveTotals[key] = 0;
          if (frameIdx > 0) {
            const prevPlayer = playerId === 1 ? frames[frameIdx - 1]?.p1 : frames[frameIdx - 1]?.p2;
            const prevRover = idx === 0 ? prevPlayer : (prevPlayer?.extraRovers || [])[idx - 1];
            if (prevRover && rover) {
              roverMoveTotals[key] += d2({ x: prevRover.x, y: prevRover.y }, { x: rover.x, y: rover.y }) / PIXELS_PER_KM;
            }
          }
          series.data[frameIdx] = roverMoveTotals[key];
        });
      });
    });
    const roverMoveSeries = [...roverMoveMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.assetIdx - b.assetIdx
    );

    const STATUS_ORDER = ["idle_nopsr", "idle", "moving", "mining", "carrying", "depositing", "depleted"];
    const statusToValue = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i]));
    const roverStateMap = new Map();
    const ensureRoverStateSeries = (playerId, roverId) => {
      const key = `P${playerId}-state-rover-${roverId}`;
      if (!roverStateMap.has(key)) {
        roverStateMap.set(key, {
          key,
          label: `P${playerId} Rover ${roverId}`,
          color: seriesColor(playerId, "rover", roverId, 1),
          playerId,
          assetIdx: roverId,
          data: new Array(frames.length).fill(null),
        });
      }
      return roverStateMap.get(key);
    };
    frames.forEach((frame, frameIdx) => {
      [frame.p1, frame.p2].forEach((player, pi) => {
        if (!player) return;
        const playerId = pi + 1;
        const rovers = [player, ...((player.extraRovers || []))];
        rovers.forEach((rover, idx) => {
          const series = ensureRoverStateSeries(playerId, idx + 1);
          const status = rover?.status || "idle";
          series.data[frameIdx] = statusToValue[status] ?? statusToValue.idle;
        });
      });
    });
    const roverStateSeries = [...roverStateMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.assetIdx - b.assetIdx
    );

    const scoreSeries = [
      { key:"score-p1", label:"P1 Score", color:seriesColor(1, "score", 1, 1), data:frames.map(f => scorePlayerState(f.p1)) },
      { key:"score-p2", label:"P2 Score", color:seriesColor(2, "score", 1, 1), data:frames.map(f => scorePlayerState(f.p2)) },
    ];
    const budgetSeries = [
      { key:"budget-p1", label:"P1 Remaining Credits", color:seriesColor(1, "score", 1, 1), data:frames.map(f => f.p1?.budget ?? 0) },
      { key:"budget-p2", label:"P2 Remaining Credits", color:seriesColor(2, "score", 1, 1), data:frames.map(f => f.p2?.budget ?? 0) },
    ];
    const cumCreditsSeries = [
      { key:"cumcredits-p1", label:"P1 Cumulative Credits", color:seriesColor(1, "score", 1, 1), data:frames.map(f => (f.history || []).reduce((sum, h) => sum + (h.bud1 || 0), 0)) },
      { key:"cumcredits-p2", label:"P2 Cumulative Credits", color:seriesColor(2, "score", 1, 1), data:frames.map(f => (f.history || []).reduce((sum, h) => sum + (h.bud2 || 0), 0)) },
    ];
    const violationSeries = [
      { key:"vio-p1", label:"P1 Violations", color:seriesColor(1, "violation", 1, 1), data:frames.map(f => f.p1?.safetyViolations ?? 0) },
      { key:"vio-p2", label:"P2 Violations", color:seriesColor(2, "violation", 1, 1), data:frames.map(f => f.p2?.safetyViolations ?? 0) },
    ];
    const sharedSeries = [
      { key:"shared", label:"Shared Grid", color:"#7fd9ff", data:frames.map(f => f.powerGridState?.mode === "shared" ? 1 : 0) },
    ];
    const p1SupplyAllocationSeries = [
      { key:"p1-to-p1", label:"P1 Generators → P1 Assets", color:seriesColor(1, "solar", 1, 1), data:frames.map(f => f.p1?.generatorSupplyByRecipient?.[1] ?? 0) },
      { key:"p1-to-p2", label:"P1 Generators → P2 Assets", color:"#7fd9ff", data:frames.map(f => f.p1?.generatorSupplyByRecipient?.[2] ?? 0) },
    ];
    const p2SupplyAllocationSeries = [
      { key:"p2-to-p1", label:"P2 Generators → P1 Assets", color:"#7fd9ff", data:frames.map(f => f.p2?.generatorSupplyByRecipient?.[1] ?? 0) },
      { key:"p2-to-p2", label:"P2 Generators → P2 Assets", color:seriesColor(2, "solar", 1, 1), data:frames.map(f => f.p2?.generatorSupplyByRecipient?.[2] ?? 0) },
    ];
    const structureHealthMap = new Map();
    const ensureHealthSeries = (playerId, type, assetIdx) => {
      const key = `P${playerId}-${type}-health-${assetIdx}`;
      const healthTypeMeta = {
        panels: { label: "Solar Panel", colorType: "solar" },
        reactors: { label: "Nuclear Reactor", colorType: "reactor" },
        habitats: { label: "Habitat", colorType: "habitat" },
        extraRovers: { label: "Rover", colorType: "rover" },
        landingPads: { label: "Landing Pad", colorType: "reactor" },
      };
      const meta = healthTypeMeta[type] || { label: type, colorType: "solar" };
      if (!structureHealthMap.has(key)) {
        structureHealthMap.set(key, {
          key,
          label: `P${playerId} ${meta.label} ${assetIdx}`,
          color: seriesColor(playerId, meta.colorType, assetIdx, 1),
          playerId,
          assetIdx,
          data: new Array(frames.length).fill(null),
        });
      }
      return structureHealthMap.get(key);
    };
    frames.forEach((frame, frameIdx) => {
      [frame.p1, frame.p2].forEach((player, pi) => {
        if (!player) return;
        const playerId = pi + 1;
        const groups = [
          ["panels", player.panels || [], player.structureHealth?.panels || []],
          ["reactors", player.reactors || [], player.structureHealth?.reactors || []],
          ["habitats", player.habitats || [], player.structureHealth?.habitats || []],
          ["extraRovers", player.extraRovers || [], player.structureHealth?.extraRovers || []],
          ["landingPads", player.landingPads || [], player.structureHealth?.landingPads || []],
        ];
        groups.forEach(([type, list, healths]) => {
          list.forEach((_, idx) => {
            const series = ensureHealthSeries(playerId, type, idx + 1);
            series.data[frameIdx] = (healths[idx] ?? 1) * 100;
          });
        });
      });
    });
    const structureHealthSeries = [...structureHealthMap.values()].sort((a, b) =>
      a.playerId - b.playerId || a.label.localeCompare(b.label)
    );

    const purchaseSeriesMap = new Map();
    const purchaseLabels = ["Solar Panel", "Nuclear Reactor", "Habitat", "Rover", "Landing Pad"];
    const resupplyLabels = ["No Resupply", "Resupply"];
    let purchaseCursor = 0;
    const addPointSeries = (map, prefix, ev, idx, colorType, customLabel) => {
      const key = `${prefix}-${idx}`;
      const label = customLabel || ev.label || `P${ev.actor} ${structureLabel(ev.itemType)} ${idx + 1}`;
      map.set(key, {
        key,
        label,
        color: seriesColor(ev.actor || 1, colorType, idx + 1, 1),
        playerId: ev.actor || 1,
        assetIdx: idx + 1,
        data: new Array(frames.length).fill(null),
        pointOnly: true,
      });
      return map.get(key);
    };
    frames.forEach((frame, frameIdx) => {
      while (purchaseCursor < log.length && purchaseCursor < (frame.logLength || 0)) {
        const ev = log[purchaseCursor];
        if (ev?.type === "purchase" && ev.itemType) {
          if (ev.itemType === "resupply") {
            // handled below as a single baseline-plus-spike series
          } else {
            const typeKey = ev.itemType === "solar" ? "solar" : ev.itemType === "reactor" ? "reactor" : ev.itemType === "habitat" ? "habitat" : "rover";
            const series = addPointSeries(
              purchaseSeriesMap,
              "purchase",
              ev,
              purchaseSeriesMap.size,
              typeKey,
              `P${ev.actor} ${structureLabel(ev.itemType)}`
            );
            const yValue = { solar:0, reactor:1, habitat:2, rover:3, pad:4 }[ev.itemType] ?? 0;
            series.data[frameIdx] = yValue;
          }
        }
        purchaseCursor += 1;
      }
    });
    const purchaseSeries = [...purchaseSeriesMap.values()];
    const resupplyData = new Array(frames.length).fill(0);
    let resupplyLogCursor = 0;
    frames.forEach((frame, frameIdx) => {
      while (resupplyLogCursor < log.length && resupplyLogCursor < (frame.logLength || 0)) {
        const ev = log[resupplyLogCursor];
        if (ev?.type === "purchase" && ev.itemType === "resupply") {
          resupplyData[frameIdx] = 1;
        }
        resupplyLogCursor += 1;
      }
    });
    const resupplySeries = [{
      key: "resupply-timeline",
      label: "Resupply Purchases",
      color: "#7fd9ff",
      playerId: 0,
      assetIdx: 1,
      data: resupplyData,
      spikeOnly: true,
    }];

    const makePlot = (id, title, series, opts = {}) => {
      const legendCols = opts.legendCols || 3;
      const legendRows = Math.max(1, Math.ceil(Math.max(1, series.length) / legendCols));
      return {
        id,
        title,
        series,
        xLabels,
        yLabel: opts.yLabel || "",
        xLabel: opts.xLabel || "Days",
        booleanPlot: !!opts.booleanPlot,
        categoricalTicks: opts.categoricalTicks || null,
        pointOnly: !!opts.pointOnly,
        tickFormatter: opts.tickFormatter || null,
        legendCols,
        width: 980,
        height: 270 + legendRows * 18,
      };
    };

    return [
      makePlot("power-state-over-time", "Power State Over Time", consumerPowerSeries, { yLabel:"Power units", legendCols: 4 }),
      makePlot("power-supplied-over-time", "Cumulative Power Supplied Over Time", generatorPowerSeries, { yLabel:"Power units", legendCols: 4 }),
      makePlot("p1-power-supply-allocation", "Cumulative P1 Power Supply Over Time", p1SupplyAllocationSeries, { yLabel:"Power units", legendCols: 2 }),
      makePlot("p2-power-supply-allocation", "Cumulative P2 Power Supply Over Time", p2SupplyAllocationSeries, { yLabel:"Power units", legendCols: 2 }),
      makePlot("ice-by-rover", "Cumulative Ice Mined Over Time By Rover", roverIceSeries, { yLabel:"kg", legendCols: 4 }),
      makePlot("ice-delivered-by-rover", "Cumulative Ice Delivered Over Time By Rover", roverDeliveredSeries, { yLabel:"kg", legendCols: 4 }),
      makePlot("movement-by-rover", "Cumulative Movement By Rover", roverMoveSeries, { yLabel:"km", legendCols: 4 }),
      makePlot("rover-state-over-time", "Rover State Over Time", roverStateSeries, { legendCols: 4, categoricalTicks: STATUS_ORDER.map(key => STATUS_INFO[key]?.label || key) }),
      makePlot("asset-purchases", "Asset Purchases", purchaseSeries, { legendCols: 3, categoricalTicks: purchaseLabels, pointOnly: true }),
      makePlot("resupply-purchases", "Resupply Purchases", resupplySeries, { legendCols: 2, categoricalTicks: resupplyLabels }),
      makePlot("structure-health-over-time", "Structure Health Over Time", structureHealthSeries, { yLabel:"Health %", legendCols: 4, tickFormatter:(v)=>`${Math.round(v)}%` }),
      makePlot("budget-over-time", "Remaining Credits Over Time", budgetSeries, { yLabel:"credits", legendCols: 2, tickFormatter:(v)=>`${Math.round(v)}` }),
      makePlot("cumulative-credits-over-time", "Cumulative Credits Over Time", cumCreditsSeries, { yLabel:"credits", legendCols: 2, tickFormatter:(v)=>`${Math.round(v)}` }),
      makePlot("score-over-time", "Score Over Time", scoreSeries, { legendCols: 2 }),
      makePlot("violations-over-time", "Safety Zone Violations Over Time", violationSeries, { legendCols: 2 }),
      makePlot("shared-status", "Shared Grid Status Over Time", sharedSeries, { booleanPlot: true, legendCols: 1 }),
    ];
  }, [plotSource, physOverrides]);

  const drawPlotCanvas = (canvas, plot) => {
    if (!canvas || !plot) return;
    const ctx = canvas.getContext("2d");
    const width = plot.width;
    const height = plot.height;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#020914";
    ctx.fillRect(0, 0, width, height);

    const yTickLabels = plot.booleanPlot
      ? ["TRUE", "FALSE"]
      : (plot.categoricalTicks || []);
    const longestYTick = yTickLabels.reduce((max, label) => Math.max(max, String(label || "").length), 0);
    const leftMargin = plot.categoricalTicks
      ? Math.min(240, Math.max(92, 28 + longestYTick * 8))
      : 56;
    const margin = { top: 42, right: 18, bottom: 78 + Math.ceil(Math.max(1, plot.series.length) / plot.legendCols) * 18, left: leftMargin + (plot.yLabel ? 18 : 0) };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;
    const flatValues = plot.series.flatMap(s => s.data.filter(v => v != null));
    const yMin = 0;
    const yMax = plot.booleanPlot ? 1 : plot.categoricalTicks ? Math.max(1, plot.categoricalTicks.length - 1) : Math.max(1, ...flatValues, 0);

    ctx.fillStyle = "#5f86a0";
    ctx.font = "16px 'Orbitron', monospace";
    ctx.textBaseline = "top";
    ctx.fillText(plot.title, 14, 10);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    const gridSteps = plot.booleanPlot ? 1 : plot.categoricalTicks ? Math.max(1, plot.categoricalTicks.length - 1) : 4;
    for (let i = 0; i <= gridSteps; i++) {
      const y = margin.top + (chartH * i / Math.max(1, gridSteps));
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
      const value = yMax - ((yMax - yMin) * i / Math.max(1, gridSteps));
      ctx.fillStyle = "#537189";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.textAlign = "right";
      const tickLabel = plot.booleanPlot
        ? (value >= 0.5 ? "TRUE" : "FALSE")
        : plot.categoricalTicks
          ? (plot.categoricalTicks[Math.round(value)] ?? "")
          : plot.tickFormatter
            ? plot.tickFormatter(value)
            : value.toFixed(value >= 10 ? 0 : 1);
      ctx.fillText(tickLabel, margin.left - 8, y - 6);
    }

    const pointX = (idx) => margin.left + (plot.xLabels.length <= 1 ? 0 : (chartW * idx / (plot.xLabels.length - 1)));
    const pointY = (value) => margin.top + chartH - (((value - yMin) / Math.max(1e-6, yMax - yMin)) * chartH);
    const xTickCount = Math.min(6, plot.xLabels.length);
    ctx.textAlign = "center";
    for (let i = 0; i < xTickCount; i++) {
      const idx = plot.xLabels.length <= 1 ? 0 : Math.round((plot.xLabels.length - 1) * i / Math.max(1, xTickCount - 1));
      const x = pointX(idx);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + chartH);
      ctx.stroke();
      ctx.fillStyle = "#537189";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillText(plot.xLabels[idx], x, margin.top + chartH + 10);
    }

    if (plot.xLabel) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#6c90a8";
      ctx.font = "12px 'JetBrains Mono', monospace";
      ctx.fillText(plot.xLabel, margin.left + chartW / 2, margin.top + chartH + 28);
    }

    if (plot.yLabel) {
      ctx.save();
      ctx.translate(18, margin.top + chartH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillStyle = "#6c90a8";
      ctx.font = "12px 'JetBrains Mono', monospace";
      ctx.fillText(plot.yLabel, 0, 0);
      ctx.restore();
    }

    plot.series.forEach((series) => {
      let firstIdx = series.data.findIndex(v => v != null);
      if (firstIdx < 0) return;
      if (!plot.pointOnly && !series.pointOnly) {
        ctx.strokeStyle = series.color;
        ctx.lineWidth = plot.booleanPlot ? 2 : 2.2;
        ctx.beginPath();
        let started = false;
        series.data.forEach((value, idx) => {
          if (value == null) { started = false; return; }
          const x = pointX(idx);
          const y = pointY(value);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else { ctx.lineTo(x, y); }
        });
        ctx.stroke();
        const firstValue = series.data[firstIdx];
        const bubbleX = pointX(firstIdx);
        const bubbleY = pointY(firstValue);
        ctx.fillStyle = "#020914";
        ctx.beginPath();
        ctx.arc(bubbleX, bubbleY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 2;
        ctx.stroke();
        if (series.spikeOnly) {
          series.data.forEach((value, idx) => {
            if (value == null || value <= 0) return;
            const bubbleX = pointX(idx);
            const bubbleY = pointY(value);
            ctx.fillStyle = "#020914";
            ctx.beginPath();
            ctx.arc(bubbleX, bubbleY, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = series.color;
            ctx.lineWidth = 2;
            ctx.stroke();
          });
        }
      } else {
        series.data.forEach((value, idx) => {
          if (value == null) return;
          const bubbleX = pointX(idx);
          const bubbleY = pointY(value);
          ctx.fillStyle = "#020914";
          ctx.beginPath();
          ctx.arc(bubbleX, bubbleY, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = series.color;
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }
    });

    const legendStartY = margin.top + chartH + 44;
    const colWidth = Math.floor((width - 24) / plot.legendCols);
    plot.series.forEach((series, idx) => {
      const col = idx % plot.legendCols;
      const row = Math.floor(idx / plot.legendCols);
      const x = 14 + col * colWidth;
      const y = legendStartY + row * 18;
      ctx.fillStyle = series.color;
      ctx.fillRect(x, y + 4, 12, 4);
      ctx.fillStyle = "#9ab7cc";
      ctx.textAlign = "left";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillText(series.label, x + 18, y);
    });
  };

  const downloadCanvasPng = (canvas, filename) => {
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = filename;
    a.click();
  };

  const exportAllPlots = () => {
    plotDefinitions.forEach(plot => {
      const canvas = plotCanvasRefs.current[plot.id];
      if (canvas) downloadCanvasPng(canvas, `${plot.id}.png`);
    });
  };

  const buildSeparatePlot = (plot, series, idx) => ({
    ...plot,
    id: `${plot.id}-single-${idx}`,
    title: `${plot.title} — ${series.label}`,
    series: [{ ...series }],
    legendCols: 1,
    height: 240 + 18,
  });

  const PlotCanvas = ({ plot }) => {
    const ref = useRef(null);
    useEffect(() => {
      if (ref.current) {
        drawPlotCanvas(ref.current, plot);
        plotCanvasRefs.current[plot.id] = ref.current;
      }
    }, [plot]);
    return (
      <canvas
        ref={ref}
        width={plot.width}
        height={plot.height}
        style={{ width:"100%", height:"auto", display:"block", borderRadius:8, background:"#020914" }}
      />
    );
  };

  const Bar = ({ val, max, color, h=4 }) => {
    const pct = clamp((val/max)*100,0,100);
    return (
      <div style={{ height:h, background:"rgba(255,255,255,0.05)", borderRadius:2, overflow:"hidden",
        position:"relative", boxShadow:"inset 0 1px 0 rgba(0,0,0,0.3)" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:2,
          transition:"width 0.18s ease",
          boxShadow: pct > 20 ? `0 0 6px ${color}66` : "none" }} />
      </div>
    );
  };

  const night = showLayers.night && isNight(globalDay);
  const totalIce1 = p1?.iceDeposited||0, totalIce2 = p2?.iceDeposited||0;
  const mined1 = Object.keys(p1?.mineMap||{}).length, mined2 = Object.keys(p2?.mineMap||{}).length;
  const depleted = CRATER_DATA.filter((_,ci) => (craterHealth[ci]||1)<0.2).length;
  // ── Composite Mission Score ──────────────────────────────────────────────
  // Unbounded weighted sum of raw values. Each weight converts a unit of that
  // axis into "mission points" so the three scales are comparable without
  // capping either player. Tune these to taste.
  const PTS_PER_KG  = 1;    // 1 point per kg of ice deposited
  const PTS_PER_AP  = 15;   // 15 points per asset point built
  const ap1 = p1?.assetPts ?? 0, ap2 = p2?.assetPts ?? 0;
  const adj1 = p1?.scoreAdjustments ?? 0, adj2 = p2?.scoreAdjustments ?? 0;
  const vio1 = p1?.safetyViolations ?? 0, vio2 = p2?.safetyViolations ?? 0;
  const score1 = totalIce1 * PTS_PER_KG + ap1 * PTS_PER_AP + adj1 - vio1 * 25;
  const score2 = totalIce2 * PTS_PER_KG + ap2 * PTS_PER_AP + adj2 - vio2 * 25;
  const winner = phase===PHASE.DONE ? (score1>score2?1:score2>score1?2:0) : null;
  const share1 = score1 / (score1+score2||1);
  const replayActive = !!replayRun;
  const durationSummaryLabel = missionEndMode === "depletion" ? "UNTIL DEPLETION" : `${totalRounds} ROUNDS · ${totalRounds * DAYS_PER_ROUND} DAYS`;
  const roundCounterLabel = missionEndMode === "depletion" ? `R${round} · D${day+1}/${DAYS_PER_ROUND}` : `R${round}/${totalRounds} · D${day+1}/${DAYS_PER_ROUND}`;

  // ── Settings screen ──────────────────────────────────────────────────────
  if (phase===PHASE.SETTINGS) return (
    <div style={{
      minHeight:"100vh",
      background:"radial-gradient(ellipse at 35% 25%, #06101e 0%, #020810 55%, #030c18 100%)",
      fontFamily:"'JetBrains Mono','Courier New',monospace", color:"#9bbcd4",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      padding:20, position:"relative", overflow:"hidden",
    }}>
      {/* Background stars */}
      <div style={{ position:"absolute", inset:0, pointerEvents:"none", overflow:"hidden" }}>
        {Array.from({length:60},(_,i) => (
          <div key={i} style={{
            position:"absolute",
            left:`${(i*37+13)%100}%`, top:`${(i*53+7)%100}%`,
            width: i%5===0 ? 2 : 1, height: i%5===0 ? 2 : 1,
            borderRadius:"50%",
            background: `rgba(180,220,255,${0.15 + (i%4)*0.1})`,
            animation:`flicker ${2+i%3}s ease-in-out ${(i*0.3)%2}s infinite`,
          }}/>
        ))}
      </div>

      <div style={{ textAlign:"center", marginBottom:32, position:"relative" }}>
        <div style={{ fontSize:8, letterSpacing:"0.6em", color:"#1a3a50", marginBottom:8,
          fontFamily:"'Orbitron',monospace" }}>ARTEMIS PROTOCOL v4 · TURN-BASED OPS</div>
        <h1 style={{ margin:0, fontSize:32, fontWeight:900, letterSpacing:"0.18em",
          fontFamily:"'Orbitron',monospace",
          background:"linear-gradient(90deg,#ffd700 0%,#ffffff 40%,#b000ff 80%)",
          WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
          textShadow:"none",
        }}>
          PSR ICE MINING
        </h1>
        <div style={{ fontSize:9, color:"#3a6080", letterSpacing:"0.15em", marginTop:8,
          fontFamily:"'JetBrains Mono',monospace" }}>
          PERMANENTLY SHADOWED REGION · SHACKLETON CRATER · SOUTH POLE
        </div>
      </div>

      <div style={{ background:"rgba(4,9,20,0.96)", border:"1px solid rgba(255,255,255,0.09)",
        borderRadius:10, padding:"26px 30px", width:"100%", maxWidth:420,
        boxShadow:"0 0 40px rgba(0,100,200,0.08), inset 0 1px 0 rgba(255,255,255,0.04)",
        position:"relative",
      }}>
        <div style={{ fontSize:8, letterSpacing:"0.4em", color:"#2a4a60",
          marginBottom:20, fontFamily:"'Orbitron',monospace" }}>MISSION PARAMETERS</div>

        {/* Sim Mode Selector */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:7, letterSpacing:"0.25em", color:"#2a4050", marginBottom:8,
            fontFamily:"'Orbitron',monospace" }}>SIMULATION MODE</div>
          <div style={{ display:"flex", gap:5 }}>
            {[
              ["competitive","⚔ COMPETITIVE","Two players compete for PSR ice"],
              ["solo","👤 SOLO","You control P1; P2 auto-mines in place"],
              ["analysis","⚙ BATCH RUNNER","Run 100 bot matches and compare outcomes"],
            ].map(([m,label,tip]) => (
              <button key={m} onClick={()=>setSimMode(m)} title={tip} style={{
                flex:1, background:simMode===m?"rgba(0,180,255,0.15)":"rgba(255,255,255,0.03)",
                border:`1px solid ${simMode===m?"rgba(0,180,255,0.4)":"rgba(255,255,255,0.06)"}`,
                color:simMode===m?"#44aaff":"#2a4050",
                borderRadius:5, padding:"7px 4px", cursor:"pointer",
                fontSize:6.5, fontFamily:"'Orbitron','Courier New',monospace",
                letterSpacing:"0.06em", lineHeight:1.5,
              }}>{label}<br/><span style={{opacity:0.55,fontSize:5.5,letterSpacing:"0.03em",fontFamily:"'JetBrains Mono',monospace"}}>{tip}</span></button>
            ))}
          </div>
        </div>

        {/* Scenario Presets */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:7, letterSpacing:"0.25em", color:"#2a4050", marginBottom:8,
            fontFamily:"'Orbitron',monospace" }}>SCENARIO PRESETS</div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {[
              { id:"standard", label:"STANDARD MISSION", desc:"Default parameters · 12 rounds · balanced economy", rounds:12 },
              { id:"longhaul",  label:"LONG-HAUL EXTRACTION", desc:"20 rounds · test crater depletion dynamics", rounds:20 },
              { id:"sprint",    label:"SPRINT ACQUISITION", desc:"4 rounds · first-mover advantage focus", rounds:4 },
              { id:"unevenArrival", label:"UNEVEN ARRIVAL", desc:"20 rounds · delayed Player 2 arrival", rounds:20 },
              { id:"nocombat",  label:"COOPERATIVE MODE", desc:"Military disabled · pure ISRU optimization", rounds:12, overrides:{ HOSTILE_DECAY:0, MIL_DAMAGE_SCALE:0 } },
            ].map(scen => (
              <button key={scen.id} onClick={()=>{
                setScenarioPreset(scen.id);
                setTotalRounds(scen.rounds);
                setMissionEndMode("fixed");
                if (scen.overrides) setPhysOverrides(scen.overrides);
                else setPhysOverrides({});
              }} style={{
                background:scenarioPreset===scen.id?"rgba(0,180,255,0.1)":"rgba(255,255,255,0.02)",
                border:`1px solid ${scenarioPreset===scen.id?"rgba(0,180,255,0.3)":"rgba(255,255,255,0.06)"}`,
                borderRadius:5, padding:"7px 10px", cursor:"pointer", textAlign:"left",
                display:"flex", justifyContent:"space-between", alignItems:"center",
              }}>
                <span>
                  <div style={{fontSize:8,color:scenarioPreset===scen.id?"#8fd0ff":"#6a8fa8",letterSpacing:"0.1em",fontFamily:"'Orbitron',monospace"}}>{scen.label}</div>
                  <div style={{fontSize:6.5,color:"#2a4050",marginTop:2,fontFamily:"'JetBrains Mono',monospace"}}>{scen.desc}</div>
                </span>
                <span style={{fontSize:9,color:"#1e3040"}}>→</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
            <span style={{ fontSize:9, color:"#6a8fa8", letterSpacing:"0.1em" }}>MISSION DURATION</span>
            <span style={{ fontSize:14, fontWeight:700, color:"#ffd700",
              fontFamily:"'Orbitron',monospace" }}>
              {missionEndMode === "depletion" ? "VERY LONG · UNTIL DEPLETION" : `${totalRounds} RND · ${totalRounds*DAYS_PER_ROUND} DAYS`}
            </span>
          </div>
          {missionEndMode === "fixed" && (
            <div style={{ position:"relative" }}>
              <input type="range" min={4} max={20} value={totalRounds}
                onChange={e=>setTotalRounds(+e.target.value)}
                style={{ width:"100%", accentColor:"#ffd700", cursor:"pointer" }} />
            </div>
          )}
          <div style={{ display:"flex", gap:5, marginTop:8 }}>
            {[[4,"QUICK","fixed"],[8,"SHORT","fixed"],[12,"STANDARD","fixed"],[20,"LONG","fixed"],["depletion","VERY LONG","depletion"]].map(([v,l,mode]) => (
              <button key={l} onClick={()=>{
                if (mode === "depletion") setMissionEndMode("depletion");
                else {
                  setMissionEndMode("fixed");
                  setTotalRounds(v);
                }
              }} style={{
                flex:1, background:(mode==="depletion" ? missionEndMode==="depletion" : missionEndMode==="fixed" && totalRounds===v)?"rgba(255,215,0,0.12)":"rgba(255,255,255,0.03)",
                border:`1px solid ${(mode==="depletion" ? missionEndMode==="depletion" : missionEndMode==="fixed" && totalRounds===v)?"#ffd70055":"rgba(255,255,255,0.06)"}`,
                color:(mode==="depletion" ? missionEndMode==="depletion" : missionEndMode==="fixed" && totalRounds===v)?"#ffd700":"#2a4050", borderRadius:4, padding:"5px 0",
                cursor:"pointer", fontSize:7, fontFamily:"'Orbitron','Courier New',monospace",
                letterSpacing:"0.08em",
              }}>{l}</button>
            ))}
          </div>
          {scenarioPreset === "unevenArrival" && (
            <div style={{ marginTop:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:9, color:"#6a8fa8", letterSpacing:"0.1em" }}>ARRIVAL DELAY</span>
                <span style={{ fontSize:12, fontWeight:700, color:"#44aaff",
                  fontFamily:"'Orbitron',monospace" }}>{arrivalDelay} DAY{arrivalDelay!==1?"S":""}</span>
              </div>
              <div style={{ position:"relative" }}>
                <input type="range" min={1} max={90} value={arrivalDelay}
                  onChange={e=>setArrivalDelay(+e.target.value)}
                  style={{ width:"100%", accentColor:"#44aaff", cursor:"pointer" }} />
              </div>
            </div>
          )}
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:7, letterSpacing:"0.25em", color:"#2a4050", marginBottom:8,
            fontFamily:"'Orbitron',monospace" }}>GRID SHARING</div>
          <div style={{ display:"flex", gap:6, marginBottom:8 }}>
            {[
              ["enabled", "SHARING ENABLED", "Offers and joins may occur"],
              ["disabled", "SHARING DISABLED", "Power grids remain isolated"],
            ].map(([mode, label, tip]) => (
              <button key={mode} onClick={()=>setGridSharingEnabled(mode==="enabled")} style={{
                flex:1, background:(gridSharingEnabled === (mode==="enabled"))?"rgba(0,180,255,0.12)":"rgba(255,255,255,0.03)",
                border:`1px solid ${(gridSharingEnabled === (mode==="enabled"))?"rgba(0,180,255,0.35)":"rgba(255,255,255,0.06)"}`,
                color:(gridSharingEnabled === (mode==="enabled"))?"#44aaff":"#2a4050", borderRadius:5, padding:"7px 6px",
                cursor:"pointer", fontSize:6.5, fontFamily:"'Orbitron','Courier New',monospace", lineHeight:1.5,
              }}>{label}<br/><span style={{opacity:0.55,fontSize:5.5,fontFamily:"'JetBrains Mono',monospace"}}>{tip}</span></button>
            ))}
          </div>
          {gridSharingEnabled && (
            <div style={{ display:"flex", gap:6 }}>
              {[
                [false, "REVERSIBLE", "Either player may later decouple"],
                [true, "PERMANENT", "Shared grid cannot be decoupled"],
              ].map(([perm, label, tip]) => (
                <button key={label} onClick={()=>setGridSharingPermanent(perm)} style={{
                  flex:1, background:gridSharingPermanent===perm?"rgba(255,215,0,0.12)":"rgba(255,255,255,0.03)",
                  border:`1px solid ${gridSharingPermanent===perm?"rgba(255,215,0,0.35)":"rgba(255,255,255,0.06)"}`,
                  color:gridSharingPermanent===perm?"#ffd700":"#2a4050", borderRadius:5, padding:"7px 6px",
                  cursor:"pointer", fontSize:6.5, fontFamily:"'Orbitron','Courier New',monospace", lineHeight:1.5,
                }}>{label}<br/><span style={{opacity:0.55,fontSize:5.5,fontFamily:"'JetBrains Mono',monospace"}}>{tip}</span></button>
              ))}
            </div>
          )}
        </div>

        {simMode === "analysis" && (
          <div style={{ marginBottom:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
              <span style={{ fontSize:9, color:"#6a8fa8", letterSpacing:"0.1em" }}>MONTE CARLO RUNS</span>
              <span style={{ fontSize:12, fontWeight:700, color:"#44aaff",
                fontFamily:"'Orbitron',monospace" }}>{batchRunCount} RUN{batchRunCount!==1?"S":""}</span>
            </div>
            <div style={{ position:"relative" }}>
              <input
                type="range"
                min={1}
                max={500}
                step={1}
                value={batchRunCount}
                onChange={e=>setBatchRunCount(+e.target.value)}
                style={{ width:"100%", accentColor:"#44aaff", cursor:"pointer" }}
              />
            </div>
            <div style={{ display:"flex", gap:5, marginTop:8 }}>
              {[1, 10, 25, 50, 100, 250].map(v => (
                <button key={v} onClick={()=>setBatchRunCount(v)} style={{
                  flex:1, background:batchRunCount===v?"rgba(68,170,255,0.12)":"rgba(255,255,255,0.03)",
                  border:`1px solid ${batchRunCount===v?"rgba(68,170,255,0.35)":"rgba(255,255,255,0.06)"}`,
                  color:batchRunCount===v?"#44aaff":"#2a4050", borderRadius:4, padding:"5px 0",
                  cursor:"pointer", fontSize:7, fontFamily:"'Orbitron','Courier New',monospace",
                  letterSpacing:"0.08em",
                }}>{v}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:8, letterSpacing:"0.3em", color:"#2a4050", marginBottom:10,
            fontFamily:"'Orbitron',monospace" }}>MAP OVERLAYS</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
            {[["mine","⛏ Mine Heat"],["claims","◉ Claims"],["craters","🌑 Depletion"],["night","🌙 Night Cycle"]].map(([k,l]) => (
              <button key={k} onClick={()=>setShowLayers(s=>({...s,[k]:!s[k]}))} style={{
                background:showLayers[k]?"rgba(0,180,255,0.1)":"rgba(255,255,255,0.02)",
                border:`1px solid ${showLayers[k]?"rgba(0,180,255,0.3)":"rgba(255,255,255,0.05)"}`,
                color:showLayers[k]?"#44aaff":"#2a4050", borderRadius:4, padding:"6px 10px",
                cursor:"pointer", fontSize:8, fontFamily:"inherit"}}>
                {showLayers[k]?"✓ ":""}{l}
              </button>
            ))}
          </div>
        </div>

        <div style={{ background:"rgba(0,30,60,0.4)", border:"1px solid rgba(0,100,200,0.12)",
          borderRadius:7, padding:"12px 14px", marginBottom:22, fontSize:8, lineHeight:2, color:"#3a6080",
          borderLeft:"2px solid rgba(0,120,255,0.2)",
        }}>
          <div style={{ color:"#4a8099", marginBottom:6, letterSpacing:"0.15em", fontSize:9,
            fontFamily:"'Orbitron',monospace" }}>MISSION BRIEFING</div>
          {simMode === "analysis" ? (
            <>
              <div>1. Launch a seeded batch of bot-vs-bot missions under the current ruleset.</div>
              <div>2. Watch the circular progress indicator fill as runs complete in the background.</div>
              <div>3. Review win rates, ice output, safety violations, and shared-grid outcomes afterward.</div>
              <div>4. Open any stored run and replay it in the browser UI day by day.</div>
            </>
          ) : (
            <>
              <div>1. <span style={{color:"#ffd700"}}>P1</span> plans action, then clicks <strong style={{color:"#ffd700"}}>END TURN</strong>.</div>
              <div>2. <span style={{color:"#b000ff"}}>P2</span> plans action, then clicks <strong style={{color:"#b000ff"}}>END TURN</strong>.</div>
              <div>3. Both turns resolve simultaneously.</div>
              <div>4. Repeat until mission end. Extract the most ice.</div>
            </>
          )}
        </div>

        <button onClick={()=>{
          if (simMode==="analysis") startBatchRunner();
          else {
            setUndoStack([]);
            setPhase(PHASE.SETUP1);
          }
        }} style={{
          width:"100%", background:"rgba(255,215,0,0.08)",
          border:"1px solid rgba(255,215,0,0.35)",
          color:"#ffd700", borderRadius:7, padding:"14px 0", cursor:"pointer",
          fontSize:11, letterSpacing:"0.3em", fontFamily:"'Orbitron','Courier New',monospace",
          fontWeight:700, position:"relative", overflow:"hidden",
          boxShadow:"0 0 20px rgba(255,215,0,0.1)",
        }}>
          {simMode==="analysis" ? "RUN BATCH" : "DEPLOY MISSION"}
        </button>

        <div style={{ marginTop:12, borderTop:"1px solid rgba(255,255,255,0.05)", paddingTop:12 }}>
          <input ref={saveFileInputRef} type="file" accept=".json" style={{ display:"none" }}
            onChange={e => { importSaveGame(e.target.files?.[0]); e.target.value = ""; }} />
          <button onClick={() => saveFileInputRef.current?.click()} style={{
            width:"100%", background:"rgba(100,160,255,0.06)",
            border:"1px solid rgba(100,160,255,0.2)",
            color:"#5a9fd4", borderRadius:7, padding:"10px 0", cursor:"pointer",
            fontSize:9, letterSpacing:"0.25em", fontFamily:"'Orbitron','Courier New',monospace",
            fontWeight:700,
          }}>⬆ LOAD SAVED GAME</button>
          <div style={{ fontSize:6, color:"#1e3a50", textAlign:"center", marginTop:5, letterSpacing:"0.08em" }}>
            Load a .json save file exported during a previous session
          </div>
        </div>
      </div>
    </div>
  );

  // ── Main HUD ─────────────────────────────────────────────────────────────
  if (phase===PHASE.BATCH) {
    const pct = Math.round((batchProgress.completed / Math.max(1, batchProgress.total)) * 100);
    const bestRun = batchResult?.runs?.slice().sort((a, b) => Math.abs(b.summary.score1 - b.summary.score2) - Math.abs(a.summary.score1 - a.summary.score2))[0];
    return (
      <div style={{
        minHeight:"100vh",
        background:"radial-gradient(ellipse at 35% 25%, #06101e 0%, #020810 55%, #030c18 100%)",
        fontFamily:"'JetBrains Mono','Courier New',monospace", color:"#9bbcd4",
        display:"flex", flexDirection:"column", alignItems:"center", padding:"28px 20px",
      }}>
        <div style={{ width:"100%", maxWidth:760, display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
          <div>
            <div style={{ fontSize:8, letterSpacing:"0.45em", color:"#2a4a60", fontFamily:"'Orbitron',monospace" }}>BATCH RUNNER</div>
            <div style={{ fontSize:18, color:"#d7e8f6", letterSpacing:"0.08em", fontFamily:"'Orbitron',monospace", marginTop:6 }}>
              {batchRunning ? "Running Monte Carlo Batch" : "Batch Results"}
            </div>
          </div>
          <button onClick={()=>!batchRunning && !replayLoading && setPhase(PHASE.SETTINGS)} disabled={batchRunning || replayLoading} style={{
            background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)",
            color:(batchRunning || replayLoading)?"#243848":"#6a8fa8", borderRadius:6, padding:"7px 12px", cursor:(batchRunning || replayLoading)?"default":"pointer",
            fontSize:7, letterSpacing:"0.1em", fontFamily:"'JetBrains Mono',monospace",
          }}>BACK</button>
        </div>

        {batchRunning ? (
          <div style={{ width:"100%", maxWidth:520, background:"rgba(4,9,20,0.96)", border:"1px solid rgba(255,255,255,0.09)",
            borderRadius:12, padding:"32px 28px", textAlign:"center", boxShadow:"0 0 40px rgba(0,100,200,0.08)" }}>
            <div style={{
              width:180, height:180, margin:"0 auto 22px", borderRadius:"50%",
              background:`conic-gradient(#44aaff ${pct}%, rgba(255,255,255,0.06) 0%)`,
              display:"grid", placeItems:"center", boxShadow:"0 0 30px rgba(68,170,255,0.15)"
            }}>
              <div style={{
                width:136, height:136, borderRadius:"50%", background:"rgba(3,8,18,0.95)",
                border:"1px solid rgba(255,255,255,0.05)", display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center"
              }}>
                <div style={{ fontSize:28, color:"#44aaff", fontFamily:"'Orbitron',monospace" }}>{pct}%</div>
                <div style={{ fontSize:7, color:"#3a6080", letterSpacing:"0.12em" }}>
                  {batchProgress.completed}/{batchProgress.total} RUNS
                </div>
              </div>
            </div>
            <div style={{ fontSize:9, color:"#7fb8de", letterSpacing:"0.1em", fontFamily:"'Orbitron',monospace", marginBottom:8 }}>
              SIMULATING STRATEGIC BOT MATCHES
            </div>
            <div style={{ fontSize:7, color:"#3a5570", lineHeight:1.8 }}>
              Ruleset: {scenarioPreset.toUpperCase()} · {missionEndMode === "depletion" ? "until depletion" : `${totalRounds} rounds · ${totalRounds * DAYS_PER_ROUND} days`}
              {scenarioPreset === "unevenArrival" && <> · P2 delay {arrivalDelay}d</>}
              {gridSharingEnabled ? ` · sharing ${gridSharingPermanent ? "permanent" : "reversible"}` : " · sharing disabled"}
            </div>
            {batchProgress.currentSeed != null && (
              <div style={{ marginTop:10, fontSize:6.5, color:"#2a4a60" }}>
                Current seed {batchProgress.currentSeed}
              </div>
            )}
          </div>
        ) : replayLoading ? (
          <div style={{ width:"100%", maxWidth:520, background:"rgba(4,9,20,0.96)", border:"1px solid rgba(255,255,255,0.09)",
            borderRadius:12, padding:"32px 28px", textAlign:"center", boxShadow:"0 0 40px rgba(0,100,200,0.08)" }}>
            <div style={{ width:26, height:26, margin:"0 auto 14px", borderRadius:"50%", border:"2px solid rgba(68,170,255,0.25)",
              borderTopColor:"#44aaff", animation:"spin 1s linear infinite" }} />
            <div style={{ fontSize:9, color:"#7fb8de", letterSpacing:"0.1em", fontFamily:"'Orbitron',monospace", marginBottom:8 }}>
              REBUILDING REPLAY
            </div>
            <div style={{ fontSize:7, color:"#3a5570", lineHeight:1.8 }}>
              Re-simulating the selected run from its stored seed to avoid keeping every long-match frame in memory.
            </div>
          </div>
        ) : batchResult ? (
          <div style={{ width:"100%", maxWidth:860, display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:8 }}>
              {[
                [`P1 WIN RATE`, `${(batchResult.p1WinRate * 100).toFixed(1)}%`, "#ffd700"],
                [`P2 WIN RATE`, `${(batchResult.p2WinRate * 100).toFixed(1)}%`, "#b000ff"],
                [`AVG ICE`, `${batchResult.avgIce1.toFixed(0)} / ${batchResult.avgIce2.toFixed(0)} kg`, "#44aaff"],
                [`AVG EXTRACTED`, `${batchResult.avgExtracted.toFixed(0)} / ${batchResult.totalMapIce.toFixed(0)} kg`, "#5dd0c9"],
                [`MAP EXTRACTION`, `${(batchResult.avgExtractedPct * 100).toFixed(1)}%`, "#6be28c"],
                [`AVG SCORE`, `${batchResult.avgScore1.toFixed(0)} / ${batchResult.avgScore2.toFixed(0)}`, "#66d7a5"],
                [`JOIN RATE`, `${(batchResult.joinRate * 100).toFixed(1)}%`, "#7ad8ff"],
                [`AVG SHARED DAYS`, `${batchResult.avgSharedDays.toFixed(1)}`, "#ffcc66"],
              ].map(([label, value, color]) => (
                <div key={label} style={{ background:"rgba(4,9,20,0.96)", border:`1px solid ${color}22`, borderRadius:8, padding:"10px 12px" }}>
                  <div style={{ fontSize:6, color:"#2a4a60", letterSpacing:"0.16em", fontFamily:"'Orbitron',monospace" }}>{label}</div>
                  <div style={{ marginTop:4, fontSize:14, color, fontFamily:"'Orbitron',monospace" }}>{value}</div>
                </div>
              ))}
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={startBatchRunner} style={{
                background:"rgba(68,170,255,0.1)", border:"1px solid rgba(68,170,255,0.35)",
                color:"#44aaff", borderRadius:6, padding:"8px 12px", cursor:"pointer",
                fontSize:7, letterSpacing:"0.12em", fontFamily:"'JetBrains Mono',monospace",
              }}>RUN AGAIN</button>
              {bestRun && (
                <button onClick={()=>watchReplayRun(bestRun)} style={{
                  background:"rgba(255,215,0,0.1)", border:"1px solid rgba(255,215,0,0.35)",
                  color:"#ffd700", borderRadius:6, padding:"8px 12px", cursor:"pointer",
                  fontSize:7, letterSpacing:"0.12em", fontFamily:"'JetBrains Mono',monospace",
                }}>WATCH REPRESENTATIVE RUN</button>
              )}
            </div>

            <div style={{ background:"rgba(4,9,20,0.96)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:10, padding:"14px 16px" }}>
              <div style={{ fontSize:8, color:"#4a8099", letterSpacing:"0.18em", fontFamily:"'Orbitron',monospace", marginBottom:10 }}>
                INDIVIDUAL RUNS
              </div>
              <div style={{ maxHeight:420, overflowY:"auto", display:"flex", flexDirection:"column", gap:5 }}>
                {batchResult.runs.map((run, idx) => (
                  <div key={run.seed} style={{ display:"grid", gridTemplateColumns:"58px 68px 1fr 1fr 90px", gap:8, alignItems:"center",
                    padding:"7px 8px", borderRadius:6, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.04)" }}>
                    <div style={{ fontSize:7, color:"#5a7f98" }}>Run {idx+1}</div>
                    <div style={{ fontSize:7, color:run.summary.winner===1?"#ffd700":run.summary.winner===2?"#cc88ff":"#7a8a9a" }}>
                      {run.summary.winner===0 ? "DRAW" : `P${run.summary.winner} WIN`}
                    </div>
                    <div style={{ fontSize:6.5, color:"#3a5570" }}>
                      Score {run.summary.score1.toFixed(0)} / {run.summary.score2.toFixed(0)} · Ice {run.summary.ice1.toFixed(0)} / {run.summary.ice2.toFixed(0)}
                    </div>
                    <div style={{ fontSize:6.5, color:"#3a5570" }}>
                      Violations {run.summary.vio1.toFixed(0)} / {run.summary.vio2.toFixed(0)} · Extracted {(run.summary.extractedPct * 100).toFixed(1)}%
                    </div>
                    <button onClick={()=>watchReplayRun(run)} style={{
                      background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
                      color:"#8fbfe2", borderRadius:5, padding:"6px 8px", cursor:"pointer",
                      fontSize:7, letterSpacing:"0.08em", fontFamily:"'JetBrains Mono',monospace",
                    }}>WATCH</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (!dataReady) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
      height:"100vh",background:"#020710",color:"#4a7a9a",fontFamily:"'JetBrains Mono','Courier New',monospace",
      fontSize:11,letterSpacing:"0.15em", gap:12}}>
      <div style={{ width:32, height:32, borderRadius:"50%", border:"2px solid #1a3050",
        borderTopColor:"#00d4ff", animation:"spin 1s linear infinite" }}/>
      LOADING LUNAR MAP DATA…
    </div>
  );

  return (
    <div style={{
      minHeight:"100vh",
      background:"radial-gradient(ellipse at 25% 15%, #060d1e 0%, #010508 55%, #030c18 100%)",
      fontFamily:"'JetBrains Mono','Courier New',monospace", color:"#9bbcd4",
      display:"flex", flexDirection:"column", alignItems:"center",
      padding:"8px",
    }}>
      {/* Top bar */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        width:"100%", maxWidth:650, marginBottom:6 }}>
        <div>
          <div style={{ fontSize:7, letterSpacing:"0.5em", color:"#1a3050", fontFamily:"'Orbitron',monospace", marginBottom:2 }}>ARTEMIS v4 · LUNAR OPS</div>
          <h1 style={{ margin:0, fontSize:18, fontWeight:900, letterSpacing:"0.15em",
            fontFamily:"'Orbitron',monospace",
            background:"linear-gradient(90deg,#ffd700,#fff 45%,#b000ff)",
            WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            PSR ICE MINING
          </h1>
        </div>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          <select
            value={mapLayer}
            onChange={e => setMapLayer(e.target.value)}
            style={{
              background:"rgba(4,9,22,0.97)",
              border:"1px solid rgba(255,255,255,0.1)",
              color:"#6a8fa8", borderRadius:4, padding:"4px 6px",
              cursor:"pointer", fontSize:7, fontFamily:"'JetBrains Mono',monospace",
              outline:"none", letterSpacing:"0.04em",
            }}>
            <option value="base">BASE MAP</option>
            <option value="illumination">ILLUMINATION</option>
            <option value="altitude">ALTITUDE</option>
            <option value="slope">SLOPE</option>
            <option value="earthvisibility">EARTH VIS.</option>
          </select>
          {[["mine","⛏"],["claims","◉"],["craters","🌑"],["night","🌙"]].map(([k,ic]) => (
            <button key={k} onClick={()=>setShowLayers(s=>({...s,[k]:!s[k]}))}
              title={`Toggle ${k} layer`} style={{
              background:showLayers[k]?"rgba(0,180,255,0.1)":"rgba(255,255,255,0.02)",
              border:`1px solid ${showLayers[k]?"rgba(0,180,255,0.25)":"rgba(255,255,255,0.05)"}`,
              color:showLayers[k]?"#44aaff":"#2a3a44", borderRadius:4, padding:"3px 7px",
              cursor:"pointer", fontSize:10, fontFamily:"inherit"}}>{ic}</button>
          ))}
          <button onClick={reset} style={{ background:"transparent",
            border:"1px solid rgba(255,255,255,0.06)",
            color:"#2a3a44", borderRadius:4, padding:"4px 9px", cursor:"pointer",
            fontSize:9, letterSpacing:"0.08em", fontFamily:"inherit"}}>↺</button>
        </div>
      </div>

      {/* ── Tool Toolbar ─────────────────────────────────────────────────── */}
      <div style={{ display:"flex", gap:4, width:"100%", maxWidth:650, marginBottom:5,
        background:"rgba(2,6,16,0.9)", border:"1px solid rgba(255,255,255,0.05)",
        borderRadius:6, padding:"5px 8px", alignItems:"center", flexWrap:"wrap" }}>

        {/* Sim mode badge */}
        <div style={{ fontSize:6.5, color:"#2a4a60", letterSpacing:"0.15em",
          fontFamily:"'Orbitron',monospace", marginRight:4, whiteSpace:"nowrap" }}>
          {replayActive ? "▶ REPLAY" : simMode==="solo"?"👤 SOLO":simMode==="analysis"?"⚙ BATCH":"⚔ COMPETITIVE"}
        </div>

        <div style={{ width:1, height:16, background:"rgba(255,255,255,0.07)" }}/>

        {/* Auto-advance control */}
        <button onClick={()=>setAutoAdvance(v=>!v)} title="Auto-advance turns" style={{
          background: autoAdvance ? "rgba(0,255,120,0.12)" : "rgba(255,255,255,0.03)",
          border:`1px solid ${autoAdvance?"rgba(0,255,120,0.3)":"rgba(255,255,255,0.07)"}`,
          color: autoAdvance ? "#44ff88" : "#3a5570",
          borderRadius:4, padding:"3px 8px", cursor:"pointer",
          fontSize:7, fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em",
          whiteSpace:"nowrap",
        }}>
          {autoAdvance ? "⏸ PAUSE" : "▶▶ AUTO"}
        </button>

        <button onClick={undoLastTurn} disabled={undoStack.length===0 || replayActive || batchRunning} title="Undo the latest planning segment" style={{
          background: undoStack.length>0 && !replayActive && !batchRunning ? "rgba(255,180,0,0.1)" : "rgba(255,255,255,0.03)",
          border:`1px solid ${undoStack.length>0 && !replayActive && !batchRunning ? "rgba(255,180,0,0.24)" : "rgba(255,255,255,0.07)"}`,
          color: undoStack.length>0 && !replayActive && !batchRunning ? "#ffcc66" : "#2a3d4c",
          borderRadius:4, padding:"3px 8px", cursor: undoStack.length>0 && !replayActive && !batchRunning ? "pointer" : "default",
          fontSize:7, fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em",
          whiteSpace:"nowrap",
        }}>
          ↶ UNDO
        </button>

        {autoAdvance && (
          <select value={autoSpeed} onChange={e=>setAutoSpeed(+e.target.value)} style={{
            background:"rgba(4,9,22,0.97)", border:"1px solid rgba(0,255,120,0.2)",
            color:"#44ff88", borderRadius:4, padding:"3px 5px",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace", outline:"none",
          }}>
            <option value={2000}>0.5×</option>
            <option value={1000}>1×</option>
            <option value={500}>2×</option>
            <option value={200}>5×</option>
            <option value={80}>12×</option>
          </select>
        )}

        {replayActive && (
          <>
            <div style={{ width:1, height:16, background:"rgba(255,255,255,0.07)" }}/>
            <button onClick={()=>loadReplayFrame(replayRun, Math.max(0, replayFrameIndex - 1))} disabled={replayFrameIndex===0} style={{
              background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
              color: replayFrameIndex===0 ? "#1e3040" : "#7aaac0", borderRadius:4, padding:"3px 7px",
              cursor: replayFrameIndex===0 ? "default" : "pointer", fontSize:7, fontFamily:"'JetBrains Mono',monospace",
            }}>◀</button>
            <button onClick={()=>setReplayPlaying(v=>!v)} style={{
              background: replayPlaying ? "rgba(255,180,0,0.12)" : "rgba(0,180,255,0.08)",
              border:`1px solid ${replayPlaying?"rgba(255,180,0,0.28)":"rgba(0,180,255,0.22)"}`,
              color: replayPlaying ? "#ffcc66" : "#66c8ff", borderRadius:4, padding:"3px 8px",
              cursor:"pointer", fontSize:7, fontFamily:"'JetBrains Mono',monospace",
            }}>{replayPlaying ? "PAUSE" : "PLAY"}</button>
            <button onClick={()=>loadReplayFrame(replayRun, Math.min((replayRun?.frames?.length ?? 1) - 1, replayFrameIndex + 1))}
              disabled={replayFrameIndex >= (replayRun?.frames?.length ?? 1) - 1} style={{
              background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
              color: replayFrameIndex >= (replayRun?.frames?.length ?? 1) - 1 ? "#1e3040" : "#7aaac0",
              borderRadius:4, padding:"3px 7px", cursor: replayFrameIndex >= (replayRun?.frames?.length ?? 1) - 1 ? "default" : "pointer",
              fontSize:7, fontFamily:"'JetBrains Mono',monospace",
            }}>▶</button>
            <div style={{ fontSize:7, color:"#3a5570", whiteSpace:"nowrap" }}>
              {replayFrameIndex+1}/{replayRun?.frames?.length ?? 1}
            </div>
            <button onClick={exitReplay} style={{
              background:"rgba(255,120,80,0.06)", border:"1px solid rgba(255,120,80,0.18)",
              color:"#cc7766", borderRadius:4, padding:"3px 7px", cursor:"pointer",
              fontSize:7, fontFamily:"'JetBrains Mono',monospace",
            }}>EXIT REPLAY</button>
          </>
        )}

        <div style={{ width:1, height:16, background:"rgba(255,255,255,0.07)" }}/>

        {/* Annotation tool */}
        <button onClick={()=>setAnnotating(v=>!v)} title="Place map annotations" style={{
          background: annotating ? "rgba(255,200,0,0.14)" : "rgba(255,255,255,0.03)",
          border:`1px solid ${annotating?"rgba(255,200,0,0.3)":"rgba(255,255,255,0.07)"}`,
          color: annotating ? "#ffcc00" : "#3a5570",
          borderRadius:4, padding:"3px 8px", cursor:"pointer",
          fontSize:7, fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em",
        }}>📍 PIN</button>

        {annotating && (
          <input
            value={annotNote}
            onChange={e=>setAnnotNote(e.target.value)}
            placeholder="Pin label..."
            style={{
              background:"rgba(4,9,22,0.97)", border:"1px solid rgba(255,200,0,0.25)",
              color:"#ffcc00", borderRadius:4, padding:"3px 7px",
              fontSize:7, fontFamily:"'JetBrains Mono',monospace", outline:"none", width:90,
            }}
          />
        )}

        {annotations.length > 0 && (
          <button onClick={()=>setAnnotations([])} title="Clear all pins" style={{
            background:"transparent", border:"1px solid rgba(255,100,50,0.2)",
            color:"#774433", borderRadius:4, padding:"3px 6px", cursor:"pointer",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace",
          }}>✕ {annotations.length}</button>
        )}

        <div style={{ width:1, height:16, background:"rgba(255,255,255,0.07)" }}/>

        {/* Panel toggles */}
        {[
          ["📋", "LOG", showLog, ()=>setShowLog(v=>!v), "Mission event log"],
          ["📊", "DATA", showAnalytics, ()=>setShowAnalytics(v=>!v), "Analytics charts"],
          ["⚙", "PARAMS", showParams, ()=>setShowParams(v=>!v), "Physics parameters"],
        ].map(([icon, label, active, fn, tip]) => (
          <button key={label} onClick={fn} title={tip} style={{
            background: active ? "rgba(100,180,255,0.1)" : "rgba(255,255,255,0.03)",
            border:`1px solid ${active?"rgba(100,180,255,0.25)":"rgba(255,255,255,0.07)"}`,
            color: active ? "#66aadd" : "#3a5570",
            borderRadius:4, padding:"3px 7px", cursor:"pointer",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em",
          }}>{icon} {label}</button>
        ))}

        <div style={{ marginLeft:"auto", display:"flex", gap:3 }}>
          <button onClick={()=>setShowPlots(true)} disabled={!p1 || batchRunning || replayLoading} title="Open analysis plots" style={{
            background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
            color: (!p1 || batchRunning || replayLoading) ? "#2a2f38" : "#7fd9ff", borderRadius:4, padding:"3px 7px",
            cursor: (!p1 || batchRunning || replayLoading) ? "default" : "pointer",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace",
          }}>📈 PLOTS</button>
          <button onClick={exportSaveGame} disabled={!p1 || gifExporting} title="Save full game state to a .json file you can reload later" style={{
            background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
            color: (!p1 || gifExporting) ? "#2a2f38" : "#5ab4d4", borderRadius:4, padding:"3px 7px",
            cursor: (!p1 || gifExporting) ? "default" : "pointer",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace",
          }}>💾 SAVE</button>
          <button onClick={exportMissionGif} disabled={!p1 || gifExporting || batchRunning || replayLoading} title="Export the visible mission timeline as an animated GIF" style={{
            background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
            color: (!p1 || gifExporting || batchRunning || replayLoading) ? "#2a2f38" : "#d4a85f", borderRadius:4, padding:"3px 7px",
            cursor: (!p1 || gifExporting || batchRunning || replayLoading) ? "default" : "pointer",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace",
          }}>⬇ GIF</button>
          {gifExporting && (
            <button onClick={() => {
              if (gifSavedSnapshotRef.current) applyUndoSnapshot(gifSavedSnapshotRef.current);
              gifSavedSnapshotRef.current = null;
              setGifExporting(false);
            }} title="Cancel GIF export and restore game state" style={{
              background:"rgba(255,80,80,0.12)", border:"1px solid rgba(255,80,80,0.35)",
              color:"#ff6060", borderRadius:4, padding:"3px 7px", cursor:"pointer",
              fontSize:7, fontFamily:"'JetBrains Mono',monospace",
            }}>✕ CANCEL GIF</button>
          )}
          <button onClick={exportMissionData} disabled={missionLog.length===0} title="Export event log as CSV" style={{
            background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
            color: missionLog.length>0?"#3a7a50":"#1a2a22", borderRadius:4, padding:"3px 7px",
            cursor: missionLog.length>0?"pointer":"default",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace",
          }}>⬇ CSV</button>
          <button onClick={exportStateJSON} disabled={!p1} title="Export full mission state as JSON" style={{
            background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
            color: p1?"#3a6090":"#1a2030", borderRadius:4, padding:"3px 7px",
            cursor: p1?"pointer":"default",
            fontSize:7, fontFamily:"'JetBrains Mono',monospace",
          }}>⬇ JSON</button>
        </div>
      </div>

      {showPlots && (
        <div style={{
          width:"100%", maxWidth:980, marginBottom:10,
          background:"rgba(3,7,18,0.98)", border:"1px solid rgba(255,255,255,0.08)",
          borderRadius:10, padding:"14px 16px", boxShadow:"0 0 40px rgba(0,0,0,0.45)",
        }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div>
              <div style={{ fontSize:8, letterSpacing:"0.28em", color:"#4f7c96", fontFamily:"'Orbitron',monospace" }}>MISSION PLOTS</div>
              <div style={{ fontSize:7, color:"#35546a", marginTop:3 }}>
                Timeline source: {replayRun ? "Replay frames" : "Live mission timeline"} · Each plot can be exported as PNG.
              </div>
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={exportAllPlots} style={{
                background:"rgba(68,170,255,0.1)", border:"1px solid rgba(68,170,255,0.35)",
                color:"#7fd9ff", borderRadius:6, padding:"7px 10px", cursor:"pointer",
                fontSize:7, letterSpacing:"0.12em", fontFamily:"'JetBrains Mono',monospace",
              }}>EXPORT ALL PNGS</button>
              <button onClick={()=>setShowPlots(false)} style={{
                background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
                color:"#6b8aa1", borderRadius:6, padding:"7px 10px", cursor:"pointer",
                fontSize:7, letterSpacing:"0.12em", fontFamily:"'JetBrains Mono',monospace",
              }}>CLOSE</button>
            </div>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:14, maxHeight:"70vh", overflowY:"auto", paddingRight:4 }}>
            {plotDefinitions.map(plot => (
              <div key={plot.id} style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10, padding:"10px 10px 12px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div style={{ fontSize:8, color:"#7ea8c2", letterSpacing:"0.12em", fontFamily:"'Orbitron',monospace" }}>{plot.title}</div>
                  <div style={{ display:"flex", gap:6 }}>
                    <button onClick={() => setSeparatePlotsOpen(prev => ({ ...prev, [plot.id]: !prev[plot.id] }))} style={{
                      background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
                      color:"#9bc4db", borderRadius:5, padding:"5px 8px", cursor:"pointer",
                      fontSize:6.5, fontFamily:"'JetBrains Mono',monospace",
                    }}>{separatePlotsOpen[plot.id] ? "HIDE SEPERATE PLOTS" : "SEPERATE PLOTS"}</button>
                    <button onClick={() => downloadCanvasPng(plotCanvasRefs.current[plot.id], `${plot.id}.png`)} style={{
                      background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
                      color:"#9bc4db", borderRadius:5, padding:"5px 8px", cursor:"pointer",
                      fontSize:6.5, fontFamily:"'JetBrains Mono',monospace",
                    }}>EXPORT PNG</button>
                  </div>
                </div>
                <PlotCanvas plot={plot} />
                {separatePlotsOpen[plot.id] && (
                  <div style={{ marginTop:10, display:"flex", flexDirection:"column", gap:10 }}>
                    {plot.series.map((series, idx) => {
                      const singlePlot = buildSeparatePlot(plot, series, idx);
                      return (
                        <div key={singlePlot.id} style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, padding:"8px 8px 10px" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                            <div style={{ fontSize:7, color:"#86acc4", letterSpacing:"0.08em", fontFamily:"'Orbitron',monospace" }}>{series.label}</div>
                            <button onClick={() => downloadCanvasPng(plotCanvasRefs.current[singlePlot.id], `${singlePlot.id}.png`)} style={{
                              background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
                              color:"#9bc4db", borderRadius:5, padding:"4px 7px", cursor:"pointer",
                              fontSize:6.5, fontFamily:"'JetBrains Mono',monospace",
                            }}>EXPORT PNG</button>
                          </div>
                          <PlotCanvas plot={singlePlot} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Turn / phase prompt */}
      {(() => {
        let msg, color;
        if (replayActive) { msg=`▶ REPLAY MODE — Frame ${replayFrameIndex+1}/${replayRun?.frames?.length ?? 1}`; color="#44aaff"; }
        else if (phase===PHASE.SETUP1) { msg="◉ PLAYER 1 — Click a dark PSR crater to place your base"; color="#ffd700"; }
        else if (phase===PHASE.SETUP1_HAB) { msg="◉ PLAYER 1 — Click anywhere to place your free 🏠 Habitat"; color="#ffd700"; }
        else if (phase===PHASE.SETUP1_SOL) { msg="◉ PLAYER 1 — Click anywhere to place your free ☀ Solar Panel"; color="#ffd700"; }
        else if (phase===PHASE.SETUP1_PAD) { msg="◉ PLAYER 1 — Click anywhere to place your free 🛬 Landing Pad"; color="#ffd700"; }
        else if (phase===PHASE.SETUP2) { msg="◉ PLAYER 2 — Click a dark PSR crater to place your base"; color="#b000ff"; }
        else if (phase===PHASE.SETUP2_HAB) { msg="◉ PLAYER 2 — Click anywhere to place your free 🏠 Habitat"; color="#b000ff"; }
        else if (phase===PHASE.SETUP2_SOL) { msg="◉ PLAYER 2 — Click anywhere to place your free ☀ Solar Panel"; color="#b000ff"; }
        else if (phase===PHASE.SETUP2_PAD) { msg="◉ PLAYER 2 — Click anywhere to place your free 🛬 Landing Pad"; color="#b000ff"; }
        else if (phase===PHASE.DONE) { msg="▶ MISSION COMPLETE · DEBRIEF BELOW"; color="#44aaff"; }
        else if (phase===PHASE.PLAYING && scenarioPreset === "unevenArrival" && !p2 && globalDay < arrivalDelay) {
          const daysRemaining = Math.max(0, arrivalDelay - globalDay);
          msg=`▶ PLAYER 1 HEAD START · PLAYER 2 ARRIVES IN ${daysRemaining} DAY${daysRemaining!==1?"S":""}`;
          color="#44aaff";
        }
        else if (placingFor!==null) {
          const icon = ({solar:"☀ Solar Panel",reactor:"☢ Nuclear Reactor",habitat:"🏠 Habitat",pad:"🛬 Landing Pad"})[placingType] || placingType;
          msg=`📍 P${placingFor+1} — Click anywhere to place ${icon}`;
          color=placingFor===0?"#ffd700":"#b000ff";
        }
        else if (selectingFor!==null) {
          msg=`📍 P${selectingFor+1} — Left-click set waypoint · Right-click add more · Click ✓ Done to confirm`;
          color=selectingFor===0?"#ffd700":"#b000ff";
        } else if (p1Done && p2Done) {
          msg="⚙ Resolving turn…"; color="#44ff88";
        } else if (p1Done && !p2Done) {
          msg="✓ P1 confirmed · PLAYER 2 — Plan your action then click END TURN"; color="#b000ff";
        } else if (!p1Done && p2Done) {
          msg="✓ P2 confirmed · PLAYER 1 — Plan your action then click END TURN"; color="#ffd700";
        } else {
          const who = activeTurn===0 ? "PLAYER 1" : "PLAYER 2";
          const col2 = activeTurn===0 ? "#ffd700" : "#b000ff";
          msg=`▶ ${who} — Set a waypoint (or stay to mine), then END TURN`; color=col2;
        }
        return (
          <div style={{
            width:"100%", maxWidth:650,
            background:night?"rgba(10,5,30,0.85)":"rgba(4,8,20,0.85)",
            border:`1px solid ${color}33`,
            borderLeft:`3px solid ${color}`,
            borderRadius:4, padding:"6px 14px", marginBottom:6,
            fontSize:8, letterSpacing:"0.08em", textAlign:"left", color,
            backdropFilter:"blur(4px)",
          }}>{msg}</div>
        );
      })()}

      {/* Scorebar */}
      <div style={{ display:"flex", gap:5, width:"100%", maxWidth:650, marginBottom:5 }}>
        {[
          { label:"PLAYER 1", val:score1.toFixed(0), color:"#ffd700",
            sub:`💧 ${totalIce1.toFixed(0)}kg · 🏗 ${p1?.assetPts??0}ap · ⚠ ${p1?.safetyViolations??0}`,
            sub2:`${Math.round(p1?.budget??0)}cr · ${(share1*100).toFixed(0)}%` },
          { label:roundCounterLabel,
            val:`${depleted}/${CRATER_DATA.length}`, color:"#2a5070",
            sub:"craters depleted", sub2:"" },
          { label:"PLAYER 2", val:score2.toFixed(0), color:"#b000ff",
            sub:`💧 ${totalIce2.toFixed(0)}kg · 🏗 ${p2?.assetPts??0}ap · ⚠ ${p2?.safetyViolations??0}`,
            sub2:`${Math.round(p2?.budget??0)}cr · ${((1-share1)*100).toFixed(0)}%` },
        ].map(({label,val,color,sub,sub2}) => (
          <div key={label} style={{ flex:1, background:"rgba(4,9,22,0.98)",
            border:`1px solid ${color}1a`, borderRadius:6, padding:"7px 9px", textAlign:"center",
            position:"relative", overflow:"hidden",
            boxShadow:`inset 0 0 20px ${color}06` }}>
            <div style={{ position:"absolute", inset:0, pointerEvents:"none",
              background:`radial-gradient(ellipse at 50% 0%, ${color}08 0%, transparent 70%)` }} />
            <div style={{ fontSize:7, color, opacity:0.5, letterSpacing:"0.2em", marginBottom:2,
              fontFamily:"'Orbitron',monospace" }}>{label}</div>
            <div style={{ fontSize:20, fontWeight:900, color, lineHeight:1.05,
              fontFamily:"'Orbitron',monospace", textShadow:`0 0 12px ${color}44` }}>{val}</div>
            <div style={{ fontSize:6, color, opacity:0.35, letterSpacing:"0.12em" }}>MISSION SCORE</div>
            <div style={{ fontSize:7, color:"#3a4a5a", marginTop:2 }}>{sub}</div>
            {sub2 && <div style={{ fontSize:7, color:"#2a3a4a" }}>{sub2}</div>}
          </div>
        ))}
      </div>

      {/* Ice share bar */}
      <div style={{ width:"100%", maxWidth:650, height:4, background:"rgba(255,255,255,0.04)",
        borderRadius:2, overflow:"hidden", marginBottom:6, display:"flex",
        boxShadow:"inset 0 1px 0 rgba(0,0,0,0.3)" }}>
        <div style={{ width:`${share1*100}%`, background:"linear-gradient(90deg,#b8860088,#ffd700aa)", transition:"width 0.4s ease", boxShadow:"1px 0 6px #ffd70066" }} />
        <div style={{ flex:1, background:"linear-gradient(90deg,#b000ffaa,#6600cc88)" }} />
      </div>

      {/* Main content */}
      <div style={{ display:"flex", gap:6, width:"100%", maxWidth:650, alignItems:"flex-start" }}>
        {/* Player panels */}
        {[0,1].map(pi => {
          const p = pi===0 ? p1 : p2;
          const color = pi===0 ? "#ffd700" : "#b000ff";
          if (!p) {
            if (scenarioPreset === "unevenArrival" && pi === 1 && phase === PHASE.PLAYING && globalDay < arrivalDelay) {
              const daysRemaining = Math.max(0, arrivalDelay - globalDay);
              return (
                <div key={pi} style={{ width:170, flexShrink:0, background:"rgba(20,10,30,0.92)",
                  border:"1px solid rgba(120,160,255,0.18)", borderRadius:8, padding:10,
                  minHeight:120, boxShadow:"inset 0 0 24px rgba(80,120,255,0.06)" }}>
                  <div style={{ fontSize:10, fontWeight:900, color:color, letterSpacing:"0.12em",
                    fontFamily:"'Orbitron',monospace", marginBottom:8 }}>P2</div>
                  <div style={{ fontSize:7, color:"#6a8fa8", letterSpacing:"0.08em", marginBottom:6 }}>
                    ARRIVAL DELAY ACTIVE
                  </div>
                  <div style={{ fontSize:18, color:"#44aaff", fontWeight:900,
                    fontFamily:"'Orbitron',monospace", marginBottom:4 }}>
                    D+{arrivalDelay}
                  </div>
                  <div style={{ fontSize:7, color:"#3a5570", lineHeight:1.8 }}>
                    Player 2 lands in {daysRemaining} day{daysRemaining!==1?"s":""}.
                  </div>
                </div>
              );
            }
            return (
              <div key={pi} style={{ width:170, flexShrink:0, background:"rgba(255,255,255,0.02)",
                border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, padding:10,
                display:"flex", alignItems:"center", justifyContent:"center",
                color:"#1a3050", fontSize:8, letterSpacing:"0.12em", minHeight:120 }}>
                AWAITING
              </div>
            );
          }
          if (p.active === false) {
            const daysRemaining = Math.max(0, (p.arrivalDay ?? arrivalDelay) - globalDay);
            return (
              <div key={pi} style={{ width:170, flexShrink:0, background:"rgba(20,10,30,0.92)",
                border:"1px solid rgba(120,160,255,0.18)", borderRadius:8, padding:10,
                minHeight:120, boxShadow:"inset 0 0 24px rgba(80,120,255,0.06)" }}>
                <div style={{ fontSize:10, fontWeight:900, color:color, letterSpacing:"0.12em",
                  fontFamily:"'Orbitron',monospace", marginBottom:8 }}>P{pi+1}</div>
                <div style={{ fontSize:7, color:"#6a8fa8", letterSpacing:"0.08em", marginBottom:6 }}>
                  ARRIVAL DELAY ACTIVE
                </div>
                <div style={{ fontSize:18, color:"#44aaff", fontWeight:900,
                  fontFamily:"'Orbitron',monospace", marginBottom:4 }}>
                  D+{p.arrivalDay ?? arrivalDelay}
                </div>
                <div style={{ fontSize:7, color:"#3a5570", lineHeight:1.8 }}>
                  Player {pi+1} lands in {daysRemaining} day{daysRemaining!==1?"s":""}.
                </div>
              </div>
            );
          }

          const panelPwr = p.panels.reduce((s,pn)=>{
            if (night) return s; // no charging at night
            const px2=Math.round(pn.y)*W+Math.round(pn.x);
            const illum2=(px2>=0&&px2<W*H)?ILLUM_MAP[px2]:1.0;
            return s+PANEL_RIDGE*illum2;
          },0);
          const reactorPwr = (p.reactors||[]).reduce((s, _, i) => {
            const health = p.structureHealth?.reactors?.[i] ?? 1.0;
            return health > 0 ? s + REACTOR_OUTPUT : s;
          }, 0);
          const isSelecting = selectingFor===pi;
          const roverIdx    = selectedRover[pi];
          const activeRover = roverIdx === 0 ? p : (p.extraRovers||[])[roverIdx - 1];
          const activeRoverLabel = `R${roverIdx + 1}`;
          const wpCount     = activeRover
            ? (activeRover.waypoints||[]).length + (activeRover.currentWaypoint ? 1 : 0) : 0;
          const totalRovers = 1 + (p.extraRovers||[]).length;
          // All of these reflect the currently-selected rover, not always the primary
          const arX = activeRover ? Math.round(activeRover.x ?? p.x) : Math.round(p.x);
          const arY = activeRover ? Math.round(activeRover.y ?? p.y) : Math.round(p.y);
          const si  = STATUS_INFO[(activeRover?.status ?? p.status)] || STATUS_INFO.idle;
          const onRidgeNow = RIDGE_MASK[arY * W + arX] === 1;
          const ci = PIXEL_CRATER[arY * W + arX];
          const localHealth = ci>=0 ? craterHealth[ci] : null;
          const isDone = (pi===0&&p1Done)||(pi===1&&p2Done);
          const isMyTurn = activeTurn===pi && !isDone && phase===PHASE.PLAYING;

          return (
            <div key={pi} style={{
              width:170, flexShrink:0,
              background: isDone ? `rgba(${pi===0?"12,20,6":"8,0,20"},0.98)` :
                          isMyTurn ? `rgba(${pi===0?"28,20,0":"20,0,36"},0.98)` : "rgba(5,10,22,0.98)",
              border:`1px solid ${isDone?(color+"66"):isMyTurn?(color+"aa"):(color+"1a")}`,
              borderRadius:8, padding:"10px 11px", transition:"border 0.2s, box-shadow 0.2s",
              boxShadow: isMyTurn && !isDone ? `0 0 18px ${color}22, inset 0 0 30px ${color}05` : "none",
            }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:9,
                borderBottom:`1px solid ${color}18`, paddingBottom:7 }}>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:color,
                    boxShadow:isMyTurn?`0 0 8px ${color}`:"none",
                    transition:"box-shadow 0.3s" }} />
                  <span style={{ fontSize:10, fontWeight:900, color, letterSpacing:"0.12em",
                    fontFamily:"'Orbitron',monospace" }}>P{pi+1}</span>
                  {isDone && <span style={{ fontSize:8, color:"#44ff66", letterSpacing:"0.05em" }}>✓</span>}
                  {isMyTurn && <span style={{ fontSize:7, color, opacity:0.6, letterSpacing:"0.06em" }}>ACTIVE</span>}
                </div>
                <span style={{ fontSize:7, color:si.col, background:`${si.col}11`,
                  border:`1px solid ${si.col}33`, borderRadius:3, padding:"2px 5px",
                  letterSpacing:"0.06em" }}>{si.icon} {si.label}</span>
              </div>

              {/* Power */}
              <div style={{ marginBottom:6 }}>
                {(() => {
                  const roverPower = activeRover?.power ?? p.power;
                  const powerLow = roverPower > POWER_LOW;
                  return (
                    <>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, color:"#1e3040", marginBottom:2 }}>
                  <span>⚡ {activeRoverLabel} POWER</span>
                  <span style={{ color:powerLow?"#77ee33":"#ee4433",
                    fontFamily:"'JetBrains Mono',monospace" }}>{roverPower.toFixed(0)}/{POWER_CAP}</span>
                </div>
                <Bar val={roverPower} max={POWER_CAP} color={powerLow?"#66ee33":"#ee3322"} h={4} />
                    </>
                  );
                })()}
                <div style={{ fontSize:6, color:night?"#4a3a18":"#1e2e18", marginTop:2, letterSpacing:"0.04em" }}>
                  {activeRoverLabel} battery ·
                  +{Math.round(panelPwr + reactorPwr)}/day · {p.panels.length} panel{p.panels.length!==1?"s":""}
                  {(p.reactors||[]).length>0 &&
                    <span style={{color}}> · {(p.reactors||[]).length} ☢ reactor{(p.reactors||[]).length!==1?"s":""}</span>}
                  {p.panels.filter(pn=>pn.onRidge).length>0 &&
                    <span style={{color:"#88cc33"}}> ({p.panels.filter(pn=>pn.onRidge).length}★ridge)</span>}
                  {night && p.panels.length>0 && <span style={{color:"#8866cc"}}> 🌙 solar offline</span>}
                </div>
              </div>

              {/* Ice carry — shows selected rover's cargo */}
              <div style={{ marginBottom:6 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, color:"#1e3040", marginBottom:2 }}>
                  <span>❄ {activeRoverLabel} ICE CARRY</span>
                  <span style={{color:"#66aadd",fontFamily:"'JetBrains Mono',monospace"}}>{(activeRover?.ice??p.ice).toFixed(0)}/{ICE_CAP}kg</span>
                </div>
                <Bar val={activeRover?.ice??p.ice} max={ICE_CAP} color="#3399cc" h={4} />
                <div style={{ fontSize:6, color:"#1e2e38", marginTop:2, letterSpacing:"0.04em" }}>
                  Cargo currently loaded on {activeRoverLabel.toLowerCase()}
                </div>
              </div>

              {/* Budget */}
              {(() => {
                const bud = p.budget ?? calcBudget(E_INIT);
                const { costs } = calcAssetCosts(p.alloc || { mil:20, rd:20, econ:60 });
                const budCol = bud > 60 ? "#33ddaa" : bud > 20 ? "#ccaa33" : "#ee4433";
                const E = p.econ ?? E_INIT;
                const M = p.milStock ?? 1;
                return (
                  <div style={{ marginBottom:6 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, color:"#1e3040", marginBottom:2 }}>
                      <span>💰 BUDGET</span>
                      <span style={{color:budCol,fontFamily:"'JetBrains Mono',monospace"}}>{Math.round(bud)}cr</span>
                    </div>
                    <Bar val={bud} max={400} color={budCol} h={4} />
                    <div style={{ fontSize:6, color:"#1a2418", marginTop:2, letterSpacing:"0.03em" }}>
                      E:{E.toFixed(1)} · R:{Math.round(p.rdAccum??0)} · M:{M.toFixed(1)} · Mil:{(p.milScore??1).toFixed(2)}x
                    </div>
                  </div>
                );
              })()}

              {/* Asset Points */}
              {(() => {
                const pts = p.assetPts ?? 0;
                // Rolling display target: grow the bar's ceiling in 50-ap steps
                // so early bases fill a short bar and massive bases still show
                // progress rather than the bar staying pinned near empty.
                const maxPts = Math.max(50, Math.ceil((pts + 1) / 50) * 50);
                const breakdown = [
                  { icon:"🏠", count:(p.habitats||[]).length,      pts:ASSET_POINTS.habitat },
                  { icon:"🛬", count:(p.landingPads||[]).length,   pts:ASSET_POINTS.pad     },
                  { icon:"🚗", count:(p.extraRovers||[]).length + 1, pts:ASSET_POINTS.rover   },
                  { icon:"☀", count:p.panels.length,               pts:ASSET_POINTS.solar   },
                  { icon:"☢", count:(p.reactors||[]).length,       pts:ASSET_POINTS.reactor },
                ].filter(b => b.count > 0);
                const ptsCol = pts >= 20 ? "#ff9944" : pts >= 10 ? "#ffcc44" : "#667788";
                return (
                  <div style={{ marginBottom:5 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, color:"#2a4055", marginBottom:2 }}>
                      <span>🏗 Asset Pts</span>
                      <span style={{ color:ptsCol, fontWeight:700 }}>{pts}</span>
                    </div>
                    <Bar val={pts} max={maxPts} color={ptsCol} h={3} />
                    {breakdown.length > 0 && (
                      <div style={{ display:"flex", gap:4, marginTop:2, flexWrap:"wrap" }}>
                        {breakdown.map(b => (
                          <span key={b.icon} style={{ fontSize:6, color:"#2a5070" }}>
                            {b.icon}×{b.count}={b.count*b.pts}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Habitat power bars */}
                    {(p.habitats||[]).length > 0 && (
                      <div style={{ marginTop:4 }}>
                        <div style={{ fontSize:6, color:"#2a4055", marginBottom:2, letterSpacing:"0.06em" }}>
                          🏠 HABITAT POWER
                        </div>
                        {(p.habitats||[]).map((_, i) => {
                          const hPwr = (p.habitatPower ?? [])[i] ?? HABITAT_POWER_INIT;
                          const frac = Math.max(0, hPwr / HABITAT_POWER_CAP);
                          const col  = frac > 0.4 ? "#44ff88" : frac > 0.15 ? "#ffcc44" : "#ff4444";
                          const label = frac <= 0 ? "⚡ OFFLINE" : `${hPwr.toFixed(0)}/${HABITAT_POWER_CAP}`;
                          return (
                            <div key={i} style={{ marginBottom:3 }}>
                              <div style={{ display:"flex", justifyContent:"space-between", fontSize:6, color:"#2a4055", marginBottom:1 }}>
                                <span>Hab {i+1}</span>
                                <span style={{ color: frac <= 0 ? "#ff4444" : col }}>{label}</span>
                              </div>
                              <Bar val={hPwr} max={HABITAT_POWER_CAP} color={col} h={3} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Budget allocation sliders */}
              {(() => {
                const alloc = p.alloc || { mil:20, rd:20, econ:60 };
                const E = p.econ ?? E_INIT;
                const projBudget = calcBudget(E);
                const { costs: aC, maint: aM } = calcAssetCosts(alloc);
                const totalMaint = (p.panels.length * aM.solar)
                  + (((p.reactors||[]).length) * aM.reactor)
                  + ((p.habitats||[]).length * aM.habitat)
                  + ((p.extraRovers||[]).length * aM.rover)
                  + ((p.landingPads||[]).length * aM.pad);
                const spendableFrac = Math.max(0, 1 - totalMaint / Math.max(1, projBudget));
                const totalPct  = (alloc.mil + alloc.rd + alloc.econ + (alloc.budget||0)) || 1;
                const I_E_proj = ((alloc.econ / totalPct) * spendableFrac).toFixed(2);
                const I_R_proj = ((alloc.rd   / totalPct) * spendableFrac).toFixed(2);
                const I_M_proj = ((alloc.mil  / totalPct) * spendableFrac).toFixed(2);
                const I_B_proj = Math.round(((alloc.budget||0) / totalPct) * spendableFrac * (p.budget ?? 0));
                const sliders = [
                  { key:"mil",    label:"MIL",  col:"#ff5544", tip:`${I_M_proj} → ΔM` },
                  { key:"rd",     label:"R&D",  col:"#44aaff", tip:`${I_R_proj} → ΔR` },
                  { key:"econ",   label:"ECO",  col:"#44ffaa", tip:`${I_E_proj} → ΔE` },
                  { key:"budget", label:"BUD",  col:"#ffcc44", tip:`+${I_B_proj}cr` },
                ];
                return (
                  <div style={{ marginBottom:6, background:"rgba(0,0,0,0.2)",
                    border:"1px solid rgba(255,255,255,0.04)", borderRadius:5, padding:"7px 8px" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:6,
                      color:"#1e3040", marginBottom:5, letterSpacing:"0.1em",
                      fontFamily:"'Orbitron',monospace" }}>
                      <span>ALLOCATION · E={E.toFixed(1)}</span>
                      <span style={{ color:"#cc9922" }}>{projBudget}cr/rnd</span>
                    </div>
                    {sliders.map(({ key, label, col, tip }) => (
                      <div key={key} style={{ marginBottom:5 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:6,
                          marginBottom:2 }}>
                          <span style={{ color:col, letterSpacing:"0.08em" }}>{label} {alloc[key]}%</span>
                          <span style={{ color:"#1e3040" }}>{tip}</span>
                        </div>
                        <input type="range" min={0} max={80} step={5}
                          value={alloc[key]}
                          disabled={isDone}
                          onChange={e => setAlloc(pi, key, +e.target.value)}
                          style={{ width:"100%", accentColor:col, cursor:isDone?"not-allowed":"pointer",
                            color:col }} />
                      </div>
                    ))}
                    <div style={{ marginTop:4, display:"flex", gap:3, flexWrap:"wrap" }}>
                      {Object.entries(aC).map(([k,v]) => (
                        <span key={k} style={{ fontSize:5, color:"#1e3040",
                          background:"rgba(255,255,255,0.04)", borderRadius:2, padding:"2px 4px",
                          border:"1px solid rgba(255,255,255,0.04)" }}>
                          {({solar:"☀",reactor:"☢",habitat:"🏠",rover:"🚗",pad:"🛬"})[k]} {v}cr
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {localHealth!==null && (
                <div style={{ marginBottom:5, fontSize:7, padding:"3px 0",
                  color:localHealth>0.6?"#33cc99":localHealth>0.3?"#ccaa33":"#cc4422",
                  letterSpacing:"0.05em" }}>
                  🌑 Crater {(localHealth*100).toFixed(0)}% intact
                </div>
              )}

              {wpCount>0 && (
                <div style={{ fontSize:7, color:"#1e4060", marginBottom:4, letterSpacing:"0.06em" }}>
                  📍 {wpCount} waypoint{wpCount!==1?"s":""} queued
                  {roverIdx>0 && <span style={{color,opacity:0.5}}> (R{roverIdx+1})</span>}
                </div>
              )}

              {/* Auto-return indicator */}
              {p.returning && false && (
                <div style={{ fontSize:7, color:"#ff8860", marginBottom:5 }}>↩ Auto-returning to base</div>
              )}

              {/* Buttons */}
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {/* Rover selector tabs */}
                {totalRovers > 1 && (
                  <div style={{ display:"flex", gap:2 }}>
                    {Array.from({length:totalRovers},(_,ri) => {
                      const isActive = roverIdx === ri;
                      const rState   = ri === 0 ? p : (p.extraRovers||[])[ri-1];
                      const rIce     = rState?.ice ?? 0;
                      return (
                        <button key={ri}
                          onClick={() => setSelectedRover(prev => { const n=[...prev]; n[pi]=ri; return n; })}
                          style={{
                            flex:1, padding:"3px 0",
                            background: isActive?(color+"22"):"rgba(255,255,255,0.03)",
                            border:`1px solid ${isActive?color:"rgba(255,255,255,0.07)"}`,
                            color: isActive?color:"#2a4055",
                            borderRadius:3, cursor:"pointer", fontSize:7, fontFamily:"inherit",
                          }}>
                          R{ri+1}{rIce>2?` ❄${rIce.toFixed(0)}`:""}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Waypoint button — sets waypoint for currently selected rover */}
                <button onClick={()=>{ setSelectingFor(isSelecting?null:pi); setAddingWaypoint(false); }}
                  disabled={isDone}
                  style={{
                    background:isSelecting?`rgba(${pi===0?"255,215,0":"176,0,255"},0.12)`:"rgba(255,255,255,0.04)",
                    border:`1px solid ${isSelecting?color:"rgba(255,255,255,0.07)"}`,
                    color:isSelecting?color:isDone?"#0d1a22":"#3a5570",
                    borderRadius:5, padding:"6px 0", cursor:isDone?"not-allowed":"pointer",
                    fontSize:8, letterSpacing:"0.08em", fontFamily:"inherit",
                    opacity:isDone?0.35:1,
                    boxShadow:isSelecting?`0 0 10px ${color}33`:"none",
                  }}>
                  {isSelecting?"✓ CONFIRM ROUTE":"📍 SET WAYPOINT"}
                </button>

                {wpCount>0 && (
                  <button onClick={()=>clearWaypoints(pi)} disabled={isDone} style={{
                    background:"rgba(255,40,40,0.06)", border:"1px solid rgba(255,60,60,0.18)",
                    color:isDone?"#1a0a0a":"#cc5544", borderRadius:5, padding:"4px 0",
                    cursor:isDone?"not-allowed":"pointer", fontSize:7, fontFamily:"inherit",
                    opacity:isDone?0.35:1, letterSpacing:"0.06em" }}>✕ CLEAR ROUTE</button>
                )}

                {/* Build dropdown */}
                {(() => {
                  const pads = p.landingPads || [];
                  const { costs: aCosts, maint: aMaint } = calcAssetCosts(p.alloc || { mil:20, rd:20, econ:60 });
                  const BUILD_OPTIONS = [
                    { type:"solar",   label:"☀ Solar Panel",   cost:aCosts.solar,   maint:aMaint.solar,   pts:ASSET_POINTS.solar,   max:MAX_PANELS,   count:p.panels.length },
                    { type:"reactor", label:"☢ Nuclear Reactor", cost:aCosts.reactor, maint:aMaint.reactor, pts:ASSET_POINTS.reactor, max:MAX_REACTORS, count:(p.reactors||[]).length },
                    { type:"habitat", label:"🏠 Habitat",       cost:aCosts.habitat, maint:aMaint.habitat, pts:ASSET_POINTS.habitat, max:MAX_HABITATS, count:(p.habitats||[]).length },
                    { type:"rover",   label:"🚗 Rover",         cost:aCosts.rover,   maint:aMaint.rover,   pts:ASSET_POINTS.rover,   max:MAX_ROVERS,   count:(p.extraRovers||[]).length + 1 },
                    { type:"pad",     label:"🛬 Landing Pad",   cost:aCosts.pad,     maint:aMaint.pad,     pts:ASSET_POINTS.pad,     max:MAX_PADS,     count:(p.landingPads||[]).length },
                    { type:"resupply",label:"📦 Resupply Order",cost:RESUPPLY_COST,  maint:0,              pts:0,                    max:Infinity,      count:0 },
                  ];
                  const sel = selectedBuild[pi];
                  const chosen = BUILD_OPTIONS.find(o=>o.type===sel);
                  const padIdx = Math.min(selectedPad[pi], Math.max(0, pads.length-1));
                  const hasPad = pads.length > 0;
                  const padFree = hasPlacementGrace(p.arrivalDay, globalDay) || chosen?.type === "pad";
                  const canDo = chosen && (p.budget??0)>=chosen.cost && chosen.count<chosen.max && !isDone && (hasPad || padFree || chosen.type==="rover");
                  const pendingHere = (p.pendingDeliveries||[]).filter(d=>d.padIdx===padIdx);
                  return (
                    <div style={{ display:"flex", flexDirection:"column", gap:3,
                      background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.04)",
                      borderRadius:5, padding:"6px 6px 5px" }}>
                      <select
                        value={sel||""}
                        onChange={e => setSelectedBuild(prev => { const n=[...prev]; n[pi]=e.target.value||null; return n; })}
                        disabled={isDone}
                        style={{
                          background:"rgba(4,9,22,0.98)",
                          border:`1px solid ${isDone?"rgba(255,255,255,0.04)":sel?(color+"44"):"rgba(255,255,255,0.1)"}`,
                          color: isDone?"#0d1820":sel?color:"#3a5570",
                          borderRadius:4, padding:"5px 5px",
                          cursor:isDone?"not-allowed":"pointer",
                          fontSize:7, fontFamily:"inherit",
                          letterSpacing:"0.05em",
                          outline:"none", width:"100%",
                          opacity: isDone?0.35:1,
                        }}>
                        <option value="">🔧 BUILD…</option>
                        {BUILD_OPTIONS.map(o=>(
                          <option key={o.type} value={o.type}
                            disabled={o.count>=o.max}
                            style={{ background:"#040916", color: o.count>=o.max?"#1a2a34":"#7aaac0" }}>
                            {o.label}{o.type !== "resupply" ? ` (${o.count}${isFinite(o.max) ? `/${o.max}` : ""})` : ""} — {o.cost}cr +{o.pts}ap
                          </option>
                        ))}
                      </select>
                      {/* Landing pad selector */}
                      {chosen && chosen.type !== "rover" && hasPad && pads.length > 1 && !padFree && (
                        <select
                          value={padIdx}
                          onChange={e => setSelectedPad(prev => { const n=[...prev]; n[pi]=+e.target.value; return n; })}
                          disabled={isDone}
                          style={{
                            background:"rgba(4,9,22,0.98)",
                            border:`1px solid rgba(0,160,255,0.25)`,
                            color:"#6090b8", borderRadius:4, padding:"4px 5px",
                            cursor:"pointer", fontSize:7, fontFamily:"inherit", outline:"none",
                          }}>
                          {pads.map((_, i) => (
                            <option key={i} value={i} style={{background:"#040916"}}>🛬 PAD {i+1}</option>
                          ))}
                        </select>
                      )}
                      {chosen && !hasPad && !padFree && chosen.type !== "rover" && (
                        <div style={{fontSize:7,color:"#774422",padding:"2px 0",letterSpacing:"0.06em"}}>⚠ PLACE LANDING PAD FIRST</div>
                      )}
                      {chosen && (hasPad || padFree) && (
                        <button
                          onClick={()=>buildStructure(pi, chosen.type)}
                          disabled={!canDo}
                          style={{
                            background: canDo ? `rgba(${pi===0?"255,200,40":"180,80,255"},0.1)` : "rgba(255,255,255,0.02)",
                            border:`1px solid ${canDo?(pi===0?"rgba(255,200,40,0.4)":"rgba(180,80,255,0.4)"):"rgba(255,255,255,0.05)"}`,
                            color: canDo?(pi===0?"#ffc828":"#cc88ff"):"#1a2030",
                            borderRadius:5, padding:"5px 0",
                            cursor: canDo?"pointer":"not-allowed",
                            fontSize:7, fontFamily:"inherit",
                            opacity:isDone?0.35:1,
                            letterSpacing:"0.05em",
                          }}>
                          {canDo
                            ? chosen.type === "rover"
                              ? "🚗 DEPLOY AT BASE"
                              : padFree
                                ? "📍 CLICK MAP TO PLACE"
                                : `🛬 SEND TO PAD ${pads.length>1?padIdx+1:""}`
                            : chosen.count>=chosen.max
                              ? "MAX REACHED"
                              : `NEED ${chosen.cost}cr`}
                          <div style={{fontSize:6,opacity:0.45,marginTop:1,letterSpacing:"0.03em"}}>
                            {chosen.cost}cr · +{chosen.pts}ap · {chosen.type==="rover"?"spawns at base":padFree?"click map":"rover delivers"}
                          </div>
                        </button>
                      )}
                      {/* Pending deliveries indicator */}
                      {(p.pendingDeliveries||[]).length > 0 && (
                        <div style={{fontSize:7, color:"#cc9922", padding:"3px 0",
                          background:"rgba(255,180,0,0.05)", border:"1px solid rgba(255,180,0,0.12)",
                          borderRadius:3, textAlign:"center", letterSpacing:"0.06em"}}>
                          🛬 {(p.pendingDeliveries||[]).map(d=>({solar:"☀",reactor:"☢",habitat:"🏠",rover:"🚗",pad:"🛬"})[d.type]||"?").join(" ")} IN TRANSIT
                        </div>
                      )}
                      {(activeRover?.carrying ?? p.carrying) && (
                        <div style={{fontSize:7, color:"#bb8833", padding:"3px 0",
                          background:"rgba(255,140,0,0.05)", border:"1px solid rgba(255,140,0,0.1)",
                          borderRadius:3, textAlign:"center", letterSpacing:"0.05em"}}>
                          🚚 {roverIdx>0?`R${roverIdx+1} `:""}{({solar:"☀",reactor:"☢",habitat:"🏠",rover:"🚗",pad:"🛬"})[(activeRover?.carrying??p.carrying).type]} — SET DESTINATION
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Diplomatic decisions */}
                {(() => {
                  const dipOptions = getDiplomacyOptions(pi);
                  const sel = selectedDiplomacy[pi];
                  const statusText = !gridSharingEnabled
                    ? "GRID STATUS: DISABLED"
                    : powerGridState.mode === "shared"
                    ? `GRID STATUS: SHARED${gridSharingPermanent ? " · PERMANENT" : ""}`
                    : powerGridState.mode === "offered" && powerGridState.offeredBy === pi + 1
                      ? `GRID STATUS: OFFER OUT TO P${powerGridState.offeredTo}`
                      : powerGridState.mode === "offered" && powerGridState.offeredTo === pi + 1
                        ? `GRID STATUS: OFFER FROM P${powerGridState.offeredBy}`
                        : "GRID STATUS: INDEPENDENT";
                  return (
                    <div style={{ display:"flex", flexDirection:"column", gap:3,
                      background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.04)",
                      borderRadius:5, padding:"6px 6px 5px" }}>
                      <select
                        value={sel||""}
                        onChange={e => setSelectedDiplomacy(prev => { const n=[...prev]; n[pi]=e.target.value||null; return n; })}
                        disabled={isDone || dipOptions.length === 0}
                        style={{
                          background:"rgba(4,9,22,0.98)",
                          border:`1px solid ${isDone?"rgba(255,255,255,0.04)":sel?(color+"44"):"rgba(255,255,255,0.1)"}`,
                          color:isDone?"#0d1820":sel?color:(dipOptions.length === 0 ? "#203040" : "#3a5570"),
                          borderRadius:4, padding:"5px 5px",
                          cursor:isDone||dipOptions.length===0?"not-allowed":"pointer",
                          fontSize:7, fontFamily:"inherit", letterSpacing:"0.05em", outline:"none", width:"100%",
                          opacity:isDone?0.35:1,
                        }}>
                        <option value="">⚡ GRID DECISIONS</option>
                        {dipOptions.map(o => (
                          <option key={o.type} value={o.type} style={{ background:"#040916", color:"#7aaac0" }}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <div style={{ fontSize:6, color:"#2a5070", letterSpacing:"0.06em", textAlign:"center" }}>
                        {statusText}
                      </div>
                      <button
                        onClick={() => executeDiplomaticDecision(pi)}
                        disabled={!sel || isDone}
                        style={{
                          background: sel ? `rgba(${pi===0?"120,220,255":"180,120,255"},0.08)` : "rgba(255,255,255,0.02)",
                          border:`1px solid ${sel?(pi===0?"rgba(120,220,255,0.35)":"rgba(180,120,255,0.35)"):"rgba(255,255,255,0.05)"}`,
                          color: sel ? "#7ad8ff" : "#1a2030",
                          borderRadius:5, padding:"5px 0",
                          cursor: sel && !isDone ? "pointer" : "not-allowed",
                          fontSize:7, fontFamily:"inherit", opacity:isDone?0.35:1, letterSpacing:"0.05em",
                        }}>
                        {sel ? "TRANSMIT DECISION" : "SELECT A GRID ACTION"}
                      </button>
                    </div>
                  );
                })()}

                {/* END TURN button — the main action */}
                {phase===PHASE.PLAYING && (
                  <button
                    onClick={()=>endTurn(pi)}
                    disabled={isDone}
                    style={{
                      background:isDone?"rgba(30,80,30,0.2)":isMyTurn?`linear-gradient(135deg,${color}18,${color}08)`:"rgba(255,255,255,0.03)",
                      border:`2px solid ${isDone?"#44ff6655":isMyTurn?color:"rgba(255,255,255,0.08)"}`,
                      color:isDone?"#44ff66":isMyTurn?color:"#223344",
                      borderRadius:6, padding:"9px 0", cursor:isDone?"default":"pointer",
                      fontSize:isDone?8:9, letterSpacing:"0.18em",
                      fontFamily:"'Orbitron','Courier New',monospace",
                      fontWeight:700, transition:"all 0.15s",
                      boxShadow:isMyTurn&&!isDone?`0 0 16px ${color}44, 0 2px 8px ${color}22`:"none",
                      animation: isMyTurn&&!isDone ? (pi===0?"pulse-glow 2.5s ease-in-out infinite":"pulse-glow-p2 2.5s ease-in-out infinite") : "none",
                      marginTop:2,
                    }}>
                    {isDone ? "✓ TURN DONE" : "⏭ END TURN"}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Centre: map + info */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", gap:5, minWidth:0 }}>
          {/* Map canvas */}
          <div style={{
            position:"relative", width:"100%", aspectRatio:"1",
            borderRadius:8, overflow:"hidden",
            border:`1px solid ${night?"rgba(100,80,200,0.3)":"rgba(60,100,160,0.2)"}`,
            boxShadow:night?"0 0 36px rgba(60,40,140,0.5), inset 0 0 0 1px rgba(100,80,200,0.1)":"0 0 30px rgba(10,40,90,0.4), inset 0 0 0 1px rgba(60,100,180,0.08)",
            cursor:annotating?"crosshair":selectingFor!==null||phase===PHASE.SETUP1||phase===PHASE.SETUP1_HAB||phase===PHASE.SETUP1_SOL||phase===PHASE.SETUP1_PAD||phase===PHASE.SETUP2||phase===PHASE.SETUP2_HAB||phase===PHASE.SETUP2_SOL||phase===PHASE.SETUP2_PAD?"crosshair":"default",
          }}>
            {!mapLoaded && (
              <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center", gap:10,
                background:"#020710", color:"#1a3050", fontSize:9, letterSpacing:"0.15em" }}>
                <div style={{ width:24, height:24, borderRadius:"50%", border:"2px solid #1a3050",
                  borderTopColor:"#00d4ff", animation:"spin 1s linear infinite" }}/>
                LOADING LUNAR MAP...
              </div>
            )}
            <canvas ref={canvasRef} width={W} height={H}
              style={{ width:"100%", height:"100%", display:"block" }}
              onClick={handleClick} onMouseMove={handleMouseMove}
              onMouseLeave={()=>setHover(null)}
              onContextMenu={handleRightClick} />
            {/* Day progress bar */}
            {phase===PHASE.PLAYING && (
              <div style={{ position:"absolute", bottom:0, left:0, right:0, height:3,
                background:"rgba(0,0,0,0.6)" }}>
                <div style={{ height:"100%", width:`${(day/DAYS_PER_ROUND)*100}%`,
                  background:night?"rgba(140,100,255,0.7)":"rgba(80,160,255,0.7)",
                  transition:"width 0.15s", boxShadow:night?"0 0 4px rgba(140,100,255,0.8)":"0 0 4px rgba(80,160,255,0.8)" }} />
              </div>
            )}
            {/* Turn indicator overlay */}
            {phase===PHASE.PLAYING && !p1Done && !p2Done && (
              <div style={{ position:"absolute", top:8, left:8,
                background:"rgba(2,5,12,0.92)", border:`1px solid ${activeTurn===0?"#ffd70044":"#b000ff44"}`,
                borderLeft:`2px solid ${activeTurn===0?"#ffd700":"#b000ff"}`,
                borderRadius:4, padding:"3px 9px", fontSize:7,
                color:activeTurn===0?"#ffd700":"#b000ff", letterSpacing:"0.12em",
                fontFamily:"'Orbitron',monospace" }}>
                P{activeTurn+1} PLANNING
              </div>
            )}
            {phase===PHASE.PLAYING && (p1Done||p2Done) && !(p1Done&&p2Done) && (
              <div style={{ position:"absolute", top:8, left:8,
                background:"rgba(2,5,12,0.92)", border:"1px solid rgba(60,220,100,0.25)",
                borderLeft:"2px solid rgba(60,220,100,0.6)",
                borderRadius:4, padding:"3px 9px", fontSize:7, color:"#44ff88", letterSpacing:"0.1em",
                fontFamily:"'Orbitron',monospace" }}>
                {p1Done?"P1":"P2"} DONE
              </div>
            )}
            {/* Night indicator */}
            {night && (
              <div style={{ position:"absolute", top:8, right:8,
                background:"rgba(2,5,20,0.88)", border:"1px solid rgba(120,80,255,0.3)",
                borderRadius:4, padding:"3px 8px", fontSize:7, color:"#9060ff", letterSpacing:"0.08em" }}>
                🌙 LUNAR NIGHT
              </div>
            )}
            {/* Mine heatmap legend */}
            {showLayers.mine && (mined1>0||mined2>0) && (
              <div style={{ position:"absolute", bottom:8, right:8,
                background:"rgba(2,5,12,0.92)", border:"1px solid rgba(255,255,255,0.07)",
                borderRadius:5, padding:"6px 9px", fontSize:7, lineHeight:2 }}>
                <div style={{color:"#2a4060",marginBottom:2,letterSpacing:"0.14em",fontSize:6}}>MINE INTENSITY</div>
                {[[255,215,0,"P1"],[176,0,255,"P2"]].map(([r,g,b,l]) => (
                  <div key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:30,height:4,borderRadius:2,
                      background:`linear-gradient(90deg,rgba(${r},${g},${b},0.1),rgba(${r},${g},${b},0.9))`,
                      boxShadow:`0 0 4px rgba(${r},${g},${b},0.4)`}}/>
                    <span style={{color:`rgb(${r},${g},${b})`,fontSize:7,fontFamily:"'Orbitron',monospace"}}>{l}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Last-step event log */}
          {lastEvents.length>0 && (
            <div style={{ background:"rgba(2,6,16,0.94)", border:"1px solid rgba(255,255,255,0.05)",
              borderRadius:5, padding:"6px 10px", fontSize:7, color:"#2a4060", lineHeight:1.9 }}>
              <div style={{color:"#1a2a38",marginBottom:2,letterSpacing:"0.18em",fontSize:6,
                fontFamily:"'Orbitron',monospace"}}>LAST STEP</div>
              {lastEvents.slice(-4).map((ev,i) => (
                <div key={i} style={{
                  color:ev.type==="deposit"?"#44ff88":ev.type==="mine"?"#00d4ff":"#2a4060",
                  display:"flex", alignItems:"center", gap:4
                }}>
                  {ev.type==="deposit"
                    ? <><span style={{color:"#22cc66"}}>📦</span> Deposited {ev.kg.toFixed(0)} kg</>
                    : ev.type==="mine"
                    ? <><span style={{color:"#0099bb"}}>⛏</span> Mined {ev.kg.toFixed(0)} kg</>
                    : "·"}
                </div>
              ))}
            </div>
          )}

          {/* History chart */}
          {history.length>0 && (
            <div style={{ background:"rgba(2,6,16,0.94)", border:"1px solid rgba(255,255,255,0.05)",
              borderRadius:5, padding:"8px 10px" }}>
              <div style={{ fontSize:6, letterSpacing:"0.25em", color:"#1a2a38", marginBottom:6,
                fontFamily:"'Orbitron',monospace" }}>
                ICE DEPOSITS / ROUND (kg)
              </div>
              <div style={{ display:"flex", gap:2, alignItems:"flex-end", height:44 }}>
                {history.map((h,i) => {
                  const max=Math.max(...history.map(x=>Math.max(x.dep1||0,x.dep2||0)),1);
                  return (
                    <div key={i} style={{display:"flex",gap:1,alignItems:"flex-end",flex:1}}>
                      <div title={`P1: +${h.dep1}kg`} style={{
                        flex:1, background:"linear-gradient(180deg,#ffd700cc,#ffd70066)",
                        borderRadius:"2px 2px 0 0",
                        height:`${Math.max(4,((h.dep1||0)/max)*100)}%`, minHeight:2,
                        boxShadow:"0 0 4px #ffd70044" }}/>
                      <div title={`P2: +${h.dep2}kg`} style={{
                        flex:1, background:"linear-gradient(180deg,#b000ffcc,#b000ff66)",
                        borderRadius:"2px 2px 0 0",
                        height:`${Math.max(4,((h.dep2||0)/max)*100)}%`, minHeight:2,
                        boxShadow:"0 0 4px #b000ff44" }}/>
                    </div>
                  );
                })}
              </div>
              <div style={{display:"flex",gap:2,marginTop:3}}>
                {history.map((h,i) => (
                  <div key={i} style={{flex:1,textAlign:"center",fontSize:5,color:"#1a2a38",
                    letterSpacing:"0.04em"}}>R{h.r}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Done overlay */}
      {phase===PHASE.DONE && p1 && p2 && (
        <div style={{
          marginTop:14, background:"rgba(3,7,18,0.98)",
          border:"1px solid rgba(255,255,255,0.1)",
          borderTop:`2px solid ${winner===1?"#ffd700":winner===2?"#b000ff":"#446688"}`,
          borderRadius:10, padding:"22px 30px", textAlign:"center", maxWidth:440, width:"100%",
          boxShadow:"0 0 50px rgba(0,0,0,0.6), 0 0 80px rgba(0,0,0,0.4)",
          animation:"fadeIn 0.4s ease",
        }}>
          <div style={{fontSize:7,letterSpacing:"0.4em",color:"#2a4050",marginBottom:14,
            fontFamily:"'Orbitron',monospace"}}>
            MISSION DEBRIEF — {durationSummaryLabel}
          </div>
          <div style={{display:"flex",gap:30,justifyContent:"center",marginBottom:14}}>
            {[p1,p2].map((p,i) => {
              const sc = i===0 ? score1 : score2;
              const col = i===0?"#ffd700":"#b000ff";
              const isW = (i===0&&winner===1)||(i===1&&winner===2);
              return (
              <div key={i} style={{ position:"relative" }}>
                {isW && <div style={{ position:"absolute", top:-10, left:"50%", transform:"translateX(-50%)",
                  fontSize:14 }}>👑</div>}
                <div style={{fontSize:8,color:col,letterSpacing:"0.18em",fontFamily:"'Orbitron',monospace",
                  marginBottom:4}}>P{i+1}</div>
                <div style={{fontSize:30,fontWeight:900,color:col,lineHeight:1.0,
                  fontFamily:"'Orbitron',monospace", textShadow:`0 0 20px ${col}55`}}>
                  {sc.toFixed(0)}
                </div>
                <div style={{fontSize:7,color:"#2a3a4a",letterSpacing:"0.08em"}}>MISSION SCORE</div>
                <div style={{fontSize:8,color:"#2a3a4a",marginTop:6,lineHeight:1.8}}>
                  <div>💧 {p.iceDeposited.toFixed(0)} kg ice</div>
                  <div>🏗 {p.assetPts??0} asset pts</div>
                  <div>⚠ {Math.round(p.safetyViolations??0)} safety violations</div>
                </div>
              </div>
            )})}
          </div>
          {/* Share bar */}
          <div style={{height:5,background:"rgba(255,255,255,0.04)",borderRadius:3,overflow:"hidden",
            display:"flex",marginBottom:14,boxShadow:"inset 0 1px 0 rgba(0,0,0,0.3)"}}>
            <div style={{width:`${share1*100}%`,
              background:"linear-gradient(90deg,#b8860088,#ffd700aa)",
              boxShadow:"1px 0 6px #ffd70066"}}/>
            <div style={{flex:1,background:"linear-gradient(90deg,#b000ffaa,#6600cc88)"}}/>
          </div>
          <div style={{fontSize:18,fontWeight:900,letterSpacing:"0.18em",marginBottom:12,
            fontFamily:"'Orbitron',monospace",
            color:winner===1?"#ffd700":winner===2?"#b000ff":"#4a7090",
            textShadow:winner===1?"0 0 20px #ffd70066":winner===2?"0 0 20px #b000ff66":"none"}}>
            {winner===1?"PLAYER 1 WINS":winner===2?"PLAYER 2 WINS":"DRAW"}
          </div>
          <div style={{fontSize:8,color:"#2a3a4a",marginBottom:18,letterSpacing:"0.06em"}}>
            {depleted} of {CRATER_DATA.length} craters depleted · {globalDay} days elapsed
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"center"}}>
            <button onClick={()=>setPhase(PHASE.SETTINGS)} style={{
              background:"rgba(255,215,0,0.07)", border:"1px solid rgba(255,215,0,0.28)",
              color:"#ffd700", borderRadius:6, padding:"9px 18px", cursor:"pointer",
              fontSize:8, letterSpacing:"0.18em", fontFamily:"'Orbitron','Courier New',monospace"}}>
              ⚙ SETTINGS
            </button>
            <button onClick={reset} style={{
              background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.12)",
              color:"#6a8fa8", borderRadius:6, padding:"9px 18px", cursor:"pointer",
              fontSize:8, letterSpacing:"0.18em", fontFamily:"'Orbitron','Courier New',monospace"}}>
              ↺ NEW MISSION
            </button>
          </div>
        </div>
      )}

      {/* ── Mission Log Panel ─────────────────────────────────────────── */}
      {showLog && (
        <div style={{ width:"100%", maxWidth:650, marginTop:8,
          background:"rgba(2,6,16,0.97)", border:"1px solid rgba(255,255,255,0.07)",
          borderRadius:7, padding:"12px 14px", maxHeight:220, overflow:"hidden",
          display:"flex", flexDirection:"column", animation:"fadeIn 0.2s ease" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <span style={{ fontSize:8, letterSpacing:"0.3em", color:"#2a4a60",
              fontFamily:"'Orbitron',monospace" }}>MISSION EVENT LOG</span>
            <div style={{ display:"flex", gap:5 }}>
              <span style={{ fontSize:7, color:"#1a3040" }}>{missionLog.length} events</span>
              <button onClick={exportMissionData} disabled={missionLog.length===0} style={{
                background:"rgba(0,180,100,0.1)", border:"1px solid rgba(0,180,100,0.2)",
                color:"#33cc77", borderRadius:3, padding:"2px 7px", cursor:"pointer",
                fontSize:6.5, fontFamily:"'JetBrains Mono',monospace" }}>EXPORT CSV</button>
            </div>
          </div>
          <div style={{ overflowY:"auto", flex:1, display:"flex", flexDirection:"column", gap:1 }}>
            {missionLog.length === 0 ? (
              <div style={{ fontSize:7, color:"#1a2a38", textAlign:"center", padding:"20px 0" }}>
                Events will appear here as the mission progresses.
              </div>
            ) : [...missionLog].reverse().slice(0, 60).map((ev, i) => {
              const col = ev.type==="deposit"?"#44ff88"
                : ev.type==="mine"?"#00d4ff"
                : ev.type==="place"?"#ffaa44"
                : ev.type==="grid"?"#7ad8ff"
                : "#3a5570";
              return (
                <div key={i} style={{ display:"flex", gap:8, fontSize:6.5,
                  color:col, padding:"1px 0", borderBottom:"1px solid rgba(255,255,255,0.02)" }}>
                  <span style={{ color:"#1a3040", minWidth:50 }}>R{ev.round}D{ev.day}</span>
                  <span style={{ minWidth:55 }}>{ev.type.toUpperCase()}</span>
                  {ev.kg != null && <span>{ev.kg.toFixed(1)} kg</span>}
                  {ev.craterIdx != null && <span style={{color:"#1a3040"}}>crater#{ev.craterIdx}</span>}
                  {ev.label && <span style={{ color:col }}>{ev.label}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Analytics Panel ────────────────────────────────────────────── */}
      {showAnalytics && (
        <div style={{ width:"100%", maxWidth:650, marginTop:8,
          background:"rgba(2,6,16,0.97)", border:"1px solid rgba(255,255,255,0.07)",
          borderRadius:7, padding:"14px 16px", animation:"fadeIn 0.2s ease" }}>
          <div style={{ fontSize:8, letterSpacing:"0.3em", color:"#2a4a60",
            fontFamily:"'Orbitron',monospace", marginBottom:12 }}>ANALYTICS DASHBOARD</div>

          {history.length === 0 ? (
            <div style={{ fontSize:7, color:"#1a2a38", textAlign:"center", padding:"16px 0" }}>
              Analytics will populate after the first round completes.
            </div>
          ) : (
            <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
              {/* Ice cumulative chart */}
              <div style={{ flex:"1 1 180px" }}>
                <div style={{ fontSize:6, color:"#1a3040", letterSpacing:"0.15em",
                  fontFamily:"'Orbitron',monospace", marginBottom:6 }}>CUMULATIVE ICE (kg)</div>
                <div style={{ display:"flex", gap:1, alignItems:"flex-end", height:50 }}>
                  {history.map((h, i) => {
                    const max = Math.max(...history.map(x => Math.max(x.d1||0, x.d2||0)), 1);
                    return (
                      <div key={i} style={{ display:"flex", gap:1, alignItems:"flex-end", flex:1 }}>
                        <div title={`P1: ${h.d1}kg total`} style={{
                          flex:1, background:"linear-gradient(180deg,#ffd700cc,#ffd70044)",
                          borderRadius:"2px 2px 0 0",
                          height:`${Math.max(3,((h.d1||0)/max)*100)}%` }}/>
                        <div title={`P2: ${h.d2}kg total`} style={{
                          flex:1, background:"linear-gradient(180deg,#b000ffcc,#b000ff44)",
                          borderRadius:"2px 2px 0 0",
                          height:`${Math.max(3,((h.d2||0)/max)*100)}%` }}/>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display:"flex", gap:1, marginTop:2 }}>
                  {history.map((h,i)=>(
                    <div key={i} style={{flex:1,textAlign:"center",fontSize:5,color:"#1a2a38"}}>R{h.r}</div>
                  ))}
                </div>
              </div>

              {/* Budget per round */}
              <div style={{ flex:"1 1 180px" }}>
                <div style={{ fontSize:6, color:"#1a3040", letterSpacing:"0.15em",
                  fontFamily:"'Orbitron',monospace", marginBottom:6 }}>BUDGET / ROUND (cr)</div>
                <div style={{ display:"flex", gap:1, alignItems:"flex-end", height:50 }}>
                  {history.map((h, i) => {
                    const max = Math.max(...history.map(x => Math.max(x.bud1||0, x.bud2||0)), 1);
                    return (
                      <div key={i} style={{ display:"flex", gap:1, alignItems:"flex-end", flex:1 }}>
                        <div title={`P1: ${h.bud1}cr`} style={{
                          flex:1, background:"rgba(255,215,0,0.6)", borderRadius:"2px 2px 0 0",
                          height:`${Math.max(3,((h.bud1||0)/max)*100)}%` }}/>
                        <div title={`P2: ${h.bud2}cr`} style={{
                          flex:1, background:"rgba(176,0,255,0.6)", borderRadius:"2px 2px 0 0",
                          height:`${Math.max(3,((h.bud2||0)/max)*100)}%` }}/>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display:"flex", gap:1, marginTop:2 }}>
                  {history.map((h,i)=>(
                    <div key={i} style={{flex:1,textAlign:"center",fontSize:5,color:"#1a2a38"}}>R{h.r}</div>
                  ))}
                </div>
              </div>

              {/* Stat table */}
              <div style={{ flex:"1 1 160px", fontSize:7, lineHeight:1.9 }}>
                <div style={{ fontSize:6, color:"#1a3040", letterSpacing:"0.15em",
                  fontFamily:"'Orbitron',monospace", marginBottom:6 }}>CURRENT SNAPSHOT</div>
                {[
                  ["💧 Total Ice", `${totalIce1.toFixed(0)} / ${totalIce2.toFixed(0)} kg`],
                  ["🌑 Craters Depleted", `${depleted} / ${CRATER_DATA.length}`],
                  ["🏗 Asset Pts", `${p1?.assetPts??0} / ${p2?.assetPts??0}`],
                  ["💰 Budget", `${Math.round(p1?.budget??0)} / ${Math.round(p2?.budget??0)} cr`],
                  ["📡 R&D Accum", `${Math.round(p1?.rdAccum??0)} / ${Math.round(p2?.rdAccum??0)}`],
                  ["⚔ Mil Score", `${(p1?.milScore??1).toFixed(2)} / ${(p2?.milScore??1).toFixed(2)}`],
                  ["⚠ Safety Violations", `${Math.round(p1?.safetyViolations??0)} / ${Math.round(p2?.safetyViolations??0)}`],
                ].map(([label, val]) => (
                  <div key={label} style={{ display:"flex", justifyContent:"space-between",
                    borderBottom:"1px solid rgba(255,255,255,0.03)", paddingBottom:1 }}>
                    <span style={{ color:"#1e3040" }}>{label}</span>
                    <span style={{ color:"#4a7090", fontFamily:"'JetBrains Mono',monospace", fontSize:6.5 }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Physics Parameters Panel ───────────────────────────────────── */}
      {showParams && (
        <div style={{ width:"100%", maxWidth:650, marginTop:8,
          background:"rgba(2,6,16,0.97)", border:"1px solid rgba(255,140,0,0.15)",
          borderRadius:7, padding:"14px 16px", animation:"fadeIn 0.2s ease" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:8, letterSpacing:"0.3em", color:"#5a3a10",
              fontFamily:"'Orbitron',monospace" }}>PHYSICS PARAMETERS</span>
            <button onClick={()=>setPhysOverrides({})} style={{
              background:"rgba(255,100,50,0.08)", border:"1px solid rgba(255,100,50,0.2)",
              color:"#cc5533", borderRadius:3, padding:"2px 8px", cursor:"pointer",
              fontSize:6.5, fontFamily:"'JetBrains Mono',monospace" }}>RESET ALL</button>
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
            {[
              { key:"BASE_MINE_RATE",   label:"Mine Rate (kg/day)",  def:BASE_MINE_RATE, min:0.01, max:10, step:0.01 },
              { key:"ROVER_STEP",       label:"Rover Step (px/turn)",def:ROVER_STEP, min:10, max:400, step:5 },
              { key:"POWER_MOVE_DRAIN", label:"Move Power Drain",   def:POWER_MOVE_DRAIN, min:1, max:60, step:1 },
              { key:"POWER_MINE_DRAIN", label:"Mine Power Drain",   def:POWER_MINE_DRAIN, min:0.5, max:15, step:0.1 },
              { key:"PASSIVE_DECAY",    label:"Passive Decay/Turn", def:PASSIVE_DECAY, min:0, max:0.1, step:0.001 },
              { key:"HOSTILE_DECAY",    label:"Hostile Decay/Turn", def:HOSTILE_DECAY, min:0, max:0.2, step:0.005 },
              { key:"DEPLETION_RATE",   label:"Crater Depletion",   def:DEPLETION_RATE, min:0, max:0.05, step:0.0005 },
              { key:"ICE_MASS_FRACTION",label:"Ice Mass Fraction",  def:ICE_MASS_FRACTION, min:0.01, max:0.3, step:0.001 },
            ].map(param => {
              const current = physOverrides[param.key] ?? param.def;
              const isOverridden = physOverrides[param.key] != null;
              return (
                <div key={param.key} style={{ flex:"1 1 140px", minWidth:130 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                    <span style={{ fontSize:6.5, color: isOverridden?"#ffaa44":"#2a4055",
                      fontFamily:"'JetBrains Mono',monospace" }}>{param.label}</span>
                    {isOverridden && (
                      <button onClick={()=>setPhysOverrides(p=>{const n={...p};delete n[param.key];return n;})} style={{
                        background:"none", border:"none", color:"#774422", cursor:"pointer",
                        fontSize:6.5, padding:0 }}>↩</button>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                    <input type="range" min={param.min} max={param.max} step={param.step}
                      value={current}
                      onChange={e=>setPhysOverrides(p=>({...p,[param.key]:+e.target.value}))}
                      style={{ flex:1, accentColor: isOverridden?"#ffaa44":"#2a5070" }} />
                    <span style={{ fontSize:6.5, color: isOverridden?"#ffaa44":"#3a6080",
                      fontFamily:"'JetBrains Mono',monospace", minWidth:36, textAlign:"right" }}>
                      {current.toFixed(param.step < 0.01 ? 4 : param.step < 0.1 ? 3 : param.step < 1 ? 1 : 0)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop:10, fontSize:6.5, color:"#3a2510", lineHeight:1.8,
            background:"rgba(255,140,0,0.04)", border:"1px solid rgba(255,140,0,0.08)",
            borderRadius:4, padding:"6px 10px" }}>
            ⚠ Parameter overrides apply to the running simulation immediately. Overridden values shown in amber.
            Changes do not persist across sessions. Use JSON export to save scenario configurations.
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{marginTop:10,display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center",
        fontSize:7,color:"#1a3050",letterSpacing:"0.08em", paddingBottom:8}}>
        {[
          {c:"rgba(5,25,35,0.9)",l:"PSR fresh"},
          {c:"rgba(120,40,10,0.8)",l:"PSR depleted"},
          {c:"rgba(255,215,0,0.9)",l:"P1 mined"},
          {c:"rgba(176,0,255,0.9)",l:"P2 mined"},
          {c:"rgba(60,100,255,0.2)",l:"claimed"},
          {c:"rgba(255,230,50,0.35)",l:"ridge ☀"},
        ].map(({c,l}) => (
          <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
            <div style={{width:8,height:8,background:c,borderRadius:1,border:"1px solid rgba(255,255,255,0.07)"}}/>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

