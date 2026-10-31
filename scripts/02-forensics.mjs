// PART 4 - Investigate actual arbitrage activity on-chain.
//
// Detects self-funded atomic arbitrage from block receipts alone: no trace
// API, no third-party MEV dataset, no API key. For each candidate it records
// venues, tokens, funding method, gross profit, real execution cost
// (L2 execution gas + OP-stack L1 data fee) and net retained profit.
//
// Everything that cannot be fully attributed from on-chain state is reported
// as `unverified` and kept out of the profit statistics.
//
//   node scripts/02-forensics.mjs --chain base --blocks 300 [--from <block>]

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { decodeSwap, decodeTransfer, FUNDING_EVENTS, liquidityEventsIn } from '../lib/events.mjs';
import { MetaStore, makeVenueResolver } from '../lib/pools.mjs';
import { Pricer } from '../lib/price.mjs';
import { buildLedger, classifyLedger, buildRateGraph, priceViaGraph, NATIVE } from '../lib/arbdetect.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const chainId = args.chain ?? 'base';
const N_BLOCKS = Number(args.blocks ?? 300);
const cfg = loadChain(chainId);
const rpc = new Rpc(cfg.rpc, { concurrency: 4, timeoutMs: 45000 });
const meta = new MetaStore(rpc, chainId, cfg);
const resolveVenue = makeVenueResolver(cfg);
const pricer = new Pricer(rpc, cfg, meta);
const lc = (s) => (s ?? '').toLowerCase();

const v4Path = new URL(`../data/cache/v4-pools-${chainId}.json`, import.meta.url);
const v4pools = existsSync(v4Path) ? JSON.parse(readFileSync(v4Path, 'utf8')) : { pools: {} };

const WETH = cfg.tokens.WETH.address.toLowerCase();
const STABLES = new Set(['USDC', 'USDbC', 'DAI', 'USDT'].map((s) => cfg.tokens[s]?.address?.toLowerCase()).filter(Boolean));

function decimalsOf(token) {
  if (token === NATIVE) return 18;
  const d = meta.token(token).decimals;
  return d != null ? d : cfg.tokenByAddress[token]?.decimals ?? null;
}
function symbolOf(token) {
  if (token === NATIVE) return 'ETH';
  return meta.token(token).symbol ?? cfg.tokenByAddress[token]?.symbol ?? token.slice(0, 10);
}

async function collect(from, to) {
  const out = [];
  const BATCH = 10;
  for (let b = from; b <= to; b += BATCH) {
    const nums = Array.from({ length: Math.min(BATCH, to - b + 1) }, (_, k) => b + k);
    const blocks = await Promise.all(nums.map(async (n) => {
      try {
        const [receipts, block] = await Promise.all([rpc.getBlockReceipts(n), rpc.getBlock(n, true)]);
        const valueByHash = new Map(block.transactions.map((t) => [t.hash, t.value]));
        const rows = [];
        for (const r of receipts) {
          if (r.status !== '0x1' || (r.logs?.length ?? 0) < 2) continue;
          const swaps = r.logs.map(decodeSwap).filter(Boolean);
          if (swaps.length < 2) continue;
          rows.push({ receipt: r, swaps, transfers: r.logs.map(decodeTransfer).filter(Boolean), txValue: valueByHash.get(r.transactionHash) ?? '0x0' });
        }
        return rows;
      } catch { return []; }
    }));
    out.push(...blocks.flat());
    if ((b - from) % 100 === 0) console.error(`  ..block ${b} (+${out.length} multi-swap txs)`);
  }
  return out;
}

async function main() {
  const head = await rpc.blockNumber();
  const from = args.from ? Number(args.from) : head - N_BLOCKS - 5;
  const to = from + N_BLOCKS - 1;
  console.error(`scanning ${cfg.name} blocks ${from}..${to} (${N_BLOCKS} blocks, ~${(N_BLOCKS * cfg.blockTimeSec / 60).toFixed(1)} min of chain time)`);

  const cands = await collect(from, to);
  console.error(`${cands.length} successful multi-swap transactions`);

  await meta.resolvePools(cands.flatMap((c) => c.swaps.map((s) => s.pool)));
  const tokenAddrs = new Set([WETH, ...STABLES]);
  for (const c of cands) {
    for (const s of c.swaps) {
      const p = meta.pool(s.pool);
      if (p?.token0) tokenAddrs.add(p.token0);
      if (p?.token1) tokenAddrs.add(p.token1);
      if (s.family === 'uniswap-v4') {
        const v = v4pools.pools?.[s.poolId];
        if (v) { tokenAddrs.add(v.currency0); tokenAddrs.add(v.currency1); }
      }
    }
    for (const t of c.transfers) tokenAddrs.add(t.token);
  }
  tokenAddrs.delete(NATIVE);
  await meta.resolveTokens([...tokenAddrs]);
  console.error(`resolved ${Object.keys(meta.pools).length} pools, ${Object.keys(meta.tokens).length} tokens`);

  const arbs = []; const rejected = [];
  let i = 0;
  for (const c of cands) {
    if (++i % 100 === 0) console.error(`  classifying ${i}/${cands.length}`);
    const block = Number(BigInt(c.receipt.blockNumber));
    const ledger = buildLedger({
      receipt: c.receipt, txValue: c.txValue, swaps: c.swaps, transfers: c.transfers,
      poolMetaOf: (addr) => meta.pool(addr), v4pools, wethAddress: WETH,
    });

    // Price anchors: stablecoins at $1, WETH and native ETH from the
    // WETH/USDC pool's own state at this block.
    const w = await pricer.wethUsd(block);
    if (!w) { rejected.push({ hash: c.receipt.transactionHash, block, kind: 'unverified', reason: 'no WETH/USDC reference price at this block' }); continue; }
    const anchors = new Map([[WETH, w.usdPerWeth], [NATIVE, w.usdPerWeth]]);
    for (const s of STABLES) anchors.set(s, 1);

    const graph = buildRateGraph(ledger.legs, decimalsOf);
    const priceCache = new Map();
    const usdOf = (token, raw) => {
      const d = decimalsOf(token);
      if (d == null) return { usd: null, basis: 'unknown decimals' };
      if (!priceCache.has(token)) priceCache.set(token, priceViaGraph(token, graph, anchors));
      const p = priceCache.get(token);
      if (p.usd == null) return { usd: null, basis: p.basis };
      return { usd: (Number(raw) / 10 ** d) * p.usd, basis: p.basis };
    };

    const fundingEvents = [];
    for (const log of c.receipt.logs) {
      const f = FUNDING_EVENTS[log.topics?.[0]];
      if (f) fundingEvents.push({ ...f, emitter: lc(log.address) });
    }
    // Capital movement, not trading: exclude before attributing any profit.
    const liqEvents = liquidityEventsIn(c.receipt.logs);
    const verdict = liqEvents.length
      ? {
          kind: 'liquidity-event',
          reason: `transaction manages liquidity (${[...new Set(liqEvents.map((e) => e.name))].join(', ')}), so its balance change is the operator's own capital, not arbitrage profit`,
          grossUsd: null, legsPriced: [],
        }
      : classifyLedger(ledger, usdOf, {
        materialUsd: 0.01,
        fundingAddrs: new Set(fundingEvents.map((f) => f.emitter)),
      });

    const venueDetail = c.swaps.map((s) => {
      const p = meta.pool(s.pool);
      const v4 = s.family === 'uniswap-v4' ? v4pools.pools?.[s.poolId] : null;
      return {
        venue: s.family === 'uniswap-v4' ? 'uniswap-v4' : resolveVenue(p, s.family),
        family: s.family,
        pool: s.family === 'uniswap-v4' ? s.poolId : s.pool,
        fee: v4 ? v4.fee : p?.fee ?? null,
        stable: p?.stable ?? null,
        factory: p?.factory ?? null,
      };
    });
    const cycleTokens = [...new Set(ledger.legs.filter((l) => l.resolved).flatMap((l) => [l.tokenIn, l.tokenOut]))];

    const gasUsed = BigInt(c.receipt.gasUsed);
    const l2FeeWei = gasUsed * BigInt(c.receipt.effectiveGasPrice ?? 0);
    const l1FeeWei = BigInt(c.receipt.l1Fee ?? 0);
    const totalFeeWei = l2FeeWei + l1FeeWei;
    const costUsd = (Number(totalFeeWei) / 1e18) * w.usdPerWeth;

    const row = {
      hash: c.receipt.transactionHash,
      block,
      operatorEoa: ledger.from,
      operatorContract: ledger.to,
      swapCount: c.swaps.length,
      venues: venueDetail.map((v) => v.venue),
      venueCombo: [...new Set(venueDetail.map((v) => v.venue))].sort().join(' + '),
      venueDetail,
      cycleTokens: cycleTokens.map(symbolOf),
      cycleTokenAddrs: cycleTokens,
      funding: fundingEvents.length ? [...new Set(fundingEvents.map((f) => f.provider))] : ['none-observed'],
      fundingKind: fundingEvents.length ? [...new Set(fundingEvents.map((f) => f.kind))] : ['inventory-or-unobserved'],
      txValueEth: Number(ledger.txValue) / 1e18,
      gasUsed: Number(gasUsed),
      l2FeeWei: l2FeeWei.toString(),
      l1FeeWei: l1FeeWei.toString(),
      totalFeeWei: totalFeeWei.toString(),
      costUsd,
      l1ShareOfCost: Number(totalFeeWei) ? Number(l1FeeWei) / Number(totalFeeWei) : null,
      wethUsdAtBlock: w.usdPerWeth,
      flags: ledger.flags,
      verdict: verdict.kind,
      verdictReason: verdict.reason ?? null,
    };

    if (verdict.kind === 'self-funded-arb') {
      row.grossProfitUsd = verdict.grossUsd;
      row.netProfitUsd = verdict.grossUsd - costUsd;
      row.balanceSheet = verdict.legsPriced.map((p) => ({
        symbol: symbolOf(p.token), token: p.token,
        human: decimalsOf(p.token) != null ? Number(p.raw) / 10 ** decimalsOf(p.token) : null,
        usd: p.usd, pricingBasis: p.basis,
      }));
      arbs.push(row);
    } else {
      row.grossProfitUsd = verdict.grossUsd ?? null;
      rejected.push(row);
    }
  }

  const byReason = rejected.reduce((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] ?? 0) + 1 }), {});
  const out = {
    chain: cfg.id, chainName: cfg.name, measuredAt: new Date().toISOString(),
    window: { fromBlock: from, toBlock: to, blocks: N_BLOCKS, chainMinutes: +(N_BLOCKS * cfg.blockTimeSec / 60).toFixed(1) },
    detectionRule: 'operator balance sheet valued in USD at the transaction block; see lib/arbdetect.mjs',
    pricingBasis: 'stablecoins assumed $1.00; WETH/ETH from the Uniswap V3 WETH/USDC pool slot0 at the same block; all other tokens from rates executed inside the same transaction',
    v4RegistryCoverage: v4pools.coverage ?? null,
    counts: {
      multiSwapTxs: cands.length,
      selfFundedArb: arbs.length,
      rejected: rejected.length,
      rejectedByVerdict: byReason,
    },
    arbs: arbs.sort((a, b) => (b.netProfitUsd ?? -1e9) - (a.netProfitUsd ?? -1e9)),
    unverifiedSample: rejected.filter((r) => r.verdict === 'unverified').slice(0, 25),
    rpcStats: rpc.stats,
  };
  const path = new URL(`../data/forensics-${cfg.id}-${from}-${to}.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.error(`\nwrote ${path.pathname}`);
  console.error(JSON.stringify(out.counts, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
