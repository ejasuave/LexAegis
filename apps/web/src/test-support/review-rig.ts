import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import { runTextDiff } from '@lexaegis/agent/review';
import { extractPdf, type ExtractIdentity, type PdfjsLike } from '@/features/documents/extract';
import { PdfIntake, type WorkerLike } from '@/features/documents/pdf-intake';
import { ReviewController, type ReviewDeps } from '@/features/review/controller';
import type { VaultOutcome } from '@/features/vault/vault-controller';
import {
  createVaultHarness,
  withVault,
  type VaultHarness,
  type VaultHarnessOptions,
} from './vault-harness';

/*
 * lexaegis-test-only
 * Test rig: the real review controller on the real account and vault controllers (real Web
 * Crypto, in-memory server) with real synthetic PDFs parsed by the real pdf.js. The "worker" is
 * an in-process stand-in that runs the same extraction code. Test code only; not real-device evidence.
 */
const pdfjs = pdfjsModule as unknown as PdfjsLike;
const dir = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/documents-v1/pdfs',
);
export const pdf = (name: string) => new Uint8Array(readFileSync(join(dir, `${name}.pdf`)));
export const must = <T>(outcome: VaultOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.failure}`);
  return outcome.data;
};
export const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export const port = (h: VaultHarness) => ({
  getSnapshot: () => h.vault.getSnapshot(),
  subscribe: (listener: () => void) => h.vault.subscribe(listener),
  commands: h.vault,
});

/** Runs extraction in-process behind the worker interface. */
export class InlineWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  hold: Promise<void> | null = null;
  postMessage(message: unknown): void {
    const { job, bytes, identity } = message as {
      job: string;
      bytes: Uint8Array;
      identity: ExtractIdentity;
    };
    void (async () => {
      const outcome = await extractPdf(pdfjs, bytes, identity);
      await this.hold;
      if (!this.terminated) this.onmessage?.({ data: { job, outcome } });
    })();
  }
  terminate(): void {
    this.terminated = true;
  }
}

export interface Rig {
  readonly h: VaultHarness;
  readonly controller: ReviewController;
  readonly workers: InlineWorker[];
  readonly matterId: string;
}

export async function rig(
  options: { holdWorkers?: boolean; harness?: VaultHarnessOptions } = {},
): Promise<Rig> {
  const h = await withVault(createVaultHarness(options.harness));
  const matterId = must(await h.vault.createMatter('Synthetic review matter'));
  const workers: InlineWorker[] = [];
  const intake = new PdfIntake({
    createWorker: () => {
      const worker = new InlineWorker();
      if (options.holdWorkers) worker.hold = new Promise(() => undefined);
      workers.push(worker);
      return worker;
    },
    generation: () => h.vault.getSnapshot().generation,
    assets: {},
  });
  const deps: ReviewDeps = {
    vault: port(h),
    account: () => h.controller.getSnapshot().account?.address ?? null,
    intake,
    runDiff: (a, b) => ({ promise: Promise.resolve(runTextDiff(a, b)), cancel: () => undefined }),
    now: () => new Date(h.clock.now),
    newId: () => crypto.randomUUID(),
  };
  const controller = new ReviewController(deps);
  h.vault.selectMatter(matterId);
  await wait(20);
  return { h, controller, workers, matterId };
}

export async function importAndWait(r: Rig, name: string) {
  await r.controller.importPdf({ bytes: pdf(name), label: `${name}.pdf` });
  const snapshot = r.controller.getSnapshot();
  const doc = snapshot.documents.find((d) => d.label === `${name}.pdf`);
  if (doc === undefined) throw new Error(`not imported: ${JSON.stringify(snapshot.intake)}`);
  return doc;
}

export function range(text: string, quote: string): { start: number; end: number } {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`no ${quote}`);
  return { start, end: start + quote.length };
}

export async function confirm(
  r: Rig,
  documentVersionId: string,
  spec: { field: string; slot: string; value: string; quote: string; page: number },
) {
  const text = r.controller.extraction(documentVersionId)?.pages[spec.page - 1]?.text ?? '';
  const made = r.controller.createReference({
    documentVersionId,
    page: spec.page,
    ...range(text, spec.quote),
  });
  if (!made.ok) throw new Error(made.code);
  return r.controller.confirmFact({
    candidate: {
      schema: 'lexaegis.fact-candidate.v1',
      factId: crypto.randomUUID(),
      matterId: r.matterId,
      field: spec.field,
      group: 'settlement',
      slot: spec.slot,
      value: spec.value,
      provenance: 'reviewer_selection',
      references: [made.data],
    },
    basis: 'source',
    statementReason: null,
  });
}
