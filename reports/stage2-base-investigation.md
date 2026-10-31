# Stage 2 — Base blockchain investigation

**Date:** 2026-10-29 · **Chain:** Base (8453) · **Comparison:** Ethereum mainnet (1)
**Scope:** research and validation only. No contract was deployed, no transaction was sent, no funds moved. Every script is read-only.

---

## The short version

Base is a far better *place* to look than Ethereum: transactions cost about **1/1,381** as much, there are **~2.6 million swaps a day** across six venue families, and zero-fee flash-loan capacity is live and deep. Real arbitrage is happening constantly — we measured **1,662 self-funded atomic arbitrages in 33 minutes** of chain time, run by **131 different operator contracts**.

But the stage gate did not pass, and the reason is specific and consistent.

We took 68 of the real arbitrages we found and re-priced each one against exact pool state at the **end of the previous block** — the information a bot that watches for `Swap` events and then reacts would actually have. **None of the 68 was profitable at that moment.** Not one. 65 of them were created by an earlier transaction *inside the same block* as the arbitrage that captured them.

That held in a 20-candidate **random** sample as well as in the 48 largest-profit ones, so it is not an artefact of looking only at the big trades: in the random sample, 20 of 20 were same-block and 20 of 20 were unprofitable at the previous block boundary.

So the profits are real, but they are not sitting on the chain waiting to be found. They are created and consumed inside a single 2-second block, by operators positioned to react within that block. The architecture the course teaches — watch for a swap, compute a price difference, send a transaction — is looking for a thing that, on Base, does not exist long enough to be found that way.

**Recommendation: do not write the Solidity yet.** The blocker is not the contract. It is the question of how a transaction gets into the same block as the trade that creates the opportunity. That is answerable with more research, and Step 5 below lists exactly what to answer.

---

## Part 2 — Keeping the evidence honest

Everything in this report is tagged by how we know it.

| Category | What it covers here |
|---|---|
| **1. What Dapp University teaches** | The five steps; two exchanges with the same swap interface; Balancer flash loans first (fee was zero) with DODO as fallback; `exactInputSingle` / `swapExactTokensForTokens`; an off-chain Node.js bot on `contract.on("Swap")`; "look for pairs others ignore"; cheaper chains to avoid competition; min-out left at zero. Source: 34 transcripts in `../../pack/` (`index.md`, `picks.md`, `notes.md`, `gaps.md`). |
| **2. What we observed on-chain** | Every count, fee, gas figure, swap tally, operator address and transaction hash in this report. Measured from public Base RPC; raw output in `../data/`. |
| **3. What our models estimate** | The optimal trade size for each cycle, and the "implied daily total" extrapolations. Clearly marked as extrapolations where used. |
| **4. What is validated by exact quotes or simulation** | The re-priced cycles in Step 3, using exact historical pool state. Our V3 maths is checked wei-for-wei against Uniswap's deployed QuoterV2 (32/32 exact, including a 410-tick trade). |
| **5. Inferred, unverified or excluded** | Listed explicitly in [What we could not establish](#what-we-could-not-establish). |

**On the Ethereum result:** Stage 1 covered **one 24-hour window on specific pairs**. It is evidence that those pairs were too competitive in that window. It is **not** a finding that Ethereum arbitrage is unprofitable, and this report does not treat it as one. Ethereum's registry status is `VALIDATION REQUIRED`, not `FAILED`.

---

## Step 1 — Select the blockchain

### What we investigated
Base's suitability as an arbitrage venue, measured directly from its own RPC rather than from documentation: block cadence, throughput, fee structure, swap activity per venue family, whether the DEX and flash-loan contracts we expected actually exist, and live flash-loan fees. The same script was run against Ethereum for comparison.

### What we discovered

| Metric | Base | Ethereum mainnet |
|---|---|---|
| Measured block time | **2.0 s** | **12.0 s** |
| Mean transactions/block | 235.3 | 228.4 |
| Estimated transactions/day | **10,166,595** | 1,644,768 |
| Mean gas used/block | 45,716,854 | 31,151,181 |
| Base fee, 50th pct | **0.005 gwei** | 0.137 gwei |
| Base fee, 95th pct | **0.005 gwei** | **49.68 gwei** |
| Median total fee per transaction | **1.25 × 10⁻⁶ ETH** | 1.73 × 10⁻³ ETH |
| Cost ratio | — | **1,381× more expensive** |
| Separate L1 data fee | **Yes** — 39.9% of a median transaction's cost | No |
| Measured swaps/block | **60.2** | not measurable (free endpoints refuse unfiltered log queries) |
| Estimated swaps/day | **2,601,792** | not measured |
| Venue families seen trading | **6** | not measured |
| DEX contracts verified present | 10 of 10 | 4 of 4 |
| Balancer V2 flash-loan fee | **0 bps** (read on-chain) | 0 bps |
| Aave V3 flash-loan fee | **5 bps** (read on-chain) | 5 bps |

Base swap activity by venue family (25-block windows, three samples):

| Family | Swaps/block | Distinct pools | Est. swaps/day |
|---|---|---|---|
| Uniswap V3 and its forks | 39.08 | 377 | 1,688,256 |
| Uniswap V4 | 10.35 | 1 (singleton) | 446,976 |
| PancakeSwap V3 | 8.71 | 40 | 376,128 |
| Solidly/Aerodrome classic | 1.25 | 32 | 54,144 |
| Uniswap V2 forks | 0.81 | 35 | 35,136 |
| Balancer V2 | 0.03 | 1 | 1,152 |

Two findings worth separating out:

- **Ethereum's gas is bimodal, Base's is flat.** In the same Ethereum sample, the median base fee was 0.137 gwei and the 95th percentile was 49.68 gwei — a 363× spread, because one sampled window caught a congestion spike while others were quiet. Base sat at its 0.005 gwei floor in every sample. For arbitrage this matters more than the average: on Ethereum the cost of being wrong varies by two orders of magnitude depending on when you trade.
- **Base's L1 data fee is real but small for arbitrage-sized transactions.** It is 39.9% of a *median* transaction's cost, but arbitrage transactions use far more gas (median 332,278 vs 92,634), so the L1 component falls to a **median 0.08%** of an arbitrage's cost (90th percentile 23%). Ethereum builder-payment economics genuinely do not transfer — but neither does the L2 "the L1 fee dominates" intuition.

### What it means
Base is the better hunting ground on every structural measure. Cheap gas means a failed attempt costs a fraction of a cent instead of several dollars, which is exactly the argument the course makes for cheaper chains. Dense activity across six venue families and 377+ V3-style pools means price differences are constantly being created.

Note what this does *not* say. "More opportunities exist" and "we can capture them" are different claims. Step 3 tests the second one.

### Current status
**Completed.** Base: `PROMISING`. Ethereum: `VALIDATION REQUIRED` (one window, specific pairs — not a disproof).

### Next action
None for Step 1. Base is a reasonable chain to continue on.

---

## Step 2 — Select two exchanges

### What we investigated
Rather than picking two exchanges and hoping, we ranked DEX combinations by **where arbitrage demonstrably happens**: 1,662 real arbitrages across 1,000 blocks, grouped by the venues they touched. We deliberately did not restrict to the course's "two exchanges with the same swap interface" shape.

Identifying the venues took on-chain work. Six factories producing heavy arbitrage volume matched nothing we had configured. We fingerprinted each one by which methods it answers, then confirmed protocol identity by comparing governance pointers:

| Factory | Identified as | On-chain evidence |
|---|---|---|
| `0x5e7BB104…809a` | Aerodrome Slipstream CL #1 | `voter()` = `0x1661…80A5`, 3,669 pools |
| `0xade65c38…716a` | Aerodrome Slipstream CL #2 | same `voter()` as Aerodrome classic, 2,295 pools |
| `0xf8f2eb49…061ef` | Aerodrome Slipstream CL #3 | same `voter()`, 5,173 pools — largest CL factory |
| `0x420DD381…40Da` | Aerodrome classic | same `voter()`, 29,855 pools |
| `0x9cb22058…7a76` | **A separate Slipstream-fork protocol** | Slipstream fingerprint but a **different** `voter()` (`0x3824…4078`) and `factoryRegistry` → not Aerodrome. 513 pools. Third-party references identify it as Aero, the merged Aerodrome/Velodrome deployment; that brand attribution is *not* from chain state. |
| `0x70fe4a44…f687` | Solidly V3 | `feeAmountTickSpacing(3000)` = **50** where Uniswap V3 returns 60 |
| `0xb5e5a9e6…6ca9`, `0x6e606cf9…0a31` | Unidentified V3 forks | fingerprinted only; 1 arbitrage leg each |

### What we discovered

Ranked by observed arbitrage transactions:

| # | DEX combination | Arb txs | Share | Net USD (sum) | Median net | Operators |
|---|---|---|---|---|---|---|
| 1 | **Uniswap V3 + Uniswap V4** | 525 | 31.6% | $108.57 | $0.0272 | 39 |
| 2 | Aero-merged CL + Uniswap V3 | 153 | 9.2% | $29.60 | $0.0166 | 33 |
| 3 | **Uniswap V3 alone** (two pools, different fee tiers) | 142 | 8.5% | $11.96 | $0.0192 | 33 |
| 4 | Aero-merged CL + Aerodrome Slipstream #3 | 88 | 5.3% | $53.55 | $0.0189 | 36 |
| 5 | Aero-merged CL + PancakeSwap V3 | 86 | 5.2% | $3.19 | $0.0099 | 21 |
| 6 | Aerodrome Slipstream #1 + PancakeSwap V3 | 51 | 3.1% | $0.79 | $0.0099 | 11 |
| 7 | Aero-merged CL + Aerodrome Slipstream #2 | 34 | 2.0% | $12.74 | $0.0137 | 13 |
| 8 | Aerodrome Slipstream #3 + PancakeSwap V3 | 28 | 1.7% | $16.05 | $0.0040 | 14 |

The structural breakdown is the headline:

| Shape | Arb txs | Share |
|---|---|---|
| Different DEX brands (the course's model) | 712 | 42.8% |
| **Same protocol, different version or factory** | **720** | **43.3%** |
| **A single venue** — two pools of the same DEX, usually different fee tiers | **230** | **13.8%** |

### What it means
**The course's "two different exchanges" framing describes less than half of real Base arbitrage.** Arbitrage between *versions of the same protocol* (Uniswap V3 against Uniswap V4; Aerodrome's three Slipstream factories against each other) is just as common, and one arbitrage in seven happens entirely inside one DEX between two fee tiers. An implementation hard-wired to "DEX A router and DEX B router" would be blind to 57% of the activity.

Two caveats on the #1 combination, which matter:

- Its 525 transactions are **97.5% a single token pair** (512 are AXIS/USDC). It is not a broad Uniswap-V3-vs-V4 pattern; it is one heavily-worked pair. Ranking by transaction count makes a single contested pair look like a strategy.
- The combination with the most *operators* competing is #4 (36 operators for 88 transactions) — a crowd fighting over few opportunities.

Note also that the venue that shows up in the most combinations is the newest: the separate Slipstream-fork deployment at `0x9cb22058…`, with only 513 pools, appears in combinations 2, 4, 5 and 7. A new venue with shallow pools diverges from established ones more often. That is the mechanism behind "look for pairs others ignore" — but as Step 3 shows, "others" are already there.

### Current status
**Completed.** Shortlist produced with evidence. Top four combinations set to `INVESTIGATING` in the registry — meaning *other people demonstrably arbitrage these*, which is not the same as us being able to.

### Next action
None in isolation. A combination is only worth implementing against a validated opportunity, which is Step 3's job.

---

## Step 3 — Select trading pairs

### What we investigated
For every token cycle appearing in the 1,662 observed arbitrages we recorded frequency, net profit distribution, how many distinct operators competed, and how often opportunities repeated. Then we put 54 of them through full revalidation: re-pricing the entire cycle against **exact historical pool state**, searching for the optimal trade size, and subtracting real costs.

Quote accuracy was the prerequisite. Most Base arbitrage happens on V3 *forks* that have no quoter we can call, so we implemented Uniswap V3's tick maths and ran it against the deployed Uniswap QuoterV2: **32 of 32 cases matched exactly, to the wei**, including a trade crossing 410 initialised ticks. Two bugs were found and fixed in that process (a double-decrement in the compressed-tick calculation, and a zero-liquidity guard that aborted valid swaps through empty ranges). Without that check the rest of this step would be guesswork.

### What we discovered

**Observed activity, by cycle:**

| Cycle | Arb txs | Net USD (sum) | Max single | Operators | Repeats |
|---|---|---|---|---|---|
| AXIS / USDC | **654** | $107.57 | $2.33 | **49** | 166 of 274 blocks had more than one |
| WETH / toby | 17 | $116.98 | $107.29 | 10 | — |
| USDC / WETH / cbBTC | 20 | $58.87 | $57.36 | 8 | — |
| WETH / cbBTC | 48 | $29.17 | $12.53 | 14 | — |
| USDC / LAPTOP | 7 | $19.58 | $7.77 | 6 | — |
| USDC / LMTS | 23 | $12.65 | $11.47 | 9 | — |
| AERO / USDC / USDT | 2 | $161.88 | $138.07 | 1 | — |
| LIc / USDC / WETH / wUSDC | 1 | $250.57 | $250.57 | 1 | — |

**Whole-population economics** (1,662 arbitrages, 1,000 blocks, 33.2 minutes of chain time):

| | Value |
|---|---|
| Net profit per arbitrage, median | **$0.0172** |
| Net profit per arbitrage, 90th pct | $0.4677 |
| Net profit per arbitrage, max | $250.57 |
| Execution cost per arbitrage, median | $0.0159 |
| Arbitrages netting > $0 | 1,558 of 1,662 |
| Arbitrages netting > $1 | **54** |
| Arbitrages netting > $5 | **18** |
| Arbitrages netting > $25 | **5** |
| Total net, all 131 operators, 33 minutes | **$932.74** |
| Extrapolated to 24h, all operators (an extrapolation, not a measurement) | ~$40,456 |

The median arbitrage nets **$0.0172 against a $0.0159 cost** — it barely clears its own gas. This is a business of pennies at volume, with a thin tail.

**The revalidation gate — the decisive result:**

Two samples were drawn to separate the finding from how we picked candidates: the **largest-profit** arbitrages, and a **random** sample (fixed seed, reproducible).

| | Largest-profit | Random sample | Combined |
|---|---|---|---|
| Candidates re-priced against exact historical state | 48 | 20 | **68** |
| **Profitable at the end of the previous block** | **0** | **0** | **0** |
| Same-block backrun (an earlier transaction in the *same* block moved these pools) | 45 | **20 of 20** | 65 |
| Not profitable beforehand, no same-block trigger (unexplained by our model) | 3 | 0 | 3 |
| Revalidated net — best case | −$0.0033 | −$0.0035 | **−$0.0033** |
| Revalidated net — median | −$0.0940 | −$0.0158 | −$0.0370 |

Not one candidate was positive, in either sample. The random sample matters: ranking by profit would naturally over-select trades that followed a large swap, and that objection does not survive — the pattern is uniform across the population, including the two-cent arbitrages.

**The clearest single case** — `0xee4c1632…23e4`, block 53,247,257:

- The operator earned **$107.29 net** (gross $110.68, cost $3.39) on a WETH → toby → WETH cycle between SushiSwap V2 and SushiSwap V3.
- Re-pricing that same cycle at the end of block 53,247,256, the optimal trade size collapsed to effectively zero: **no profitable size existed**, and attempting it would have lost the gas, −$3.39.
- In block 53,247,257, **seven earlier transactions swapped on those two pools** — at transaction indices 65, 248, 308, 313 and 364. The arbitrage landed at index **366**, two slots after the last of them.

The opportunity was created inside the block and taken inside the block.

### What it means

This is the finding that decides Stage 2, so it is worth stating plainly.

The arbitrage profits on Base are real and we measured them precisely. But **they do not exist at block boundaries.** They are created by a trade and consumed within the same 2-second block by an operator who was positioned to react to that specific trade. By the time a block has closed and a bot can read its state, the opportunity has already been taken.

The architecture the course teaches is: watch for a `Swap` event, compute whether a price difference exceeds gas, send a transaction. That design reads state *after* a block closes. On the evidence here, it would find nothing — every one of the 68 opportunities we tested was already gone, and acting on them at the only moment such a bot could see them would have **lost** money.

It also follows that **long-tail tokens are not the refuge they appear to be.** The tokens carrying the most arbitrage here — AXIS, toby, LAPTOP, LMTS, Basecat — are exactly the obscure tokens the course recommends hunting. AXIS/USDC alone drew **49 competing operators**, with more than one arbitrage in the same block in 166 of 274 blocks. These pairs are not ignored. They are the contested ground.

And an observed profitable transaction is not an available opportunity. That distinction is the whole content of this step: 68 verifiably profitable trades by other people, and zero of them capturable by the design we were evaluating.

### Current status
**FAILED for this architecture.** No cycle reached `VALIDATED`. The gate required four things; `captureShown` failed in every case, so the registry holds no `VALIDATED` rows.

To be precise about what failed: not Base, and not arbitrage. What failed is *finding opportunities by polling state between blocks.*

### Next action
Answer one question before anything else: **can a transaction get into the same block as the trade that creates the opportunity, on Base, from our position?** That is a question about Base's sequencer, mempool visibility and achievable latency — listed in Step 5.

---

## Step 4 — Select the funding method

### What we investigated
Every flash-loan provider on Base, with fees and lendable capacity read live from chain state, plus what the observed arbitrages actually used. The course picks Balancer first because its fee was zero; we tested whether that still holds on Base.

### What we discovered

| Provider | Fee | Lendable WETH | Lendable USDC | How measured |
|---|---|---|---|---|
| **Morpho Blue** | **0 bps** | **84,242** | **$196,066,493** | `balanceOf(provider)` |
| Aave V3 | 5 bps | 16,174 | $10,096,446 | `balanceOf(aToken)` from `Pool.getReserveData().aTokenAddress` |
| **Balancer V2** (the course's pick) | 0 bps | **22.9** | **$74,581** | `balanceOf(vault)` |
| Uniswap V3 pool flash | = pool fee tier | per-pool | per-pool | pool-native credit |

What the 1,662 real arbitrages used:

| Funding observed | Arb txs | Share | Net USD (sum) |
|---|---|---|---|
| **None — inventory-funded** | **1,590** | **95.7%** | $929.44 |
| Morpho Blue flash loan | 72 | 4.3% | $3.29 |
| Balancer V2 flash loan | **0** | 0% | — |
| Aave V3 flash loan | **0** | 0% | — |

### What it means

Three things, in order of importance:

1. **Almost nobody uses a flash loan.** 95.7% of real Base arbitrage is funded from the operator's own inventory. The course treats a flash loan as the default for every arbitrage; on Base the practitioners do the opposite. The reason is arithmetic: a flash loan adds a borrow-and-repay callback to the transaction, and gas is the dominant cost when the median profit is $0.017. Borrowing to chase two cents loses to the gas the borrow costs.
2. **Balancer, the course's first choice, is the weakest option on Base** — not on fee (still 0 bps) but on depth: **22.9 WETH** against Morpho Blue's 84,242. It was used zero times in our sample. If a flash loan is ever needed, Morpho Blue dominates it on both fee and capacity.
3. **Fee choice is not the deciding variable.** With two zero-fee providers available, the flash-loan fee imposes no spread threshold at all. The real cost of borrowing is gas, not interest.

For scale: Aave's 5 bps costs $5 on a $10,000 borrow. The median observed arbitrage nets $0.017. A borrow of about **$34** notional would hand Aave the entire median profit.

### Current status
**Completed, and gated.** All four providers are `INVESTIGATING`. No funding method should be selected yet, because no validated opportunity exists that needs funding.

If one emerges, the evidence points to **inventory first** (what 95.7% of working operators do), with **Morpho Blue** as the flash-loan option if borrowed capital is ever required — not Balancer.

### Next action
None. Revisit only after an opportunity passes Step 3.

---

## Step 5 — Create and test the smart contract

**This step remains gated and no contract was written.** Below are the requirements and, more usefully, the questions that must be answered before a contract is worth writing.

### What the contract would need

| Requirement | What the evidence says about it |
|---|---|
| Exchange integrations | Must handle **four** interfaces, not two: Uniswap V3-style (`exactInputSingle`), Uniswap V4 (`PoolManager` with flash accounting and native-ETH currencies), Solidly/Aerodrome (`getAmountOut` + `swap`), and V2-style. 57% of observed arbitrage mixes versions, and 13.8% happens within one venue across fee tiers. |
| Multi-factory awareness | Aerodrome alone runs **three** Slipstream CL factories plus classic pools, and a separate fork with its own registry. Pool discovery must be factory-driven, not brand-driven. |
| Native-ETH handling | 10,463 of 36,403 Uniswap V4 pools (29%) use native ETH as a currency. |
| Funding integration | Optional, not mandatory — 95.7% of real operators use none. Build inventory-funded first. |
| Profitability guard | `require(balanceAfter > balanceBefore + costs)`. The course describes this but never shows it. At a $0.017 median margin it is not optional. |
| Slippage protection | The course leaves min-out at zero. With 49 operators on one pair, a zero min-out is an invitation to be sandwiched. |
| Revert conditions | Must revert rather than complete at a loss; gas on a revert is the designed downside. |
| Historical fork testing | Our validated quote engine already re-prices any V3-fork pool at any historical block — the hard part of a fork test is done and reusable. |

### The questions that actually gate this

The contract is not the blocker. These are, in order:

1. **Can we reach the same block as the trigger?** 65 of 68 opportunities required it. This needs facts about Base's sequencer: is there pre-confirmation visibility of pending transactions (Flashblocks or equivalent), what does it cost to access, and what end-to-end latency is achievable from where we would run?
2. **Can we win the priority-fee auction?** Base has no builder auction, but it has a clear fee race: **67.1%** of observed arbitrages paid more than 2× the 0.005 gwei base-fee floor, **24.1%** paid more than 10×, the 99th percentile was 3.98 gwei and the maximum 8.10 gwei — up to **1,620× the floor**. Ethereum's builder-payment economics do not transfer, but "pay to be ordered first" very much does, in a different form.
3. **Is there a slower niche?** 65 of 68 tested candidates were same-block. We tested the largest-profit candidates plus a random sample; if some corner of the chain moves slowly enough for a block-polling bot, we have not found it, and finding it would require widening the search rather than building.
4. **Does inventory-funded change the latency maths?** Skipping the flash-loan callback saves gas and transaction complexity, which may matter more for speed than for cost.

### Current status
**Blocked, intentionally.** Requirements documented; no implementation. The gate is unchanged: no Solidity until an opportunity survives Step 3.

### Next action
Answer question 1. It decides whether this strategy is reachable at all, and it is research, not engineering.

---

## Part 4 — What the real operators are doing

Method: scan every transaction in a block from its receipts, build each operator's complete balance sheet (ERC-20 transfers plus the native-ETH legs transfers cannot show), value every leg in USD at that block, and keep only transactions that close as self-funded cycles. Four windows of 250 blocks spread across ~24 hours, so the result is not a single moment.

**What was found and what was excluded:**

| | Count |
|---|---|
| Successful multi-swap transactions examined | 9,284 |
| **Self-funded atomic arbitrage** | **1,662** |
| Not materially profitable | 4,637 |
| Third-party funded (user swaps, aggregator routes, router fees) | 356 |
| Liquidity events (Mint/Burn/Collect/ModifyLiquidity) | 710 |
| Gains in two or more tokens at once (not a closed cycle) | 39 |
| **Unverified — could not be fully attributed** | **1,880 (20.3%)** |

The last three rows are the honest part. The 710 liquidity events and 39 multi-token rows are **excluded, not counted as profit**: an LP withdrawing a position produces a balance sheet that looks exactly like a large arbitrage, and earlier in this work five such transactions were briefly scored as $430,000 of "profit" before the guard was added. The 1,880 unverified transactions are **not counted either way** — they involve native-ETH movements or V4 pools we could not attribute from public endpoints.

**Who is doing it:**

- **131 distinct operator contracts** in 33 minutes.
- Concentration is low: the busiest operator accounts for 10.5% of arbitrages, the top five for 32.1%. This is a crowded field, not a cartel.
- The most profitable pattern is narrow specialisation. Operator `0x7f0d70ac…49da` ran **164 arbitrages on exactly one cycle** (USDC/AXIS) through exactly one venue combination (Uniswap V3 + V4), in 127 of 250 blocks, median net **$0.49**, total **$67.68** in eight minutes of chain time. That is the single best repeatable operation we observed — and the AXIS cycles we revalidated were all same-block backruns.

**Cost structure, measured from receipts:**

| | Median | 90th pct | Max |
|---|---|---|---|
| Gas used | 332,278 | 659,759 | 3,660,731 |
| Effective gas price (gwei) | 0.0165 | 0.4675 | 8.104 |
| Execution cost (USD) | $0.0159 | $0.4147 | $18.01 |
| L1 data fee as share of cost | **0.08%** | 23.05% | — |

**Base-specific execution mechanics — do not assume Ethereum's:**

- **No builder auction, but a real fee race.** Base has one sequencer and no MEV-Boost market, so there is no builder payment to carve out of profit. There is still competition for ordering, expressed as priority fee: two-thirds of arbitrages bid above 2× the fee floor and a quarter above 10×. The economics rhyme with Ethereum's; the mechanism is different.
- **Two fee components, and the L1 one is minor here.** Every receipt carries `l1Fee` alongside L2 execution gas. For a median *transaction* the L1 share is 39.9%; for a median *arbitrage* it is 0.08%, because arbitrage burns far more L2 gas. Both numbers are right; using the first for arbitrage cost modelling would be wrong.
- **Two-second blocks compress everything.** The same-block pattern is not incidental to Base — it is what a 2-second block with first-come ordering produces.

**Do opportunities repeat?** Yes, and that is the problem. AXIS/USDC saw 654 arbitrages across 274 blocks, with more than one in the same block in **166** of them and up to **9 in a single block**. Opportunities recur constantly and are contested immediately.

---

## Part 5 — Other arbitrage models, and whether any looks better

Kept on the roadmap, not implemented. Status from this round's evidence:

| Model | Evidence from this round | Looks more promising? |
|---|---|---|
| **Two-pool, same pair** (course model) | 73.5% of observed arbitrage; $558.51 of the $932.74 total net | Still the main event — but it fails the capture test |
| **Triangular / 3-pool** | 22.7% of arbitrage uses 3 swaps; median net $0.0126 vs $0.0187 for 2-swap | **No** — more complexity, lower median |
| **Multi-hop (4+)** | 3.8% of arbitrage; includes the single largest observed ($250.57 across 4 tokens) | Unclear — rare, occasionally large, not separately validated |
| **Same-block backrunning** | **65 of 68** validated candidates were this | **Yes, materially** — it is what actually works on Base, and it is a different architecture |
| **Pool-native credit** | Cheapest funding in gas where it applies | Worth testing *if* an opportunity validates |
| **Cross-quote** | Not tested | Unknown |
| **CEX–DEX** | Not tested; needs off-chain venue access and two-sided inventory | Unknown — outside this on-chain-only toolchain |

The honest reading: the one model the evidence actively points toward is **same-block backrunning**, which is not a variant of the course's strategy but a replacement for it, with a harder infrastructure requirement. That is a finding, not a recommendation to start building it.

---

## Part 7 — Stage gate

**The milestone was:** identify at least one historical arbitrage opportunity on Base that survives exact liquidity and fee validation, and show through transaction-aware simulation whether our proposed system could reasonably have captured it.

**Result: not met, with a clear and consistent reason.**

| Gate criterion | Result |
|---|---|
| Opportunities found on Base | **Yes** — 1,662 in 33 minutes, by 131 operators |
| Survive exact liquidity and fee validation at the moment they were taken | **Yes** — real, verified, profitable for whoever took them |
| Survive validation at the previous block boundary (when our design could see them) | **No — 0 of 68** |
| Could our proposed system have captured them | **No** — 65 of 68 required same-block reaction |

**Recommendation: do not proceed to contract implementation. Spend the next round on the latency and ordering question, not on Solidity.**

Because the blocker is a specific, answerable question rather than a general "it's too competitive," in priority order:

1. **Establish whether same-block execution is reachable for us on Base** (pre-confirmation/Flashblocks visibility, access cost, achievable latency from our infrastructure). This single question determines whether the whole strategy family is available. It is research.
2. **Widen the observation window before concluding anything about size.** We measured 33 minutes of chain time across 24 hours. Days of continuous observation would show whether any pocket of Base moves slowly enough for block-boundary capture, and would catch volatility regimes we did not sample. The tooling runs unattended.
3. **Re-run Ethereum through this same toolchain.** Stage 1's negative result came from one window on specific pairs, using weaker methods than we now have. We now have validated exact-quote maths, the balance-sheet detector and the capture test. Ethereum's 12-second blocks are six times longer than Base's — the same-block problem may bind differently there. This is cheap: a chain config and a run.
4. **Only then consider the model question.** If same-block execution proves out of reach, the choice is between a different architecture (backrunning) and a different strategy family — not a different token pair.

What we would *not* recommend: hunting more obscure tokens on Base. That hypothesis was tested directly. The long-tail tokens carrying the most arbitrage — AXIS, toby, LAPTOP, LMTS — are the most contested things on the chain, with up to 49 operators per pair.

---

## What we could not establish

Stated plainly, because these bound every conclusion above.

- **20.3% of multi-swap transactions (1,880) could not be fully attributed** and are excluded from all profit figures. Public endpoints offer no trace API and no state overrides, so native-ETH movements that are neither an ERC-20 transfer nor a WETH wrap are invisible.
- **The observation window is 33.2 minutes of chain time** (1,000 blocks in four windows across ~24 hours). It is spread deliberately, but it is not days of data. Rate and total figures are extrapolations and labelled as such.
- **One window collected poorly.** Window 53218040–53218289 yielded 4.0 multi-swap transactions per block against ~10 typical, consistent with partial RPC collection. Its counts are a floor, and the ranking file flags it.
- **68 candidates were revalidated, not all 1,662.** We tested the 48 largest-profit candidates plus a 20-candidate random sample to remove selection bias. The uniform result (0 of 68) makes a different conclusion from fuller coverage unlikely, but it is not proven.
- **A further 14 of the 82 candidates drawn were skipped, not tested.** Their two pools shared only one token, so they were not the clean two-pool cycle this step evaluates, or their pool metadata would not resolve. They are neither passes nor failures, and a two-pool-only gate cannot speak to them.
- **Ethereum swap activity by venue was not measured.** Free Ethereum endpoints refuse unfiltered log queries, so the comparison table has gaps on the Ethereum side. These are blanks, not zeros.
- **Brand attribution for factory `0x9cb22058…7a76` is from third-party references, not chain state.** What chain state proves is that it is a Slipstream-family fork with its own governance, separate from Aerodrome. Two further V3-fork factories remain unidentified by brand.
- **Stablecoins are assumed to be worth exactly $1.00.** A depeg would shift the stablecoin-cycle figures.
- **Aerodrome Slipstream charges a dynamic fee via a swap-fee module.** Our quotes use the pool's `fee()` at that block, which may differ from the fee the module applied, so Slipstream quotes carry more uncertainty than Uniswap ones.
- **Base's archive depth on public endpoints is about 50,000 blocks (~27 hours).** Validation cannot reach further back than that without a paid provider.
- **The 3 "unexplained" candidates** were not profitable beforehand and showed no same-block trigger on their pools. Our model does not account for them; they may involve a venue or mechanism we are not decoding.

---

## Evidence index

All measured data is in `../data/`, reproducible from public RPC with no API key.

| File | Contents |
|---|---|
| `chain-profile-base.json`, `chain-profile-ethereum.json` | Step 1 measurements |
| `forensics-base-53261540-53261789.json` | Window 1 (most recent) — 3,191 multi-swap txs, 624 arbitrages |
| `forensics-base-53247040-53247289.json` | Window 2 (~8h earlier) — 2,454 / 297 |
| `forensics-base-53232040-53232289.json` | Window 3 (~17h earlier) — 2,639 / 670 |
| `forensics-base-53218040-53218289.json` | Window 4 (~24h earlier) — 1,000 / 71 (low yield, flagged) |
| `ranking-base.json` | Steps 2, 3, 4 rankings, operator concentration |
| `validation-base-*.json` | The revalidation gate, per candidate, with capture verdicts |
| `funding-base.json` | Step 4 provider fees and capacity |
| `cache/v4-pools-base.json` | 36,403 Uniswap V4 pools; 10,463 use native ETH |
| `../registry.json` | The investigation ledger |

Key transaction hashes:

| Hash | Why it matters |
|---|---|
| `0xee4c1632051dcb45a9a23242936742c945190fa9c673d88421d063001c7223e4` | The clearest same-block case: $107.29 earned at index 366, seven earlier swaps on the same pools, −$3.39 at the previous block boundary |
| `0x8fe410623cfeb9b290b56fef435798ef2b3d99f77d859665f30a25aebb65bea0` | Why USD-denominated balance sheets are necessary: reads as +$1,499 on raw amounts, actually −$0.72 |
| `0x1cca6c64b46c1bdf5b5642a0ce0108fffe47d968d79369924048035c03cb6786` | Why liquidity events must be excluded: an LP withdrawal that scored as $121,240 of "arbitrage" before the guard |
| `0x7f0d70ac761b496ebf9cf32f399f704fb8c449da` (contract) | The specialist: 164 arbitrages, one cycle, one venue combination, $67.68 |

Reproduce with `scripts/03-validate-quotemath.mjs` first — if the 32 quote cases do not match the deployed Uniswap quoter exactly, nothing downstream should be trusted.
