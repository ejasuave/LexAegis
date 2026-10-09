import { useId, useState, type ChangeEvent } from 'react';
import { unknownVerificationStatus } from '@lexaegis/protocol';
import { loadVerifierConfig } from './config';

const status = unknownVerificationStatus();

interface Panel {
  readonly title: string;
  readonly value: string;
  readonly note: string;
}

const NOT_AVAILABLE = 'Unknown: verification is not implemented yet.';

const config = loadVerifierConfig(import.meta.env);

const PANELS: Panel[] = [
  { title: 'Package integrity', value: status.packageIntegrity, note: NOT_AVAILABLE },
  { title: 'Receipt lifecycle', value: status.receiptLifecycle, note: NOT_AVAILABLE },
  {
    title: 'Signer acceptance',
    value: status.signerAcceptance,
    note: 'Unknown: no signer policy is selected.',
  },
  {
    title: 'Chain and registry',
    value: config.chainId ? `Chain ${config.chainId}` : 'Not configured',
    note: config.registryAddress ?? 'No registry address is configured.',
  },
  { title: 'Block / checkpoint', value: 'Unavailable', note: 'No chain read has been made.' },
];

export function App() {
  const inputId = useId();
  const [selected, setSelected] = useState<{ name: string; size: number } | null>(null);

  // Only the file's name and size are shown. The file is not read, parsed or uploaded anywhere.
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelected(file ? { name: file.name, size: file.size } : null);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header>
        <h1 className="m-0 text-xl font-medium">Proof of Review verifier</h1>
        <p className="mt-2 text-lj-secondary">
          Check an exported review package without a LexAegis account, passkey or backend.
          Verification is not implemented yet, so every result below is shown as unknown.
        </p>
      </header>

      <section aria-labelledby="input-title" className="mt-6">
        <h2 id="input-title" className="m-0 text-lg font-medium">
          Proof package
        </h2>
        <label htmlFor={inputId} className="mt-2 block text-[0.875rem] text-lj-secondary">
          Choose an exported package file. It stays on this device.
        </label>
        <input
          id={inputId}
          type="file"
          onChange={onFile}
          className="mt-2 block min-h-11 w-full text-[0.875rem]"
        />
        {selected ? (
          <p role="status" className="mt-2 text-[0.875rem] text-lj-secondary">
            Selected: {selected.name} ({selected.size} bytes). It has not been read or checked.
          </p>
        ) : null}
        <button
          type="button"
          aria-disabled="true"
          aria-describedby="verify-reason"
          className="mt-3 min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] text-lj-muted"
        >
          Verify package
        </button>
        <p id="verify-reason" className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
          Unavailable: package verification is not implemented yet.
        </p>
      </section>

      <section aria-labelledby="results-title" className="mt-8">
        <h2 id="results-title" className="m-0 text-lg font-medium">
          Results
        </h2>
        <dl className="mt-2 divide-y divide-lj-divider">
          {PANELS.map((panel) => (
            <div key={panel.title} className="py-3">
              <dt className="text-base font-medium">{panel.title}</dt>
              <dd className="m-0 mt-1 text-lj-text">{panel.value}</dd>
              <dd className="m-0 mt-1 text-[0.875rem] text-lj-secondary">{panel.note}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
