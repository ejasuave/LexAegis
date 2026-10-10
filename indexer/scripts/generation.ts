import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { indexerRoot } from './binding';

const FILE = resolve(indexerRoot, '.generation');
const PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export const newGeneration = (): string => `gen-${randomUUID()}`;

/** Stable across restarts: created once, changed only by an explicit rebuild. */
export function readOrCreateGeneration(): string {
  if (existsSync(FILE)) {
    const value = readFileSync(FILE, 'utf8').trim();
    if (!PATTERN.test(value)) throw new Error('GENERATION_INVALID: .generation is malformed');
    return value;
  }
  const value = newGeneration();
  writeFileSync(FILE, `${value}\n`);
  return value;
}

export function writeGeneration(value: string): void {
  if (!PATTERN.test(value)) throw new Error('GENERATION_INVALID');
  writeFileSync(FILE, `${value}\n`);
}
