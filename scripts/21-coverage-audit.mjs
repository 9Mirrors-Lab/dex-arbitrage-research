// Phase A — Coverage audit.
//
// Answers one question: of the market that exists, what did the Stage-2
// forensics pipeline actually look at?
//
// The audit is structural as well as numeric. The existing pipeline is
// swap-log driven: 02-forensics.mjs reads block receipts, finds transactions
// that already contain two or more swaps, and reconstructs them. That design
// can only ever see a pool that someone traded inside the observed blocks, and
// only ever see a token pair that an operator already chose. It cannot, by
// construction, see a pool that sat idle with a standing price difference.
//
// So this script measures two different things and never conflates them:
//   observed  — pools/tokens/pairs that appear in the forensics output
//   universe  — pools/pairs that exist on the configured factories, from
//               on-chain counts (data/enumeration-<chain>.json)
//
// Everything in the universe that is not in `observed` is NOT TESTED. It is
// not "unprofitable" and this script refuses to describe it that way.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChain } from '../lib/rpc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const chainId = argOf('chain', 'base');

const cfg = loadChain(chainId);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const pairKey = (a, b) => [a.toLowerCase(), b.toLowerCase()].sort().join('/');

// ---------------------------------------------------------------------------
// 1. What the forensics pipeline observed
// ---------------------------------------------------------------------------
const forensicsFiles = readdirSync(DATA)
  .filter((f) => f.startsWith(`forensics-${chainId}-`) && f.endsWith('.json'))
  .sort();

const observed = {
  pools: new Set(), tokens: new Set(), pairs: new Set(), venues: new Set(),
  venueCombos: new Set(), poolsByVenue: {}, blocks: new Set(),
  arbs: 0, multiSwapTxs: 0, windows: [],
};

for (const f of forensicsFiles) {
  const doc = readJson(join(DATA, f));
  if (!doc) continue;
  observed.windows.push({ file: f, ...doc.window, arbs: doc.counts?.selfFundedArb ?? null, multiSwapTxs: doc.counts?.multiSwapTxs ?? null });
  observed.arbs += doc.counts?.selfFundedArb ?? 0;
  observed.multiSwapTxs += doc.counts?.multiSwapTxs ?? 0;
  for (let b = doc.window.fromBlock; b <= doc.window.toBlock; b++) observed.blocks.add(b);
  for (const arb of doc.arbs ?? []) {
    observed.venueCombos.add(arb.venueCombo);
    for (const v of arb.venueDetail ?? []) {
      if (v.pool) observed.pools.add(v.pool.toLowerCase());
      observed.venues.add(v.venue);
      observed.poolsByVenue[v.venue] ??= new Set();
      if (v.pool) observed.poolsByVenue[v.venue].add(v.pool.toLowerCase());
    }
    const addrs = (arb.cycleTokenAddrs ?? []).filter(Boolean).map((a) => a.toLowerCase());
    for (const a of addrs) observed.tokens.add(a);
    // Every unordered token pair the cycle actually touched.
    for (let i = 0; i < addrs.length; i++) {
      for (let j = i + 1; j < addrs.length; j++) observed.pairs.add(pairKey(addrs[i], addrs[j]));
    }
  }
}

// The metadata cache is a wider "everything the tools ever resolved" set: it
// includes pools seen in rejected transactions too, so it is the honest upper
// bound on what the existing pipeline ever touched.
const poolCache = readJson(join(DATA, 'cache', `pools-${chainId}.json`)) ?? {};
const tokenCache = readJson(join(DATA, 'cache', `tokens-${chainId}.json`)) ?? {};
const v4Cache = readJson(join(DATA, 'cache', `v4-pools-${chainId}.json`)) ?? {};

const touchedPairs = new Set();
for (const p of Object.values(poolCache)) {
  if (p.token0 && p.token1) touchedPairs.add(pairKey(p.token0, p.token1));
}

// ---------------------------------------------------------------------------
// 2. What exists — measured universe size
// ---------------------------------------------------------------------------
const enumeration = readJson(join(DATA, `enumeration-${chainId}.json`));
const universe = { byFactory: {}, enumerablePools: 0, nonEnumerableFactories: [], knownPoolFloor: 0 };

if (enumeration) {
  for (const [key, f] of Object.entries(enumeration.factories)) {
    universe.byFactory[key] = {
      label: f.label, family: f.family, address: f.address,
      onChainPoolCount: f.poolCount, enumerable: f.enumerable, enumMethod: f.enumMethod,
      observedPools: observed.poolsByVenue[key]?.size ?? 0,
    };
    if (f.enumerable && f.poolCount != null) universe.enumerablePools += f.poolCount;
    else universe.nonEnumerableFactories.push(key);
  }
  universe.knownPoolFloor = universe.enumerablePools;
}

// ---------------------------------------------------------------------------
// 3. Structural blind spots — what the design cannot see, independent of run length
// ---------------------------------------------------------------------------
const blindSpots = [
  {
    id: 'requires-prior-arbitrage',
    severity: 'fundamental',
    finding: 'A pool enters the dataset only if an operator already traded it inside an observed block. A pool holding a standing price difference that nobody took is invisible.',
    consequence: 'The Stage-2 result describes opportunities other operators competed for. It is not a measurement of the opportunity universe.',
  },
  {
    id: 'pair-selection-is-inherited',
    severity: 'fundamental',
    finding: 'Token pairs were never chosen by us; they are whatever the observed operators chose. 97.5% of the top venue combination was a single pair.',
    consequence: 'Conclusions about "which pairs are profitable" are conclusions about other operators\' pair selection.',
  },
  {
    id: 'observation-window',
    severity: 'quantified',
    finding: `${observed.blocks.size} blocks observed across ${observed.windows.length} windows (${(observed.blocks.size * cfg.blockTimeSec / 60).toFixed(1)} minutes of chain time).`,
    consequence: 'Opportunities that recur on a daily or weekly cycle cannot appear in a 33-minute sample.',
  },
  {
    id: 'no-idle-pool-state',
    severity: 'fundamental',
    finding: 'No script reads pool state for a pool that did not trade. 04-validate-opportunity.mjs re-prices only the pools named in an observed arbitrage.',
    consequence: 'Zero coverage of the quiet majority of the market, where competition is lowest.',
  },
  {
    id: 'no-factory-enumeration',
    severity: 'fundamental',
    finding: 'Before this stage, nothing enumerated a factory. Pool discovery was entirely incidental to swap-log decoding.',
    consequence: `No denominator existed, so no coverage percentage could be stated. ${universe.enumerablePools.toLocaleString()} pools are reachable from on-chain arrays alone.`,
  },
  {
    id: 'v4-registry-window',
    severity: 'quantified',
    finding: `The Uniswap V4 poolId registry holds ${Object.keys(v4Cache).length} pools, built from a bounded block scan.`,
    consequence: 'V4 swaps in pools created outside that window are unattributable and were marked unverified.',
  },
];

// ---------------------------------------------------------------------------
// 4. Coverage arithmetic
// ---------------------------------------------------------------------------
const pct = (a, b) => (b > 0 ? +(100 * a / b).toFixed(6) : null);

const coverage = {
  observed: {
    poolsInArbitrages: observed.pools.size,
    poolsEverResolved: Object.keys(poolCache).length,
    tokensInArbitrages: observed.tokens.size,
    tokensEverResolved: Object.keys(tokenCache).length,
    pairsInArbitrageCycles: observed.pairs.size,
    pairsEverResolved: touchedPairs.size,
    venues: [...observed.venues].sort(),
    venueCombos: observed.venueCombos.size,
    blocks: observed.blocks.size,
    chainMinutes: +(observed.blocks.size * cfg.blockTimeSec / 60).toFixed(1),
    arbitragesDetected: observed.arbs,
    multiSwapTxsExamined: observed.multiSwapTxs,
  },
  universe,
  ratios: {
    poolsEverResolvedVsEnumerableUniverse: pct(Object.keys(poolCache).length, universe.enumerablePools),
    poolsInArbitragesVsEnumerableUniverse: pct(observed.pools.size, universe.enumerablePools),
    note: 'Denominator counts only factories exposing an on-chain array. Factories without one (Uniswap V3, PancakeSwap V3, SushiSwap V3, Solidly V3, two unidentified V3 forks, Uniswap V4, Balancer V2) are additional and uncounted, so every percentage here is an OVERSTATEMENT of true coverage.',
  },
  routeUniverse: null,
};

// Two-pool routes implied by what we already touched, as a lower bound on the
// route universe. A pair needs two or more pools to host a two-pool arbitrage.
{
  const poolsByPair = new Map();
  for (const [addr, p] of Object.entries(poolCache)) {
    if (!p.token0 || !p.token1 || p.incomplete) continue;
    const k = pairKey(p.token0, p.token1);
    if (!poolsByPair.has(k)) poolsByPair.set(k, []);
    poolsByPair.get(k).push(addr);
  }
  const multi = [...poolsByPair.values()].filter((v) => v.length >= 2);
  const routes = multi.reduce((a, v) => a + (v.length * (v.length - 1)) / 2, 0);
  coverage.routeUniverse = {
    basis: 'pools already in the metadata cache only — a lower bound, not the market',
    pairsWithPools: poolsByPair.size,
    pairsWithTwoOrMorePools: multi.length,
    twoPoolRouteCandidates: routes,
    directionalRoutes: routes * 2,
    routesEvaluatedByExistingTools: 0,
    routesEvaluatedNote: 'No existing script generates a route. 04-validate-opportunity.mjs re-prices observed transactions; it never constructs an untraded pool combination.',
  };
}

// ---------------------------------------------------------------------------
// 5. Reusability inventory — what Stage 3 can build on
// ---------------------------------------------------------------------------
const reuse = {
  reusableAsIs: [
    ['lib/rpc.mjs', 'JSON-RPC with failover, retry and concurrency cap'],
    ['lib/v3math.mjs', 'exact V3 tick maths, validated 32/32 against the deployed QuoterV2'],
    ['lib/quote.mjs', 'one exact-quote interface across V3 forks, solidly-v2, uniswap-v2; plus ternary-search optimal sizing'],
    ['lib/pools.mjs', 'pool/token metadata with retrying on-disk cache and factory->venue resolver'],
    ['lib/price.mjs', 'USD pricing from on-chain state at a block'],
    ['lib/registry.mjs', 'status ledger with the VALIDATED gate'],
    ['chains/*.json', 'per-chain factories with on-chain identification evidence'],
    ['scripts/03-validate-quotemath.mjs', 'the correctness gate every quote depends on'],
    ['scripts/08,09,10', 'latency, Flashblocks and decision-cost measurements feeding capture feasibility'],
  ],
  mustBeBuilt: [
    ['lib/multicall.mjs', 'batched reads — built in this stage; makes enumeration affordable'],
    ['lib/discovery.mjs', 'factory enumeration and cross-venue pool completion'],
    ['lib/poolregistry.mjs', 'the indexed pool/token inventory with incremental updates'],
    ['lib/routes.mjs', 'route generation and the coverage ledger'],
    ['lib/costs.mjs', 'standalone cost model (gas + L1 data fee) not tied to an observed receipt'],
    ['scripts/22-24', 'discovery, state snapshot, independent scanner, persistence'],
  ],
  preserved: [
    ['data/forensics-base-*.json', '1,662 arbitrages across 1,000 blocks — System B evidence, untouched'],
    ['data/ranking-base.json, validation-base-*.json', 'Stage 2 rankings and validation runs, untouched'],
    ['registry.json', '67 FAILED opportunity rows — negative results retained, not deleted'],
    ['reports/stage2-base-investigation.md, stage3-sameblock-feasibility.md', 'prior conclusions, unmodified'],
  ],
};

const out = {
  chain: chainId, chainName: cfg.name, auditedAt: new Date().toISOString(),
  pipelineAudited: forensicsFiles,
  windows: observed.windows,
  coverage, blindSpots, reuse,
  verdict: forensicsFiles.length
    ? 'The Stage-2 pipeline is a forensics instrument. Its coverage of the independent-opportunity universe is effectively zero, because it has no mechanism to evaluate a pool that did not already trade.'
    : 'No forensics run exists for this chain. All coverage is NOT TESTED.',
};

writeFileSync(join(DATA, `coverage-audit-${chainId}.json`), `${JSON.stringify(out, null, 2)}\n`);

// ---------------------------------------------------------------------------
console.log(`\n=== Phase A coverage audit — ${cfg.name} ===\n`);
if (!forensicsFiles.length) {
  console.log('No forensics files. Everything is NOT TESTED.\n');
} else {
  console.log(`Observation window: ${observed.blocks.size} blocks / ${coverage.observed.chainMinutes} min of chain time, ${observed.windows.length} windows`);
  console.log(`Arbitrages detected: ${observed.arbs} from ${observed.multiSwapTxs} multi-swap transactions\n`);
  console.log('Observed vs universe');
  console.log(`  pools in detected arbitrages      ${String(observed.pools.size).padStart(9)}`);
  console.log(`  pools ever resolved by any script ${String(Object.keys(poolCache).length).padStart(9)}`);
  console.log(`  tokens ever resolved              ${String(Object.keys(tokenCache).length).padStart(9)}`);
  console.log(`  token pairs ever resolved         ${String(touchedPairs.size).padStart(9)}`);
  console.log(`  pools on enumerable factories     ${String(universe.enumerablePools).padStart(9)}  <- denominator floor`);
  console.log(`  coverage of that floor            ${String(coverage.ratios.poolsEverResolvedVsEnumerableUniverse).padStart(9)} %`);
  console.log(`  factories with no on-chain array  ${universe.nonEnumerableFactories.length} (${universe.nonEnumerableFactories.join(', ')}) — additional, uncounted\n`);
  console.log('Route universe (lower bound, from cached pools only)');
  console.log(`  pairs with >=2 pools              ${String(coverage.routeUniverse.pairsWithTwoOrMorePools).padStart(9)}`);
  console.log(`  two-pool routes implied           ${String(coverage.routeUniverse.twoPoolRouteCandidates).padStart(9)}`);
  console.log(`  routes any existing script evaluates   ${String(0).padStart(5)}\n`);
  console.log('Per-factory observed / on-chain count');
  for (const [k, v] of Object.entries(universe.byFactory)) {
    const d = v.onChainPoolCount != null ? `${v.observedPools} / ${v.onChainPoolCount}` : `${v.observedPools} / unknown (needs creation logs)`;
    console.log(`  ${k.padEnd(20)} ${d}`);
  }
  console.log(`\nVerdict: ${out.verdict}\n`);
}
console.log(`wrote data/coverage-audit-${chainId}.json`);
