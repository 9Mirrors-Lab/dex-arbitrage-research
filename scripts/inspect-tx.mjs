// Audit one transaction by hand: full decoded swap + transfer + native-value
// ledger. Used to check the forensics detector against reality.
//
//   node scripts/inspect-tx.mjs --chain base --tx 0x...

import { Rpc, loadChain } from '../lib/rpc.mjs';
import { decodeSwap, decodeTransfer } from '../lib/events.mjs';
import { MetaStore, makeVenueResolver } from '../lib/pools.mjs';
import { toEventSelector, decodeAbiParameters, parseAbiParameters } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const rpc = new Rpc(cfg.rpc, { concurrency: 3 });
const meta = new MetaStore(rpc, cfg.id);
const resolveVenue = makeVenueResolver(cfg);

const DEPOSIT = toEventSelector('Deposit(address,uint256)');
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)');
const lc = (s) => (s ?? '').toLowerCase();

const r = await rpc.get('eth_getTransactionReceipt', [args.tx]);
const tx = await rpc.get('eth_getTransactionByHash', [args.tx]);
const weth = cfg.tokens.WETH.address.toLowerCase();

const swaps = r.logs.map(decodeSwap).filter(Boolean);
const transfers = r.logs.map(decodeTransfer).filter(Boolean);
await meta.resolvePools(swaps.map((s) => s.pool));
await meta.resolveTokens([...new Set([...transfers.map((t) => t.token),
  ...swaps.flatMap((s) => { const p = meta.pool(s.pool); return [p?.token0, p?.token1]; })].filter(Boolean))]);

const sym = (a) => meta.token(a).symbol ?? a?.slice(0, 10) ?? '?';
const dec = (a) => meta.token(a).decimals ?? 18;
const h = (a, v) => Number(v) / 10 ** dec(a);

console.log(`tx    ${args.tx}`);
console.log(`block ${Number(BigInt(r.blockNumber))}  status ${r.status}  logs ${r.logs.length}`);
console.log(`from  ${lc(r.from)}`);
console.log(`to    ${lc(r.to)}`);
console.log(`value ${Number(BigInt(tx.value)) / 1e18} ETH   gasUsed ${Number(BigInt(r.gasUsed))}`);
console.log(`cost  L2 ${Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) / 1e18} ETH + L1 ${Number(BigInt(r.l1Fee ?? 0)) / 1e18} ETH`);

console.log(`\nSWAPS (${swaps.length}):`);
for (const s of swaps) {
  const p = meta.pool(s.pool);
  const venue = resolveVenue(p, s.family);
  if (s.family === 'balancer-v2') {
    console.log(`  ${venue.padEnd(22)} ${sym(s.tokenIn)} -> ${sym(s.tokenOut)}  in ${h(s.tokenIn, s.amountIn)} out ${h(s.tokenOut, s.amountOut)}`);
    continue;
  }
  if (!p?.token0) { console.log(`  ${venue.padEnd(22)} pool ${s.pool} UNRESOLVED (${s.event}) a0=${s.amount0} a1=${s.amount1} poolId=${s.poolId ?? '-'}`); continue; }
  const inIs0 = s.amount0 > 0n;
  const tIn = inIs0 ? p.token0 : p.token1, tOut = inIs0 ? p.token1 : p.token0;
  const aIn = inIs0 ? s.amount0 : s.amount1, aOut = inIs0 ? -s.amount1 : -s.amount0;
  console.log(`  ${venue.padEnd(22)} fee=${String(p.fee ?? p.stable ?? '-').padEnd(6)} ${sym(tIn)} -> ${sym(tOut)}  in ${h(tIn, aIn)} out ${h(tOut, aOut)}  pool ${s.pool} factory ${p.factory}`);
}

console.log(`\nNATIVE/WETH WRAP EVENTS:`);
for (const log of r.logs) {
  if (lc(log.address) !== weth) continue;
  if (log.topics[0] === DEPOSIT) {
    const [v] = decodeAbiParameters(parseAbiParameters('uint256'), log.data);
    console.log(`  Deposit  ${`0x${log.topics[1].slice(26)}`} +${Number(v) / 1e18} WETH (paid native ETH)`);
  }
  if (log.topics[0] === WITHDRAWAL) {
    const [v] = decodeAbiParameters(parseAbiParameters('uint256'), log.data);
    console.log(`  Withdraw ${`0x${log.topics[1].slice(26)}`} -${Number(v) / 1e18} WETH (received native ETH)`);
  }
}

const byAddr = new Map();
for (const t of transfers) {
  for (const [a, d] of [[t.from, -t.value], [t.to, t.value]]) {
    if (!byAddr.has(a)) byAddr.set(a, new Map());
    byAddr.get(a).set(t.token, (byAddr.get(a).get(t.token) ?? 0n) + d);
  }
}
const poolSet = new Set(swaps.map((s) => s.pool));
console.log(`\nNET ERC-20 DELTAS (${transfers.length} transfers):`);
for (const [addr, m] of byAddr) {
  const nz = [...m].filter(([, v]) => v !== 0n);
  if (!nz.length) continue;
  const role = poolSet.has(addr) ? 'POOL' : addr === lc(r.from) ? 'EOA' : addr === lc(r.to) ? 'TO' : '';
  console.log(`  ${addr} ${role.padEnd(5)} ${nz.map(([t, v]) => `${v > 0n ? '+' : ''}${h(t, v)} ${sym(t)}`).join('  ')}`);
}
meta.flush();
