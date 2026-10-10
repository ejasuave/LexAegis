import {
  addEntry,
  confirmEntry,
  correctEntry,
  removeEntry,
  type ContextEntryV1,
  type MatterRecordV1,
  type VaultResult,
} from '@lexaegis/vault';

/** Pure edit functions for a matter's working context. They produce a draft; storing is a separate, explicit save. */
export type MatterEdit = (record: MatterRecordV1) => VaultResult<MatterRecordV1>;

export interface EditEnvironment {
  readonly now: () => string;
  readonly newId: () => string;
}

export const editAddEntry =
  (
    env: EditEnvironment,
    input: {
      kind: ContextEntryV1['kind'];
      text: string;
      confirmed: boolean;
      sourceRefs?: ContextEntryV1['sourceRefs'];
      /** "model_proposed" for a saved assistant observation: it always starts unconfirmed. */
      origin?: 'user' | 'model_proposed';
    },
  ): MatterEdit =>
  (record) =>
    addEntry(
      record,
      {
        entryId: env.newId(),
        kind: input.kind,
        text: input.text,
        confirmed: input.confirmed,
        ...(input.origin !== undefined && { origin: input.origin }),
        ...(input.sourceRefs !== undefined && { sourceRefs: input.sourceRefs }),
      },
      env.now(),
    );

/** A correction is a new, unconfirmed revision: the earlier confirmation does not carry over. */
export const editCorrectEntry =
  (env: EditEnvironment, entryId: string, text: string): MatterEdit =>
  (record) =>
    correctEntry(record, entryId, text, env.now());

export const editConfirmEntry =
  (env: EditEnvironment, entryId: string): MatterEdit =>
  (record) =>
    confirmEntry(record, entryId, env.now());

/** Removes working context only. Frozen reviews, earlier exports and retained storage copies are unaffected. */
export const editRemoveEntry =
  (env: EditEnvironment, entryId: string): MatterEdit =>
  (record) =>
    removeEntry(record, entryId, env.now());
