# Base — discovery coverage and opportunity report

Generated 2026-10-30 from measured artefacts in `data/`. Every figure traces to a named file; nothing is asserted without one.

## What changed in this stage

The earlier work reconstructed arbitrages other operators had already executed. It could only ever see a pool that someone had traded inside an observed block, so it had no denominator and could state no coverage. This stage replaced that with mechanical discovery: enumerate the market, generate every eligible route, quote each one exactly, and keep a ledger in which a route we did not reach is recorded as not reached.

### Phase A — what the previous pipeline actually scanned

| | |
|---|---|
| Observation window | 1,000 blocks, 33.3 minutes of chain time |
| Arbitrages reconstructed | 1,662 from 9,284 multi-swap transactions |
| Pools appearing in those arbitrages | 478 |
| Pools any script had ever resolved | 1,804 |
| Pools on factories exposing an on-chain array | 3,129,641 |
| Coverage of that floor | 0.0576% |
| Two-pool routes any script evaluated | 0 |

The last row is the finding. No script in the previous pipeline constructed a route; `04-validate-opportunity.mjs` re-priced transactions that already existed. Independent-discovery coverage was not low, it was zero.

## Market coverage

| Measure | Value | Denominator |
|---|---|---|
| Tokens discovered | 49,956 | — |
| Pools discovered | 67,599 | — |
| Pools with resolved token identity | 62,531 | of pools discovered |
| Exchanges configured | 16 | — |
| Exchanges with an exact-quote path | 14 | of configured |
| Unconfigured factories seen trading | 138 | coverage hole, ranked in `unconfigured-factories-base.json` |
| Factory pools enumerated in full | 55,961 | exhaustive for those factories |
| Factory pools deliberately deferred | 3,073,680 | Uniswap V2, reached by pair lookup only |
| Distinct token pairs | 56,441 | — |
| Eligible pools | 3,668 | of pools discovered |
| Eligible pairs with 2+ pools | 261 | route-bearing pairs |
| Directional two-pool routes possible | 2,820 | — |

### Reserve verification

Eligibility above is measured **after** cross-checking every pool's reported reserves against the ERC-20 balances it actually holds (`scripts/27-verify-reserves.mjs`). A pool can only pay out tokens it holds, and a contract can report any reserve it likes.

| | |
|---|---|
| Pools checked | 62,496 |
| Reserves match balances | 61,932 |
| Reported reserves exceed balances (excluded as spoofed) | 533 |
| V3 depth clamped to real balance | 7,659 |
| balanceOf unreadable | 31 |

This check is load-bearing out of all proportion to the count. Spoofed pools claim enormous reserves, so they sort to the very top of a depth-ranked queue: before the check existed they made up most of the candidate list on both chains.

### Why pools were excluded

An excluded pool is recorded with its reason. None of these reasons is a statement about profitability.

| Reason | Pools |
|---|---|
| `below-min-depth` | 39,286 |
| `reserves-dust-or-empty` | 18,864 |
| `singleton-pool-no-exact-quote-path` | 5,066 |
| `factory-not-configured` | 749 |
| `no-screening-price-for-either-token` | 632 |
| `reported-reserves-exceed-token-balances` | 533 |
| `token-decimals-unresolved` | 34 |
| `state-unreadable` | 5 |
| `token-identity-unresolved` | 2 |

## Route coverage

| Measure | Value |
|---|---|
| Routes generated | 2,820 |
| Routes queued for exact quoting | 2,820 |
| Routes evaluated | 2,741 (97.1986% of generated) |
| Routes still NOT TESTED | 0 |
| Routes UNSUPPORTED | 79 |

### Classification

| Class | Routes | Meaning |
|---|---|---|
| NO SPREAD | 2,645 | No profitable difference at the tested state. |
| NEGATIVE NET | 93 | Price difference exists but costs exceed returns. |
| UNSUPPORTED | 79 | Cannot currently be quoted or simulated reliably. |
| PROFITABLE / TIMING UNKNOWN | 3 | Positive executable net quote; capture feasibility not established. |

### Why routes were UNSUPPORTED

None of these is a statement that the route is unprofitable.

| Reason | Routes |
|---|---|
| pool could not be quoted at this block | 70 |
| exact spread found, but no reliable USD basis for the input token | 9 |

**9 routes returned a genuine positive round trip in token terms** — the exact quote through both pools paid back more of the input token than it consumed — but the input token's only available USD rate was a multi-hop screening price, which is too weak to carry a profit claim. They are recorded as UNSUPPORTED with the token-denominated spread kept, not as profitable and not as unprofitable. Closing this gap needs a stronger pricing path for long-tail tokens, and it is the single largest unquantified result in this run. Examples are in `data/dashboard-base.json` under `exactSpreadsWithoutUsdBasis`.

## How a route was evaluated

Scanned at block 53,266,711.

- **candidateSource** — pool registry (data/market/pools-base.json) — generated mechanically, not derived from any observed arbitrage transaction
- **legOneQuote** — exact, pool-native arithmetic at the stated block
- **legTwoQuote** — exact, on the actual output amount of leg one
- **sizing** — geometric ladder of 8 sizes bounded by the shallower pool's input-token reserve, then ternary refinement when a spread appears
- **costs** — data/forensics-base-*.json, 1,222 observed two-swap self-funded arbitrages across 1,000 blocks; block 53266711 base fee 0.0050 gwei, measured p50 kept in preference to it
- **costGasUsedBorrowed** — false
- **builderPaymentUnmodelled** — false
- **netProfitIsUpperBound** — false
- **spotPricesUsedForProfit** — false

## Capture feasibility

The latency model is stated rather than assumed, from `data/latency-base.json, data/decision-latency-base.json`:

| Step | Milliseconds |
|---|---|
| Observe the block header | 43 |
| Decide, with warm pool state | 55 |
| Submit the transaction | 43 |
| **Total reaction budget** | **141** |
| Block interval | 2000 |
| Slack | 1859 |

Block-boundary capture only. Same-block reaction is a different architecture and is not claimed here.

Measured against Base public endpoints from a local workstation.

**Base is sequenced first-come-first-served by a single sequencer with no public builder auction, so arriving inside the budget is the binding constraint and a persistent opportunity is genuinely reachable — subject to other operators arriving sooner.**

| Result | Routes |
|---|---|
| Tested for persistence | 3 |
| Survived two or more consecutive boundaries | 3 |
| Profitable at one boundary only (needs same-block) | 0 |
| Not reproducible on re-quote | 0 |

## Leading candidates

| Pair | Venues | Size | Gross | Cost (med) | Net (med) | Net (contested) | Duration | Rival arbs | Status |
|---|---|---|---|---|---|---|---|---|---|
| WETH/JAILBRK | uniswap-v2 -> aerodrome-v2 | 0.007953 | $0.3266 | $0.0135 | $0.3131 | $-2.7919 | 15 blk / 30s | 0 | CAPTURE CANDIDATE |
| WETH/EDNA | uniswap-v2 -> aerodrome-v2 | 0.003083 | $0.0294 | $0.0135 | $0.0159 | $-3.0890 | 15 blk / 30s | 0 | CAPTURE CANDIDATE |
| AIXBT/VIRTUAL | uniswap-v2 -> uniswap-v3 | 555.1 | $0.0197 | $0.0135 | $0.0062 | $-3.0987 | 15 blk / 30s | 0 | CAPTURE CANDIDATE |

Pool addresses, block numbers and the full size ladder for each row are in `data/dashboard-base.json` and the per-route ledger, so any row can be re-quoted independently.

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

**Established.** Within the eligible universe defined above, 97.1986% of generated two-pool routes were evaluated with exact, protocol-aware quotes at a named block — leg two priced on the actual output of leg one, never on a spot difference. 96 routes showed a real executable spread. 3 remained net positive after modelled execution cost under the median-gas scenario, and 3 of those were still net positive at two or more consecutive completed-block boundaries.

That last number is the one that matters against the Stage-2 result. Stage 2 found that 65 of 68 arbitrages taken by other operators existed only *inside* a block, created by an earlier transaction in the same block, and so were unreachable for a block-polling design. The routes found here are different in kind: they sat at completed-block boundaries for 30s or longer with no observed competing arbitrage on either pool. Independent discovery therefore finds a category of opportunity that forensics on other operators' transactions could not have revealed.

**Not established.** Capture. Every candidate here is net positive only under the median-gas scenario and turns negative once gas is contested. The sizes are small — the best net figure on this chain is $0.3131 — and none has been simulated against execution semantics, token transfer behaviour, or a competing operator. No route on either chain reached SIMULATION VALIDATED, and none should be treated as a trading signal.

**Out of scope of this measurement.** 0 routes remain NOT TESTED and 79 UNSUPPORTED; the universe itself excludes 3,073,680 unenumerated Uniswap V2 pairs, 138 unconfigured factories, and every singleton-pool venue. A conclusion about Base as a whole cannot be drawn from this run, and none is drawn.


## Known limitations

- Filtered eth_getLogs is capped at ~10,000 blocks and unfiltered at 100 block(s) on the free Base endpoints, so creation-event history was not scanned. Pools on factories without an on-chain array were found by swap activity and cross-venue lookup instead, which finds what trades rather than everything that exists.
- 3,073,680 Uniswap V2 pairs were not enumerated. They are reached only when a pair already has an eligible pool elsewhere, via getPair(). A pair whose only two pools are both unenumerated is NOT TESTED.
- 49 of 200 swap-sweep windows failed on the public endpoints even after retry, so the activity figures and the token set they produced are incomplete by that fraction.
- 138 factories were seen trading but are not in chains/base.json. Their pools are recorded and excluded from routes as `factory-not-configured` — an honest exclusion, but still a coverage hole. Closing it is mechanical: scripts/23 fingerprints each one and emits a config stub.
- Uniswap V4 and Balancer V2 pools are recorded but classified UNSUPPORTED: no exact-quote implementation exists for a singleton-pool design in this toolchain. On Base that is a material exclusion, since Uniswap V4 carried 31.6% of the arbitrage observed in Stage 2.
- 533 pools reported reserves exceeding their own token balances and are excluded as spoofed. Verification matters out of proportion to that count: these pools rank top by depth, so before the check was added they occupied most of the candidate list.
- Screening prices are spot reserve ratios and are used only to rank and to size. Profit is computed from exact quotes, but converting a token-denominated profit to USD uses the screening price when the input token is not a stablecoin or WETH, and every candidate row records which basis applied.
- Transfer taxes, rebasing and other non-standard token behaviour are not yet detected. A fee-on-transfer token would quote as profitable and fail in execution; such routes should be treated as unvalidated until a transfer simulation exists.
- Capture feasibility is tested only at completed-block boundaries under the stated latency model. It is not a claim that we would win a race against another operator.

## Reproducing this

```bash
node scripts/20-enumeration-probe.mjs --chain base
node scripts/21-coverage-audit.mjs   --chain base
node scripts/22-discover-pools.mjs   --chain base --sweep-blocks 20000
node scripts/23-identify-factories.mjs --chain base
node scripts/24-scan-routes.mjs      --chain base --block 53266711 --top 2000
node scripts/25-persistence.mjs      --chain base --blocks 12
node scripts/26-coverage-report.mjs  --chain base
```

Read-only throughout: `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`. No keys, no signing, no transactions.

