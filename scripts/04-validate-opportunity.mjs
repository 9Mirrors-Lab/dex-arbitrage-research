// STEP 3 GATE - Could our proposed system have captured a real opportunity?
//
// For each observed two-pool arbitrage, this re-prices the whole cycle against
// exact historical pool state and answers two separate questions:
//
//   1. ECONOMICS: at the best possible size, does the cycle clear swap fees,
//      funding fees, L2 execution gas and the OP-stack L1 data fee?
//   2. CAPTURE: was the opportunity already on the chain at the end of the
//      previous block (so a bot polling block boundaries could have found it),
//      or was it created by an earlier transaction inside the same block (so
//      taking it requires same-block reaction, which a polling design cannot
//      do)?
//
// Question 2 is the one that decides whether an observed profitable trade is
// evidence that WE could earn anything. It is answered from the block's own
// transaction order, not assumed.
//
//   node scripts/04-validate-opportunity.mjs --chain base --file data/forensics-....json [--top 12]

import { writeFileSync, readFileSync } from 'node:fs';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { MetaStore } from '../lib/pools.mjs';
import { QuoteEngine, optimalSize } from '../lib/quote.mjs';
import { Pricer } from '../lib/price.mjs';
import { decodeSwap } from '../lib/events.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const TOP = Number(args.top ?? 12);
const rpc = new Rpc(cfg.rpc, { concurrency: 4, timeoutMs: 45000 });
const meta = new MetaStore(rpc, cfg.id, cfg);
const qe = new QuoteEngine(rpc, cfg);
const pricer = new Pricer(rpc, cfg, meta);

const input = JSON.parse(readFileSync(args.file, 'utf8'));
const sym = (a) => meta.token(a).symbol ?? cfg.tokenByAddress[a?.toLowerCase()]?.symbol ?? a?.slice(0, 10);
const decOf = (a) => meta.token(a).decimals ?? cfg.tokenByAddress[a?.toLowerCase()]?.decimals ?? null;

// Two-pool cycles only: that is the instructor's model, and the one we would
// implement first.
const candidates = (input.arbs ?? [])
  .filter((a) => a.swapCount === 2 && a.venueDetail.every((v) => v.family !== 'uniswap-v4' && v.family !== 'balancer-v2'))
  .slice(0, args.random ? undefined : TOP);

// The input file is sorted by net profit, so taking the head biases the
// sample toward the biggest trades - exactly the ones most likely to be
// same-block reactions to a large swap. --random draws an unbiased sample
// instead, with a fixed seed so the selection is reproducible.
if (args.random) {
  let seed = Number(args.seed ?? 20261029);
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  candidates.length = Math.min(candidates.length, TOP);
}

console.error(`validating ${candidates.length} two-pool arbitrage candidates from ${args.file}${args.random ? ' (random sample)' : ' (top by observed net profit)'}`);

const results = [];
for (const a of candidates) {
  const [p0, p1] = a.venueDetail;
  await meta.resolvePools([p0.pool, p1.pool]);
  const m0 = meta.pool(p0.pool); const m1 = meta.pool(p1.pool);
  if (!m0?.token0 || !m1?.token0) { results.push({ hash: a.hash, skipped: 'pool tokens unresolved' }); continue; }
  await meta.resolveTokens([m0.token0, m0.token1, m1.token0, m1.token1]);

  // The cycle token is the one both pools share with the profit token.
  const set0 = new Set([m0.token0, m0.token1]); const set1 = new Set([m1.token0, m1.token1]);
  const shared = [...set0].filter((t) => set1.has(t));
  if (shared.length !== 2) { results.push({ hash: a.hash, skipped: `pools share ${shared.length} tokens, not a clean 2-pool cycle` }); continue; }
  const profitToken = a.balanceSheet?.find((b) => b.usd > 0)?.token?.toLowerCase();
  const X = shared.includes(profitToken) ? profitToken : shared[0];
  const Y = shared.find((t) => t !== X);
  if (decOf(X) == null || decOf(Y) == null) { results.push({ hash: a.hash, skipped: 'token decimals unresolved' }); continue; }

  const prevBlock = a.block - 1;

  // Re-price the full cycle X -> Y -> X through both pools, in both
  // orientations, at a given block.
  const cycleAt = (block, firstPool, secondPool) => async (sizeX) => {
    const leg1 = await qe.quoteExactIn({ pool: firstPool.pool, family: firstPool.family, factory: firstPool.factory, tokenIn: X, amountIn: sizeX, block });
    if (leg1.amountOut == null || leg1.amountOut <= 0n) return null;
    const leg2 = await qe.quoteExactIn({ pool: secondPool.pool, family: secondPool.family, factory: secondPool.factory, tokenIn: Y, amountIn: leg1.amountOut, block });
    if (leg2.amountOut == null) return null;
    return { profit: leg2.amountOut - sizeX, out: leg2.amountOut, mid: leg1.amountOut, leg1, leg2 };
  };

  const dX = decOf(X);
  const observedSize = (() => {
    // Size the search range from the trade that actually happened.
    const g = a.balanceSheet?.find((b) => b.token?.toLowerCase() === X);
    const base = g && g.human ? Math.abs(g.human) : 1;
    return BigInt(Math.max(1, Math.round(base * 10 ** dX)));
  })();
  // Search up to 64x the size the real trade used. A far wider bound is not
  // free: the first probes then walk thousands of initialised ticks, and every
  // tick is a separate archive read against a public endpoint.
  const hi = observedSize > 0n ? observedSize * 64n : 10n ** BigInt(dX);

  const orientations = [[p0, p1], [p1, p0]];
  const evaluate = async (block) => {
    let best = null;
    for (const [f, s] of orientations) {
      const r = await optimalSize({ quoteCycle: cycleAt(block, f, s), lo: 1n, hi, iterations: 20 });
      if (r.best && (best == null || r.best.profit > best.profit)) best = { ...r.best, first: f, second: s, probes: r.probes };
    }
    return best;
  };

  const atPrev = await evaluate(prevBlock);

  // Cost model: the real receipt is the best available estimate of what this
  // trade shape costs to execute on this chain.
  const costUsd = a.costUsd;
  const w = await pricer.wethUsd(prevBlock);
  const dY = decOf(Y);
  let xPricingBasis = null;
  const xUsdPerUnit = await (async () => {
    const direct = await pricer.usdValue(X, 10n ** BigInt(dX), prevBlock);
    if (direct.usd != null) { xPricingBasis = direct.basis; return direct.usd; }
    // X has no direct route. If the other side of the cycle is priceable,
    // derive X from the rate this very cycle just quoted.
    if (!atPrev || atPrev.mid == null || atPrev.size == null || dY == null) return null;
    const yUnit = await pricer.usdValue(Y, 10n ** BigInt(dY), prevBlock);
    if (yUnit.usd == null) return null;
    const humanX = Number(atPrev.size) / 10 ** dX;
    const humanY = Number(atPrev.mid) / 10 ** dY;
    if (!(humanX > 0) || !(humanY > 0)) return null;
    xPricingBasis = `derived from the cycle's own ${sym(X)}->${sym(Y)} quote at block ${prevBlock}, with ${sym(Y)} priced by ${yUnit.basis}`;
    return (humanY / humanX) * yUnit.usd;
  })();

  const grossUsdAtPrev = atPrev && xUsdPerUnit != null ? (Number(atPrev.profit) / 10 ** dX) * xUsdPerUnit : null;

  // Transaction-aware capture test: did an earlier transaction in the SAME
  // block already swap on either of these pools?
  const receipts = await rpc.getBlockReceipts(a.block);
  const arbReceipt = receipts.find((r) => r.transactionHash === a.hash);
  const arbIndex = arbReceipt ? Number(BigInt(arbReceipt.transactionIndex)) : null;
  const pools = new Set([p0.pool.toLowerCase(), p1.pool.toLowerCase()]);
  const earlierTouches = [];
  for (const r of receipts) {
    const idx = Number(BigInt(r.transactionIndex));
    if (arbIndex == null || idx >= arbIndex) continue;
    for (const log of r.logs ?? []) {
      if (!pools.has(log.address.toLowerCase())) continue;
      if (!decodeSwap(log)) continue;
      earlierTouches.push({ hash: r.transactionHash, index: idx, pool: log.address.toLowerCase() });
    }
  }
  // Competing arbitrage on the same pools, anywhere in the block.
  const sameBlockCompetitors = (input.arbs ?? []).filter((o) => o.block === a.block && o.hash !== a.hash
    && o.venueDetail.some((v) => pools.has(String(v.pool).toLowerCase()))).map((o) => o.hash);

  const profitableAtPrev = grossUsdAtPrev != null && grossUsdAtPrev > costUsd;
  let capture;
  if (profitableAtPrev && earlierTouches.length === 0) {
    capture = 'pre-existing: visible at the previous block boundary, no same-block trigger - a block-polling bot could have found it';
  } else if (earlierTouches.length > 0) {
    capture = `same-block backrun: ${earlierTouches.length} earlier transaction(s) in this block swapped on these pools, so capture needs same-block reaction`;
  } else if (!profitableAtPrev) {
    capture = 'not profitable at the previous block boundary and no same-block trigger found on these pools - our model does not explain this trade';
  }

  results.push({
    hash: a.hash,
    block: a.block,
    txIndex: arbIndex,
    venueCombo: a.venueCombo,
    cycle: `${sym(X)} -> ${sym(Y)} -> ${sym(X)}`,
    cycleTokens: { X, Y, symbolX: sym(X), symbolY: sym(Y) },
    pools: [{ ...p0 }, { ...p1 }],
    observedNetUsd: a.netProfitUsd,
    observedGrossUsd: a.grossProfitUsd,
    executionCostUsd: costUsd,
    l1ShareOfCost: a.l1ShareOfCost,
    gasUsed: a.gasUsed,
    funding: a.funding,
    revalidatedAtPrevBlock: atPrev ? {
      block: prevBlock,
      optimalSizeX: (Number(atPrev.size) / 10 ** dX),
      optimalSizeRaw: atPrev.size.toString(),
      grossProfitX: Number(atPrev.profit) / 10 ** dX,
      grossProfitUsd: grossUsdAtPrev,
      netProfitUsd: grossUsdAtPrev != null ? grossUsdAtPrev - costUsd : null,
      direction: `${atPrev.first.venue} -> ${atPrev.second.venue}`,
      cycleTokenPricingBasis: xPricingBasis,
      quoteBasis: [atPrev.best?.leg1?.basis ?? atPrev.leg1?.basis, atPrev.leg2?.basis].filter(Boolean),
      ticksCrossed: [atPrev.leg1?.ticksCrossed, atPrev.leg2?.ticksCrossed],
      probes: atPrev.probes,
    } : null,
    captureTest: {
      profitableAtPreviousBlock: profitableAtPrev,
      earlierSameBlockSwapsOnThesePools: earlierTouches.length,
      earlierSameBlockDetail: earlierTouches.slice(0, 5),
      otherArbsOnSamePoolsInBlock: sameBlockCompetitors,
      verdict: capture,
    },
    wethUsdAtPrevBlock: w?.usdPerWeth ?? null,
  });
  const r = results[results.length - 1];
  console.error(`  ${a.hash.slice(0, 12)} ${r.cycle.padEnd(26)} observed net $${(a.netProfitUsd ?? 0).toFixed(3)} | revalidated net $${r.revalidatedAtPrevBlock?.netProfitUsd?.toFixed(3) ?? 'n/a'} | ${capture?.split(':')[0]}`);
}

const out = {
  chain: cfg.id, measuredAt: new Date().toISOString(), source: args.file,
  sourceWindow: input.window,
  costModel: 'the observed transaction receipt (L2 gas x effective gas price + OP-stack l1Fee), converted at the WETH/USDC pool price at the same block',
  quoteBasis: 'exact historical pool state: local V3 tick maths (validated wei-for-wei against the deployed Uniswap QuoterV2), pool.getAmountOut() for Solidly/Aerodrome, constant product on getReserves() for V2',
  captureTestMethod: 'an opportunity counts as capturable by a block-polling design only if it is already profitable using state at the end of the previous block AND no earlier transaction in the same block swapped on either pool',
  results,
  rpcStats: rpc.stats, quoteCalls: qe.calls,
};
const path = new URL(`../data/validation-${cfg.id}-${Date.now()}.json`, import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.error(`\nwrote ${path.pathname}`);
