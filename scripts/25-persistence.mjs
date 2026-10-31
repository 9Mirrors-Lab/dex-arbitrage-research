// Phase D — Persistence, competition and capture feasibility.
//
//   node scripts/25-persistence.mjs --chain base --scan data/scan-base-<block>-<tag>.json --blocks 12
//
// A positive net quote at one block is not an opportunity we could have taken.
// This script asks the three questions that decide that, each answered from
// chain state rather than from assumption:
//
//   1. PERSISTENCE  — re-quote the same route at consecutive completed-block
//      boundaries. How many blocks, and how many seconds, does the profitable
//      state survive?
//   2. CAPTURE      — given the measured latency budget (below), could a bot
//      that observed block N have landed a transaction in block N+1 while the
//      opportunity was still there?
//   3. COMPETITION  — how contested are these two pools? Swap counts per block
//      from the discovery sweep, plus whether any operator in the preserved
//      forensics dataset already traded them.
//
// THE LATENCY MODEL IS STATED, NOT ASSUMED. Numbers come from
// data/latency-base.json and data/decision-latency-base.json:
//
//   observe block header        43 ms   (drpc p50 RTT, the fastest endpoint)
//   decide, warm state          55 ms   (full optimal-size search, p50)
//   submit transaction          43 ms
//   ---------------------------------
//   reaction budget            141 ms   against a 2,000 ms block interval
//
// So block-boundary capture has ~1.86 s of slack. That is what makes
// persistence across one boundary the meaningful test: it does not require
// same-block reaction, which is the constraint that defeated Stage 2.

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { PoolRegistry } from '../lib/poolregistry.mjs';
import { QuoteEngine } from '../lib/quote.mjs';
import { CostModel } from '../lib/costs.mjs';
import { CLASS } from '../lib/routes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const chainId = argOf('chain', 'base');
const horizon = Number(argOf('blocks', 12));
const topN = Number(argOf('top', 60));

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 12 });
const reg = new PoolRegistry(chainId);
const quoter = new QuoteEngine(rpc, cfg);
const costs = new CostModel(cfg);

export const LATENCY_MODEL = {
  source: 'data/latency-base.json, data/decision-latency-base.json',
  observeMs: 43, decideMs: 55, submitMs: 43, totalMs: 141,
  blockIntervalMs: cfg.blockTimeSec * 1000,
  slackMs: cfg.blockTimeSec * 1000 - 141,
  measuredAgainst: 'Base public endpoints from a local workstation',
  note: 'Block-boundary capture only. Same-block reaction is a different architecture and is not claimed here.',
  // The reaction budget is necessary but nowhere near sufficient on a chain
  // with a builder auction. There, having the transaction ready in time only
  // buys the right to bid; the opportunity goes to whoever pays the builder
  // most. Timing slack on such a chain must not be read as capture.
  caveat: cfg.kind === 'l1'
    ? `${cfg.name} orders transactions through a competitive block-builder market. Arriving inside the budget is necessary but NOT sufficient: inclusion is auctioned, and the builder payment is not modelled anywhere in this repo. A CAPTURE CANDIDATE here means "the opportunity was still live long enough to act on", not "we would have won it".`
    : `${cfg.name} is sequenced first-come-first-served by a single sequencer with no public builder auction, so arriving inside the budget is the binding constraint and a persistent opportunity is genuinely reachable — subject to other operators arriving sooner.`,
};

// ---------------------------------------------------------------------------
let scanPath = argOf('scan');
if (!scanPath) {
  // By modification time, not by name. Sorting `scan-<chain>-<block>-<tag>`
  // alphabetically picks whichever tag sorts last, which silently fed an
  // obsolete scan into this analysis once already.
  const cands = readdirSync(join(ROOT, 'data'))
    .filter((f) => f.startsWith(`scan-${chainId}-`) && f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(ROOT, 'data', f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  if (!cands.length) { console.error('no scan file found; run scripts/24-scan-routes.mjs first'); process.exit(1); }
  scanPath = join(ROOT, 'data', cands[cands.length - 1].f);
}
const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
const baseBlock = scan.block;
await costs.calibrate(rpc, baseBlock);

const candidates = (scan.leadingCandidates ?? [])
  .filter((r) => r.classification === CLASS.PROFITABLE_TIMING_UNKNOWN || (r.evidence?.netUsdMedian ?? 0) > 0)
  .slice(0, topN);

console.log(`\n=== Phase D persistence — ${cfg.name} ===`);
console.log(`scan: ${scanPath.split('/').pop()}  base block ${baseBlock}`);
console.log(`candidates: ${candidates.length}, horizon ${horizon} blocks (${horizon * cfg.blockTimeSec}s of chain time)\n`);

if (!candidates.length) {
  console.log('Nothing profitable to test. Phase D is a no-op, which is itself the result.\n');
  writeFileSync(join(ROOT, 'data', `persistence-${chainId}-${baseBlock}.json`), `${JSON.stringify({
    chain: chainId, baseBlock, scanFile: scanPath.split('/').pop(), latencyModel: LATENCY_MODEL,
    candidates: 0, results: [], conclusion: 'No route reached PROFITABLE / TIMING UNKNOWN at the scanned block, so there was no persistence to measure.',
  }, null, 2)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Competition signal from the preserved forensics dataset (System B feeding A)
// ---------------------------------------------------------------------------
const contestedPools = new Map(); // pool -> { arbs, operators:Set }
for (const f of readdirSync(join(ROOT, 'data')).filter((x) => x.startsWith(`forensics-${chainId}-`))) {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
  for (const arb of doc.arbs ?? []) {
    for (const v of arb.venueDetail ?? []) {
      if (!v.pool) continue;
      const k = v.pool.toLowerCase();
      if (!contestedPools.has(k)) contestedPools.set(k, { arbs: 0, operators: new Set() });
      const e = contestedPools.get(k);
      e.arbs++; e.operators.add(arb.operatorContract ?? arb.operatorEoa);
    }
  }
}

// ---------------------------------------------------------------------------
async function quoteAt(route, size, block) {
  const leg1 = await quoter.quoteExactIn({
    pool: route.poolA, family: route.familyA, factory: route.factoryA,
    tokenIn: route.tokenIn, amountIn: size, block,
  });
  if (leg1.amountOut == null || leg1.amountOut === 0n) return { error: leg1.reason ?? 'leg1 zero output' };
  const leg2 = await quoter.quoteExactIn({
    pool: route.poolB, family: route.familyB, factory: route.factoryB,
    tokenIn: route.tokenMid, amountIn: leg1.amountOut, block,
  });
  if (leg2.amountOut == null) return { error: leg2.reason ?? 'leg2 failed' };
  return { profit: leg2.amountOut - size, out: leg2.amountOut };
}

const results = [];
let i = 0;
for (const route of candidates) {
  i++;
  const tIn = reg.token(route.tokenIn);
  const dec = tIn?.decimals ?? 18;
  const size = BigInt(route.evidence.bestSizeRaw);
  // Reuse the scan's own USD rate for the input token, so the series is
  // comparable to the scan row rather than repriced on a different basis.
  const pxUsd = route.evidence.notionalUsd != null && route.evidence.bestSizeToken
    ? route.evidence.notionalUsd / route.evidence.bestSizeToken : null;

  // Re-quote the SAME size at each boundary, so the series measures the
  // market moving rather than our sizing changing.
  const series = [];
  for (let k = -2; k <= horizon; k++) {
    const b = baseBlock + k;
    const q = await quoteAt(route, size, b);
    if (q.error) { series.push({ block: b, offset: k, error: q.error }); continue; }
    const grossToken = Number(q.profit) / 10 ** dec;
    const grossUsd = pxUsd != null ? grossToken * pxUsd : null;
    const net = grossUsd != null ? grossUsd - route.evidence.costMedianUsd : null;
    series.push({ block: b, offset: k, grossToken, grossUsd, netUsdMedian: net, profitable: net != null && net > 0 });
  }

  // Longest run of consecutive profitable boundaries that includes or follows
  // the scanned block. A run of length >= 2 means an operator that saw the
  // first of those boundaries had a whole block to act while it was still live.
  let bestRun = 0; let run = 0; let runStart = null; let bestStart = null;
  for (const s of series) {
    if (s.profitable) { if (run === 0) runStart = s.block; run++; if (run > bestRun) { bestRun = run; bestStart = runStart; } } else { run = 0; }
  }

  const atBase = series.find((s) => s.offset === 0);
  const atNext = series.find((s) => s.offset === 1);
  const atPrev = series.find((s) => s.offset === -1);

  const compA = contestedPools.get(route.poolA);
  const compB = contestedPools.get(route.poolB);
  const poolA = reg.pool(route.poolA); const poolB = reg.pool(route.poolB);
  const sweepBlocks = (poolA?.activity?.windowTo ?? 0) - (poolA?.activity?.windowFrom ?? 0) + 1;
  const competition = {
    knownArbitragesOnPoolA: compA?.arbs ?? 0,
    knownArbitragesOnPoolB: compB?.arbs ?? 0,
    distinctOperatorsPoolA: compA?.operators.size ?? 0,
    distinctOperatorsPoolB: compB?.operators.size ?? 0,
    swapsPoolAInSweep: poolA?.activity?.swapsObserved ?? 0,
    swapsPoolBInSweep: poolB?.activity?.swapsObserved ?? 0,
    swapsPerBlockPoolA: sweepBlocks > 0 ? +((poolA?.activity?.swapsObserved ?? 0) / sweepBlocks).toFixed(4) : null,
    swapsPerBlockPoolB: sweepBlocks > 0 ? +((poolB?.activity?.swapsObserved ?? 0) / sweepBlocks).toFixed(4) : null,
    basis: 'arbitrage counts from the preserved Stage-2 forensics windows; swap counts from the Phase-B sweep window',
  };

  // Classification. The capture test is persistence across a boundary, under
  // the stated latency model — not a claim that we would have won the race.
  let cls;
  let rationale;
  if (!atBase || atBase.error) {
    cls = CLASS.UNSUPPORTED;
    rationale = `could not re-quote at the scanned block: ${atBase?.error ?? 'missing'}`;
  } else if (!atBase.profitable) {
    cls = CLASS.NO_SPREAD;
    rationale = 'not reproducible: the re-quote at the scanned block is not net positive. Treat the scan row as unconfirmed.';
  } else if (bestRun >= 2) {
    cls = CLASS.CAPTURE_CANDIDATE;
    rationale = `net positive at ${bestRun} consecutive completed-block boundaries (${bestRun * cfg.blockTimeSec}s). A bot observing the first boundary had ${LATENCY_MODEL.slackMs}ms of slack to land in the next block while the state was still profitable.`;
  } else if (atNext && !atNext.profitable) {
    cls = CLASS.NOT_CAPTURABLE;
    rationale = 'profitable at exactly one boundary and gone at the next, so capturing it requires same-block reaction, which the tested block-polling model cannot do.';
  } else {
    cls = CLASS.PROFITABLE_TIMING_UNKNOWN;
    rationale = 'profitable at the scanned boundary but the following boundary could not be quoted, so persistence is unmeasured.';
  }

  results.push({
    key: route.key, pair: route.pair,
    tokenIn: route.tokenIn, tokenInSymbol: tIn?.symbol ?? null,
    tokenMid: route.tokenMid, tokenMidSymbol: reg.token(route.tokenMid)?.symbol ?? null,
    venueA: route.venueA, venueB: route.venueB, poolA: route.poolA, poolB: route.poolB,
    feeA: route.feeA, feeB: route.feeB, dir: route.dir,
    sizeToken: route.evidence.bestSizeToken, notionalUsd: route.evidence.notionalUsd,
    grossUsdAtScan: route.evidence.grossUsd,
    costMedianUsd: route.evidence.costMedianUsd, costContestedUsd: route.evidence.costContestedUsd,
    netUsdMedianAtScan: route.evidence.netUsdMedian, netUsdContestedAtScan: route.evidence.netUsdContested,
    priceBasis: route.evidence.priceBasis,
    profitableAtPrevBoundary: atPrev?.profitable ?? null,
    profitableAtNextBoundary: atNext?.profitable ?? null,
    longestProfitableRunBlocks: bestRun,
    longestProfitableRunSeconds: bestRun * cfg.blockTimeSec,
    runStartBlock: bestStart,
    classification: cls, rationale,
    competition, series,
  });

  process.stdout.write(`\r  ${i}/${candidates.length} candidates re-quoted across ${horizon + 3} boundaries`.padEnd(90));
}
process.stdout.write('\n');

const byClass = {};
for (const r of results) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;

const out = {
  chain: chainId, chainName: cfg.name, baseBlock, horizon,
  scanFile: scanPath.split('/').pop(), measuredAt: new Date().toISOString(),
  latencyModel: LATENCY_MODEL,
  candidates: candidates.length,
  byClassification: byClass,
  captureCandidates: results.filter((r) => r.classification === CLASS.CAPTURE_CANDIDATE).length,
  notCapturable: results.filter((r) => r.classification === CLASS.NOT_CAPTURABLE).length,
  notReproducible: results.filter((r) => r.classification === CLASS.NO_SPREAD).length,
  results,
  rpc: { calls: rpc.stats.calls, errors: rpc.stats.errors },
};
writeFileSync(join(ROOT, 'data', `persistence-${chainId}-${baseBlock}.json`), `${JSON.stringify(out, null, 2)}\n`);

console.log('\n=== capture feasibility ===');
for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${String(v).padStart(5)}`);
console.log('');
for (const r of results.filter((x) => x.classification === CLASS.CAPTURE_CANDIDATE).slice(0, 20)) {
  console.log(`  ${(r.tokenInSymbol ?? '?').padEnd(9)}/${(r.tokenMidSymbol ?? '?').padEnd(9)} ${r.venueA.padEnd(15)} -> ${r.venueB.padEnd(15)} net $${(r.netUsdMedianAtScan ?? 0).toFixed(4).padStart(9)}  persisted ${String(r.longestProfitableRunBlocks).padStart(2)} blocks (${r.longestProfitableRunSeconds}s)  rival arbs ${r.competition.knownArbitragesOnPoolA + r.competition.knownArbitragesOnPoolB}`);
}
console.log(`\nwrote data/persistence-${chainId}-${baseBlock}.json`);
