// Phase C — Independent opportunity scanner (System A).
//
//   node scripts/24-scan-routes.mjs --chain base --block 53266711 --top 2000
//
// For every generated route this does, in order:
//   1. read the real pool state of both pools at one historical block
//   2. quote leg one exactly, with the pool's own arithmetic
//   3. quote leg two with the ACTUAL output of leg one, never a spot price
//   4. walk a geometric size ladder, then refine the best bracket
//   5. price the round trip, subtract modelled execution cost
//   6. classify, and record the evidence that justifies the classification
//
// No historical arbitrage transaction is consulted anywhere in this file. The
// candidate set comes from the pool registry, so a pool nobody has ever
// arbitraged is examined on exactly the same terms as a contested one.
//
// A route that cannot be quoted is classified UNSUPPORTED with the reason.
// It is never counted as unprofitable.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { Multicall } from '../lib/multicall.mjs';
import { PoolRegistry } from '../lib/poolregistry.mjs';
import { QuoteEngine } from '../lib/quote.mjs';
import { CostModel } from '../lib/costs.mjs';
import { generateTwoPoolRoutes, prioritise, RouteLedger, CLASS } from '../lib/routes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const chainId = argOf('chain', 'base');
const topN = Number(argOf('top', 2000));
const minDepthUsd = Number(argOf('min-depth', 500));
const concurrency = Number(argOf('concurrency', 6));
const outTag = argOf('tag', String(Date.now()));

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: Number(argOf('rpc-concurrency', 24)) });
const reg = new PoolRegistry(chainId);
const mc = new Multicall(rpc, cfg.multicall3, { batch: 400, parallel: 5 });
const quoter = new QuoteEngine(rpc, cfg);
const costs = new CostModel(cfg);

const block = argOf('block') ? Number(argOf('block')) : await rpc.blockNumber();

// Base carries a cost calibration measured from its own forensics dataset.
// Any other chain has no measured gas price, and the model refuses to price
// execution until one is read from the chain at this block.
const calib = await costs.calibrate(rpc, block);
if (!costs.calibrated) {
  console.error(`cannot calibrate execution cost for ${chainId}: ${calib.reason}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// USD pricing for profit reporting
// ---------------------------------------------------------------------------
// WETH is priced from the Uniswap V3 WETH/USDC pool's own state at this block —
// the same basis the forensics pass uses. Everything else falls back to the
// registry's screening price, and the basis is recorded per route so a reader
// can tell a hard number from a soft one.
// A USD figure is only reported when its basis is strong enough to carry a
// profit claim. The first scan showed why this matters: a token priced three
// hops out through thin pools produced a "profit" of $2.4e51. Rather than
// print a number nobody can defend, a route whose input token has no reliable
// basis is classified UNSUPPORTED and its token-denominated spread is kept as
// the finding. That is the difference between an unquantified result and a
// wrong one.
// Anchor addresses come from the chain config, never from an on-chain symbol.
// A token that merely CALLS itself USDT is not a dollar.
const STABLE_SYMBOLS = new Set(['USDC', 'USDbC', 'USDT', 'DAI', 'EURC', 'USDS']);
const STABLE_ADDRESSES = new Set(
  Object.entries(cfg.tokens ?? {})
    .filter(([sym]) => STABLE_SYMBOLS.has(sym))
    .map(([, t]) => t.address.toLowerCase()),
);
const RELIABLE_HOP_DEPTH_USD = 25000;
const MAX_PLAUSIBLE_PRICING_DEPTH_USD = 5e9;

function priceOf(tokenAddr) {
  const t = reg.token(tokenAddr);
  if (!t) return { usd: null, reliable: false, basis: 'token unknown' };
  if (STABLE_ADDRESSES.has(String(tokenAddr).toLowerCase()) && t.decimals != null) {
    return { usd: 1, reliable: true, basis: 'configured stablecoin address, assumed $1.00' };
  }
  if (t.screeningPriceUsd == null) return { usd: null, reliable: false, basis: 'no on-chain price path' };

  const hops = t.priceHopsFromAnchor;
  const depth = t.pricingDepthUsd ?? null;
  // One hop from a $1 anchor, through a pool deep enough that its spot ratio
  // is not an artefact. WETH on Base satisfies this through the Uniswap V3
  // WETH/USDC pool, which is the same basis the forensics pass uses.
  const reliable = hops === 1 && depth != null
    && depth >= RELIABLE_HOP_DEPTH_USD && depth < MAX_PLAUSIBLE_PRICING_DEPTH_USD;
  return {
    usd: t.screeningPriceUsd,
    reliable,
    hops,
    pricingDepthUsd: depth,
    basis: reliable
      ? `spot ratio of a $${Math.round(depth).toLocaleString()} pool against a $1 anchor (1 hop) — ${t.priceVia}`
      : `screening price only, ${hops} hop(s) from a $1 anchor${depth != null ? `, pricing pool depth $${Math.round(depth).toLocaleString()}` : ''} — not strong enough for a profit claim`,
  };
}

// ---------------------------------------------------------------------------
// Route generation
// ---------------------------------------------------------------------------
console.log(`\n=== Phase C scan — ${cfg.name} @ block ${block} ===\n`);
const { routes, excluded } = generateTwoPoolRoutes({ registry: reg, minDepthUsd });
const ledger = new RouteLedger();
ledger.seed(routes);
console.log(`route universe: ${routes.length} directional two-pool routes over ${new Set(routes.map((r) => r.pair)).size} pairs`);
console.log(`excluded at generation: ${excluded.length}`);
console.log(`evaluating top ${Math.min(topN, routes.length)} by depth\n`);

const queue = prioritise(routes).slice(0, topN);

// ---------------------------------------------------------------------------
// Pre-warm pool state
// ---------------------------------------------------------------------------
// Every pool in the queue is read once, in batches, before any quoting starts.
// Done lazily instead, the six cold reads per pool are serialised behind the
// rate limiter and dominate the whole scan.
{
  const needed = new Map();
  for (const r of queue) {
    needed.set(r.poolA, reg.pool(r.poolA)?.family);
    needed.set(r.poolB, reg.pool(r.poolB)?.family);
  }
  const v3 = [...needed].filter(([, f]) => f === 'uniswap-v3' || f === 'pancake-v3').map(([p]) => p);
  const v2 = [...needed].filter(([, f]) => f === 'uniswap-v2' || f === 'solidly-v2').map(([p]) => p);
  const pw = (s) => process.stdout.write(`\r  ${s}`.padEnd(90));
  const a = await quoter.prewarmV3({ mc, pools: v3, block, log: pw });
  const b = await quoter.prewarmV2({ mc, pools: v2, block, log: pw });
  const t = await quoter.prewarmV3Ticks({ mc, block, wordRadius: 4, maxTicksPerPool: 160, log: pw });
  process.stdout.write('\n');
  console.log(`pre-warmed ${a.prewarmed}/${a.attempted} v3-family and ${b.prewarmed}/${b.attempted} v2-family pool states at block ${block}`);
  console.log(`pre-warmed ${t.words} tick bitmap words and ${t.ticks} initialised ticks across ${t.pools} V3 pools\n`);
}

// ---------------------------------------------------------------------------
// Size ladder
// ---------------------------------------------------------------------------
// The ladder spans six orders of magnitude below the depth-limited ceiling, so
// a route is tested at sizes a real operator would use rather than at one
// arbitrary notional. The ceiling is a fraction of the shallower pool's
// holding of the input token: beyond that the price impact of leg one alone
// destroys any spread, and quoting there wastes RPC.
// Capped at 8% of the binding reserve. Beyond that the price impact of leg one
// alone exceeds any plausible spread, and on a V3 pool a probe that large
// walks hundreds of ticks — each an uncached state read, which was the second
// largest cost in the first scan. The cap is a bound on what we claim to have
// tested, and it is recorded with every result.
const LADDER_FRACTIONS = [0.00002, 0.0002, 0.001, 0.004, 0.012, 0.03, 0.05, 0.08];

function ceilingRaw(route, poolA, poolB) {
  const sideOf = (p, token) => {
    if (!p?.state || p.state.error) return null;
    try { return BigInt(p.token0 === token ? p.state.reserve0 : p.state.reserve1); } catch { return null; }
  };
  const a = sideOf(poolA, route.tokenIn);
  // Pool B receives tokenMid and pays tokenIn, so its binding side is tokenIn.
  const b = sideOf(poolB, route.tokenIn);
  const sides = [a, b].filter((x) => x != null && x > 0n);
  if (!sides.length) return null;
  return sides.reduce((m, x) => (x < m ? x : m));
}

// Evaluate a set of trade sizes as two batched legs.
//
// Leg two is always quoted on the ACTUAL output of leg one — that is what
// separates an executable round trip from a spot-price comparison. Batching
// the sizes does not weaken it: each size still gets its own exact leg-two
// quote on its own leg-one output.
async function cycleMany(route, sizes) {
  const results = sizes.map(() => null);
  if (!sizes.length) return results;

  const leg1s = await quoter.quoteExactInBatch({
    pool: route.poolA, family: route.familyA, factory: route.factoryA,
    tokenIn: route.tokenIn, amounts: sizes, block, mc,
  });
  const live = [];
  leg1s.forEach((r, i) => { if (r.amountOut != null && r.amountOut > 0n) live.push(i); });
  const leg2s = live.length
    ? await quoter.quoteExactInBatch({
      pool: route.poolB, family: route.familyB, factory: route.factoryB,
      tokenIn: route.tokenMid, amounts: live.map((i) => leg1s[i].amountOut), block, mc,
    })
    : [];
  const leg2By = new Map();
  live.forEach((i, k) => leg2By.set(i, leg2s[k]));

  sizes.forEach((size, i) => {
    const l1 = leg1s[i];
    if (l1.amountOut == null) { results[i] = { error: `leg1: ${l1.reason}`, size }; return; }
    if (l1.amountOut === 0n) { results[i] = { profit: -size, out: 0n, leg1: l1, leg2: null, size }; return; }
    const l2 = leg2By.get(i);
    if (!l2 || l2.amountOut == null) { results[i] = { error: `leg2: ${l2?.reason ?? 'missing'}`, size }; return; }
    results[i] = { profit: l2.amountOut - size, out: l2.amountOut, leg1: l1, leg2: l2, size };
  });
  return results;
}

// Ternary search inside the bracket the ladder found best. Both probes of an
// iteration go out together, so a solidly-v2 leg costs one batched call per
// iteration rather than two round trips.
async function refine(route, lo, hi, iterations = 14) {
  let a = lo; let b = hi; let best = null;
  for (let i = 0; i < iterations && b - a > 1n; i++) {
    const m1 = a + (b - a) / 3n;
    const m2 = b - (b - a) / 3n;
    const [p1, p2] = await cycleMany(route, [m1, m2]);
    for (const p of [p1, p2]) {
      if (p && !p.error && (!best || p.profit > best.profit)) best = p;
    }
    const v1 = p1 && !p1.error ? p1.profit : -(2n ** 255n);
    const v2 = p2 && !p2.error ? p2.profit : -(2n ** 255n);
    if (v1 < v2) a = m1 + 1n; else b = m2 - 1n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Evaluate one route
// ---------------------------------------------------------------------------
async function evaluate(route) {
  const poolA = reg.pool(route.poolA); const poolB = reg.pool(route.poolB);
  route.factoryA = poolA?.factory; route.factoryB = poolB?.factory;

  const tIn = reg.token(route.tokenIn);
  if (tIn?.decimals == null) return { cls: CLASS.UNSUPPORTED, evidence: { reason: 'input token decimals unknown' } };

  const ceil = ceilingRaw(route, poolA, poolB);
  if (ceil == null || ceil <= 0n) return { cls: CLASS.UNSUPPORTED, evidence: { reason: 'no usable reserve snapshot to bound trade size' } };

  // --- ladder, evaluated as two batched legs rather than size by size
  const sizes = LADDER_FRACTIONS
    .map((f) => BigInt(Math.floor(Number(ceil) * f)))
    .filter((s) => s > 0n);
  const ladder = [];
  let bestLadder = null; let bestIdx = -1; let quoteError = null;

  if (sizes.length) {
    const rungs = await cycleMany(route, sizes);
    rungs.forEach((r, i) => {
      if (!r) return;
      if (r.error) { quoteError ??= r.error; ladder.push({ size: String(sizes[i]), error: r.error }); return; }
      ladder.push({ size: String(sizes[i]), out: String(r.out), profit: String(r.profit) });
      if (!bestLadder || r.profit > bestLadder.profit) { bestLadder = r; bestIdx = i; }
    });
  }

  if (!bestLadder) {
    return { cls: CLASS.UNSUPPORTED, evidence: { reason: quoteError ?? 'every ladder probe failed to quote', ladder } };
  }

  // --- refine around the best rung when the ladder shows a spread
  let best = bestLadder;
  if (bestLadder.profit > 0n) {
    const lo = sizes[Math.max(0, bestIdx - 1)];
    const hi = sizes[Math.min(sizes.length - 1, bestIdx + 1)];
    const refined = await refine(route, lo > 0n ? lo : 1n, hi);
    if (refined && refined.profit > best.profit) best = refined;
  }

  const px = priceOf(route.tokenIn);
  const dec = tIn.decimals;
  const human = (raw) => Number(raw) / 10 ** dec;
  const grossToken = human(best.profit);
  const sizeToken = human(best.size);
  const grossUsd = px.reliable ? grossToken * px.usd : null;
  const notionalUsd = px.reliable ? sizeToken * px.usd : null;

  // --- no spread: the exact round trip returns less than it consumed
  if (best.profit <= 0n) {
    return {
      cls: CLASS.NO_SPREAD,
      evidence: {
        reason: 'exact round trip returns less input than it consumes at every tested size',
        bestSizeToken: sizeToken, bestGrossToken: grossToken, bestGrossUsd: grossUsd,
        sizesTested: ladder.length, ladder, ceilingRaw: String(ceil),
        quoteBasis: [best.leg1?.basis, best.leg2?.basis],
      },
    };
  }

  // --- a spread exists; does it survive cost?
  const weth = priceOf(cfg.tokens[cfg.nativeSymbol === 'ETH' ? 'WETH' : cfg.nativeSymbol].address);
  const wethUsd = weth.reliable ? weth.usd : null;
  if (wethUsd == null) return { cls: CLASS.UNSUPPORTED, evidence: { reason: `cannot price the gas token reliably at this block (${weth.basis}), so execution cost is unknown`, bestGrossToken: grossToken } };
  const cost = costs.both({ legs: 2, wethUsd, fundingBps: 0, notionalUsd: notionalUsd ?? 0 });

  const evidence = {
    block,
    bestSizeToken: sizeToken, bestSizeRaw: String(best.size),
    midAmountRaw: String(best.leg1.amountOut), returnedRaw: String(best.out),
    grossToken, grossUsd, notionalUsd,
    grossBasisToken: tIn.symbol ?? route.tokenIn,
    priceBasis: px.basis,
    quoteBasis: [best.leg1?.basis, best.leg2?.basis],
    ticksCrossed: [best.leg1?.ticksCrossed ?? null, best.leg2?.ticksCrossed ?? null],
    costMedianUsd: cost.median.totalUsd, costContestedUsd: cost.contested.totalUsd,
    netUsdMedian: grossUsd != null ? grossUsd - cost.median.totalUsd : null,
    netUsdContested: grossUsd != null ? grossUsd - cost.contested.totalUsd : null,
    costModel: cost.median.basis,
    netIsUpperBound: costs.builderPaymentUnmodelled,
    ladder, ceilingRaw: String(ceil),
  };

  if (grossUsd == null) {
    // A real, exactly-quoted spread in token terms that we decline to convert
    // to USD, because the only available rate is too weak to support the
    // claim. Recorded as UNSUPPORTED, never as unprofitable.
    return {
      cls: CLASS.UNSUPPORTED,
      evidence: {
        ...evidence,
        reason: `exact round trip is positive by ${grossToken} ${tIn.symbol ?? 'tokens'}, but net profit cannot be stated: ${px.basis}`,
        tokenDenominatedSpread: true,
      },
    };
  }
  if (evidence.netUsdMedian <= 0) return { cls: CLASS.NEGATIVE_NET, evidence };
  // Profitable on an exact quote at an executable size. Whether we could ever
  // have been the one to take it is a separate measurement — Phase D.
  return { cls: CLASS.PROFITABLE_TIMING_UNKNOWN, evidence };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const t0 = Date.now();
let done = 0; let errors = 0;
const tallyLive = {};

async function worker(slice) {
  for (const route of slice) {
    try {
      const { cls, evidence } = await evaluate(route);
      ledger.classify(route.key, cls, evidence);
      tallyLive[cls] = (tallyLive[cls] ?? 0) + 1;
    } catch (e) {
      errors++;
      ledger.classify(route.key, CLASS.UNSUPPORTED, { reason: `evaluation threw: ${String(e.message).slice(0, 160)}` });
      tallyLive[CLASS.UNSUPPORTED] = (tallyLive[CLASS.UNSUPPORTED] ?? 0) + 1;
    }
    done++;
    if (done % 25 === 0 || done === queue.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${done}/${queue.length} routes  ${rate.toFixed(1)}/s  ${Object.entries(tallyLive).map(([k, v]) => `${k}:${v}`).join('  ')}`.padEnd(150));
    }
  }
}

const slices = Array.from({ length: concurrency }, () => []);
queue.forEach((r, i) => slices[i % concurrency].push(r));
await Promise.all(slices.map(worker));
process.stdout.write('\n');

const tally = ledger.tally();
const profitable = ledger.profitable();

const out = {
  chain: chainId, chainName: cfg.name, block, scannedAt: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 1000),
  method: {
    candidateSource: `pool registry (data/market/pools-${chainId}.json) — generated mechanically, not derived from any observed arbitrage transaction`,
    legOneQuote: 'exact, pool-native arithmetic at the stated block',
    legTwoQuote: 'exact, on the actual output amount of leg one',
    sizing: `geometric ladder of ${LADDER_FRACTIONS.length} sizes bounded by the shallower pool's input-token reserve, then ternary refinement when a spread appears`,
    costs: costs.cal.source,
    costGasUsedBorrowed: !!costs.cal.borrowedGasUsed,
    builderPaymentUnmodelled: costs.builderPaymentUnmodelled,
    netProfitIsUpperBound: costs.builderPaymentUnmodelled,
    spotPricesUsedForProfit: false,
  },
  routeUniverse: {
    generated: routes.length,
    pairs: new Set(routes.map((r) => r.pair)).size,
    excludedAtGeneration: excluded.length,
    queued: queue.length,
  },
  coverage: tally,
  rpc: { calls: rpc.stats.calls, errors: rpc.stats.errors, quoteCalls: quoter.calls },
  evaluationErrors: errors,
  leadingCandidates: profitable.slice(0, 50),
  excludedSample: excluded.slice(0, 200),
};

writeFileSync(join(ROOT, 'data', `scan-${chainId}-${block}-${outTag}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(join(ROOT, 'data', `ledger-${chainId}-${block}-${outTag}.json`), `${JSON.stringify(ledger.toJSON())}\n`);

console.log('\n=== classification ===');
for (const [k, v] of Object.entries(tally.byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${String(v).padStart(7)}`);
console.log(`\n  routes generated   ${routes.length}`);
console.log(`  routes evaluated   ${tally.evaluated}  (${tally.pctEvaluated}% of generated)`);
console.log(`  still NOT TESTED   ${tally.notTested}`);
console.log(`\nprofitable after exact quotes and modelled cost (median scenario): ${profitable.filter((r) => (r.evidence?.netUsdMedian ?? 0) > 0).length}`);
for (const r of profitable.slice(0, 15)) {
  const e = r.evidence ?? {};
  console.log(`  ${(reg.token(r.tokenIn)?.symbol ?? r.tokenIn.slice(0, 8)).padEnd(10)} ${r.venueA.padEnd(16)} -> ${r.venueB.padEnd(16)} size ${(e.bestSizeToken ?? 0).toPrecision(4).padStart(12)}  gross $${(e.grossUsd ?? 0).toFixed(4).padStart(10)}  net(med) $${(e.netUsdMedian ?? 0).toFixed(4).padStart(10)}  net(cont) $${(e.netUsdContested ?? 0).toFixed(4).padStart(10)}`);
}
console.log(`\n${out.seconds}s, ${rpc.stats.calls} rpc calls; wrote data/scan-${chainId}-${block}-${outTag}.json`);
