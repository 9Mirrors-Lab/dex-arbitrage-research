// SAME-BLOCK FEASIBILITY — what the Flashblocks stream actually gives us.
//
// Stage 2 found that Base arbitrage is created and consumed inside one 2s
// block. A reaction is only possible if we can (a) see the triggering trade
// before the block seals and (b) still get a transaction into a later part of
// that same block.
//
// This connects to Base's Flashblocks stream and measures:
//   - how many Flashblocks a block is actually divided into
//   - the arrival interval and jitter, as we receive it
//   - which Flashblock index DEX-touching transactions land in
//   - the resulting REACTION ROOM: how many Flashblocks of the same block
//     remain after a given trade appears
//
// Read-only. Nothing is signed or sent.
//
// Note: wss://mainnet.flashblocks.base.org/ws is documented by Base as an
// infrastructure (node-sync) endpoint rather than an application API. It is
// reachable and parseable today; that is an observation, not a guarantee of
// support, and a production design should not assume it stays open.
//
//   node scripts/09-flashblock-observer.mjs [--seconds 90]

import { writeFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { parseTransaction } from 'viem';
import { loadChain } from '../lib/rpc.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const SECONDS = Number(args.seconds ?? 90);
const cfg = loadChain('base');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))] : null; };

// Addresses whose appearance as a transaction's `to` marks it as DEX-related.
// Factories and the V4 singleton, plus routers we know of. This under-counts
// (most swaps go through aggregators we have not enumerated), so treat the
// DEX-touch figures as a floor.
const dexAddrs = new Set();
for (const d of Object.values(cfg.dexes ?? {})) {
  for (const a of [d.factory, d.poolManager, d.vault, d.router, d.quoter]) if (a) dexAddrs.add(a.toLowerCase());
}

const blocks = new Map(); // block_number -> { flashblocks: [...] }
const arrivals = [];
let messages = 0; let decodeFailures = 0; let txParseFailures = 0;
const t0 = performance.now();

await new Promise((resolve) => {
  const ws = new WebSocket('wss://mainnet.flashblocks.base.org/ws');
  ws.binaryType = 'arraybuffer';
  const stop = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, SECONDS * 1000);

  ws.onopen = () => console.error(`connected; observing ${SECONDS}s`);
  ws.onmessage = (ev) => {
    const at = performance.now() - t0;
    let j;
    try { j = JSON.parse(brotliDecompressSync(Buffer.from(ev.data)).toString('utf8')); } catch { decodeFailures++; return; }
    messages++;
    arrivals.push(at);
    const bn = j.metadata?.block_number;
    if (bn == null) return;
    if (!blocks.has(bn)) blocks.set(bn, { block: bn, flashblocks: [] });

    const txs = j.diff?.transactions ?? [];
    let dexTouching = 0;
    const tos = [];
    for (const raw of txs) {
      try {
        const t = parseTransaction(raw);
        const to = t.to?.toLowerCase() ?? null;
        tos.push(to);
        if (to && dexAddrs.has(to)) dexTouching++;
      } catch { txParseFailures++; tos.push(null); }
    }
    blocks.get(bn).flashblocks.push({
      index: j.index, atMs: +at.toFixed(0), txCount: txs.length,
      dexTouching, gasUsed: j.diff?.gas_used ? Number(BigInt(j.diff.gas_used)) : null,
      distinctTo: new Set(tos.filter(Boolean)).size,
    });
  };
  ws.onerror = () => { clearTimeout(stop); resolve(); };
  ws.onclose = () => { clearTimeout(stop); resolve(); };
});

// ---- analysis ------------------------------------------------------------
// Keep only blocks we saw from index 0 to the end, so counts are not biased
// by blocks we joined or left mid-stream.
const all = [...blocks.values()].map((b) => ({ ...b, flashblocks: b.flashblocks.sort((x, y) => x.index - y.index) }));
const complete = all.filter((b) => b.flashblocks[0]?.index === 0).slice(0, -1);

const intervals = [];
for (let i = 1; i < arrivals.length; i++) intervals.push(arrivals[i] - arrivals[i - 1]);

const fbPerBlock = complete.map((b) => b.flashblocks.length);
const txPerFb = complete.flatMap((b) => b.flashblocks.map((f) => f.txCount));

// Reaction room: for each flashblock that carried a DEX-touching transaction,
// how many further flashblocks of the SAME block followed it?
const room = [];
for (const b of complete) {
  const last = b.flashblocks[b.flashblocks.length - 1].index;
  for (const f of b.flashblocks) {
    if (f.dexTouching > 0) room.push({ block: b.block, atIndex: f.index, remainingFlashblocks: last - f.index, remainingMs: (last - f.index) * 200 });
  }
}

// Where in the block does transaction volume sit? If most transactions land
// early, a late reaction has little company and may miss the block.
const txByIndex = {};
for (const b of complete) for (const f of b.flashblocks) {
  txByIndex[f.index] ??= [];
  txByIndex[f.index].push(f.txCount);
}

const out = {
  measuredAt: new Date().toISOString(),
  endpoint: 'wss://mainnet.flashblocks.base.org/ws',
  endpointCaveat: 'documented by Base as a node-infrastructure endpoint, not an application API; reachable and brotli-parseable at time of measurement',
  observationSeconds: SECONDS,
  feedContents: {
    carriesRawTransactions: true,
    carriesReceiptsOrLogs: false,
    consequence: 'a reaction cannot read Swap events from this feed. It must decode raw calldata and simulate the trade itself to know how a pool moved, which is strictly more work than the course\'s contract.on("Swap") design.',
  },
  volume: { messages, decodeFailures, rawTxParseFailures: txParseFailures, blocksTouched: all.length, completeBlocks: complete.length },
  arrivalIntervalMs: { p10: +pct(intervals, 10)?.toFixed(0), p50: +pct(intervals, 50)?.toFixed(0), p90: +pct(intervals, 90)?.toFixed(0), max: +Math.max(...intervals).toFixed(0) },
  flashblocksPerBlock: { min: Math.min(...fbPerBlock), p50: pct(fbPerBlock, 50), max: Math.max(...fbPerBlock) },
  txPerFlashblock: { p50: pct(txPerFb, 50), p90: pct(txPerFb, 90), max: Math.max(...txPerFb) },
  txCountByFlashblockIndex: Object.fromEntries(Object.entries(txByIndex).map(([i, v]) => [i, { medianTxs: pct(v, 50), blocks: v.length }])),
  dexTouchingReactionRoom: room.length ? {
    observations: room.length,
    remainingFlashblocksAfterADexTx: { p10: pct(room.map((r) => r.remainingFlashblocks), 10), p50: pct(room.map((r) => r.remainingFlashblocks), 50), p90: pct(room.map((r) => r.remainingFlashblocks), 90) },
    remainingMsAfterADexTx: { p10: pct(room.map((r) => r.remainingMs), 10), p50: pct(room.map((r) => r.remainingMs), 50), p90: pct(room.map((r) => r.remainingMs), 90) },
    note: 'counts only transactions sent directly to a configured factory/router/singleton, so it is a floor on real DEX activity',
  } : { observations: 0, note: 'no transactions addressed a configured DEX address during the window; most swaps route through aggregators not enumerated here' },
  sampleBlocks: complete.slice(0, 4),
};

const path = new URL('../data/flashblocks-base.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ ...out, sampleBlocks: `${complete.length} complete blocks recorded` }, null, 2));
console.error(`\nwrote ${path.pathname}`);
