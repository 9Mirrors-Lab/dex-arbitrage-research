// STEP 4 - Select the funding method.
//
// Reads each provider's live fee and usable capacity straight from the chain,
// then sizes those costs against what Base arbitrage actually pays, so the
// recommendation is driven by measured economics rather than by the
// instructor's default choice of a flash loan.
//
//   node scripts/06-funding.mjs --chain base [--ranking data/ranking-base.json]

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Rpc, loadChain } from '../lib/rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const rpc = new Rpc(cfg.rpc, { concurrency: 3 });

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function getProtocolFeesCollector() view returns (address)',
  'function getFlashLoanFeePercentage() view returns (uint256)',
  'function getReserveData(address) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)',
  'function decimals() view returns (uint8)',
]);

const read = async (to, fn, a = []) => {
  const r = await rpc.ethCall(to, encodeFunctionData({ abi: ABI, functionName: fn, args: a }));
  if (r.error || !r.result || r.result === '0x') return null;
  try { return decodeFunctionResult({ abi: ABI, functionName: fn, data: r.result }); } catch { return null; }
};

const FUND_TOKENS = ['WETH', 'USDC'].filter((s) => cfg.tokens[s]);

const out = {
  chain: cfg.id, measuredAt: new Date().toISOString(),
  whatTheCourseTeaches: 'Dapp University selects a flash loan first (Balancer because its fee was zero, DODO as a fallback) and treats borrowed capital as the default for every arbitrage.',
  providers: {},
};

for (const [key, p] of Object.entries(cfg.flashLoanProviders ?? {})) {
  const row = { label: p.label, kind: p.kind, address: p.address, feeModel: p.feeModel };
  if (!p.address) {
    row.note = 'per-pool credit, not a single contract: cost is the pool fee tier on the borrowed amount, and capacity is that one pool';
    row.feeBps = 'equal to the pool fee tier (e.g. 5 bps on a 0.05% pool)';
    out.providers[key] = row; continue;
  }

  // Fee, read live.
  if (key === 'aave-v3') {
    const v = await read(p.address, 'FLASHLOAN_PREMIUM_TOTAL');
    row.feeBps = v != null ? Number(v) : null;
    row.feeSource = 'Pool.FLASHLOAN_PREMIUM_TOTAL()';
  } else if (key === 'balancer-v2') {
    const collector = await read(p.address, 'getProtocolFeesCollector');
    if (collector) {
      const fee = await read(String(collector), 'getFlashLoanFeePercentage');
      row.feeBps = fee != null ? Number(fee) / 1e18 * 10000 : null;
      row.feeSource = `ProtocolFeesCollector(${collector}).getFlashLoanFeePercentage()`;
    }
  } else if (key === 'morpho-blue') {
    row.feeBps = 0;
    row.feeSource = 'Morpho Blue charges no flash-loan fee (no fee parameter exists on flashLoan); stated, not read from a getter';
  }

  // Capacity: what the provider can actually lend right now.
  // Aave V3 keeps the underlying in each reserve's aToken, not in the Pool,
  // so reading balanceOf(Pool) understates it by orders of magnitude.
  row.capacity = {};
  for (const sym of FUND_TOKENS) {
    const t = cfg.tokens[sym];
    let holder = p.address;
    let via = 'balanceOf(provider)';
    if (key === 'aave-v3') {
      const rd = await read(p.address, 'getReserveData', [t.address]);
      const aToken = rd?.[8];
      if (aToken && !/^0x0+$/.test(String(aToken))) {
        holder = String(aToken);
        via = `balanceOf(aToken ${holder}) from Pool.getReserveData(${sym}).aTokenAddress`;
      } else {
        via = 'could not resolve aToken from getReserveData; figure below is balanceOf(Pool) and understates real capacity';
      }
    }
    const bal = await read(t.address, 'balanceOf', [holder]);
    row.capacity[sym] = bal != null ? { raw: String(bal), human: Number(bal) / 10 ** t.decimals, via } : { error: 'balanceOf failed', via };
  }
  out.providers[key] = row;
}

// What the observed economics can afford.
let econ = null;
const rankingPath = args.ranking ?? 'data/ranking-base.json';
if (existsSync(rankingPath)) {
  const r = JSON.parse(readFileSync(rankingPath, 'utf8'));
  econ = { netUsdPerArb: r.economics?.netUsdPerArb, executionCostUsdPerArb: r.economics?.executionCostUsdPerArb, fundingObserved: r.step4_fundingObserved };
}

out.observedEconomics = econ;

// The decisive arithmetic: a flash loan's fee is charged on the notional
// borrowed, while the profit is a spread on that same notional. So the fee is
// only affordable if the spread exceeds it.
out.affordability = {
  method: 'For a borrowed notional N and a gross spread s (as a fraction of N), a flash loan at f bps is worth using only when s*N > f/10000*N + gas, i.e. the gross spread must exceed the flash-loan fee before gas is even counted.',
  breakEvenSpreadBps: Object.fromEntries(Object.entries(out.providers).map(([k, v]) => [k, typeof v.feeBps === 'number' ? v.feeBps : v.feeBps ?? 'n/a'])),
  note: 'A zero-fee provider (Balancer V2, Morpho Blue) imposes no spread threshold at all, so on Base the fee question is not what decides the funding method - the extra gas of the borrow/repay callback is.',
};

if (econ?.netUsdPerArb) {
  const median = econ.netUsdPerArb.median;
  out.affordability.aaveAt5bps = {
    medianNetUsdPerObservedArb: median,
    notionalAtWhichAaveFeeEatsMedianProfit: median != null ? +(median / 0.0005).toFixed(2) : null,
    reading: median != null
      ? `Aave's 5 bps premium costs $${(0.0005 * 10000).toFixed(2)} on a $10,000 borrow. The median observed Base arbitrage nets $${median}, so a borrow above roughly $${(median / 0.0005).toFixed(0)} notional would hand the entire median profit to the lender.`
      : null,
  };
}

const path = new URL(`../data/funding-${cfg.id}.json`, import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.error(`\nwrote ${path.pathname}`);
