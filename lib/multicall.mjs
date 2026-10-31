// Multicall3 aggregate3 batching.
//
// This is the primitive that makes market-wide discovery affordable. A single
// eth_call carrying 500 aggregate3 sub-calls returns in ~150ms, and several of
// those run in parallel, so a public endpoint sustains roughly 4,800 contract
// reads per second. Measured, not assumed: see data/enumeration-<chain>.json
// and reports/stage3-coverage-audit.md.
//
// allowFailure is always true. A pool that reverts on `fee()` is a fact about
// that pool, not a transport failure, and must not abort a 500-call batch.

import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

const MC_ABI = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);

export class Multicall {
  constructor(rpc, address, { batch = 500, parallel = 6 } = {}) {
    if (!address) throw new Error('multicall3 address required');
    this.rpc = rpc; this.address = address;
    this.batchSize = batch; this.parallel = parallel;
    this.stats = { batches: 0, reads: 0, failed: 0, fallback: 0 };
  }

  // calls: [{ target, callData }]  ->  ['0x..' | null] aligned to input order.
  // null means the sub-call reverted or returned nothing.
  async read(calls, { block = 'latest', onProgress = null } = {}) {
    const out = new Array(calls.length).fill(null);
    const chunks = [];
    for (let i = 0; i < calls.length; i += this.batchSize) chunks.push(i);

    let done = 0;
    for (let c = 0; c < chunks.length; c += this.parallel) {
      const group = chunks.slice(c, c + this.parallel);
      await Promise.all(group.map(async (start) => {
        const slice = calls.slice(start, start + this.batchSize);
        const decoded = await this.#oneBatch(slice, block);
        decoded.forEach((v, k) => { out[start + k] = v; });
      }));
      done += group.reduce((a, s) => a + Math.min(this.batchSize, calls.length - s), 0);
      if (onProgress) onProgress(done, calls.length);
    }
    return out;
  }

  async #oneBatch(slice, block) {
    const payload = slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }));
    this.stats.batches++; this.stats.reads += slice.length;
    const r = await this.rpc.ethCall(
      this.address,
      encodeFunctionData({ abi: MC_ABI, functionName: 'aggregate3', args: [payload] }),
      block,
    );
    if (!r.error && r.result && r.result !== '0x') {
      try {
        const rows = decodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', data: r.result });
        return rows.map((row) => {
          if (!row.success || !row.returnData || row.returnData === '0x') { this.stats.failed++; return null; }
          return row.returnData;
        });
      } catch { /* fall through to split */ }
    }
    // A whole batch that fails is usually a response-size or gas limit, not a
    // bad sub-call. Halve and retry; at size 1 fall back to a plain eth_call so
    // one pathological contract cannot blank out 499 good reads.
    if (slice.length === 1) {
      this.stats.fallback++;
      const d = await this.rpc.ethCall(slice[0].target, slice[0].callData, block);
      if (d.error || !d.result || d.result === '0x') { this.stats.failed++; return [null]; }
      return [d.result];
    }
    const mid = Math.ceil(slice.length / 2);
    const [a, b] = await Promise.all([
      this.#oneBatch(slice.slice(0, mid), block),
      this.#oneBatch(slice.slice(mid), block),
    ]);
    return [...a, ...b];
  }
}

// Read one no-argument view off many contracts.
export function fieldCalls(addresses, abi, functionName) {
  const callData = encodeFunctionData({ abi, functionName });
  return addresses.map((target) => ({ target, callData }));
}

export function decodeField(abi, functionName, data) {
  if (data == null) return undefined;
  try { return decodeFunctionResult({ abi, functionName, data }); } catch { return undefined; }
}
