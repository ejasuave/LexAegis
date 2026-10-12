import { checkExactResource, type Guarded } from './guards';

/*
 * Cleanup may remove only exact resources created and recorded by THIS run. The ledger refuses to
 * record a wildcard, never lists a shared database or bucket, and runs each cleanup once, newest first.
 */

export interface LedgerEntry {
  readonly kind: string;
  readonly name: string;
  readonly cleanup: () => Promise<void> | void;
}

export class ResourceLedger {
  readonly #entries: LedgerEntry[] = [];
  readonly #cleaned = new Set<string>();

  record(entry: LedgerEntry): Guarded {
    const guard = checkExactResource(entry.name);
    if (!guard.ok) return guard;
    this.#entries.push(entry);
    return { ok: true };
  }

  get recorded(): readonly string[] {
    return this.#entries.map((entry) => `${entry.kind}:${entry.name}`);
  }

  /** Removes exactly what was recorded, newest first. A failing cleanup does not hide the others. */
  async cleanup(): Promise<readonly string[]> {
    const failures: string[] = [];
    for (const entry of [...this.#entries].reverse()) {
      const key = `${entry.kind}:${entry.name}`;
      if (this.#cleaned.has(key)) continue;
      this.#cleaned.add(key);
      try {
        await entry.cleanup();
      } catch {
        failures.push(key);
      }
    }
    return failures;
  }
}
