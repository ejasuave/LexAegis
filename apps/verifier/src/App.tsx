import { useEffect, useState } from 'react';
import { VerifierController } from './controller';
import { loadVerifierConfig } from './config';
import { InputSection } from './components/InputSection';
import { RegistrySection } from './components/RegistrySection';
import { ResultSection } from './components/ResultSection';
import { useVerifier } from './use-verifier';

// Loopback HTTP exists only in the test build mode used by the browser check, never in production.
const loopback = import.meta.env.MODE === 'loopback-test';
const config = loadVerifierConfig(import.meta.env, undefined, { allowLoopbackHttp: loopback });

function createController(): VerifierController {
  return new VerifierController({
    createWorker: () =>
      new Worker(new URL('./verification-worker.ts', import.meta.url), { type: 'module' }),
    policy: config.policy,
    rpcUrl: config.rpcUrl,
    allowedRpcOrigins: config.allowedRpcOrigins,
    ...(loopback && { allowLoopbackHttp: true }),
  });
}

export function App() {
  const [controller] = useState(createController);
  const snapshot = useVerifier(controller);

  // Leaving or restoring the page (including from the back-forward cache) drops every private view.
  useEffect(() => {
    const clear = () => controller.clear();
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) clear();
    };
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', onShow);
    };
  }, [controller]);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-6">
      <header>
        <h1 className="m-0 text-xl font-medium">Proof of Review verifier</h1>
        <p className="mt-2 text-lj-secondary">
          Check an exported review package without a LexAegis account, passkey, wallet or backend.
          Files are checked on this device and are never uploaded.
        </p>
        <p className="mt-2 text-[0.875rem] text-lj-secondary">
          A match shows that the files are the ones a receipt reference commits to, and, if you
          check the registry, what the registry records. It does not show that the analysis is
          correct, that the facts are true, or who the reviewer is.
        </p>
      </header>

      <InputSection controller={controller} snapshot={snapshot} />
      <ResultSection snapshot={snapshot} />
      <RegistrySection
        controller={controller}
        snapshot={snapshot}
        policyNote={config.policyNote}
        policySource={config.policySource}
      />
    </div>
  );
}
