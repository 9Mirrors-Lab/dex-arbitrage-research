// Chain-agnostic JSON-RPC client: provider failover, concurrency cap, retries.
// Deliberately dependency-light so every result in this repo is reproducible
// from a public endpoint with no API key.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadChain(id) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'chains', `${id}.json`), 'utf8'));
  cfg.tokenByAddress = {};
  for (const [sym, t] of Object.entries(cfg.tokens ?? {})) {
    cfg.tokenByAddress[t.address.toLowerCase()] = { symbol: sym, ...t };
  }
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Rpc {
  constructor(urls, { concurrency = 4, timeoutMs = 30000, retries = 3 } = {}) {
    this.urls = Array.isArray(urls) ? urls.slice() : [urls];
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.active = 0;
    this.queue = [];
    this.stats = { calls: 0, errors: 0, retries: 0, byUrl: {} };
  }

  async #slot() {
    if (this.active < this.concurrency) { this.active++; return; }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }

  #release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  // Single call, rotating providers on failure. `preferUrl` pins a provider
  // when a method is only supported there.
  async call(method, params = [], { preferUrl = null, allowError = false } = {}) {
    await this.#slot();
    try {
      const urls = preferUrl ? [preferUrl, ...this.urls.filter((u) => u !== preferUrl)] : this.urls;
      let lastErr = null;
      for (let attempt = 0; attempt < this.retries; attempt++) {
        for (const url of urls) {
          this.stats.calls++;
          this.stats.byUrl[url] = (this.stats.byUrl[url] ?? 0) + 1;
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
            let res;
            try {
              res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: ctrl.signal,
              });
            } finally { clearTimeout(timer); }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (body.error) {
              // A revert or an "execution reverted" is a real answer, not a
              // transport failure: surface it instead of rotating providers.
              const msg = String(body.error.message ?? '');
              if (allowError || /revert|invalid opcode|out of gas/i.test(msg)) {
                return { error: body.error };
              }
              throw new Error(msg || 'rpc error');
            }
            return { result: body.result };
          } catch (e) {
            lastErr = e;
            this.stats.errors++;
          }
        }
        this.stats.retries++;
        await sleep(250 * 2 ** attempt);
      }
      throw new Error(`${method} failed on all providers: ${lastErr?.message}`);
    } finally {
      this.#release();
    }
  }

  async get(method, params = [], opts = {}) {
    const r = await this.call(method, params, opts);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }

  // Batched JSON-RPC (array body). Falls back to sequential calls when a
  // provider rejects batches.
  async batch(calls, { preferUrl = null, chunk = 40 } = {}) {
    const out = new Array(calls.length);
    for (let i = 0; i < calls.length; i += chunk) {
      const slice = calls.slice(i, i + chunk);
      let ok = false;
      const urls = preferUrl ? [preferUrl, ...this.urls.filter((u) => u !== preferUrl)] : this.urls;
      for (const url of urls) {
        await this.#slot();
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
          let res;
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(slice.map((c, k) => ({ jsonrpc: '2.0', id: k, method: c.method, params: c.params ?? [] }))),
              signal: ctrl.signal,
            });
          } finally { clearTimeout(timer); }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (!Array.isArray(body)) throw new Error('non-array batch response');
          this.stats.calls += slice.length;
          for (const row of body) out[i + row.id] = row.error ? { error: row.error } : { result: row.result };
          ok = true;
        } catch { this.stats.errors++; } finally { this.#release(); }
        if (ok) break;
      }
      if (!ok) {
        const seq = await Promise.all(slice.map((c) => this.call(c.method, c.params ?? [], { allowError: true })));
        seq.forEach((r, k) => { out[i + k] = r; });
      }
    }
    return out;
  }

  // ---- convenience wrappers -------------------------------------------------
  async blockNumber() { return Number(BigInt(await this.get('eth_blockNumber'))); }

  async getBlock(num, full = false) {
    return this.get('eth_getBlockByNumber', [toHex(num), full]);
  }

  async getBlockReceipts(num) {
    return this.get('eth_getBlockReceipts', [toHex(num)]);
  }

  async ethCall(to, data, block = 'latest') {
    const r = await this.call('eth_call', [{ to, data }, typeof block === 'number' ? toHex(block) : block]);
    return r.error ? { error: r.error } : { result: r.result };
  }

  async getLogs(params) { return this.get('eth_getLogs', [params]); }
}

export const toHex = (n) => (typeof n === 'string' ? n : `0x${BigInt(n).toString(16)}`);
export const fromHex = (h) => (h == null ? 0n : BigInt(h));
export const num = (h) => Number(BigInt(h ?? 0));
