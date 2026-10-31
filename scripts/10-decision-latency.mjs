// SAME-BLOCK FEASIBILITY — decision latency.
//
// Reaction room is only half the question. The other half is how long it takes
// to decide there is an arbitrage once a trigger is seen. Stage 2's validation
// pass took tens of seconds per candidate, which is 10-20x a whole Base block,
// so this measures where that time goes and what a production design could
// actually achieve.
//
// Three regimes, because they differ by orders of magnitude:
//   COLD  - nothing cached: every pool read is a network round trip. This is
//           what the Stage 2 validator did.
//   WARM  - tick/bitmap data already in memory, only the live price refreshed:
//           one round trip.
//   LOCAL - everything in memory, pure arithmetic: what a bot holding pool
//           state from the Flashblocks stream would do. No network at all.
//
// Read-only. Nothing is signed or sent.
//
//   node scripts/10-decision-latency.mjs [--pairs 4]

import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { MetaStore } from '../lib/pools.mjs';
import { V3PoolState, quoteExactInputV3 } from '../lib/v3math.mjs';
import { optimalSize } from '../lib/quote.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain('base');
const rpc = new Rpc(cfg.rpc, { concurrency: 4 });
const meta = new MetaStore(rpc, 'base', cfg);
const PAIRS = Number(args.pairs ?? 4);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))] : null; };

// Take real two-pool V3 cycles out of the forensics data.
const files = readdirSync('data').filter((f) => f.startsWith('forensics-base-'));
const cands = [];
for (const f of files) {
  for (const a of JSON.parse(readFileSync(`data/${f}`, 'utf8')).arbs) {
    if (a.swapCount !== 2) continue;
    if (!a.venueDetail.every((v) => v.family === 'uniswap-v3' || v.family === 'pancake-v3')) continue;
    cands.push(a);
  }
}
const chosen = cands.slice(0, PAIRS);
console.error(`benchmarking ${chosen.length} real two-pool V3 cycles`);

const block = await rpc.blockNumber();
const rows = [];

for (const a of chosen) {
  const [p0, p1] = a.venueDetail;
  await meta.resolvePools([p0.pool, p1.pool]);
  const m0 = meta.pool(p0.pool); const m1 = meta.pool(p1.pool);
  if (!m0?.token0 || !m1?.token0) continue;
  const shared = [m0.token0, m0.token1].filter((t) => [m1.token0, m1.token1].includes(t));
  if (shared.length !== 2) continue;
  const [X, Y] = shared;
  await meta.resolveTokens([X, Y]);
  const dX = meta.token(X).decimals ?? 18;
  const size = BigInt(Math.round(0.05 * 10 ** dX)) || 1n;

  // --- COLD: brand-new state objects, every read over the network ---------
  const tCold0 = performance.now();
  const c0 = new V3PoolState(rpc, p0.pool, block);
  const c1 = new V3PoolState(rpc, p1.pool, block);
  let coldOk = true;
  try {
    const l1 = await quoteExactInputV3(c0, { tokenIn: X, amountIn: size });
    if (l1.amountOut > 0n) await quoteExactInputV3(c1, { tokenIn: Y, amountIn: l1.amountOut });
  } catch { coldOk = false; }
  const coldMs = performance.now() - tCold0;
  const coldReads = c0.rpcReads + c1.rpcReads;

  if (!coldOk) continue;

  // --- WARM: reuse the loaded state, one price refresh ---------------------
  // Simulated by re-running on the same already-populated state objects: the
  // tick maps are in memory, so only cached reads are hit.
  const warm = [];
  for (let i = 0; i < 12; i++) {
    const s = size + BigInt(i) * (size / 20n || 1n);
    const t = performance.now();
    const l1 = await quoteExactInputV3(c0, { tokenIn: X, amountIn: s });
    if (l1.amountOut > 0n) await quoteExactInputV3(c1, { tokenIn: Y, amountIn: l1.amountOut });
    warm.push(performance.now() - t);
  }
  const readsAfterWarm = c0.rpcReads + c1.rpcReads;

  // --- LOCAL: a full optimal-size search with no new network reads ---------
  const tOpt0 = performance.now();
  const readsBeforeOpt = c0.rpcReads + c1.rpcReads;
  const opt = await optimalSize({
    lo: 1n, hi: size * 64n, iterations: 20,
    quoteCycle: async (x) => {
      const l1 = await quoteExactInputV3(c0, { tokenIn: X, amountIn: x });
      if (l1.amountOut == null || l1.amountOut <= 0n) return null;
      const l2 = await quoteExactInputV3(c1, { tokenIn: Y, amountIn: l1.amountOut });
      if (l2.amountOut == null) return null;
      return { profit: l2.amountOut - x };
    },
  });
  const optMs = performance.now() - tOpt0;
  const optReads = (c0.rpcReads + c1.rpcReads) - readsBeforeOpt;

  rows.push({
    cycle: `${meta.token(X).symbol ?? X.slice(0, 8)}/${meta.token(Y).symbol ?? Y.slice(0, 8)}`,
    pools: [p0.pool, p1.pool],
    coldMs: +coldMs.toFixed(1), coldRpcReads: coldReads,
    warmMsP50: +pct(warm, 50).toFixed(2), warmMsP90: +pct(warm, 90).toFixed(2),
    rpcReadsDuringWarm: readsAfterWarm - coldReads,
    optimalSearchMs: +optMs.toFixed(1), optimalSearchProbes: opt.probes, rpcReadsDuringSearch: optReads,
  });
  console.error(`  ${rows[rows.length - 1].cycle.padEnd(16)} cold ${rows[rows.length - 1].coldMs}ms (${coldReads} reads) | warm p50 ${rows[rows.length - 1].warmMsP50}ms | search ${rows[rows.length - 1].optimalSearchMs}ms (${optReads} new reads)`);
}

const colds = rows.map((r) => r.coldMs);
const warms = rows.map((r) => r.warmMsP50);
const searches = rows.map((r) => r.optimalSearchMs);

const out = {
  measuredAt: new Date().toISOString(),
  atBlock: block,
  method: 'real two-pool V3 cycles taken from the forensics data, priced with the same code the Stage 2 gate used',
  regimes: {
    cold: {
      description: 'no cached pool state; every tick bitmap and tick read is a network round trip. This is what the Stage 2 validator did per candidate.',
      msP50: pct(colds, 50), msMax: Math.max(...colds),
      rpcReadsP50: pct(rows.map((r) => r.coldRpcReads), 50),
      verdict: pct(colds, 50) > 2000 ? 'exceeds a whole 2s Base block: unusable for same-block reaction' : 'within a block, but with no margin',
    },
    warm: {
      description: 'tick maps already in memory; a single cycle re-quote at a new size',
      msP50: pct(warms, 50), msP90: pct(warms.map((v) => v), 90),
      verdict: 'this is the operation a bot repeats; it is pure arithmetic once state is held',
    },
    localOptimalSearch: {
      description: 'full optimal-size search (20 ternary iterations, both legs each probe) with state in memory',
      msP50: pct(searches, 50), msMax: Math.max(...searches),
      newRpcReadsP50: pct(rows.map((r) => r.rpcReadsDuringSearch), 50),
    },
  },
  perCycle: rows,
};

// The decisive arithmetic, combined with the measured reaction room.
const fb = (() => { try { return JSON.parse(readFileSync('data/flashblocks-base.json', 'utf8')); } catch { return null; } })();
const lat = (() => { try { return JSON.parse(readFileSync('data/latency-base.json', 'utf8')); } catch { return null; } })();
if (fb && lat) {
  const roomMs = fb.dexTouchingReactionRoom?.remainingMsAfterADexTx?.p50 ?? null;
  const rtt = lat.headroom?.bestEndpointP50RttMs ?? null;
  const decide = pct(searches, 50);
  const budget = [
    { step: 'trigger appears in a Flashblock and reaches us', ms: fb.arrivalIntervalMs?.p50 ?? null, source: 'measured feed arrival interval p50' },
    { step: 'decide: optimal-size search with state in memory', ms: decide, source: 'measured here' },
    { step: 'sign and submit (one network leg)', ms: rtt != null ? +(rtt / 2).toFixed(0) : null, source: 'half of measured p50 RTT' },
  ];
  const total = budget.reduce((a, b) => a + (b.ms ?? 0), 0);
  out.endToEndBudget = {
    steps: budget,
    totalMs: +total.toFixed(0),
    measuredReactionRoomMsP50: roomMs,
    fitsMedianReactionRoom: roomMs != null ? total < roomMs : null,
    excludes: 'local pool-state bookkeeping, mempool competition, the sequencer actually placing our transaction in a later Flashblock of the same block, and any retry',
    status: 'arithmetic from measured components, NOT an end-to-end demonstration: no transaction was built, signed or sent at any point',
  };
}

const path = new URL('../data/decision-latency-base.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.error(`\nwrote ${path.pathname}`);
