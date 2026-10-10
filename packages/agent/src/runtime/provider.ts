import type { OutputMode, ProviderId } from '../contracts';

/*
 * The provider port the runtime talks to. One text-only chat-completions shape; the Qwen adapter
 * and the scripted test adapter both implement it. It carries no credential and no endpoint.
 */

export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls: readonly ProviderToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ProviderToolCall {
  /** The provider's call ID, echoed back on the matching tool message. */
  readonly id: string;
  readonly name: string;
  /** Raw JSON text as returned. Nothing parses or trusts it before validation. */
  readonly arguments: string;
}

export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  /** Closed JSON Schema using only the keywords the provider documents. */
  readonly parameters: Record<string, unknown>;
}

export type ResponseFormat =
  | {
      readonly mode: 'json_schema';
      readonly name: string;
      readonly schema: Record<string, unknown>;
    }
  | { readonly mode: 'json_object' };

export interface ProviderRequest {
  readonly purpose: 'route' | 'tool_round' | 'final' | 'repair' | 'capability';
  readonly messages: readonly ChatMessage[];
  /** Offered only on tool rounds. The final round never carries tools. */
  readonly tools?: readonly ProviderTool[];
  /** Requested only on structured rounds. */
  readonly responseFormat?: ResponseFormat;
  readonly maxCompletionTokens: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export type ProviderFailure =
  | 'authentication'
  | 'capability'
  | 'rate_limit'
  | 'timeout'
  | 'transport'
  | 'malformed_output'
  | 'refusal'
  | 'aborted';

export type ProviderResult =
  | {
      readonly ok: true;
      readonly requestId: string | null;
      readonly returnedModel: string | null;
      /** length means the output was cut off: never a completed analysis. */
      readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'other';
      readonly content: string | null;
      readonly toolCalls: readonly ProviderToolCall[];
      /** Null when the provider reported no usage. It is then unknown, not zero. */
      readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
    }
  | {
      readonly ok: false;
      readonly failure: ProviderFailure;
      readonly requestId: string | null;
      /** Whether the request may have reached the provider and so may be billed. */
      readonly dispatched: boolean;
    };

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly model: string;
  /** Region identifier derived from the endpoint host; never the host or a workspace ID. */
  readonly region: string;
  readonly outputMode: OutputMode;
  /** SHA-256 over host, path, model and output mode. A changed configuration is a new fingerprint. */
  readonly fingerprint: string;
}

export interface ChatProvider {
  readonly descriptor: ProviderDescriptor;
  complete(request: ProviderRequest): Promise<ProviderResult>;
}

/** Transient failures that the single permitted retry may cover. */
export const RETRYABLE_FAILURES: readonly ProviderFailure[] = [
  'timeout',
  'transport',
  'rate_limit',
];
