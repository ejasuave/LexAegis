import type { VerifierController, VerifierSnapshot } from '../controller';

interface Props {
  readonly controller: VerifierController;
  readonly snapshot: VerifierSnapshot;
}

/**
 * The optional agent identity sidecar. Separate from every proof result: a missing, unreadable or
 * unregistered identity never changes what the files or the receipt show, and a changed address or
 * owner is not tampering with unchanged package bytes. Shown only in a build that enables it.
 */
export function AgentIdentitySection({ controller, snapshot }: Props) {
  const found = snapshot.local?.agentIdentity ?? null;
  const resolution = snapshot.identity;
  const can = controller.canCheckAgentIdentity;
  return (
    <section
      aria-labelledby="identity-title"
      className="mt-10"
      data-testid="agent-identity-section"
    >
      <h2 id="identity-title" className="m-0 text-lg font-medium">
        5. Agent identity (optional)
      </h2>
      <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
        Separate from the proof. A registry record is discovery only: not proof of who ran the
        assistant, that its advice is correct, or of anyone&apos;s qualification.
      </p>
      <p className="m-0 mt-3 text-[0.9375rem]" data-testid="agent-identity-reference">
        {found === null
          ? 'Not evaluated: it needs a package whose files all matched.'
          : found.status === 'included'
            ? `Captured reference: agent ${found.reference.agentId} in registry ${found.reference.identityRegistry} on chain ${found.reference.chainId}.`
            : found.status === 'not_included'
              ? 'This package carries no agent identity reference. That is not a failure.'
              : found.status === 'unsupported_version'
                ? 'The agent configuration uses a version this verifier does not read. The proof result is unaffected.'
                : 'The agent configuration holds an unreadable identity claim. The proof result is unaffected.'}
      </p>
      {found?.status === 'included' ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="min-h-11 min-w-11 rounded-md border border-lj-line px-3"
            disabled={!can}
            onClick={() => void controller.checkAgentIdentity()}
          >
            {snapshot.identityPhase === 'running' ? 'Checking…' : 'Check agent identity'}
          </button>
          {snapshot.rpcError !== null ? (
            <span className="text-[0.875rem] text-lj-secondary">
              Set a valid registry endpoint above first.
            </span>
          ) : null}
        </div>
      ) : null}
      {resolution !== null ? (
        <p className="m-0 mt-3 text-[0.9375rem]" role="status" data-testid="agent-identity-result">
          {resolution.status === 'registered' && resolution.agent !== null
            ? `Registry now: registered, owner ${resolution.agent.owner}${resolution.agent.uri.changed ? '. The registered card address differs from the captured one (the package bytes are unchanged).' : '.'}${resolution.checkpoint === null ? '' : ` Read at block ${resolution.checkpoint.blockNumber}.`}`
            : resolution.status === 'notFound'
              ? 'Registry now: the registry reports no such agent. (This is not the receipt status.)'
              : `Unable to check agent identity (${resolution.reason}). This does not mean the agent is unregistered.`}
        </p>
      ) : null}
      <p className="m-0 mt-3 text-[0.8125rem] text-lj-muted">
        Card contents are not fetched by this verifier: they would be remote self-declarations, and
        this build only allows the registry endpoint above.
      </p>
    </section>
  );
}
