'use client';

import type { AnswerBlock, StatusReading, ToolResult } from '@lexaegis/agent/contracts';
import { formatGbp } from '@lexaegis/agent/review';
import type { LocalStatus, RunView } from '@/features/assistant/public';
import { Icon } from '@/components/shell/icons';
import { ReadAloudButton } from '@/components/voice/ReadAloud';
import { orbLabel } from './AssistantOrb';

/*
 * One run, as validated data. Text from a model is rendered as plain text only: never as HTML or
 * Markdown, never as a link, and never as something that acts by itself. Figures and status
 * readings come from the referenced tool result, not from what the model wrote.
 */

const small = 'm-0 mt-1 text-[0.8125rem] text-lj-secondary';
const chip = 'min-h-11 rounded border border-lj-edge px-3 text-[0.8125rem]';

const BASIS = {
  supported: 'Supported by the cited references',
  interpretation: 'Interpretation',
  uncertain: 'Uncertain',
} as const;

const INCOMPLETE = {
  stream_gap: 'Incomplete: part of the run stream was missing.',
  stream_lost: 'Incomplete: the connection to the run was lost. Its outcome is unknown.',
  malformed_event: 'Incomplete: the run stream was invalid.',
  stopped: 'Stopped before finishing. What is shown below is incomplete.',
} as const;

function providerLabel(run: RunView): string {
  if (run.origin === 'local')
    return 'Checked on this device. No model was used and nothing was sent.';
  if (run.modelExecution === 'none') return 'Answered by application code. No model was used.';
  if (run.modelExecution === 'scripted-test') return 'Scripted test provider (not Qwen).';
  if (run.modelExecution === 'pending') return 'Aegis';
  return `Aegis, using Qwen (${run.agentConfig?.provider?.requestedModel ?? 'configured model'}).`;
}

function PaymentCard({ tool }: { tool: ToolResult }) {
  if (tool.output?.tool !== 'check_payments') return null;
  const r = tool.output.result;
  const pounds = (value: string | null) => (value === null ? 'not available' : formatGbp(value));
  const difference =
    r.differencePence === null ? 'not available' : formatGbp(r.differencePence.replace('-', ''));
  return (
    <dl
      className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.875rem]"
      data-testid="payment-result"
      data-outcome={r.outcome}
      data-difference={r.differencePence ?? ''}
    >
      <dt className="text-lj-secondary">Outcome</dt>
      <dd className="m-0">{r.outcome.replaceAll('_', ' ')}</dd>
      <dt className="text-lj-secondary">Stated total</dt>
      <dd className="m-0">{pounds(r.statedTotalPence)}</dd>
      <dt className="text-lj-secondary">Instalments total</dt>
      <dd className="m-0">{pounds(r.comparableSumPence)}</dd>
      <dt className="text-lj-secondary">Difference</dt>
      <dd className="m-0">{difference}</dd>
      {r.reasons.length > 0 ? (
        <>
          <dt className="text-lj-secondary">Needs</dt>
          <dd className="m-0">{r.reasons.join(', ').replaceAll('_', ' ')}</dd>
        </>
      ) : null}
    </dl>
  );
}

function StatusCard({
  reading,
  local,
}: {
  reading: StatusReading | null;
  local: LocalStatus | null;
}) {
  const client = reading?.client ?? local?.client ?? null;
  const rows: [string, string][] = [];
  if (reading !== null) {
    rows.push([
      'Assistant (server)',
      `${reading.assistant.provider}, ${reading.assistant.capability}`,
    ]);
    rows.push(['Live chain (server)', reading.liveChain.state.replaceAll('_', ' ')]);
    rows.push(['Indexed history', reading.indexedHistory.state.replaceAll('_', ' ')]);
    rows.push(['Receipt', reading.receipt.lifecycle.replaceAll('_', ' ')]);
  } else if (local !== null) {
    rows.push(['Assistant', local.assistant.replaceAll('_', ' ')]);
  }
  if (client !== null) {
    rows.push(['Account (this browser)', client.account]);
    rows.push([
      'Vault (this browser)',
      `${client.vault}, ${client.vaultSave.replaceAll('_', ' ')}`,
    ]);
    rows.push(['Checks (this browser)', client.checks]);
    rows.push(['Selected documents', String(client.selectedDocuments)]);
    rows.push(['Confirmed facts', String(client.confirmedFacts)]);
  }
  return (
    <dl
      className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.875rem]"
      data-testid="status-result"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-lj-secondary">{label}</dt>
          <dd className="m-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({
  block,
  run,
  onOpenSource,
}: {
  block: AnswerBlock;
  run: RunView;
  onOpenSource: (handle: string) => void;
}) {
  const tool = (handle: string) => run.tools.find((entry) => entry.handle === handle) ?? null;
  const cite = (handle: string) => {
    const entry = run.catalog.find((candidate) => candidate.handle === handle);
    return (
      <button
        key={handle}
        type="button"
        className={chip}
        data-testid={`citation-${handle}`}
        onClick={() => onOpenSource(handle)}
      >
        Open source {handle}
        {entry === undefined ? '' : `, page ${entry.reference.page}`}
      </button>
    );
  };
  if (block.kind === 'quotation') {
    const entry = run.catalog.find((candidate) => candidate.handle === block.source);
    return (
      <div data-testid="assistant-block" data-kind="quotation">
        <blockquote className="m-0 border-l-2 border-lj-edge pl-3 text-[0.9375rem]">
          {/* The stored quote from your document, not text retyped by a model. */}
          {entry?.reference.quote ?? 'This source is no longer available.'}
        </blockquote>
        {block.comment === '' ? null : <p className={small}>{block.comment}</p>}
        <div className="mt-1 flex flex-wrap gap-2">{cite(block.source)}</div>
      </div>
    );
  }
  if (block.kind === 'calculation' || block.kind === 'status') {
    const result = tool(block.tool);
    return (
      <div data-testid="assistant-block" data-kind={block.kind}>
        <p className="m-0 text-[0.8125rem] text-lj-secondary">
          {block.kind === 'calculation'
            ? 'Calculated by the application'
            : 'Read by the application'}{' '}
          ({block.tool})
        </p>
        {result === null ? (
          <p className={small}>The referenced result is not available.</p>
        ) : block.kind === 'calculation' ? (
          <PaymentCard tool={result} />
        ) : (
          <StatusCard
            reading={result.output?.tool === 'get_status' ? result.output.status : null}
            local={null}
          />
        )}
        {block.comment === '' ? null : <p className="m-0 mt-1 text-[0.9375rem]">{block.comment}</p>}
      </div>
    );
  }
  return (
    <div data-testid="assistant-block" data-kind={block.kind}>
      <p className="m-0 whitespace-pre-wrap break-words text-[0.9375rem]">{block.text}</p>
      <p className={small}>
        {block.kind === 'finding' ? 'Finding. ' : ''}
        {BASIS[block.basis]}
        {block.rules.length > 0 ? `. Rules: ${block.rules.join(', ')}` : ''}
        {block.tools.length > 0 ? `. Results: ${block.tools.join(', ')}` : ''}
      </p>
      {block.sources.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-2">{block.sources.map(cite)}</div>
      ) : null}
      <ReadAloudButton text={block.text} />
    </div>
  );
}

export function RunCard({
  run,
  onOpenSource,
  children,
}: {
  run: RunView;
  onOpenSource: (handle: string) => void;
  /** Proposal and save controls, supplied by the conversation panel. */
  children?: React.ReactNode;
}) {
  const summary = run.summary;
  const working = run.state === 'queued' || run.state === 'running' || run.state === 'stopping';
  return (
    <article
      className="rounded border border-lj-edge p-3"
      data-testid="assistant-run"
      data-state={run.state}
      data-complete={run.complete}
      data-origin={run.origin}
      data-model={run.modelExecution}
    >
      <p className="m-0 flex items-center gap-2 text-[0.8125rem] text-lj-secondary">
        <Icon
          name={
            working
              ? 'loading'
              : run.state === 'failed'
                ? 'alert'
                : run.complete
                  ? 'check'
                  : 'unavailable'
          }
        />
        <span data-testid="assistant-run-state">{orbLabel(run.state)}</span>
        <span>· {providerLabel(run)}</span>
      </p>
      {run.stale ? (
        <p className="m-0 mt-1 text-[0.8125rem] text-lj-amber" data-testid="assistant-stale">
          Out of date: the review inputs changed after this was produced.
        </p>
      ) : null}
      {run.incomplete !== null ? (
        <p className="m-0 mt-1 text-[0.8125rem] text-lj-amber" data-testid="assistant-incomplete">
          {INCOMPLETE[run.incomplete]}
        </p>
      ) : null}
      {run.failure !== null ? (
        <p className="m-0 mt-1 text-[0.875rem] text-lj-error" data-testid="assistant-failure">
          {run.failure.message}
        </p>
      ) : null}

      {run.plan !== null ? (
        <ol
          className="m-0 mt-2 list-none p-0 text-[0.8125rem]"
          aria-label="Task steps"
          data-testid="assistant-steps"
        >
          {run.plan.steps.map((step) => (
            <li key={step.stepId} data-status={step.status}>
              <span className="text-lj-muted">{step.status.replaceAll('_', ' ')}: </span>
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}

      {run.tools.length > 0 ? (
        <ul className="m-0 mt-2 list-none p-0 text-[0.8125rem]" aria-label="Tools used">
          {run.tools.map((tool) => (
            <li
              key={tool.handle}
              data-testid="assistant-tool"
              data-tool={tool.toolName}
              data-outcome={tool.outcome}
            >
              {tool.handle}: {tool.toolName.replaceAll('_', ' ')},{' '}
              {tool.outcome.replaceAll('_', ' ')}
              {tool.output?.tool === 'read_sources'
                ? ` (${tool.output.sources.map((source) => source.handle).join(', ')})`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {run.localStatus !== null ? <StatusCard reading={null} local={run.localStatus} /> : null}

      <div className="mt-2 grid gap-3">
        {run.blocks.map((block, index) => (
          <Block key={index} block={block} run={run} onOpenSource={onOpenSource} />
        ))}
      </div>

      {summary !== null && summary.questions.length > 0 ? (
        <ul className="m-0 mt-2 list-disc pl-5 text-[0.9375rem]" aria-label="Questions for you">
          {summary.questions.map((question) => (
            <li key={question}>{question}</li>
          ))}
        </ul>
      ) : null}
      {summary !== null && summary.unresolved.length > 0 ? (
        <ul className="m-0 mt-2 list-disc pl-5 text-[0.875rem]" aria-label="Unresolved">
          {summary.unresolved.map((item, index) => (
            <li key={index}>
              <span className="text-lj-muted">
                {item.code.toLowerCase().replaceAll('_', ' ')}:{' '}
              </span>
              {item.text}
            </li>
          ))}
        </ul>
      ) : null}
      {summary !== null && summary.scopeLimitations.length > 0 ? (
        <ul
          className="m-0 mt-2 list-disc pl-5 text-[0.8125rem] text-lj-secondary"
          aria-label="Scope limitations"
        >
          {summary.scopeLimitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {children}
      {run.complete && run.origin === 'assistant' ? (
        <p className={small}>
          A finished run confirms nothing and approves nothing. References are checked; whether a
          statement is right is for you to judge.
        </p>
      ) : null}
    </article>
  );
}
