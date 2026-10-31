// STEP 1 — Select the blockchain.
// Measures a chain's arbitrage-relevant properties directly from its own RPC:
// block cadence, throughput, fee components, DEX swap activity by venue family,
// which configured contracts actually exist, and live flash-loan fees.
//
//   node scripts/01-chain-profile.mjs --chain base [--samples 3] [--blocks 25]

import { writeFileSync } from 'node:fs';
import { Rpc, loadChain, toHex } from '../lib/rpc.mjs';
import { SWAP_EVENTS, SWAP_TOPICS, decodeSwap } from '../lib/events.mjs';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const chainId = args.chain ?? 'base';
const SAMPLES = Number(args.samples ?? 3);
const WINDOW = Number(args.blocks ?? 25);

const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 3 });

const ABI = parseAbi([
  'function getFee(address pool, bool stable) view returns (uint24)',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function getProtocolFeesCollector() view returns (address)',
  'function getFlashLoanFeePercentage() view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function hasCode(addr) {
  if (!addr) return null;
  const code = await rpc.get('eth_getCode', [addr, 'latest']);
  return { address: addr, exists: code != null && code !== '0x', bytes: code ? (code.length - 2) / 2 : 0 };
}

async function main() {
  const head = await rpc.blockNumber();
  const out = {
    chain: cfg.id, chainId: cfg.chainId, name: cfg.name, kind: cfg.kind,
    measuredAt: new Date().toISOString(), headBlock: head,
    method: `${SAMPLES} windows of ${WINDOW} blocks, spread over the last ~24h of chain history`,
  };

  // ---- cadence + throughput + fees, from real blocks ---------------------
  const dayBlocks = Math.round(86400 / cfg.blockTimeSec);
  const windowStarts = Array.from({ length: SAMPLES }, (_, i) =>
    head - Math.round((i * dayBlocks) / Math.max(1, SAMPLES)) - WINDOW - 2);

  const blockRows = [];
  for (const start of windowStarts) {
    const nums = Array.from({ length: WINDOW }, (_, k) => start + k);
    const res = await rpc.batch(nums.map((n) => ({ method: 'eth_getBlockByNumber', params: [toHex(n), false] })));
    for (const r of res) {
      const b = r.result;
      if (!b) continue;
      blockRows.push({
        number: Number(BigInt(b.number)),
        ts: Number(BigInt(b.timestamp)),
        txs: b.transactions.length,
        gasUsed: BigInt(b.gasUsed),
        gasLimit: BigInt(b.gasLimit),
        baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n,
      });
    }
  }
  blockRows.sort((a, b) => a.number - b.number);

  const deltas = [];
  for (let i = 1; i < blockRows.length; i++) {
    const d = blockRows[i].ts - blockRows[i - 1].ts;
    if (blockRows[i].number === blockRows[i - 1].number + 1 && d >= 0 && d < 600) deltas.push(d);
  }
  out.cadence = {
    blocksSampled: blockRows.length,
    configuredBlockTimeSec: cfg.blockTimeSec,
    measuredMeanBlockTimeSec: deltas.length ? +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(3) : null,
  };
  out.throughput = {
    meanTxPerBlock: +(blockRows.reduce((a, b) => a + b.txs, 0) / blockRows.length).toFixed(1),
    medianTxPerBlock: pct(blockRows.map((b) => b.txs), 50),
    meanGasUsedPerBlock: Number(blockRows.reduce((a, b) => a + b.gasUsed, 0n) / BigInt(blockRows.length)),
    meanGasLimit: Number(blockRows.reduce((a, b) => a + b.gasLimit, 0n) / BigInt(blockRows.length)),
    estTxPerDay: Math.round((blockRows.reduce((a, b) => a + b.txs, 0) / blockRows.length) * dayBlocks),
  };
  const baseFees = blockRows.map((b) => b.baseFee).filter((v) => v > 0n);
  out.fees = {
    baseFeeWei: {
      p50: pct(baseFees, 50)?.toString() ?? null,
      p95: pct(baseFees, 95)?.toString() ?? null,
    },
    baseFeeGwei: {
      p50: baseFees.length ? Number(pct(baseFees, 50)) / 1e9 : null,
      p95: baseFees.length ? Number(pct(baseFees, 95)) / 1e9 : null,
    },
  };

  // ---- real per-tx cost, including the OP-stack L1 data fee --------------
  if (cfg.rpcCapabilities?.getBlockReceipts !== false) {
    try {
      const probe = windowStarts[0] + 1;
      const receipts = await rpc.getBlockReceipts(probe);
      const user = receipts.filter((r) => BigInt(r.gasUsed) > 21000n);
      const l1Fees = user.map((r) => BigInt(r.l1Fee ?? 0));
      const l2Fees = user.map((r) => BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0));
      out.txCost = {
        probeBlock: probe,
        receiptsSampled: user.length,
        hasL1FeeField: receipts.some((r) => r.l1Fee != null),
        medianL2FeeWei: pct(l2Fees, 50)?.toString() ?? null,
        medianL1FeeWei: pct(l1Fees, 50)?.toString() ?? null,
        medianTotalFeeEth: l2Fees.length
          ? Number(pct(l2Fees, 50) + (pct(l1Fees, 50) ?? 0n)) / 1e18 : null,
        medianGasUsed: Number(pct(user.map((r) => BigInt(r.gasUsed)), 50) ?? 0n),
      };
    } catch (e) { out.txCost = { error: String(e.message).slice(0, 160) }; }
  }

  // ---- DEX activity by venue family -------------------------------------
  // Unfiltered getLogs per topic0 over a short window; counts swaps and the
  // distinct pools that produced them.
  const swapWindow = Math.min(WINDOW, Number(cfg.rpcCapabilities?.unfilteredGetLogsMaxRange ?? WINDOW));
  const activity = {};
  let logsOk = true;
  for (const topic of SWAP_TOPICS) {
    const spec = SWAP_EVENTS[topic];
    let swaps = 0; const pools = new Set(); let blocksCovered = 0;
    for (const start of windowStarts) {
      const from = start, to = start + swapWindow - 1;
      const r = await rpc.call('eth_getLogs', [{ fromBlock: toHex(from), toBlock: toHex(to), topics: [topic] }], { allowError: true });
      if (r.error) { logsOk = false; continue; }
      blocksCovered += swapWindow;
      for (const log of r.result) { swaps++; pools.add(log.address.toLowerCase()); }
    }
    if (blocksCovered === 0) continue;
    activity[spec.family] ??= { swaps: 0, pools: new Set(), blocksCovered: 0, events: [] };
    activity[spec.family].swaps += swaps;
    for (const p of pools) activity[spec.family].pools.add(p);
    activity[spec.family].blocksCovered = Math.max(activity[spec.family].blocksCovered, blocksCovered);
    activity[spec.family].events.push(spec.name);
  }
  out.dexActivity = {
    unfilteredLogsSupported: logsOk,
    windowBlocksPerSample: swapWindow,
    byFamily: Object.fromEntries(Object.entries(activity).map(([fam, v]) => [fam, {
      events: v.events,
      swapsObserved: v.swaps,
      distinctPools: v.pools.size,
      blocksCovered: v.blocksCovered,
      swapsPerBlock: +(v.swaps / v.blocksCovered).toFixed(2),
      estSwapsPerDay: Math.round((v.swaps / v.blocksCovered) * dayBlocks),
    }])),
  };
  out.dexActivity.totalSwapsPerBlock = +Object.values(out.dexActivity.byFamily)
    .reduce((a, v) => a + v.swapsPerBlock, 0).toFixed(2);
  out.dexActivity.totalEstSwapsPerDay = Object.values(out.dexActivity.byFamily)
    .reduce((a, v) => a + v.estSwapsPerDay, 0);

  // ---- do the configured contracts actually exist? ----------------------
  out.contractChecks = { dexes: {}, flashLoanProviders: {} };
  for (const [key, d] of Object.entries(cfg.dexes ?? {})) {
    const target = d.factory ?? d.poolManager ?? d.vault;
    out.contractChecks.dexes[key] = { label: d.label, family: d.family, ...(await hasCode(target)) };
    if (d.quoter) out.contractChecks.dexes[key].quoter = await hasCode(d.quoter);
  }
  for (const [key, p] of Object.entries(cfg.flashLoanProviders ?? {})) {
    if (!p.address) { out.contractChecks.flashLoanProviders[key] = { label: p.label, address: null, exists: null, kind: p.kind }; continue; }
    out.contractChecks.flashLoanProviders[key] = { label: p.label, kind: p.kind, ...(await hasCode(p.address)) };
  }

  // ---- live funding fees, read on-chain ---------------------------------
  out.fundingFees = {};
  const aave = cfg.flashLoanProviders?.['aave-v3']?.address;
  if (aave) {
    const r = await rpc.ethCall(aave, encodeFunctionData({ abi: ABI, functionName: 'FLASHLOAN_PREMIUM_TOTAL' }));
    out.fundingFees['aave-v3'] = r.error
      ? { error: r.error.message?.slice(0, 120) }
      : { premiumBps: Number(decodeFunctionResult({ abi: ABI, functionName: 'FLASHLOAN_PREMIUM_TOTAL', data: r.result })), source: 'Pool.FLASHLOAN_PREMIUM_TOTAL()' };
  }
  const vault = cfg.flashLoanProviders?.['balancer-v2']?.address;
  if (vault) {
    const pc = await rpc.ethCall(vault, encodeFunctionData({ abi: ABI, functionName: 'getProtocolFeesCollector' }));
    if (!pc.error) {
      const collector = decodeFunctionResult({ abi: ABI, functionName: 'getProtocolFeesCollector', data: pc.result });
      const fr = await rpc.ethCall(collector, encodeFunctionData({ abi: ABI, functionName: 'getFlashLoanFeePercentage' }));
      out.fundingFees['balancer-v2'] = fr.error
        ? { collector, error: fr.error.message?.slice(0, 120) }
        : {
            collector,
            feePercentageWei: decodeFunctionResult({ abi: ABI, functionName: 'getFlashLoanFeePercentage', data: fr.result }).toString(),
            feeBps: Number(decodeFunctionResult({ abi: ABI, functionName: 'getFlashLoanFeePercentage', data: fr.result })) / 1e18 * 10000,
            source: 'ProtocolFeesCollector.getFlashLoanFeePercentage()',
          };
    } else out.fundingFees['balancer-v2'] = { error: pc.error.message?.slice(0, 120) };
  }

  out.rpcStats = rpc.stats;
  const path = new URL(`../data/chain-profile-${cfg.id}.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  console.error(`\nwrote ${path.pathname}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
