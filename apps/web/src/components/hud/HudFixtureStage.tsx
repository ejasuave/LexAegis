'use client';

import { useEffect } from 'react';
import { AssistantOrb } from '@/components/assistant/AssistantOrb';
import { orbForActivity } from '@/components/assistant/orb-state';
import {
  HUD_FIXTURE_NAMES,
  buildHudFixture,
  fixtureFindingIds,
  type HudFixtureName,
} from '@/features/hud/public';
import { setHudFixture } from './hud-fixture';
import { useHud } from './hud-context';

/**
 * A stand-in workbench with the same landmarks the canvas measures (nucleus, quiet regions,
 * finding rows, Findings control), filled with invented text. It makes the real pipeline draw
 * every state without a live account, run or chain.
 */
export function HudFixtureStage({ name }: { name: HudFixtureName }) {
  const { view, receipt, consumeReceipt } = useHud();
  const commitment = `0x${'ab'.repeat(32)}`;
  const send = (
    kind: 'confirmed' | 'invalidated',
    id: string,
    options?: { source?: 'live' | 'hydration'; sameMatter?: boolean },
  ) => consumeReceipt({ kind, id, commitment }, { sameMatter: true, ...options });
  useEffect(() => {
    setHudFixture(buildHudFixture(name, Date.now()));
    return () => setHudFixture(null);
  }, [name]);
  return (
    <div className="lj-workbench h-full">
      <aside className="lj-rail-left" aria-label="Fixture matter rail">
        <div className="lj-rail-inner" data-hud-quiet="">
          <h2 className="m-0 text-lg font-medium">Synthetic fixture</h2>
          <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
            Invented data for tests. State: <strong data-testid="fixture-name">{name}</strong>.
          </p>
          <ul className="m-0 mt-2 list-none p-0 text-[0.875rem]">
            {HUD_FIXTURE_NAMES.map((n) => (
              <li key={n}>
                <a className="inline-flex min-h-6 items-center underline" href={`?state=${n}`}>
                  {n}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section aria-label="Work" className="min-w-0">
        <div className="lj-hero">
          <div className="flex flex-col items-center">
            <AssistantOrb state={orbForActivity(view.activity)} size="expanded" />
            <p
              data-hud-quiet=""
              role="status"
              data-testid="fixture-status"
              className="m-0 mt-4 text-lg"
            >
              {view.activity.statusText}
            </p>
          </div>
        </div>
        <section aria-label="Findings" data-hud-quiet="" className="mx-auto max-w-xl">
          <h2 className="m-0 text-lg font-medium">Findings</h2>
          <ul className="m-0 mt-2 list-none p-0">
            {fixtureFindingIds().map((id, index) => (
              <li
                key={id}
                data-hud-finding={id}
                className="border-b border-lj-divider py-2 text-[0.875rem]"
              >
                Synthetic finding {String(index + 1)}: invented text standing in for a clause.
              </li>
            ))}
          </ul>
        </section>
      </section>
      <aside data-hud-rail="attention" aria-label="Fixture attention rail">
        <div className="lj-rail-inner" data-hud-quiet="">
          <div className="mb-3 flex flex-col items-start gap-1" aria-label="Fixture signals">
            {(
              [
                ['live', 'Confirm A (live)', () => send('confirmed', 'fx-a')],
                ['dup', 'Confirm A again', () => send('confirmed', 'fx-a')],
                ['b', 'Confirm B at once', () => send('confirmed', 'fx-b')],
                [
                  'hydrate',
                  'Replay C (history)',
                  () => send('confirmed', 'fx-c', { source: 'hydration' }),
                ],
                [
                  'other',
                  'Confirm D (other matter)',
                  () => send('confirmed', 'fx-d', { sameMatter: false }),
                ],
                ['invalidate', 'Withdraw A', () => send('invalidated', 'fx-a')],
              ] as const
            ).map(([key, label, run]) => (
              <button
                key={key}
                type="button"
                data-testid={`fx-${key}`}
                className="min-h-6 rounded border border-lj-edge px-2 text-[0.8125rem]"
                onClick={run}
              >
                {label}
              </button>
            ))}
            {receipt.label === null ? null : (
              <p
                data-testid="receipt-label"
                data-kind={receipt.label.kind}
                className="m-0 text-[0.875rem]"
              >
                {receipt.label.text}
              </p>
            )}
            <p data-testid="fixture-log" className="m-0 text-[0.8125rem] text-lj-secondary">
              Log entries: {String(receipt.log.length)}
            </p>
          </div>
          <h2 className="m-0 text-lg font-medium" data-hud-findings-control="">
            Evidence
          </h2>
          <p
            className="m-0 mt-2 text-[0.875rem] text-lj-secondary"
            data-testid="fixture-unresolved"
          >
            {String(view.attention.unresolvedCount)} unresolved,{' '}
            {String(view.attention.offscreenUnresolved)} not on screen.
          </p>
        </div>
      </aside>
    </div>
  );
}
