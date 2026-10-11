import { useSyncExternalStore } from 'react';
import type { VerifierController, VerifierSnapshot } from './controller';

export function useVerifier(controller: VerifierController): VerifierSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
