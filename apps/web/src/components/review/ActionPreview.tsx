/** Reserved area for the exact approval preview. Nothing can be approved yet. */
export function ActionPreview() {
  return (
    <section aria-labelledby="action-preview-title" className="mt-6">
      <h2 id="action-preview-title" className="m-0 text-lg font-medium">
        Action preview
      </h2>
      <p className="mt-2 text-[0.875rem] text-lj-secondary">
        No review package has been frozen, so there is nothing to approve. Approval will always
        require a separate, explicit action on an exact package.
      </p>
      <button
        type="button"
        aria-disabled="true"
        aria-describedby="approve-reason"
        className="mt-2 min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] text-lj-muted"
      >
        Approve this package
      </button>
      <p id="approve-reason" className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        Unavailable: there is no frozen package, account or registry connection.
      </p>
    </section>
  );
}
