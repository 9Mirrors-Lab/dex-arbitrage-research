// SAME-BLOCK FEASIBILITY — measure what we can actually see and how fast.
//
// The Stage 2 result was that Base arbitrage is created and consumed inside a
// single 2-second block. That makes three things measurable, and they decide
// whether the strategy is reachable at all:
//
//   1. ACCESS    - can we read pre-confirmed (Flashblock) state at all from
//                  the endpoints available to us, and does it really advance
//                  faster than the 2s block?
//   2. LATENCY   - what is the round-trip floor from this machine to Base?
//                  No reaction can be faster than one round trip.
//   3. HEADROOM  - how much of a 2s block is left after one round trip, in
//                  200ms Flashblock units?
//
// Everything here is read-only. No transaction is built, signed or sent.
//
//   node scripts/08-latency-probe.mjs [--samples 40]

import { writeFileSync } from 'node:fs';
import { loadChain } from '../lib/rpc.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain('base');
const SAMPLES = Number(args.samples ?? 40);
const FLASHBLOCK_MS = 200;
const BLOCK_MS = 2000;

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]; };

async function rpc(url, method, params = []) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json();
    return { ms: performance.now() - t0, ok: !body.error, result: body.result, error: body.error?.message };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, error: String(e.message).slice(0, 80) };
  }
}

const out = { measuredAt: new Date().toISOString(), host: 'local workstation', flashblockIntervalMs: FLASHBLOCK_MS, blockMs: BLOCK_MS, endpoints: {}, pendingTag: {}, flashblocksWs: null };

// ---- 1 + 2: latency floor and whether `pending` is served ---------------
for (const url of cfg.rpc) {
  const name = url.replace('https://', '');
  const lat = [];
  let okCount = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const r = await rpc(url, 'eth_blockNumber');
    if (r.ok) { lat.push(r.ms); okCount++; }
    await new Promise((s) => setTimeout(s, 50));
  }
  out.endpoints[name] = lat.length ? {
    samples: SAMPLES, succeeded: okCount,
    rttMs: { min: +Math.min(...lat).toFixed(1), p50: +pct(lat, 50).toFixed(1), p90: +pct(lat, 90).toFixed(1), max: +Math.max(...lat).toFixed(1) },
  } : { samples: SAMPLES, succeeded: 0, note: 'no successful samples' };

  // Does this endpoint serve pre-confirmed state under the `pending` tag,
  // and does `pending` actually differ from `latest`?
  const p = await rpc(url, 'eth_getBlockByNumber', ['pending', false]);
  const l = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
  out.pendingTag[name] = {
    pendingServed: p.ok && p.result != null,
    pendingBlock: p.result?.number ? Number(BigInt(p.result.number)) : null,
    latestBlock: l.result?.number ? Number(BigInt(l.result.number)) : null,
    pendingTxCount: Array.isArray(p.result?.transactions) ? p.result.transactions.length : null,
    pendingAheadOfLatest: p.result?.number && l.result?.number
      ? Number(BigInt(p.result.number)) - Number(BigInt(l.result.number)) : null,
    error: p.error ?? null,
  };
}

// ---- does `pending` advance faster than 2s? ------------------------------
// If pre-confirmations are reaching us, the pending block's transaction count
// should grow several times within one 2-second block.
const probeUrl = cfg.rpc[0];
const series = [];
const tStart = performance.now();
while (performance.now() - tStart < 6000) {
  const r = await rpc(probeUrl, 'eth_getBlockByNumber', ['pending', false]);
  series.push({
    atMs: +(performance.now() - tStart).toFixed(0),
    block: r.result?.number ? Number(BigInt(r.result.number)) : null,
    txs: Array.isArray(r.result?.transactions) ? r.result.transactions.length : null,
  });
  await new Promise((s) => setTimeout(s, 150));
}
const distinctStates = new Set(series.filter((s) => s.block != null).map((s) => `${s.block}:${s.txs}`));
out.pendingAdvance = {
  probeUrl: probeUrl.replace('https://', ''),
  windowMs: 6000,
  polls: series.length,
  distinctPendingStates: distinctStates.size,
  blocksSeen: new Set(series.map((s) => s.block).filter(Boolean)).size,
  interpretation: distinctStates.size > series.length * 0.3
    ? 'pending advances within blocks: sub-block (Flashblock) granularity is reaching us'
    : 'pending barely changes between polls: we are seeing block-level state only, not sub-block pre-confirmations',
  series: series.slice(0, 40),
};

// ---- 3: the documented raw Flashblocks stream ---------------------------
// Base's docs state this endpoint is for node infrastructure, not apps. Test
// whether it is reachable from here at all, since that determines whether
// sub-block data requires a paid provider.
out.flashblocksWs = await new Promise((resolve) => {
  const url = 'wss://mainnet.flashblocks.base.org/ws';
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; resolve({ url, ...v }); } };
  try {
    const ws = new WebSocket(url);
    const t0 = performance.now();
    const msgs = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} done({ reachable: msgs.length > 1, messages: msgs.length, note: 'closed after 8s observation window', sample: msgs.slice(0, 4), firstMessageMs: msgs.length > 1 ? msgs[1].atMs : null }); }, 8000);
    ws.onopen = () => { msgs.push({ atMs: +(performance.now() - t0).toFixed(0), event: 'open' }); };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '[binary]';
      let parsed = null;
      try { const j = JSON.parse(raw); parsed = { index: j.index, payload_id: j.payload_id, hasBase: Boolean(j.base), diffTxs: j.diff?.transactions?.length ?? null }; } catch { /* not json */ }
      msgs.push({ atMs: +(performance.now() - t0).toFixed(0), bytes: raw.length, parsed });
      if (msgs.length >= 12) { clearTimeout(timer); try { ws.close(); } catch {} done({ reachable: true, messages: msgs.length, firstMessageMs: msgs[1]?.atMs ?? null, sample: msgs.slice(0, 6) }); }
    };
    ws.onerror = () => { clearTimeout(timer); done({ reachable: false, messages: msgs.length, note: 'websocket error - endpoint refused or requires auth' }); };
    ws.onclose = (ev) => { clearTimeout(timer); done({ reachable: msgs.length > 1, messages: msgs.length, closeCode: ev.code, note: msgs.length > 1 ? 'received data then closed' : 'closed without data' }); };
  } catch (e) {
    done({ reachable: false, note: String(e.message).slice(0, 100) });
  }
});

// ---- headroom arithmetic ------------------------------------------------
const best = Object.values(out.endpoints).filter((e) => e.rttMs).sort((a, b) => a.rttMs.p50 - b.rttMs.p50)[0];
if (best) {
  const rtt = best.rttMs.p50;
  // A reaction needs at minimum: see the trigger (1 leg) + submit (1 leg).
  // One full round trip is the floor for a read, plus one send.
  const minReactionMs = rtt * 1.5;
  out.headroom = {
    bestEndpointP50RttMs: rtt,
    minimumReactionMs: +minReactionMs.toFixed(0),
    assumption: 'floor = one round trip to observe the trigger plus half a round trip to push the response; it ignores all local compute, quoting and signing',
    flashblocksPerBlock: BLOCK_MS / FLASHBLOCK_MS,
    flashblocksConsumedByOneReaction: +(minReactionMs / FLASHBLOCK_MS).toFixed(2),
    flashblocksRemainingInBlock: +((BLOCK_MS - minReactionMs) / FLASHBLOCK_MS).toFixed(2),
    fitsInsideOneBlock: minReactionMs < BLOCK_MS,
  };
}

const path = new URL('../data/latency-base.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.error(`\nwrote ${path.pathname}`);
