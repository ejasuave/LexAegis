/*
 * The body of the live smoke check, separated from its command-line wrapper so the same code can
 * be exercised against the loopback scripted provider in tests. What kind of evidence a record is
 * ("live" or "scripted") is stated by the caller and written into the record; a scripted run can
 * never be recorded as live.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  DEFAULT_ADMISSION,
  DEFAULT_BUDGET,
  createReviewAgent,
  runCapabilityChecks,
  type CapabilityRecord,
  type ChatProvider,
  type RunStore,
} from '@lexaegis/agent';
import type {
  AssistantEvent,
  AssistantRequest,
  SourceReferenceV1,
} from '@lexaegis/agent/contracts';
import {
  buildSelectedContext,
  buildSnapshot,
  confirmFact,
  createSourceReference,
  disclosureDigest,
  loadRulePack,
  sha256Bytes,
  snapshotDigest,
  verifySourceSet,
} from '@lexaegis/agent/review';
import { extractPdf, type PdfjsLike } from '../src/features/documents/extract';

export const SMOKE_FIXTURE = 'fixtures/documents-v1/pdfs/discrepancy-2000.pdf';

export interface SmokeAssertion {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmokeOptions {
  readonly root: string;
  readonly provider: ChatProvider;
  readonly store: RunStore;
  /** Whether the capability record reaches the application's database. */
  readonly storedForApplication: boolean;
  /** "live" only for the real configured Qwen endpoint. */
  readonly evidenceKind: 'live' | 'scripted';
  readonly now: () => Date;
  /** The request text of the run that is cancelled. */
  readonly cancelUtterance?: string;
  readonly log?: (line: string) => void;
}

export interface SmokeResult {
  readonly outcome: 'pass' | 'fail';
  readonly record: Record<string, unknown>;
  readonly assertions: readonly SmokeAssertion[];
  readonly capability: CapabilityRecord;
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const { provider, store, now } = options;
  const log = options.log ?? (() => undefined);
  const ROOT = options.root;
  const FIXTURE = SMOKE_FIXTURE;
  const descriptor = {
    id: provider.descriptor.id,
    region: provider.descriptor.region,
    requestedModel: provider.descriptor.model,
    outputMode: provider.descriptor.outputMode,
  };

  // ---- 1. Capability checks -------------------------------------------------------------------------

  log(
    `capability checks: ${descriptor.requestedModel} (${descriptor.region}, ${descriptor.outputMode})`,
  );
  const capability: CapabilityRecord = await runCapabilityChecks(provider, {
    now,
    signal: AbortSignal.timeout(90_000),
  });
  await store.saveCapability(capability);
  const base = {
    schema: 'lexaegis.qwen-smoke.v1',
    evidenceKind: options.evidenceKind,
    executedAt: now().toISOString(),
    command: 'pnpm qwen:smoke',
    provider: descriptor,
    fixture: { path: FIXTURE, kind: 'synthetic_fixture' },
    capability: {
      ...capability,
      storedForApplication: options.storedForApplication,
      note: !options.storedForApplication
        ? 'DATABASE_URL was not set: the record was not stored, so the application still treats this configuration as unverified.'
        : 'Stored by configuration fingerprint. A changed endpoint, model or output mode has no record.',
    },
  };
  if (!capability.verified) {
    return {
      outcome: 'fail',
      capability,
      assertions: [],
      record: {
        ...base,
        outcome: 'fail',
        reasons: capability.failures,
        note: 'The configured endpoint, model and output mode did not pass the capability checks. No fallback was tried.',
      },
    };
  }

  // ---- Synthetic matter from the Chapter 8 fixture -----------------------------------------------------

  const MATTER = '5a11c0de-0000-4000-8000-000000000001';
  const REVIEWER = `0x${'5e'.repeat(20)}`;
  const ids = {
    documentId: randomUUID(),
    documentVersionId: randomUUID(),
    sourceArtifactId: randomUUID(),
  };
  const sourceBytes = new Uint8Array(readFileSync(join(ROOT, FIXTURE)));
  const sourceSha256 = await sha256Bytes(sourceBytes);
  const extraction = await extractPdf(pdfjsModule as unknown as PdfjsLike, sourceBytes, {
    ...ids,
    sourceSha256,
  });
  if (extraction.kind !== 'extracted' && extraction.kind !== 'partial_coverage')
    throw new Error(`fixture extraction failed: ${extraction.kind}`);
  const set = await verifySourceSet(
    MATTER,
    [
      {
        ...ids,
        sourceSha256,
        sourceBytes,
        extractionArtifactId: randomUUID(),
        extractionSha256: await sha256Bytes(extraction.bytes),
        extractionBytes: extraction.bytes,
      },
    ],
    [ids.documentVersionId],
  );
  if (!set.ok) throw new Error(`fixture verification failed: ${set.code}`);
  const pageText = set.data.sources.get(ids.documentVersionId)?.extraction.pages[1]?.text ?? '';
  const refOf = (quote: string): SourceReferenceV1 => {
    const start = pageText.indexOf(quote);
    const made = createSourceReference(set.data, {
      documentVersionId: ids.documentVersionId,
      page: 2,
      start,
      end: start + quote.length,
    });
    if (!made.ok) throw new Error(`fixture reference failed: ${made.code}`);
    return made.data;
  };
  const refs = {
    total: refOf('24,000'),
    first: refOf('10,000'),
    second: refOf('12,000'),
    basis: refOf('gross'),
  };
  const fact = async (field: string, slot: string, value: string, reference: SourceReferenceV1) => {
    const made = await confirmFact({
      set: set.data,
      candidate: {
        schema: 'lexaegis.fact-candidate.v1',
        factId: randomUUID(),
        matterId: MATTER,
        field,
        group: 'settlement',
        slot,
        value,
        provenance: 'reviewer_selection',
        references: [reference],
      },
      basis: 'source',
      statementReason: null,
      confirmedBy: REVIEWER,
      confirmedAt: now().toISOString(),
      existing: [],
    });
    if (!made.ok) throw new Error(`fixture fact failed: ${made.code}`);
    return made.data;
  };
  const facts = [
    await fact('payment_total', 'total', '2400000', refs.total),
    await fact('payment_instalment', 'i1', '1000000', refs.first),
    await fact('payment_instalment', 'i2', '1200000', refs.second),
    await fact('payment_basis', 'basis', 'gross', refs.basis),
  ];
  const rulePack = await loadRulePack();
  if (!rulePack.ok) throw new Error('rule pack invalid');
  const digest = await snapshotDigest(
    buildSnapshot({
      matterId: MATTER,
      sources: [...set.data.sources.values()].map((source) => ({
        documentVersionId: source.documentVersionId,
        sourceSha256: source.sourceSha256,
        extractionSha256: source.extractionSha256,
      })),
      facts,
      evidence: [],
      rulePackDigest: rulePack.data.digest,
      reviewRecordState: 'demo_draft',
    }),
  );
  const context = buildSelectedContext(set.data, {
    documentVersionId: ids.documentVersionId,
    references: Object.values(refs),
    facts,
    evidence: [],
    savedContext: [],
  });
  if (!context.ok) throw new Error(`fixture context failed: ${context.code}`);
  const scope = {
    provider: provider.descriptor.id,
    model: provider.descriptor.model,
    region: provider.descriptor.region,
  };

  async function request(
    intent: AssistantRequest['intent'],
    utterance: string,
  ): Promise<AssistantRequest> {
    if (!context.ok) throw new Error('no context');
    const body = {
      schema: 'lexaegis.assistant-request.v1' as const,
      clientRequestId: randomUUID(),
      matterId: MATTER,
      documentVersionId: ids.documentVersionId,
      snapshot: { digest, revision: 1 },
      vaultGeneration: 1,
      intent,
      trigger: 'ui_action' as const,
      utterance,
      context: context.data,
      history: [],
      clientObserved: null,
    };
    return {
      ...body,
      consent: {
        schema: 'lexaegis.disclosure-consent.v1',
        action: 'explicit_send',
        providerScope: scope,
        matterId: MATTER,
        documentVersionId: ids.documentVersionId,
        disclosureDigest: await disclosureDigest(body, scope),
        consentedAt: now().toISOString(),
      },
    };
  }

  const agent = createReviewAgent({
    provider,
    store,
    status: { liveChain: () => Promise.resolve('unknown') },
    budget: DEFAULT_BUDGET,
    admission: DEFAULT_ADMISSION,
    flags: { briefingEnabled: true },
    notices: [],
    now,
    newId: () => randomUUID(),
  });
  const session = (signal: AbortSignal) => ({
    ownerId: REVIEWER,
    signal,
    sessionValid: () => Promise.resolve(true),
  });

  // ---- 2. A run in which the model requests tools and code executes them -------------------------------

  log('run 1: briefing over the synthetic fixture');
  const first = await agent.start(
    await request(
      'brief_matter',
      'Brief me: what does the payment clause say, do the instalments add up, and what evidence is missing?',
    ),
    session(new AbortController().signal),
  );
  if (!first.ok) throw new Error(`run 1 was not admitted: ${first.error.code}`);
  const events: AssistantEvent[] = [];
  for await (const event of first.data.events ?? []) events.push(event);
  const terminal = events.at(-1);
  const tools = events.flatMap((event) =>
    event.type === 'tool_result' ? [event.payload.result] : [],
  );
  const blocks = events.flatMap((event) =>
    event.type === 'response_delta' ? [event.payload.block] : [],
  );
  const summary = events.find((event) => event.type === 'response_completed');
  const response = summary?.type === 'response_completed' ? summary.payload.summary : null;
  const completed = terminal?.type === 'run_completed' ? terminal.payload : null;
  const payment = tools.find((tool) => tool.output?.tool === 'check_payments');
  const evidence = tools.find((tool) => tool.output?.tool === 'check_evidence');
  const paymentResult = payment?.output?.tool === 'check_payments' ? payment.output.result : null;
  const missing =
    evidence?.output?.tool === 'check_evidence'
      ? evidence.output.items.filter(
          (item) => item.state === 'missing' || item.state === 'not_assessed',
        ).length
      : 0;
  const cited = blocks.some(
    (block) => block.kind === 'quotation' || ('sources' in block && block.sources.length > 0),
  );
  const assertions: SmokeAssertion[] = [
    {
      id: 'run_completed_with_validated_output',
      ok: completed !== null && blocks.length > 0,
      detail:
        terminal?.type === 'run_failed'
          ? terminal.payload.failure
          : (terminal?.type ?? 'no terminal event'),
    },
    {
      id: 'model_requested_two_read_only_tools',
      ok:
        new Set(tools.filter((tool) => tool.outcome === 'succeeded').map((tool) => tool.toolName))
          .size >= 2,
      detail: tools.map((tool) => `${tool.handle}:${tool.toolName}:${tool.outcome}`).join(', '),
    },
    {
      id: 'answer_cites_resolvable_sources',
      ok: cited,
      detail: `${String(blocks.length)} validated blocks`,
    },
    {
      id: 'payment_discrepancy_or_evidence_gap_from_code',
      ok: paymentResult?.differencePence === '200000' || missing > 0,
      detail: `differencePence=${paymentResult?.differencePence ?? 'none'}; evidenceGaps=${String(missing)}`,
    },
    {
      id: 'scope_limitations_stated',
      ok: (response?.scopeLimitations.length ?? 0) > 0,
      detail: `${String(response?.scopeLimitations.length ?? 0)} limitation(s)`,
    },
    {
      id: 'user_input_requirement',
      ok:
        response !== null &&
        (response.outcome === 'needs_input' ||
          response.unresolved.length + response.questions.length + response.factProposals.length >
            0 ||
          missing > 0),
      detail: `outcome=${response?.outcome ?? 'none'}; unresolved=${String(response?.unresolved.length ?? 0)}; questions=${String(response?.questions.length ?? 0)}`,
    },
  ];

  // ---- 3. Controlled cancellation -----------------------------------------------------------------------

  log('run 2: cancellation during a provider wait');
  const second = await agent.start(
    // Long enough a task that the provider is still being waited on when Stop arrives.
    await request(
      'summarise',
      options.cancelUtterance ?? 'Summarise the selected clauses in detail.',
    ),
    session(new AbortController().signal),
  );
  let cancellation: Record<string, unknown>;
  if (!second.ok) {
    cancellation = { admitted: false, code: second.error.code };
    assertions.push({ id: 'cancellation_acknowledged', ok: false, detail: second.error.code });
  } else {
    const cancelEvents: AssistantEvent[] = [];
    const reading = (async () => {
      for await (const event of second.data.events ?? []) cancelEvents.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stop = await agent.cancel(
      { runId: second.data.metadata.runId, ownerId: REVIEWER },
      new AbortController().signal,
    );
    await reading;
    const last = cancelEvents.at(-1);
    const acknowledged = last?.type === 'run_cancelled';
    cancellation = {
      admitted: true,
      runId: second.data.metadata.runId,
      cancelState: stop.ok ? stop.data.state : stop.error.code,
      terminalEvent: last?.type ?? 'none',
      usage: last !== undefined && 'metadata' in last.payload ? last.payload.metadata.usage : null,
      note: 'A request already submitted may still be billed. Cancellation cannot retract text already sent.',
    };
    assertions.push({
      id: 'cancellation_acknowledged',
      ok: acknowledged,
      detail: `terminal=${last?.type ?? 'none'}`,
    });
  }

  const ok = assertions.every((assertion) => assertion.ok);
  return {
    outcome: ok ? 'pass' : 'fail',
    capability,
    assertions,
    record: {
      ...base,
      outcome: ok ? 'pass' : 'fail',
      run: {
        runId: first.data.metadata.runId,
        intent: 'brief_matter',
        terminalEvent: terminal?.type ?? 'none',
        failure: terminal?.type === 'run_failed' ? terminal.payload.failure : null,
        agentConfig: completed?.agentConfig ?? null,
        functionCalls: tools.map((tool) => ({
          handle: tool.handle,
          name: tool.toolName,
          version: tool.toolVersion,
          outcome: tool.outcome,
          code: tool.code,
          result:
            tool.output?.tool === 'check_payments'
              ? tool.output.result
              : tool.output?.tool === 'check_evidence'
                ? { assessed: tool.output.assessed, items: tool.output.items }
                : tool.output?.tool === 'read_sources'
                  ? { handles: tool.output.sources.map((source) => source.handle) }
                  : (tool.output ?? null),
        })),
        response: response === null ? null : { ...response, blocks },
      },
      cancellation,
      assertions,
      limits: [
        'One run and one cancellation on one synthetic fixture. This is not evidence of production reliability or of real users.',
        'Validation shows reference integrity and schema conformance, not that an answer is right.',
        'Model output is not reproducible; another run may differ.',
      ],
    },
  };
}
