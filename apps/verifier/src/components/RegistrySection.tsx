import { useId } from 'react';
import type { VerifierController, VerifierSnapshot } from '../controller';
import { CopyButton } from './CopyButton';

interface Props {
  readonly controller: VerifierController;
  readonly snapshot: VerifierSnapshot;
  readonly policyNote: string;
  readonly policySource: 'integrator' | 'default' | 'none';
}

const RPC_ERROR_TEXT = {
  NOT_HTTPS: 'Use an https:// endpoint.',
  HAS_CREDENTIALS: 'Remove the user name and password from the address.',
  HAS_QUERY_OR_FRAGMENT:
    'Remove the query and fragment. Do not use an endpoint that needs a key in its address.',
  MALFORMED_URL: 'This is not a valid address.',
  ORIGIN_NOT_ALLOWED:
    'This endpoint is not enabled in this build. Whoever builds this verifier lists the allowed endpoints.',
} as const;

/** Step 4: the registry. Optional, explicit and separate from the local file check. */
export function RegistrySection({ controller, snapshot, policyNote, policySource }: Props) {
  const rpcId = useId();
  const signerId = useId();
  const signerHelp = useId();
  const policy = snapshot.policy;
  const running = snapshot.livePhase === 'running';
  const can = controller.canCheckRegistry;
  const hasObservation = snapshot.lastObserved !== null;

  return (
    <section aria-labelledby="registry-title" className="mt-10">
      <h2 id="registry-title" className="m-0 text-lg font-medium">
        4. Registry (optional)
      </h2>
      <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
        File checking above works without this. Checking the registry reads what the registry
        records for the reference. It needs a reachable public endpoint.
      </p>

      <h3 className="mb-0 mt-4 text-base font-medium">Configured registry</h3>
      {policy === null ? (
        <p className="m-0 mt-1 text-[0.875rem]" data-testid="policy-none">
          No registry deployment is configured, so registry checks are unavailable. {policyNote}
        </p>
      ) : (
        <dl className="card mono mt-1 grid gap-1" data-testid="policy">
          <PolicyRow term="Policy" value={`${policy.id} (${policySource})`} />
          <PolicyRow term="Chain" value={policy.chainId} />
          <PolicyRow term="Registry" value={policy.registryAddress} copy />
          <PolicyRow term="Genesis" value={policy.genesisHash} />
          <PolicyRow term="Deployed at block" value={policy.deploymentBlock} />
          <PolicyRow term="Runtime code hash" value={policy.runtimeCodeKeccak256} />
          <PolicyRow term="Protocol version" value={policy.protocolVersion} />
        </dl>
      )}
      <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        This comes from this verifier’s own build, never from an imported file. {policyNote} A
        receipt that names a different registry is shown as unverified and nothing is read.
      </p>

      <label htmlFor={rpcId} className="mt-4 block text-[0.875rem]">
        Public RPC endpoint
      </label>
      <input
        id={rpcId}
        className="field mono mt-1"
        type="url"
        spellCheck={false}
        autoComplete="off"
        value={snapshot.rpcUrl}
        onChange={(event) => controller.setRpcUrl(event.target.value)}
        aria-invalid={snapshot.rpcError !== null}
        data-testid="rpc-input"
      />
      {snapshot.rpcError === null ? null : (
        <p role="alert" className="m-0 mt-1 text-[0.875rem] text-lj-bad">
          {RPC_ERROR_TEXT[snapshot.rpcError]}
        </p>
      )}
      <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        Nothing here is saved. Do not paste an address that contains a secret key.
      </p>

      <label htmlFor={signerId} className="mt-4 block text-[0.875rem]">
        Reviewer accounts you accept (optional)
      </label>
      <p id={signerHelp} className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        One 0x address per line. This is your own rule. It does not confirm anyone’s professional
        qualification. The reviewer named inside a file is never treated as accepted.
      </p>
      <textarea
        id={signerId}
        aria-describedby={signerHelp}
        className="field mono mt-1"
        rows={3}
        spellCheck={false}
        autoComplete="off"
        value={snapshot.signerText}
        onChange={(event) => controller.setSignerText(event.target.value)}
        aria-invalid={snapshot.signerInvalid}
        data-testid="signer-input"
      />
      {snapshot.signerInvalid ? (
        <p role="alert" className="m-0 mt-1 text-[0.875rem] text-lj-bad">
          Enter valid 0x addresses, one per line.
        </p>
      ) : null}
      {snapshot.signerText.trim() === '' ? (
        <p className="m-0 mt-1 text-[0.875rem]" data-testid="no-signer-policy">
          No signer policy selected.
        </p>
      ) : null}

      <div className="card mt-4 text-[0.875rem]" data-testid="disclosure">
        {snapshot.rpcOrigin === null || policy === null ? (
          'Choose a valid endpoint and a configured registry to check the registry.'
        ) : (
          <>
            Checking the registry sends the registry address, the reviewer address and the
            commitment from the reference to <strong>{snapshot.rpcOrigin}</strong>. That endpoint
            will see your network address. No file, opening, file name or hash is sent.
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={!can}
          onClick={() => {
            if (can) void controller.checkRegistry();
          }}
          data-testid="check-registry"
        >
          {hasObservation ? 'Refresh status' : 'Check registry'}
        </button>
        <button
          type="button"
          className="btn"
          aria-disabled={!running}
          onClick={() => {
            if (running) controller.cancel();
          }}
          data-testid="cancel-registry"
        >
          Cancel registry check
        </button>
      </div>
      {!can && !running ? (
        <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary" data-testid="registry-reason">
          {registryReason(snapshot)}
        </p>
      ) : null}
      <div role="status" aria-live="polite" className="mt-2 text-[0.875rem]">
        {running ? 'Checking the registry… up to 20 seconds.' : null}
      </div>
    </section>
  );
}

function registryReason(snapshot: VerifierSnapshot): string {
  if (snapshot.policy === null) return 'Unavailable: no registry deployment is configured.';
  if (snapshot.rpcError !== null) return 'Unavailable: the endpoint is not usable.';
  if (snapshot.signerInvalid) return 'Unavailable: the signer addresses are not valid.';
  return 'Choose a file, or inspect a reference, first.';
}

function PolicyRow({ term, value, copy }: { term: string; value: string; copy?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="min-w-40 text-lj-secondary">{term}</dt>
      <dd className="m-0 flex flex-wrap items-center gap-2">
        <span>{value}</span>
        {copy === true ? <CopyButton value={value} label={term.toLowerCase()} /> : null}
      </dd>
    </div>
  );
}
