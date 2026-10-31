// USD pricing from on-chain state at a specific block. Every price used in a
// profit number is read from the chain at the block being analysed, never from
// an off-chain feed, so historical results are reproducible.

import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

const ABI = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);

const Q192 = 2n ** 192n;

// sqrtPriceX96 -> human price of token1 per token0
export function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const sp = BigInt(sqrtPriceX96);
  // Scale by 1e18 before converting to Number to keep precision.
  const scaled = (sp * sp * 10n ** 18n) / Q192;
  return (Number(scaled) / 1e18) * 10 ** (dec0 - dec1);
}

export class Pricer {
  constructor(rpc, cfg, meta) {
    this.rpc = rpc; this.cfg = cfg; this.meta = meta;
    this.refPoolCache = {};
    this.wethUsdByBlock = new Map();
    // Treated as $1.00. Recorded as an explicit assumption in every report.
    this.stables = new Set(['USDC', 'USDbC', 'DAI', 'USDT'].map(
      (s) => cfg.tokens[s]?.address?.toLowerCase()).filter(Boolean));
    this.weth = cfg.tokens.WETH.address.toLowerCase();
  }

  async #refPool(a, b, fee) {
    const key = `${a}-${b}-${fee}`;
    if (this.refPoolCache[key]) return this.refPoolCache[key];
    const factory = this.cfg.dexes['uniswap-v3'].factory;
    const r = await this.rpc.ethCall(factory, encodeFunctionData({ abi: ABI, functionName: 'getPool', args: [a, b, fee] }));
    if (r.error) return null;
    const pool = decodeFunctionResult({ abi: ABI, functionName: 'getPool', data: r.result }).toLowerCase();
    if (/^0x0+$/.test(pool)) return null;
    this.refPoolCache[key] = pool;
    return pool;
  }

  // USD price of 1 WETH at `block`, from the deepest configured WETH/USDC
  // Uniswap V3 pool's slot0 at that block.
  async wethUsd(block) {
    if (this.wethUsdByBlock.has(block)) return this.wethUsdByBlock.get(block);
    const usdc = this.cfg.tokens.USDC.address.toLowerCase();
    let out = null;
    for (const fee of [500, 3000, 100, 10000]) {
      const pool = await this.#refPool(this.weth, usdc, fee);
      if (!pool) continue;
      const r = await this.rpc.ethCall(pool, encodeFunctionData({ abi: ABI, functionName: 'slot0' }), block);
      if (r.error || !r.result || r.result === '0x') continue;
      const [sqrtP] = decodeFunctionResult({ abi: ABI, functionName: 'slot0', data: r.result });
      if (!sqrtP || sqrtP === 0n) continue;
      const t0 = this.weth < usdc ? this.weth : usdc;
      const [d0, d1] = t0 === this.weth ? [18, 6] : [6, 18];
      const p = priceFromSqrt(sqrtP, d0, d1);
      out = { usdPerWeth: t0 === this.weth ? p : 1 / p, pool, fee, source: 'uniswap-v3 slot0' };
      break;
    }
    this.wethUsdByBlock.set(block, out);
    return out;
  }

  // USD value of `amount` raw units of `token` at `block`.
  // Returns { usd, basis } or { usd: null, reason } when it cannot be priced
  // from on-chain state — those rows stay unpriced rather than guessed.
  async usdValue(token, amount, block) {
    const t = token.toLowerCase();
    const meta = this.meta.token(t);
    const dec = meta.decimals ?? this.cfg.tokenByAddress[t]?.decimals;
    if (dec == null) return { usd: null, reason: 'unknown decimals' };
    const human = Number(amount) / 10 ** dec;

    if (this.stables.has(t)) return { usd: human, basis: 'stablecoin assumed $1.00' };

    const w = await this.wethUsd(block);
    if (!w) return { usd: null, reason: 'no WETH/USDC reference price' };
    if (t === this.weth) return { usd: human * w.usdPerWeth, basis: `WETH @ $${w.usdPerWeth.toFixed(2)} (${w.source})` };

    // Anything else: exact quoter call token -> WETH at this block, for this
    // exact size. Uses the real pool curve, not a spot approximation.
    const quoter = this.cfg.dexes['uniswap-v3'].quoter;
    for (const fee of [3000, 500, 10000, 100]) {
      const data = encodeFunctionData({
        abi: ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: t, tokenOut: this.weth, amountIn: BigInt(amount), fee, sqrtPriceLimitX96: 0n }],
      });
      const r = await this.rpc.ethCall(quoter, data, block);
      if (r.error || !r.result || r.result === '0x') continue;
      try {
        const [amountOut] = decodeFunctionResult({ abi: ABI, functionName: 'quoteExactInputSingle', data: r.result });
        if (amountOut > 0n) {
          const eth = Number(amountOut) / 1e18;
          return { usd: eth * w.usdPerWeth, basis: `exact quoter ${t}->WETH fee ${fee} @ block ${block}` };
        }
      } catch { /* try next tier */ }
    }
    return { usd: null, reason: 'no Uniswap V3 route to WETH for exact size' };
  }
}
