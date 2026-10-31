// The investigation ledger. Every claim in the reports should trace back to a
// row here, and every row should carry the evidence that justifies its status.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = join(ROOT, 'registry.json');

export const STATUS = {
  NOT_TESTED: 'NOT TESTED',
  INVESTIGATING: 'INVESTIGATING',
  VALIDATION_REQUIRED: 'VALIDATION REQUIRED',
  FAILED: 'FAILED',
  PROMISING: 'PROMISING',
  VALIDATED: 'VALIDATED',
};

// VALIDATED is deliberately hard to reach. All four must hold.
export const VALIDATION_CRITERIA = {
  exactQuote: 'Both legs priced by an exact on-chain call (quoter or pool math) at a specific historical block.',
  netPositive: 'Net profit > 0 after swap fees, funding fee, L2 execution gas and L1 data fee, at an executable size.',
  sizeRealistic: 'The profitable size is reachable with available funding and does not exceed measured pool depth.',
  captureShown: 'Transaction-aware simulation shows our system could have been the one to take it (ordering + latency + no prior taker in the same block).',
};

const EMPTY = { version: 2, updatedAt: null, chains: {}, dexCombos: {}, pairs: {}, funding: {}, models: {} };

export function load() {
  if (!existsSync(PATH)) return structuredClone(EMPTY);
  return JSON.parse(readFileSync(PATH, 'utf8'));
}

export function save(reg) {
  reg.updatedAt = new Date().toISOString();
  writeFileSync(PATH, `${JSON.stringify(reg, null, 2)}\n`);
  return reg;
}

export function setEntry(reg, section, key, patch) {
  reg[section] ??= {};
  const prev = reg[section][key] ?? { status: STATUS.NOT_TESTED, evidence: [], history: [] };
  const next = { ...prev, ...patch };
  if (patch.status && patch.status !== prev.status) {
    next.history = [...(prev.history ?? []), { at: new Date().toISOString(), from: prev.status, to: patch.status }];
  }
  if (next.status === STATUS.VALIDATED) {
    const met = next.criteriaMet ?? {};
    const missing = Object.keys(VALIDATION_CRITERIA).filter((c) => met[c] !== true);
    if (missing.length) {
      // Refuse to mint a VALIDATED row that cannot show its work.
      next.status = STATUS.VALIDATION_REQUIRED;
      next.downgradedBecause = `criteria not met: ${missing.join(', ')}`;
    }
  }
  reg[section][key] = next;
  return next;
}

export function addEvidence(reg, section, key, item) {
  const row = reg[section]?.[key];
  if (!row) return;
  row.evidence = [...(row.evidence ?? []), item];
}
