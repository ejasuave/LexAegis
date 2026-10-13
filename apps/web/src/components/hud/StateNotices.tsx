'use client';

import Link from 'next/link';
import { useHud } from './hud-context';

const WORD = { info: 'Note', warn: 'Warning', bad: 'Problem' } as const;
const COLOUR = { info: 'text-lj-secondary', warn: 'text-lj-amber', bad: 'text-lj-error' } as const;
/** Urgent, actionable failures interrupt; everything else waits its turn politely. */
const URGENT: ReadonlySet<string> = new Set(['tx-reverted', 'vault-conflict', 'vault-recovery']);

/**
 * What is wrong or degraded right now, in sentences, with what is and is not affected. Typographic
 * rows with hairlines, never cards. Recovery is a link to where the reviewer decides; nothing
 * here retries, signs or sends.
 */
export function StateNotices() {
  const { notices } = useHud();
  if (notices.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="lj-rule" data-hud-quiet="">
      <ul className="m-0 list-none p-0 text-[0.875rem] leading-[1.375rem]">
        {notices.map((notice) => (
          <li
            key={notice.id}
            data-notice={notice.id}
            role={URGENT.has(notice.id) ? 'alert' : 'status'}
            className="border-b border-lj-divider py-2"
          >
            <span className={`font-medium ${COLOUR[notice.severity]}`}>
              {WORD[notice.severity]}:{' '}
            </span>
            <strong className="font-medium">{notice.title}.</strong> {notice.body}
            {notice.action === null ? null : (
              <>
                {' '}
                <Link className="underline" href={notice.action.href}>
                  {notice.action.label}
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
