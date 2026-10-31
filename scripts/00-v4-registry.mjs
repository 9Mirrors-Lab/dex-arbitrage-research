// Uniswap V4 keeps every pool inside one PoolManager, so a Swap log carries a
// poolId instead of a pool address. The only on-chain source for
// poolId -> (currency0, currency1, fee, tickSpacing, hooks) is the Initialize
// event. This builds that map so V4 swaps can be attributed instead of
// discarded, and so native-ETH pools (currency 0x0) can be recognised.
//
//   node scripts/00-v4-registry.mjs --chain base [--chunks 12]

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { Rpc, loadChain, toHex } from '../lib/rpc.mjs';
import { toEventSelector, decodeAbiParameters, parseAbiParameters } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const CHUNKS = Number(args.chunks ?? 12);
const SPAN = 50000; // provider cap for address-filtered getLogs
const rpc = new Rpc(cfg.rpc, { concurrency: 2, timeoutMs: 60000 });

const pm = cfg.dexes['uniswap-v4']?.poolManager;
if (!pm) { console.error(`no uniswap-v4 poolManager configured for ${cfg.id}`); process.exit(0); }

const TOPIC = toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const PATH = new URL(`../data/cache/v4-pools-${cfg.id}.json`, import.meta.url);

const existing = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : { pools: {}, scanned: [] };

const head = await rpc.blockNumber();
let added = 0;
for (let i = 0; i < CHUNKS; i++) {
  const to = head - i * SPAN;
  const from = to - SPAN + 1;
  if (existing.scanned.some(([a, b]) => from >= a && to <= b)) continue;
  let r;
  try {
    r = await rpc.call('eth_getLogs', [{ address: pm, fromBlock: toHex(from), toBlock: toHex(to), topics: [TOPIC] }], { allowError: true });
  } catch (e) {
    // Keep whatever we already have: a provider failure mid-scan should not
    // throw away the chunks that did come back.
    console.error(`  chunk ${from}-${to}: transport failure (${String(e.message).slice(0, 60)}) - stopping scan`);
    break;
  }
  if (r.error) { console.error(`  chunk ${from}-${to}: ${r.error.message?.slice(0, 80)}`); continue; }
  for (const log of r.result) {
    const id = log.topics[1];
    const currency0 = `0x${log.topics[2].slice(26)}`.toLowerCase();
    const currency1 = `0x${log.topics[3].slice(26)}`.toLowerCase();
    const [fee, tickSpacing, hooks] = decodeAbiParameters(
      parseAbiParameters('uint24,int24,address,uint160,int24'), log.data);
    if (!existing.pools[id]) added++;
    existing.pools[id] = {
      currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing),
      hooks: hooks.toLowerCase(), initBlock: Number(BigInt(log.blockNumber)),
      native: currency0 === '0x0000000000000000000000000000000000000000' || currency1 === '0x0000000000000000000000000000000000000000',
    };
  }
  existing.scanned.push([from, to]);
  console.error(`  chunk ${from}-${to}: ${r.result.length} Initialize events (total ${Object.keys(existing.pools).length})`);
}

existing.scanned.sort((a, b) => a[0] - b[0]);
existing.coverage = { head, oldestBlockScanned: existing.scanned[0]?.[0] ?? null, chunks: existing.scanned.length };
mkdirSync(new URL('../data/cache/', import.meta.url), { recursive: true });
writeFileSync(PATH, `${JSON.stringify(existing, null, 1)}\n`);
const nativeCount = Object.values(existing.pools).filter((p) => p.native).length;
console.error(`\n${Object.keys(existing.pools).length} V4 pools known (+${added} new), ${nativeCount} use native ETH`);
console.error(`coverage: blocks ${existing.coverage.oldestBlockScanned}..${head}`);
