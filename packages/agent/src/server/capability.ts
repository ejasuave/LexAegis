import 'server-only';
import { capabilityRecordSchema, type CapabilityRecord } from './capability-record';
import { parseIntentSelection } from '../runtime/intent-router';
import { routerRound } from '../runtime/prompts';
import type { ChatProvider } from '../runtime/provider';
import { TOOL_INPUTS, providerTool } from '../runtime/tool-schemas';

export { capabilityRecordSchema, type CapabilityRecord } from './capability-record';

/*
 * Synthetic capability checks for one exact configuration: native tool calls, the selected
 * structured-output mode, usage reporting and cancellation. They use fixed synthetic prompts and
 * no matter data. "Configured" and "verified" are separate: only a passing record for the current
 * fingerprint enables real-matter inference, and a changed endpoint, model or output mode has no
 * record. Nothing probes the provider on an ordinary request.
 */

const ATTEMPT_MS = 25_000;
const TOKENS = 256;

export async function runCapabilityChecks(
  provider: ChatProvider,
  options: { readonly now: () => Date; readonly signal: AbortSignal },
): Promise<CapabilityRecord> {
  const failures: string[] = [];
  const requestIds: string[] = [];
  let returnedModel: string | null = null;
  let usageReported = true;
  const note = (result: Awaited<ReturnType<ChatProvider['complete']>>) => {
    if (result.requestId !== null) requestIds.push(result.requestId);
    if (result.ok) {
      returnedModel = result.returnedModel ?? returnedModel;
      if (result.usage === null) usageReported = false;
    }
  };

  // 1. Native function calling: the model must request the offered tool with valid arguments.
  const tool = await provider.complete({
    purpose: 'capability',
    messages: [
      {
        role: 'system',
        content: 'Capability check with synthetic input. Call the offered function.',
      },
      { role: 'user', content: 'Call get_status with scope "matter".' },
    ],
    tools: [providerTool('get_status')],
    maxCompletionTokens: TOKENS,
    timeoutMs: ATTEMPT_MS,
    signal: options.signal,
  });
  note(tool);
  let nativeToolCalls = false;
  if (!tool.ok) failures.push(`TOOL_CALL_${tool.failure.toUpperCase()}`);
  else {
    const [call] = tool.toolCalls;
    let args: unknown;
    try {
      args = JSON.parse(call?.arguments ?? '');
    } catch {
      args = undefined;
    }
    nativeToolCalls =
      tool.toolCalls.length === 1 &&
      call?.name === 'get_status' &&
      TOOL_INPUTS.get_status.safeParse(args).success;
    if (!nativeToolCalls) failures.push('TOOL_CALL_NOT_NATIVE');
  }

  // 2. The configured structured-output mode, validated locally with the same schema as a run.
  const round = routerRound(provider.descriptor.outputMode, 'Summarise the selected clause.');
  const structured = await provider.complete({
    purpose: 'capability',
    messages: round.messages,
    responseFormat: round.format,
    maxCompletionTokens: TOKENS,
    timeoutMs: ATTEMPT_MS,
    signal: options.signal,
  });
  note(structured);
  let structuredOutput = false;
  if (!structured.ok) failures.push(`OUTPUT_MODE_${structured.failure.toUpperCase()}`);
  else {
    structuredOutput =
      structured.finishReason === 'stop' &&
      parseIntentSelection(structured.content, { briefingEnabled: true }).valid;
    if (!structuredOutput) failures.push('OUTPUT_MODE_INVALID_JSON');
  }

  // 3. Cancellation: an aborted request must end as aborted, promptly, with no late result.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  const pending = provider.complete({
    purpose: 'capability',
    messages: [{ role: 'user', content: 'Count slowly from one to two hundred in words.' }],
    maxCompletionTokens: TOKENS,
    timeoutMs: ATTEMPT_MS,
    signal: controller.signal,
  });
  const timer = setTimeout(cancel, 50);
  const cancelled = await pending;
  clearTimeout(timer);
  options.signal.removeEventListener('abort', cancel);
  const cancellation = !cancelled.ok && cancelled.failure === 'aborted';
  if (!cancellation) failures.push('CANCELLATION_NOT_OBSERVED');

  const { descriptor } = provider;
  return capabilityRecordSchema.parse({
    schema: 'lexaegis.assistant-capability.v1',
    fingerprint: descriptor.fingerprint,
    provider: descriptor.id,
    model: descriptor.model,
    region: descriptor.region,
    outputMode: descriptor.outputMode,
    nativeToolCalls,
    structuredOutput,
    usageReported,
    cancellation,
    returnedModel,
    requestIds: requestIds.slice(0, 4),
    failures: failures.slice(0, 8),
    checkedAt: options.now().toISOString(),
    verified: nativeToolCalls && structuredOutput && cancellation,
  });
}
