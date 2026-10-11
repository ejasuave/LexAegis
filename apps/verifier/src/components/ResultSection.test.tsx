import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerifierController } from '../controller';
import type { WorkerLike } from '../local-job';
import { runVerificationJob, type JobInput } from '../verification-job';
import type { WorkerRequest, WorkerResponse } from '../verification-worker';
import { exportBytes, fakeFile, referenceOf } from '../test-helpers';
import { InputSection } from './InputSection';
import { RegistrySection } from './RegistrySection';
import { ResultSection } from './ResultSection';

const worker = (): WorkerLike => {
  const self: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(message: WorkerRequest) {
      const post = (response: WorkerResponse) =>
        self.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
      void runVerificationJob(message.input as JobInput, () => undefined).then((outcome) =>
        post({ type: 'done', generation: message.generation, outcome }),
      );
    },
  };
  return self;
};

async function page(
  bytes: Uint8Array,
  reference?: unknown,
  policy: boolean = true,
): Promise<string> {
  const controller = new VerifierController({
    createWorker: worker,
    policy: policy
      ? {
          id: 'test.registry',
          chainId: '31337',
          genesisHash: `0x${'00'.repeat(32)}`,
          registryAddress: referenceOf('legal').registryAddress,
          protocolVersion: '1',
          deploymentBlock: '1',
          deploymentTransactionHash: `0x${'11'.repeat(32)}`,
          runtimeCodeKeccak256: `0x${'22'.repeat(32)}`,
          executionDelayBlocks: 3,
          executionDelayRevision: 'test',
        }
      : null,
    rpcUrl: 'https://rpc.example.test/',
    now: () => new Date('2026-10-09T12:00:00.000Z'),
  });
  if (reference !== undefined) controller.setReferenceText(JSON.stringify(reference));
  await controller.chooseFile(fakeFile(bytes).file);
  const snapshot = controller.getSnapshot();
  return renderToStaticMarkup(
    <>
      <InputSection controller={controller} snapshot={snapshot} />
      <ResultSection snapshot={snapshot} />
      <RegistrySection
        controller={controller}
        snapshot={snapshot}
        policyNote="note"
        policySource="default"
      />
    </>,
  );
}

describe('result panels', () => {
  it('shows five independent panels with precise labels and no combined badge', async () => {
    const html = await page(exportBytes('legal'));
    for (const id of ['manifest', 'artifacts', 'registry', 'lifecycle', 'signer']) {
      expect(html).toContain(`data-testid="panel-${id}"`);
    }
    expect(html).toContain('Files match the reference declared inside the file');
    expect(html).toContain('Registry identity unverified');
    expect(html).toContain('Registry status unknown');
    expect(html).toContain('Signer not evaluated');
    expect(html).toContain('No signer policy selected');
    expect(html).not.toMatch(/\bvalid\b|\bverified\b(?! )|certified|approved/i);
  });

  it('states that a file-declared reference is not an independent expectation', async () => {
    const declared = await page(exportBytes('legal'));
    expect(declared).toContain('Taken from the imported file. Not independently supplied.');
    expect(declared).toContain('data-testid="origin-warning"');
    const independent = await page(exportBytes('legal'), referenceOf('legal'));
    expect(independent).toContain('Supplied independently by you.');
    expect(independent).toContain('Files match the reference you supplied');
  });

  it('shows a substituted bundle as a mismatch with both references, never silently replaced', async () => {
    const html = await page(exportBytes('generic'), referenceOf('legal'));
    expect(html).toContain('Files do not match the expected reference');
    expect(html).toContain('data-testid="declared-conflict"');
    expect(html).toContain(referenceOf('legal').commitment);
    expect(html).toContain(referenceOf('generic').commitment);
  });

  it('renders untrusted labels as inert escaped text, with no link or markup', async () => {
    const hostile = '<img src=x onerror=alert(1)><a href="https://evil.example/x">click</a>';
    const html = await page(
      exportBytes('legal', (envelope) => {
        const opening = envelope.opening as { manifest: { artifacts: { label: string | null }[] } };
        const [first] = opening.manifest.artifacts;
        if (first !== undefined) first.label = hostile;
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="https://evil.example');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('discloses the registry origin before any request and offers no automatic download', async () => {
    const html = await page(exportBytes('legal'));
    expect(html).toContain('https://rpc.example.test');
    expect(html).toContain('No file, opening, file name or hash is sent.');
    expect(html).toContain('Download verification result');
    expect(html).not.toContain('autodownload');
  });

  it('keeps the registry check unavailable, with a reason, when no deployment is configured', async () => {
    const html = await page(exportBytes('legal'), undefined, false);
    expect(html).toContain('No registry deployment is configured');
    expect(html).toContain('aria-disabled="true"');
  });
});
