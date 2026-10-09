import { z } from 'zod';
import { digestSchema, mediaTypeSchema, timestampSchema, uuidSchema } from '@lexaegis/protocol/v1';
import { MATTER_SCHEMA, VAULT_LIMITS } from './v1/constants';
import { err, ok, type VaultResult } from './v1/errors';
import { lengthSchema, revisionSchema, vaultObjectRefSchema } from './v1/schemas';

/*
 * Encrypted matter records and the working context Aegis may later use. Everything here lives
 * inside browser-encrypted objects. Source bytes are immutable (new content gets a new version
 * ID); a model proposal stays unconfirmed until the user accepts it; editing never silently
 * keeps an old confirmation; and a frozen review is a snapshot that later edits cannot change.
 */

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;

export const sourceRefSchema = z.strictObject({
  documentVersionId: uuidSchema,
  /** Optional pointer inside the document, such as a clause or page label. */
  anchor: z.string().max(200).nullable(),
});

export const contextEntrySchema = z
  .strictObject({
    entryId: uuidSchema,
    kind: z.enum(['fact', 'note', 'outcome']),
    text: z
      .string()
      .min(1)
      .refine((value) => utf8Length(value) <= VAULT_LIMITS.maxContextEntryBytes, 'too long'),
    status: z.enum(['confirmed', 'unconfirmed']),
    origin: z.enum(['user', 'imported', 'model_proposed']),
    /** Only for origin "imported": the matter the entry came from. */
    importedFrom: uuidSchema.nullable(),
    sourceRefs: z.array(sourceRefSchema).max(8),
    confirmedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revision: revisionSchema,
  })
  .check((ctx) => {
    if (ctx.issues.length > 0) return;
    const entry = ctx.value;
    const confirmed = entry.status === 'confirmed';
    const problems: string[] = [];
    if (confirmed !== (entry.confirmedAt !== null)) problems.push('confirmation');
    if (entry.kind === 'outcome' && entry.sourceRefs.length === 0)
      problems.push('outcome needs a document version');
    if ((entry.origin === 'imported') !== (entry.importedFrom !== null))
      problems.push('provenance');
    for (const message of problems)
      ctx.issues.push({ code: 'custom', message, input: entry, path: [] });
  });
export type ContextEntryV1 = z.infer<typeof contextEntrySchema>;

export const workingContextSchema = z.strictObject({
  entries: z.array(contextEntrySchema).max(VAULT_LIMITS.maxContextEntries),
});
export type WorkingContextV1 = z.infer<typeof workingContextSchema>;

export const sourceVersionSchema = z.strictObject({
  documentId: uuidSchema,
  documentVersionId: uuidSchema,
  artifactId: uuidSchema,
  byteLength: lengthSchema,
  sha256: digestSchema,
  mediaType: mediaTypeSchema,
  label: z.string().max(256),
  object: vaultObjectRefSchema,
  addedAt: timestampSchema,
});
export type SourceVersionV1 = z.infer<typeof sourceVersionSchema>;

export const frozenReviewRefSchema = z.strictObject({
  frozenReview: vaultObjectRefSchema,
  packageId: uuidSchema,
  commitment: digestSchema,
  savedAt: timestampSchema,
});

export const matterRecordSchema = z
  .strictObject({
    schema: z.literal(MATTER_SCHEMA),
    matterId: uuidSchema,
    title: z.string().min(1).max(VAULT_LIMITS.maxTitleChars),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    sources: z.array(sourceVersionSchema).max(VAULT_LIMITS.maxArtifacts),
    context: workingContextSchema,
    frozenReviews: z.array(frozenReviewRefSchema).max(VAULT_LIMITS.maxArtifacts),
  })
  .check((ctx) => {
    if (ctx.issues.length > 0) return;
    const ids = ctx.value.sources.map((source) => source.documentVersionId);
    if (new Set(ids).size !== ids.length) {
      ctx.issues.push({
        code: 'custom',
        message: 'duplicate document version',
        input: ctx.value,
        path: ['sources'],
      });
    }
  });
export type MatterRecordV1 = z.infer<typeof matterRecordSchema>;

export function newMatter(
  matterId: string,
  title: string,
  now: string,
): VaultResult<MatterRecordV1> {
  const parsed = matterRecordSchema.safeParse({
    schema: MATTER_SCHEMA,
    matterId,
    title,
    createdAt: now,
    updatedAt: now,
    sources: [],
    context: { entries: [] },
    frozenReviews: [],
  });
  return parsed.success ? ok(parsed.data) : err('INVALID_INPUT');
}

const touch = (
  record: MatterRecordV1,
  now: string,
  context: WorkingContextV1,
): VaultResult<MatterRecordV1> => {
  const parsed = matterRecordSchema.safeParse({ ...record, updatedAt: now, context });
  return parsed.success ? ok(parsed.data) : err('INVALID_INPUT');
};

export interface NewEntry {
  readonly entryId: string;
  readonly kind: ContextEntryV1['kind'];
  readonly text: string;
  readonly sourceRefs?: ContextEntryV1['sourceRefs'];
  /** "user" for something the user typed or accepted; the others stay unconfirmed. */
  readonly origin?: ContextEntryV1['origin'];
  readonly importedFrom?: string | null;
  /** The user typed this and states it is true. Ignored for imported and model-proposed entries. */
  readonly confirmed?: boolean;
}

/** Adds an entry. Only a user's own entry can start confirmed; imports and proposals never do. */
export function addEntry(
  record: MatterRecordV1,
  entry: NewEntry,
  now: string,
): VaultResult<MatterRecordV1> {
  const origin = entry.origin ?? 'user';
  const confirmed = origin === 'user' && entry.confirmed === true;
  const value = {
    entryId: entry.entryId,
    kind: entry.kind,
    text: entry.text,
    status: confirmed ? 'confirmed' : 'unconfirmed',
    origin,
    importedFrom: origin === 'imported' ? (entry.importedFrom ?? null) : null,
    sourceRefs: entry.sourceRefs ?? [],
    confirmedAt: confirmed ? now : null,
    createdAt: now,
    updatedAt: now,
    revision: '0',
  };
  if (record.context.entries.some((existing) => existing.entryId === entry.entryId))
    return err('CONFLICT');
  const parsed = contextEntrySchema.safeParse(value);
  if (!parsed.success) return err('INVALID_INPUT');
  return touch(record, now, { entries: [...record.context.entries, parsed.data] });
}

function replace(
  record: MatterRecordV1,
  entryId: string,
  now: string,
  change: (entry: ContextEntryV1) => unknown,
): VaultResult<MatterRecordV1> {
  const existing = record.context.entries.find((entry) => entry.entryId === entryId);
  if (existing === undefined) return err('NOT_FOUND');
  const parsed = contextEntrySchema.safeParse(change(existing));
  if (!parsed.success) return err('INVALID_INPUT');
  return touch(record, now, {
    entries: record.context.entries.map((entry) =>
      entry.entryId === entryId ? parsed.data : entry,
    ),
  });
}

/** Correcting an entry creates a new revision that is UNCONFIRMED: the old confirmation does not carry over. */
export function correctEntry(
  record: MatterRecordV1,
  entryId: string,
  text: string,
  now: string,
): VaultResult<MatterRecordV1> {
  return replace(record, entryId, now, (entry) => ({
    ...entry,
    text,
    status: 'unconfirmed',
    confirmedAt: null,
    updatedAt: now,
    revision: (BigInt(entry.revision) + 1n).toString(),
  }));
}

/** The user's explicit acceptance of an entry, including an imported or model-proposed one. */
export function confirmEntry(
  record: MatterRecordV1,
  entryId: string,
  now: string,
): VaultResult<MatterRecordV1> {
  return replace(record, entryId, now, (entry) => ({
    ...entry,
    status: 'confirmed',
    confirmedAt: now,
    updatedAt: now,
    revision: (BigInt(entry.revision) + 1n).toString(),
  }));
}

/** Removes working context only. Earlier frozen reviews, exports and retained storage copies are unaffected. */
export function removeEntry(
  record: MatterRecordV1,
  entryId: string,
  now: string,
): VaultResult<MatterRecordV1> {
  if (!record.context.entries.some((entry) => entry.entryId === entryId)) return err('NOT_FOUND');
  return touch(record, now, {
    entries: record.context.entries.filter((entry) => entry.entryId !== entryId),
  });
}

/** Adds a new source version. An existing version ID is never replaced. */
export function addSource(
  record: MatterRecordV1,
  source: SourceVersionV1,
  now: string,
): VaultResult<MatterRecordV1> {
  if (record.sources.some((item) => item.documentVersionId === source.documentVersionId))
    return err('CONFLICT');
  const parsed = matterRecordSchema.safeParse({
    ...record,
    updatedAt: now,
    sources: [...record.sources, source],
  });
  return parsed.success ? ok(parsed.data) : err('QUOTA');
}

export function addFrozenReview(
  record: MatterRecordV1,
  frozen: z.infer<typeof frozenReviewRefSchema>,
  now: string,
): VaultResult<MatterRecordV1> {
  if (record.frozenReviews.some((item) => item.commitment === frozen.commitment))
    return err('CONFLICT');
  const parsed = matterRecordSchema.safeParse({
    ...record,
    updatedAt: now,
    frozenReviews: [...record.frozenReviews, frozen],
  });
  return parsed.success ? ok(parsed.data) : err('QUOTA');
}

/** Source references that point at no known version of this matter stay visibly unresolved. */
export function unresolvedReferences(
  record: MatterRecordV1,
): { entryId: string; documentVersionId: string }[] {
  const known = new Set(record.sources.map((source) => source.documentVersionId));
  return record.context.entries.flatMap((entry) =>
    entry.sourceRefs
      .filter((ref) => !known.has(ref.documentVersionId))
      .map((ref) => ({ entryId: entry.entryId, documentVersionId: ref.documentVersionId })),
  );
}

export interface SelectedContext {
  readonly matterId: string;
  readonly entries: readonly Pick<ContextEntryV1, 'entryId' | 'kind' | 'text' | 'revision'>[];
  /** Versions the selected entries refer to, with any that do not exist marked unresolved. */
  readonly versions: readonly { documentVersionId: string; resolved: boolean }[];
}

/**
 * The deliberate selection of confirmed entries a later chapter may send as context. Only
 * confirmed entries are eligible; unconfirmed proposals and imports never are. The selection is
 * never truncated: if it would exceed 32 KiB the call fails and the user chooses less.
 */
export function selectContext(
  record: MatterRecordV1,
  entryIds: readonly string[],
): VaultResult<SelectedContext> {
  const picked: ContextEntryV1[] = [];
  for (const id of new Set(entryIds)) {
    const entry = record.context.entries.find((item) => item.entryId === id);
    if (entry === undefined) return err('NOT_FOUND');
    if (entry.status !== 'confirmed') return err('INVALID_INPUT');
    picked.push(entry);
  }
  const known = new Set(record.sources.map((source) => source.documentVersionId));
  const versions = [
    ...new Set(picked.flatMap((entry) => entry.sourceRefs.map((ref) => ref.documentVersionId))),
  ].map((documentVersionId) => ({ documentVersionId, resolved: known.has(documentVersionId) }));
  const selected: SelectedContext = {
    matterId: record.matterId,
    entries: picked.map(({ entryId, kind, text, revision }) => ({ entryId, kind, text, revision })),
    versions,
  };
  if (utf8Length(JSON.stringify(selected)) > VAULT_LIMITS.maxSelectedContextBytes)
    return err('TOO_LARGE');
  return ok(selected);
}
