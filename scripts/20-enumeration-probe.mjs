// Phase B prerequisite: measure HOW each configured factory can be enumerated.
//
// Market-wide pool discovery needs a complete list of pools per factory. There
// are only two ways to get one from a public endpoint:
//
//   A. the factory keeps an on-chain array  -> allPoolsLength()/allPools(i) or
//      allPairsLength()/allPairs(i). One call per pool, no block-range limit,
//      no risk of silent truncation.
//   B. creation events                      -> PoolCreated / PairCreated logs
//      filtered by factory address. Needs the provider to serve a wide block
//      range; the free endpoints cap this, and a provider that truncates
//      instead of erroring would make discovery quietly incomplete.
//
// This script measures both per factory, plus the real address-filtered
// getLogs range cap per provider, because discovery cost and feasibility
// follow from those numbers rather than from documentation.

import { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256, toHex as viemToHex } from 'viem';
import { writeFileSync } from 'node:fs';
import { Rpc, loadChain, toHex } from '../lib/rpc.mjs';

const args = process.argv.slice(2);
const argOf = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const chainId = argOf('chain', 'base');

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 4 });

const ENUM_ABI = parseAbi([
  'function allPoolsLength() view returns (uint256)',
  'function allPairsLength() view returns (uint256)',
  'function allPools(uint256) view returns (address)',
  'function allPairs(uint256) view returns (address)',
]);

// Creation-event signatures per family.
const CREATION_EVENTS = {
  'uniswap-v3': 'PoolCreated(address,address,uint24,int24,address)',
  'pancake-v3': 'PoolCreated(address,address,uint24,int24,address)',
  'uniswap-v2': 'PairCreated(address,address,address,uint256)',
  'solidly-v2': 'PoolCreated(address,address,bool,address,uint256)',
};
// Aerodrome Slipstream's event carries tickSpacing where Uniswap carries fee.
const SLIPSTREAM_EVENT = 'PoolCreated(address,address,int24,address)';

const topic0 = (sig) => keccak256(viemToHex(sig));

async function tryRead(addr, fn, args_ = []) {
  const r = await rpc.ethCall(addr, encodeFunctionData({ abi: ENUM_ABI, functionName: fn, args: args_ }));
  if (r.error || !r.result || r.result === '0x') return null;
  try { return decodeFunctionResult({ abi: ENUM_ABI, functionName: fn, data: r.result }); } catch { return null; }
}

async function probeLogRange(url, address, topics, fromBlock, range) {
  const t0 = Date.now();
  try {
    const r = await rpc.call('eth_getLogs', [{
      address, topics, fromBlock: toHex(fromBlock), toBlock: toHex(fromBlock + range - 1),
    }], { preferUrl: url, allowError: true });
    if (r.error) return { range, ok: false, error: String(r.error.message).slice(0, 140), ms: Date.now() - t0 };
    return { range, ok: true, logs: r.result.length, ms: Date.now() - t0 };
  } catch (e) {
    return { range, ok: false, error: String(e.message).slice(0, 140), ms: Date.now() - t0 };
  }
}

const main = async () => {
  const head = await rpc.blockNumber();
  console.log(`${cfg.name} head block ${head}\n`);

  const out = { chain: chainId, head, measuredAt: new Date().toISOString(), factories: {}, logRange: {} };

  // ---- 1. enumerable arrays -------------------------------------------------
  for (const [key, d] of Object.entries(cfg.dexes)) {
    const addr = d.factory ?? d.poolManager ?? d.vault;
    if (!addr) { out.factories[key] = { address: null, family: d.family, enumerable: false, note: 'no factory address in config' }; continue; }

    const [poolsLen, pairsLen] = await Promise.all([
      tryRead(addr, 'allPoolsLength'), tryRead(addr, 'allPairsLength'),
    ]);
    const method = poolsLen != null ? 'allPools' : pairsLen != null ? 'allPairs' : null;
    const count = poolsLen ?? pairsLen ?? null;

    let sample = null;
    if (method) {
      const s = await tryRead(addr, method, [0n]);
      sample = s ? String(s).toLowerCase() : null;
    }

    // Which creation event does this factory actually emit? A 2k-block window
    // near head is only conclusive when it returns a hit; zero means "still
    // unknown", not "wrong topic", because the factory may be dormant.
    const sigs = d.family === 'uniswap-v3'
      ? [CREATION_EVENTS['uniswap-v3'], SLIPSTREAM_EVENT]
      : [CREATION_EVENTS[d.family]].filter(Boolean);
    const eventProbe = [];
    for (const sig of sigs) {
      const r = await probeLogRange(cfg.rpc[0], addr, [topic0(sig)], head - 50000, 2000);
      eventProbe.push({ sig, topic0: topic0(sig), ...r });
    }

    out.factories[key] = {
      address: addr.toLowerCase(), family: d.family, label: d.label,
      enumerable: method != null && count != null,
      enumMethod: method, poolCount: count != null ? Number(count) : null,
      firstPoolSample: sample, eventProbe,
    };
    const c = out.factories[key];
    console.log(`  ${key.padEnd(20)} ${c.enumerable ? `${c.enumMethod}() = ${c.poolCount} pools` : 'no on-chain array -> needs creation logs'}`);
  }

  // ---- 2. address-filtered getLogs range cap, per provider ------------------
  console.log('');
  const uni = cfg.dexes['uniswap-v3'];
  const t = [topic0(CREATION_EVENTS['uniswap-v3'])];
  for (const url of cfg.rpc) {
    const results = [];
    let best = 0;
    for (const range of [1000, 10000, 100000, 500000, 1000000, 5000000, 60000000]) {
      const r = await probeLogRange(url, uni.factory, t, Math.max(0, head - range), Math.min(range, head));
      results.push(r);
      if (r.ok) best = range; else break;
    }
    out.logRange[url] = { maxFilteredRange: best, probes: results };
    console.log(`  ${url.padEnd(42)} filtered getLogs ok up to ~${best} blocks`);
  }

  writeFileSync(new URL(`../data/enumeration-${chainId}.json`, import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote data/enumeration-${chainId}.json   rpc calls ${rpc.stats.calls}, errors ${rpc.stats.errors}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
