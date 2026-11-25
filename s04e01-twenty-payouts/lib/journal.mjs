// Append-only JSONL journal. Every request and reply is written here with secrets masked.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(DESK, 'journal', 'journal.jsonl');

export function secretValues() {
  try {
    const raw = JSON.parse(readFileSync(join(DESK, 'vars.json'), 'utf8'));
    return Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.length >= 6 && !/^<.*>$/.test(v));
  } catch { return []; }
}

/** Replaces every secret value (also URL-encoded) with {{NAME}}. */
export function mask(text, secrets = secretValues()) {
  let s = String(text);
  for (const [k, v] of secrets) s = s.split(v).join(`{{${k}}}`).split(encodeURIComponent(v)).join(`{{${k}}}`);
  return s;
}

export function log(entry) {
  mkdirSync(dirname(FILE), { recursive: true });
  const line = mask(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  appendFileSync(FILE, line + '\n');
}

export function readAll() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
