import type { ReactNode } from 'react';

export interface DisabledAction {
  readonly label: string;
  readonly reason: string;
}

/** Dedicated page for a workflow that is not built yet: states what is missing and why actions are off. */
export function EmptyState({
  title,
  description,
  actions = [],
  children,
}: {
  title: string;
  description: string;
  actions?: readonly DisabledAction[];
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-2xl">
      <h1 id="page-title" className="m-0 text-xl font-medium">
        {title}
      </h1>
      <p className="mt-2 text-base text-lj-secondary">{description}</p>
      {actions.length > 0 ? (
        <ul className="mt-4 flex list-none flex-col gap-3 p-0">
          {actions.map((action, index) => (
            <li key={action.label}>
              <button
                type="button"
                aria-disabled="true"
                aria-describedby={`reason-${index}`}
                className="min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] text-lj-muted"
              >
                {action.label}
              </button>
              <p id={`reason-${index}`} className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
                {action.reason}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </section>
  );
}
