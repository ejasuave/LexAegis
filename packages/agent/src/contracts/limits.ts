import type { z } from 'zod';

/*
 * Hard size limits of one assistant request and response. Overflow is rejected with one of the
 * codes below; nothing is truncated, summarised or dropped to make a payload fit.
 */

export const ASSISTANT_LIMITS = Object.freeze({
  /** The whole start-request body, counted while it is read. */
  requestBytes: 128 * 1024,
  utteranceBytes: 4 * 1024,
  /** Serialized selected context (excerpts, facts, evidence descriptors, saved context). */
  contextBytes: 32 * 1024,
  historyMessages: 6,
  historyBytes: 8 * 1024,
  catalogEntries: 64,
  quoteBytes: 4 * 1024,
  savedContextEntries: 16,
  answerBlocks: 8,
  factProposals: 10,
  unresolvedItems: 10,
  /** Serialized model output and serialized validated response. */
  outputBytes: 32 * 1024,
  planSteps: 5,
  toolArgumentBytes: 4 * 1024,
  toolResultBytes: 16 * 1024,
  /** One server-sent event frame: the largest payload plus its envelope. */
  eventFrameBytes: 40 * 1024,
});

export const ASSISTANT_LIMIT_CODES = [
  'UTTERANCE_TOO_LARGE',
  'CONTEXT_TOO_LARGE',
  'HISTORY_TOO_LARGE',
  'CATALOG_TOO_LARGE',
  'QUOTE_TOO_LONG',
  'OUTPUT_TOO_LARGE',
  'TOOL_RESULT_TOO_LARGE',
] as const;
export type AssistantLimitCode = (typeof ASSISTANT_LIMIT_CODES)[number];

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;
export const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));

/** The explicit limit a failed parse hit, if any. Limit checks report their code as the message. */
export function limitCodeOf(error: z.ZodError): AssistantLimitCode | null {
  for (const issue of error.issues) {
    const code = ASSISTANT_LIMIT_CODES.find((candidate) => candidate === issue.message);
    if (code !== undefined) return code;
  }
  return null;
}
