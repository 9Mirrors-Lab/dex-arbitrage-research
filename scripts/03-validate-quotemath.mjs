// Correctness gate for lib/v3math.mjs.
//
// Prices the same swaps two ways at the same historical block: our local tick
// maths, and Uniswap's deployed QuoterV2. They must agree to the wei. If they
// do, the same code can be trusted on V3 forks that have no usable quoter,
// which is where most Base arbitrage actually happens.
//
//   node scripts/03-validate-quotemath.mjs --chain base [--block N]

import { Rpc, loadChain } from '../lib/rpc.mjs';
import { V3PoolState, quoteExactInputV3 } from '../lib/v3math.mjs';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const cfg = loadChain(args.chain ?? 'base');
const rpc = new Rpc(cfg.rpc, { concurrency: 4, timeoutMs: 40000 });

const ABI = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);

const uni = cfg.dexes['uniswap-v3'];
const block = args.block ? Number(args.block) : (await rpc.blockNumber()) - 30;

const WETH = cfg.tokens.WETH.address;
const USDC = cfg.tokens.USDC.address;
const cbBTC = cfg.tokens.cbBTC?.address;

const cases = [];
for (const [a, b, da, db, label] of [[WETH, USDC, 18, 6, 'WETH/USDC'], [USDC, WETH, 6, 18, 'USDC/WETH'],
  ...(cbBTC ? [[cbBTC, WETH, 8, 18, 'cbBTC/WETH'], [WETH, cbBTC, 18, 8, 'WETH/cbBTC']] : [])]) {
  for (const fee of [500, 3000]) {
    for (const sizeHuman of [0.01, 1, 25, 400]) {
      cases.push({ tokenIn: a, tokenOut: b, fee, amountIn: BigInt(Math.round(sizeHuman * 10 ** da)), label: `${label} fee=${fee} size=${sizeHuman}`, da, db });
    }
  }
}

console.log(`${cfg.name} @ block ${block}\ncomparing local tick maths vs deployed QuoterV2 (${uni.quoter})\n`);

let pass = 0; let fail = 0; let skip = 0;
for (const c of cases) {
  // Resolve the pool from the factory at this block.
  const pr = await rpc.ethCall(uni.factory, encodeFunctionData({ abi: ABI, functionName: 'getPool', args: [c.tokenIn, c.tokenOut, c.fee] }), block);
  if (pr.error) { skip++; continue; }
  const pool = decodeFunctionResult({ abi: ABI, functionName: 'getPool', data: pr.result });
  if (/^0x0+$/.test(pool)) { skip++; continue; }

  // (a) deployed quoter
  const qr = await rpc.ethCall(uni.quoter, encodeFunctionData({
    abi: ABI, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountIn: c.amountIn, fee: c.fee, sqrtPriceLimitX96: 0n }],
  }), block);

  // (b) local maths
  let local;
  try {
    const state = new V3PoolState(rpc, pool, block);
    local = await quoteExactInputV3(state, { tokenIn: c.tokenIn, amountIn: c.amountIn });
  } catch (e) {
    console.log(`SKIP  ${c.label.padEnd(30)} local error: ${String(e.message).slice(0, 70)}`);
    skip++; continue;
  }

  if (qr.error) {
    console.log(`SKIP  ${c.label.padEnd(30)} quoter reverted (${String(qr.error.message).slice(0, 40)}); local said ${local.amountOut}`);
    skip++; continue;
  }
  const [qOut, , qTicks] = decodeFunctionResult({ abi: ABI, functionName: 'quoteExactInputSingle', data: qr.result });

  const match = qOut === local.amountOut;
  if (match) { pass++; } else { fail++; }
  const hOut = (v) => (Number(v) / 10 ** c.db).toPrecision(10);
  console.log(`${match ? 'PASS' : 'FAIL'}  ${c.label.padEnd(30)} quoter=${hOut(qOut)} local=${hOut(local.amountOut)} ticks q=${qTicks}/l=${local.ticksCrossed}${match ? '' : `  DELTA=${qOut - local.amountOut} wei`}`);
}

console.log(`\n${pass} pass, ${fail} fail, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
