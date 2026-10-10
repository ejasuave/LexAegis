import type { ReviewController } from '@/features/review/public';
import type { VaultHandle } from '@/features/vault/public';
import { createAssistantTransport } from './api-client';
import { AssistantController } from './controller';

/*
 * The assistant surface UI code may import. It holds no provider credential, endpoint or key and
 * cannot unlock, confirm a fact, save, approve or sign: those stay with the reviewer's own controls.
 */
export { DISCLOSURE_FACTS } from './disclosure';
export type { PendingDisclosure } from './disclosure';
export { AssistantController, EMPTY_ASSISTANT_SNAPSHOT } from './controller';
export type {
  AssistantSnapshot,
  ConversationItem,
  LocalStatus,
  OrbReading,
  RunView,
} from './controller';

/** Builds the tab's assistant controller on the review controller and the vault handle. */
export function createBrowserAssistant(
  review: ReviewController,
  vault: VaultHandle,
  account: () => { present: boolean; unlocked: boolean },
): AssistantController {
  return new AssistantController({
    review,
    vault,
    account,
    transport: createAssistantTransport(),
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  });
}
