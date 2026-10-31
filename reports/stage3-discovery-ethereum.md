# Ethereum mainnet — discovery coverage and opportunity report

Generated 2026-10-30 from measured artefacts in `data/`. Every figure traces to a named file; nothing is asserted without one.

## What changed in this stage

The earlier work reconstructed arbitrages other operators had already executed. It could only ever see a pool that someone had traded inside an observed block, so it had no denominator and could state no coverage. This stage replaced that with mechanical discovery: enumerate the market, generate every eligible route, quote each one exactly, and keep a ledger in which a route we did not reach is recorded as not reached.

### Phase A — what the previous pipeline actually scanned

No forensics run ever existed for Ethereum mainnet, so there is no prior coverage to audit: every pool, pair and route on this chain was NOT TESTED before this stage. 541,013 pools are reachable from on-chain factory arrays alone, and none of them had been examined.

The Stage-1 conclusion carried in FRAMEWORK.md — that the Ethereum pairs tested were too competitive after builder payments — came from one 24-hour window on a handful of manually chosen pairs, and its scripts and data were never persisted. It is therefore reported there as *reported, not reproducible*, and this stage does not treat it as evidence.

## Market coverage

| Measure | Value | Denominator |
|---|---|---|
| Tokens discovered | 14,064 | — |
| Pools discovered | 19,413 | — |
| Pools with resolved token identity | 17,961 | of pools discovered |
| Exchanges configured | 10 | — |
| Exchanges with an exact-quote path | 9 | of configured |
| Unconfigured factories seen trading | 89 | coverage hole, ranked in `unconfigured-factories-ethereum.json` |
| Factory pools enumerated in full | 14,516 | exhaustive for those factories |
| Factory pools deliberately deferred | 526,497 | Uniswap V2, reached by pair lookup only |
| Distinct token pairs | 15,478 | — |
| Eligible pools | 2,441 | of pools discovered |
| Eligible pairs with 2+ pools | 275 | route-bearing pairs |
| Directional two-pool routes possible | 1,562 | — |

### Reserve verification

Eligibility above is measured **after** cross-checking every pool's reported reserves against the ERC-20 balances it actually holds (`scripts/27-verify-reserves.mjs`). A pool can only pay out tokens it holds, and a contract can report any reserve it likes.

| | |
|---|---|
| Pools checked | 17,935 |
| Reserves match balances | 17,892 |
| Reported reserves exceed balances (excluded as spoofed) | 28 |
| V3 depth clamped to real balance | 694 |
| balanceOf unreadable | 15 |

This check is load-bearing out of all proportion to the count. Spoofed pools claim enormous reserves, so they sort to the very top of a depth-ranked queue: before the check existed they made up most of the candidate list on both chains.

### Why pools were excluded

An excluded pool is recorded with its reason. None of these reasons is a statement about profitability.

| Reason | Pools |
|---|---|
| `below-min-depth` | 12,698 |
| `reserves-dust-or-empty` | 1,787 |
| `singleton-pool-no-exact-quote-path` | 1,451 |
| `no-screening-price-for-either-token` | 501 |
| `factory-not-configured` | 247 |
| `reported-reserves-exceed-token-balances` | 27 |
| `token-decimals-unresolved` | 24 |
| `reserves-not-verified-against-token-balances` | 4 |
| `token-identity-unresolved` | 1 |
| `state-unreadable` | 1 |

## Route coverage

| Measure | Value |
|---|---|
| Routes generated | 1,562 |
| Routes queued for exact quoting | 1,562 |
| Routes evaluated | 1,494 (95.6466% of generated) |
| Routes still NOT TESTED | 0 |
| Routes UNSUPPORTED | 68 |

### Classification

| Class | Routes | Meaning |
|---|---|---|
| NO SPREAD | 1,316 | No profitable difference at the tested state. |
| NEGATIVE NET | 173 | Price difference exists but costs exceed returns. |
| UNSUPPORTED | 68 | Cannot currently be quoted or simulated reliably. |
| PROFITABLE / TIMING UNKNOWN | 5 | Positive executable net quote; capture feasibility not established. |

### Why routes were UNSUPPORTED

None of these is a statement that the route is unprofitable.

| Reason | Routes |
|---|---|
| exact spread found, but no reliable USD basis for the input token | 68 |

**68 routes returned a genuine positive round trip in token terms** — the exact quote through both pools paid back more of the input token than it consumed — but the input token's only available USD rate was a multi-hop screening price, which is too weak to carry a profit claim. They are recorded as UNSUPPORTED with the token-denominated spread kept, not as profitable and not as unprofitable. Closing this gap needs a stronger pricing path for long-tail tokens, and it is the single largest unquantified result in this run. Examples are in `data/dashboard-ethereum.json` under `exactSpreadsWithoutUsdBasis`.

## How a route was evaluated

Scanned at block 26,302,653.

- **candidateSource** — pool registry (data/market/pools-base.json) — generated mechanically, not derived from any observed arbitrage transaction
- **legOneQuote** — exact, pool-native arithmetic at the stated block
- **legTwoQuote** — exact, on the actual output amount of leg one
- **sizing** — geometric ladder of 8 sizes bounded by the shallower pool's input-token reserve, then ternary refinement when a spread appears
- **costs** — gasUsed borrowed from data/forensics-base-*.json, 1,222 observed two-swap self-funded arbitrages across 1,000 blocks; gas price must be read from ethereum itself; gas price = baseFeePerGas at block 26302653 (1.9805 gwei), contested = +2 gwei priority
- **costGasUsedBorrowed** — true
- **builderPaymentUnmodelled** — true
- **netProfitIsUpperBound** — true
- **spotPricesUsedForProfit** — false

## Capture feasibility

The latency model is stated rather than assumed, from `data/latency-base.json, data/decision-latency-base.json`:

| Step | Milliseconds |
|---|---|
| Observe the block header | 43 |
| Decide, with warm pool state | 55 |
| Submit the transaction | 43 |
| **Total reaction budget** | **141** |
| Block interval | 12000 |
| Slack | 11859 |

Block-boundary capture only. Same-block reaction is a different architecture and is not claimed here.

Measured against Base public endpoints from a local workstation.

**Ethereum mainnet orders transactions through a competitive block-builder market. Arriving inside the budget is necessary but NOT sufficient: inclusion is auctioned, and the builder payment is not modelled anywhere in this repo. A CAPTURE CANDIDATE here means "the opportunity was still live long enough to act on", not "we would have won it".**

| Result | Routes |
|---|---|
| Tested for persistence | 5 |
| Survived two or more consecutive boundaries | 3 |
| Profitable at one boundary only (needs same-block) | 2 |
| Not reproducible on re-quote | 0 |

## Leading candidates

| Pair | Venues | Size | Gross | Cost (med) | Net (med) | Net (contested) | Duration | Rival arbs | Status |
|---|---|---|---|---|---|---|---|---|---|
| WETH/SAS | unidentified-v2-c-eth -> uniswap-v2 | 0.01294 | $2.3837 | $1.1643 | $1.2194 | $-2.1716 | 15 blk / 180s | 0 | CAPTURE CANDIDATE |
| USDT/WBTC | uniswap-v3 -> aero-merged-cl-eth | 2393 | $1.5138 | $1.1643 | $0.3495 | $-3.0415 | 7 blk / 84s | 0 | CAPTURE CANDIDATE |
| USDT/WETH | uniswap-v3 -> uniswap-v3 | 1872 | $1.3099 | $1.1643 | $0.1456 | $-3.2455 | 1 blk / 12s | 0 | NOT CAPTURABLE |
| WBTC/USDT | aero-merged-cl-eth -> uniswap-v3 | 0.02874 | $1.2272 | $1.1643 | $0.0629 | $-3.3281 | 9 blk / 108s | 0 | CAPTURE CANDIDATE |
| WETH/MANA | uniswap-v2 -> uniswap-v3 | 0.09095 | $1.2210 | $1.1643 | $0.0568 | $-3.3343 | 1 blk / 12s | 0 | NOT CAPTURABLE |

Pool addresses, block numbers and the full size ladder for each row are in `data/dashboard-ethereum.json` and the per-route ledger, so any row can be re-quoted independently.

## Correctness controls that proved necessary

Each of these was added because an earlier run of this scanner produced a confident, wrong answer without it. They are recorded because a reader deciding whether to trust these numbers should know what nearly corrupted them, and because any future scanner needs the same guards.

| Control | What went wrong without it |
|---|---|
| Per-chain gas calibration | The cost model defaulted to Base's measured gas price (0.0229 gwei) on every chain. Applied to Ethereum, where the base fee was 1.98 gwei, it understated execution cost by roughly two orders of magnitude and turned 136 routes into false positives. Gas USED transfers between EVM chains; gas PRICE must be read from the chain. |
| Address-only price anchors | Anchors were matched by on-chain `symbol()`, so a counterfeit token calling itself "USDT" was valued at $1.00. Sitting in a pool against real WETH, it propagated a WETH price of $1.2e21 and turned every genuine WETH spread into a multi-sextillion-dollar fiction. Base alone holds 144 tokens with stablecoin-looking symbols. A token's identity is its address; `symbol()` is attacker-controlled text. |
| Reserve verification against balances | Any contract can answer `getReserves()` with any number, and spoofed pools claim enormous depth, so a depth-ranked queue puts them first. They produced persistent "capture candidates" worth $1.7e21. |
| Ratio and depth read separately | Clamping reserves to the real token balance is right for depth but distorts the price *ratio*. Clamping both priced Base WETH at $522 instead of about $2,215. |
| Family from `stable()`, not the event signature | Solidly-style pools emit the same `Swap` signature as Uniswap V2 but use the x³y+y³x invariant. Quoting one with constant-product maths made a USDC/USDT pool appear to yield $20 on a $201 round trip. Pools answering `stable()` are now quoted through their own `getAmountOut()` view, which is exact whatever the invariant. |
| Unidentified implementations excluded | A pool that does not report a factory cannot be tied to a known implementation, so both its maths and its fee are assumptions. Two such pools drove five of eleven "profitable" Ethereum candidates. |

The common thread: every one of these failures produced a *large* apparent profit rather than a small one, because the scanner ranks by depth and optimises size. A discovery engine without these controls does not fail quietly — it fails loudly and in the direction of false optimism.

## What this does and does not establish

**Established.** Within the eligible universe defined above, 95.6466% of generated two-pool routes were evaluated with exact, protocol-aware quotes at a named block — leg two priced on the actual output of leg one, never on a spot difference. 178 routes showed a real executable spread. 5 remained net positive after modelled execution cost under the median-gas scenario, and 3 of those were still net positive at two or more consecutive completed-block boundaries.

That last number is the one that matters against the Stage-2 result. Stage 2 found that 65 of 68 arbitrages taken by other operators existed only *inside* a block, created by an earlier transaction in the same block, and so were unreachable for a block-polling design. The routes found here are different in kind: they sat at completed-block boundaries for 84s or longer with no observed competing arbitrage on either pool. Independent discovery therefore finds a category of opportunity that forensics on other operators' transactions could not have revealed.

**Not established.** Capture. Every candidate here is net positive only under the median-gas scenario and turns negative once gas is contested, and the builder payment that decides inclusion on this chain is not modelled at all. The sizes are small — the best net figure on this chain is $1.2194 — and none has been simulated against execution semantics, token transfer behaviour, or a competing operator. No route on either chain reached SIMULATION VALIDATED, and none should be treated as a trading signal.

**Out of scope of this measurement.** 0 routes remain NOT TESTED and 68 UNSUPPORTED; the universe itself excludes 526,497 unenumerated Uniswap V2 pairs, 89 unconfigured factories, and every singleton-pool venue. A conclusion about Ethereum mainnet as a whole cannot be drawn from this run, and none is drawn.


## Known limitations

- Filtered eth_getLogs is capped at ~1,000 blocks and unfiltered at 1 block(s) on the free Ethereum mainnet endpoints, so creation-event history was not scanned. Pools on factories without an on-chain array were found by swap activity and cross-venue lookup instead, which finds what trades rather than everything that exists.
- 526,497 Uniswap V2 pairs were not enumerated. They are reached only when a pair already has an eligible pool elsewhere, via getPair(). A pair whose only two pools are both unenumerated is NOT TESTED.
- 89 factories were seen trading but are not in chains/ethereum.json. Their pools are recorded and excluded from routes as `factory-not-configured` — an honest exclusion, but still a coverage hole. Closing it is mechanical: scripts/23 fingerprints each one and emits a config stub.
- Uniswap V4 and Balancer V2 pools are recorded but classified UNSUPPORTED: no exact-quote implementation exists for a singleton-pool design in this toolchain.
- 28 pools reported reserves exceeding their own token balances and are excluded as spoofed. Verification matters out of proportion to that count: these pools rank top by depth, so before the check was added they occupied most of the candidate list.
- Net profit on Ethereum mainnet EXCLUDES the block-builder payment, which nothing in this repo measures. Since inclusion is auctioned, every net figure here is an upper bound and the true retained profit is lower by whatever a builder would demand.
- Gas USED in the cost model is borrowed from the measured Base two-swap distribution, because Ethereum mainnet has no forensics dataset of its own; gas PRICE is read from the chain at the scanned block. Gas used is a property of the contract logic rather than the chain, so it transfers, but it has not been confirmed against real Ethereum mainnet arbitrage receipts.
- Screening prices are spot reserve ratios and are used only to rank and to size. Profit is computed from exact quotes, but converting a token-denominated profit to USD uses the screening price when the input token is not a stablecoin or WETH, and every candidate row records which basis applied.
- Transfer taxes, rebasing and other non-standard token behaviour are not yet detected. A fee-on-transfer token would quote as profitable and fail in execution; such routes should be treated as unvalidated until a transfer simulation exists.
- Capture feasibility is tested only at completed-block boundaries under the stated latency model. It is not a claim that we would win a race against another operator.

## Reproducing this

```bash
node scripts/20-enumeration-probe.mjs --chain ethereum
node scripts/21-coverage-audit.mjs   --chain ethereum
node scripts/22-discover-pools.mjs   --chain ethereum --sweep-blocks 20000
node scripts/23-identify-factories.mjs --chain ethereum
node scripts/24-scan-routes.mjs      --chain ethereum --block 26302653 --top 2000
node scripts/25-persistence.mjs      --chain ethereum --blocks 12
node scripts/26-coverage-report.mjs  --chain ethereum
```

Read-only throughout: `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`. No keys, no signing, no transactions.

