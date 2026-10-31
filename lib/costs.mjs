// Execution cost model for a hypothetical arbitrage of our own.
//
// The forensics pass could read the real cost off a receipt. A discovered
// opportunity has no receipt, so the cost has to be modelled — and the model
// is calibrated against the 1,222 two-swap arbitrages the forensics pass
// already measured on Base, rather than guessed:
//
//   gasUsed       p10 199,134   p50 266,133   p90 518,088
//   effGasPrice   p50 0.0229 gwei            p90 2.716 gwei
//   l1Fee         p50 2.05e9 wei             p90 5.43e11 wei
//
// Two scenarios are always reported together, because which one applies is a
// competitive question we cannot settle from historical state:
//
//   `median`      p50 gas, p50 gas price, p50 L1 fee — a quiet block
//   `contested`   p90 across the board — a block where others are bidding
//
// An opportunity that is profitable only under `median` is reported as such.
// Collapsing both into one number is how a research result becomes misleading.

export const BASE_TWO_SWAP_CALIBRATION = {
  source: 'data/forensics-base-*.json, 1,222 observed two-swap self-funded arbitrages across 1,000 blocks',
  gasUsed: { p10: 199134, p50: 266133, p90: 518088 },
  effectiveGasPriceWei: { p50: 22883436, p90: 2716000000 },
  l1FeeWei: { p50: 2049617229, p90: 543464537577 },
};

// Scaling for route shapes we have not observed directly. A third swap adds
// roughly one more pool interaction; measured 3-swap median gasUsed was
// 332,278 against 266,133 for 2-swap, i.e. ~66k per extra leg.
const GAS_PER_EXTRA_LEG = 66000;

// Gas USED is a property of the contract logic, not of the chain, so the
// measured Base distribution transfers to another EVM chain. Gas PRICE does
// not: Base's median effective gas price was 0.0229 gwei, while Ethereum's
// base fee is routinely three orders of magnitude higher. A cost model that
// carried Base's gas price onto Ethereum would overstate Ethereum net profit
// by roughly that factor, so a chain without its own measured calibration
// must read its gas price from the chain before it is trusted.
export class CostModel {
  constructor(cfg, { calibration = null, scenario = 'median' } = {}) {
    this.cfg = cfg;
    this.scenario = scenario;
    this.isL2 = cfg.kind === 'op-stack-l2';
    // Only Base has a measured calibration, because only Base has a forensics
    // dataset. Another chain starts with gas-used figures borrowed from it and
    // NO gas price at all, until calibrate() reads one from the chain.
    this.cal = calibration ?? (cfg.id === 'base' ? BASE_TWO_SWAP_CALIBRATION : {
      source: `gasUsed borrowed from ${BASE_TWO_SWAP_CALIBRATION.source}; gas price must be read from ${cfg.id} itself`,
      gasUsed: BASE_TWO_SWAP_CALIBRATION.gasUsed,
      effectiveGasPriceWei: null,
      l1FeeWei: { p50: 0, p90: 0 },
      borrowedGasUsed: true,
    });
    this.calibrated = this.cal.effectiveGasPriceWei != null;
    // On a chain with a competitive block-builder market, an arbitrage
    // normally reaches a builder as a private bundle and pays the builder
    // directly. That payment is the dominant cost there and nothing in this
    // repo measures it, so it is declared missing rather than treated as zero.
    this.builderPaymentUnmodelled = cfg.kind === 'l1';
  }

  // Read the gas price from the chain at the block being quoted.
  //
  // p50 = the block's own base fee, which every transaction in it paid.
  // p90 = base fee plus a 2 gwei priority tip, representing a contested block.
  // Both are stated rather than assumed, and the block number is recorded.
  async calibrate(rpc, block) {
    const b = await rpc.getBlock(block);
    const baseFee = BigInt(b?.baseFeePerGas ?? 0);
    if (baseFee === 0n) return { calibrated: this.calibrated, reason: 'block reported no baseFeePerGas' };

    // A measured gas price beats a derived one. Base's comes from 1,222 real
    // arbitrage receipts, which include the priority tip those operators
    // actually paid; the block's base fee alone would understate it. Keep the
    // measurement and record the base fee beside it as a cross-check.
    if (this.cal.effectiveGasPriceWei != null && !this.cal.borrowedGasUsed) {
      this.cal = {
        ...this.cal,
        chainBaseFeeWei: String(baseFee),
        gasPriceBlock: block,
        source: `${this.cal.source}; block ${block} base fee ${(Number(baseFee) / 1e9).toFixed(4)} gwei, measured p50 kept in preference to it`,
      };
      return { calibrated: true, baseFeeGwei: Number(baseFee) / 1e9, keptMeasured: true };
    }

    const contested = baseFee + 2000000000n; // +2 gwei priority
    this.cal = {
      ...this.cal,
      effectiveGasPriceWei: { p50: Number(baseFee), p90: Number(contested) },
      source: `${this.cal.source}; gas price = baseFeePerGas at block ${block} (${(Number(baseFee) / 1e9).toFixed(4)} gwei), contested = +2 gwei priority`,
      gasPriceBlock: block,
    };
    this.calibrated = true;
    return { calibrated: true, baseFeeGwei: Number(baseFee) / 1e9 };
  }

  // Cost of executing a `legs`-leg atomic arbitrage, in USD.
  // `wethUsd` must come from on-chain state at the same block as the quote.
  estimate({ legs = 2, wethUsd, scenario = this.scenario, fundingBps = 0, notionalUsd = 0 }) {
    if (!this.calibrated) {
      return {
        scenario, legs, totalUsd: null, gasUsd: null,
        unavailable: true,
        basis: `no gas price for chain ${this.cfg.id}: call CostModel.calibrate(rpc, block) first. Refusing to price execution with another chain's gas price.`,
      };
    }
    const p = scenario === 'contested' ? 'p90' : 'p50';
    const gasUsed = this.cal.gasUsed[p] + Math.max(0, legs - 2) * GAS_PER_EXTRA_LEG;
    const gasPrice = this.cal.effectiveGasPriceWei[p];
    const l2FeeWei = BigInt(Math.round(gasUsed * gasPrice));
    // An L1 data-availability fee exists only on an OP-stack chain. On an L1
    // this term is absent, not zero-by-luck, so it is driven by chain kind.
    const l1FeeWei = this.isL2 ? BigInt(this.cal.l1FeeWei[p]) : 0n;
    const totalWei = l2FeeWei + l1FeeWei;
    const gasUsd = (Number(totalWei) / 1e18) * wethUsd;
    const fundingUsd = (notionalUsd * fundingBps) / 10000;
    return {
      scenario, legs, gasUsed, effectiveGasPriceWei: gasPrice,
      l2FeeWei: String(l2FeeWei), l1FeeWei: String(l1FeeWei), totalFeeWei: String(totalWei),
      gasUsd, fundingBps, fundingUsd, totalUsd: gasUsd + fundingUsd,
      builderPaymentUnmodelled: this.builderPaymentUnmodelled,
      basis: `calibrated ${p} from ${this.cal.source}; ${this.isL2 ? 'includes L1 data fee' : 'no L1 data fee (L1 chain)'}${this.builderPaymentUnmodelled ? '. EXCLUDES the block-builder payment, which is unmeasured here, so net profit on this chain is an UPPER BOUND' : ''}`,
    };
  }

  // Both scenarios at once — what the scanner records for every candidate.
  both(opts) {
    return { median: this.estimate({ ...opts, scenario: 'median' }), contested: this.estimate({ ...opts, scenario: 'contested' }) };
  }
}

// Swap fees are NOT in this model on purpose: they are already inside the
// exact quote, because every pool family's own arithmetic deducts its fee
// before paying out. Adding a fee term here would double-count it.
export const SWAP_FEE_NOTE = 'Swap fees are charged inside the exact quote by each pool\'s own maths (V3 feePips, V2 fee bps, solidly getAmountOut) and are deliberately not added again here.';
