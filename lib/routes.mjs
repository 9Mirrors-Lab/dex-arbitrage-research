// Route generation and the coverage ledger.
//
// A route is a concrete, directional plan: buy token X on pool A, sell it on
// pool B, both at one historical block. Routes are generated from the registry
// mechanically — every eligible combination is enumerated whether or not any
// operator has ever traded it, which is the entire point of System A.
//
// The ledger is the discipline. Every generated route gets a row immediately,
// classified NOT TESTED. Evaluation moves a row to a terminal class. A route
// that is never reached stays NOT TESTED forever and is counted that way in
// the coverage report, so "we did not look" can never be presented as
// "there was nothing there".

export const CLASS = {
  NOT_TESTED: 'NOT TESTED',
  UNSUPPORTED: 'UNSUPPORTED',
  NO_SPREAD: 'NO SPREAD',
  NEGATIVE_NET: 'NEGATIVE NET',
  PROFITABLE_TIMING_UNKNOWN: 'PROFITABLE / TIMING UNKNOWN',
  NOT_CAPTURABLE: 'NOT CAPTURABLE',
  CAPTURE_CANDIDATE: 'CAPTURE CANDIDATE',
  SIMULATION_VALIDATED: 'SIMULATION VALIDATED',
};

export const CLASS_MEANING = {
  [CLASS.NOT_TESTED]: 'Identified but not evaluated.',
  [CLASS.UNSUPPORTED]: 'Cannot currently be quoted or simulated reliably.',
  [CLASS.NO_SPREAD]: 'No profitable difference at the tested state.',
  [CLASS.NEGATIVE_NET]: 'Price difference exists but costs exceed returns.',
  [CLASS.PROFITABLE_TIMING_UNKNOWN]: 'Positive executable net quote; capture feasibility not established.',
  [CLASS.NOT_CAPTURABLE]: 'Profitable historically but unavailable to the tested execution model.',
  [CLASS.CAPTURE_CANDIDATE]: 'Profitable and potentially reachable under an explicitly defined latency model.',
  [CLASS.SIMULATION_VALIDATED]: 'Reproduced with exact historical state and execution simulation.',
};

// Terminal in the sense that the route WAS evaluated at the tested state.
const EVALUATED = new Set([
  CLASS.NO_SPREAD, CLASS.NEGATIVE_NET, CLASS.PROFITABLE_TIMING_UNKNOWN,
  CLASS.NOT_CAPTURABLE, CLASS.CAPTURE_CANDIDATE, CLASS.SIMULATION_VALIDATED,
]);
export const isEvaluated = (c) => EVALUATED.has(c);

export const routeKey = (poolA, poolB, dir) => `${poolA}|${poolB}|d${dir}`;

// ---------------------------------------------------------------------------
// Two-pool route generation
// ---------------------------------------------------------------------------
// `dir` 0 means leg one trades token0 -> token1 on pool A and back on pool B;
// `dir` 1 is the reverse. Both are always generated: a spread is directional,
// and which side is profitable is not knowable before quoting.
export function generateTwoPoolRoutes({ registry, minDepthUsd = 500, requireQuotable = true }) {
  const byPair = registry.indexByPair({ eligibleOnly: true });
  const routes = [];
  const excluded = [];

  for (const [pair, pools] of byPair) {
    const usable = pools.filter((p) => {
      if (requireQuotable && !p.quotable) { excluded.push({ pair, pool: p.id, reason: p.quotableReason ?? 'not quotable' }); return false; }
      if ((p.depthUsd ?? 0) < minDepthUsd) { excluded.push({ pair, pool: p.id, reason: 'below-min-depth-at-route-time' }); return false; }
      return true;
    });
    if (usable.length < 2) {
      if (usable.length === 1) excluded.push({ pair, pool: usable[0].id, reason: 'only-one-eligible-pool-for-this-pair' });
      continue;
    }
    // Deterministic order so a route key is stable across runs.
    usable.sort((a, b) => (a.id < b.id ? -1 : 1));
    const [token0, token1] = pair.split('/');
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const a = usable[i]; const b = usable[j];
        for (const dir of [0, 1]) {
          routes.push({
            key: routeKey(a.id, b.id, dir),
            type: 'two-pool',
            pair, token0, token1,
            poolA: a.id, poolB: b.id,
            venueA: a.venue, venueB: b.venue,
            familyA: a.family, familyB: b.family,
            feeA: a.feeTier, feeB: b.feeTier,
            // Leg 1 sells `tokenIn` into pool A; leg 2 sells the proceeds back
            // through pool B, returning to `tokenIn`.
            tokenIn: dir === 0 ? token0 : token1,
            tokenMid: dir === 0 ? token1 : token0,
            dir,
            sameVenue: a.venue === b.venue,
            crossBrand: a.venue !== b.venue,
            depthUsdA: a.depthUsd, depthUsdB: b.depthUsd,
            minDepthUsd: Math.min(a.depthUsd ?? 0, b.depthUsd ?? 0),
            activity: (a.activity?.swapsObserved ?? 0) + (b.activity?.swapsObserved ?? 0),
            classification: CLASS.NOT_TESTED,
          });
        }
      }
    }
  }
  return { routes, excluded };
}

// ---------------------------------------------------------------------------
// Prioritisation
// ---------------------------------------------------------------------------
// Expensive exact quoting is spent on the most promising routes first, but
// nothing is REMOVED — the ledger keeps every route, and priority only decides
// the order in which they are reached. This is the difference between staged
// validation and silently sampling.
export function prioritise(routes) {
  return [...routes].sort((a, b) => {
    // Depth first: a route with more executable room can carry a larger trade,
    // so a given spread turns into more absolute profit.
    const d = (b.minDepthUsd ?? 0) - (a.minDepthUsd ?? 0);
    if (d !== 0) return d;
    return (b.activity ?? 0) - (a.activity ?? 0);
  });
}

// ---------------------------------------------------------------------------
// The coverage ledger
// ---------------------------------------------------------------------------
export class RouteLedger {
  constructor() { this.rows = new Map(); }

  seed(routes) {
    for (const r of routes) {
      if (!this.rows.has(r.key)) this.rows.set(r.key, { ...r, evaluatedAt: null, evidence: null });
    }
    return this.rows.size;
  }

  classify(key, classification, evidence) {
    const row = this.rows.get(key);
    if (!row) return null;
    row.classification = classification;
    row.evaluatedAt = new Date().toISOString();
    if (evidence) row.evidence = evidence;
    return row;
  }

  tally() {
    const byClass = {}; const byType = {};
    for (const r of this.rows.values()) {
      byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
      byType[r.type] ??= {};
      byType[r.type][r.classification] = (byType[r.type][r.classification] ?? 0) + 1;
    }
    const total = this.rows.size;
    const evaluated = [...this.rows.values()].filter((r) => isEvaluated(r.classification)).length;
    return {
      total, evaluated,
      notTested: byClass[CLASS.NOT_TESTED] ?? 0,
      unsupported: byClass[CLASS.UNSUPPORTED] ?? 0,
      pctEvaluated: total ? +(100 * evaluated / total).toFixed(4) : null,
      byClass, byType,
    };
  }

  profitable() {
    return [...this.rows.values()]
      .filter((r) => [CLASS.PROFITABLE_TIMING_UNKNOWN, CLASS.CAPTURE_CANDIDATE, CLASS.SIMULATION_VALIDATED, CLASS.NOT_CAPTURABLE].includes(r.classification))
      .sort((a, b) => (b.evidence?.netUsdMedian ?? -Infinity) - (a.evidence?.netUsdMedian ?? -Infinity));
  }

  toJSON() { return [...this.rows.values()]; }
}
