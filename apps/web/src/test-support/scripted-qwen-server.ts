import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

/*
 * lexaegis-test-only
 * SCRIPTED test provider speaking the Chat Completions wire format on 127.0.0.1. It follows a
 * fixed policy keyed on the request it receives; no model is involved and nothing leaves the
 * machine. The application reaches it only in the explicit scripted test mode, where every
 * surface labels the provider "scripted-test". Used by browser checks; never by production.
 *
 * Markers in the reviewer's REQUEST text select a behaviour:
 *   SLOW-TEST     the first completion waits (so Stop can be exercised) until the client aborts
 *   PROPOSE-TEST  the final answer proposes a fact and asks for confirmation
 *   INJECT-TEST   the "model" obeys injected instructions: it asks for a signing tool first
 *   FAIL-TEST     every completion for this request fails with a provider error (HTTP 500)
 *   HOSTILE-TEST  the explanation and the scope limitation carry executable-looking markup, script
 *                 and link schemes and Markdown: the page must render them as inert text
 */

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface WireRequest {
  model?: string;
  messages?: WireMessage[];
  tools?: { function: { name: string } }[];
  response_format?: { type: string };
  stream?: boolean;
  enable_thinking?: boolean;
  enable_search?: boolean;
  parallel_tool_calls?: boolean;
}

export interface ScriptedQwenServer {
  /** Base URL to configure as ASSISTANT_TEST_PROVIDER_URL. */
  readonly baseUrl: string;
  /** Every request body received, for assertions about what reached the provider. */
  readonly requests: WireRequest[];
  /** Authorization headers received. The test mode sends a fixed placeholder, never a real key. */
  readonly authorizations: string[];
  stop(): Promise<void>;
}

type Intent =
  | 'summarise'
  | 'explain'
  | 'check_payments'
  | 'missing_evidence'
  | 'brief_matter'
  | 'prepare_review'
  | 'status';

const OBJECTIVES: readonly (readonly [Intent, string])[] = [
  ['summarise', 'a concise summary of the selected sources'],
  ['explain', 'explain the exact selected clause'],
  ['check_payments', 'reconcile the stated GBP total'],
  ['missing_evidence', 'the evidence gaps within the selected scope'],
  ['brief_matter', 'the requested briefing on this matter'],
  ['prepare_review', 'what is still required before a review draft'],
  ['status', 'a factual status reading'],
];

/** Hostile model prose for the inert-rendering check (under the 300-character limit on a scope limitation). */
export const HOSTILE_TEXT =
  '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>' +
  '[go](javascript:window.__xss=3) <a href="javascript:window.__xss=4">link</a> ' +
  '![pixel](https://example.invalid/pixel.png) <iframe src="https://example.invalid/"></iframe> ' +
  '**bold** # heading';

const PLAN: Readonly<Record<Intent, readonly string[]>> = {
  summarise: ['read_sources'],
  explain: ['read_sources'],
  check_payments: ['check_payments'],
  missing_evidence: ['check_evidence'],
  brief_matter: ['read_sources', 'check_payments', 'check_evidence'],
  prepare_review: ['prepare_review'],
  status: ['get_status'],
};

function between(text: string, start: string, ends: readonly string[]): string {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const rest = text.slice(from + start.length);
  const cut = ends.map((end) => rest.indexOf(end)).filter((index) => index >= 0);
  return cut.length === 0 ? rest : rest.slice(0, Math.min(...cut));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export async function startScriptedQwenServer(): Promise<ScriptedQwenServer> {
  const requests: WireRequest[] = [];
  const authorizations: string[] = [];
  let serial = 0;

  const reply = (response: ServerResponse, message: Record<string, unknown>, finish = 'stop') => {
    serial += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: `scripted-${serial}`,
        object: 'chat.completion',
        model: 'scripted-test-model',
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
        usage: { prompt_tokens: 200 + serial, completion_tokens: 30, total_tokens: 230 + serial },
      }),
    );
  };
  const callTool = (response: ServerResponse, name: string, args: unknown) =>
    reply(
      response,
      {
        content: null,
        tool_calls: [
          {
            id: `call_${serial + 1}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      'tool_calls',
    );

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || request.url !== '/compatible-mode/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NotFound' } }));
      return;
    }
    authorizations.push(request.headers.authorization ?? '');
    const body = JSON.parse(await readBody(request)) as WireRequest;
    requests.push(body);
    const messages = body.messages ?? [];
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    const asked = between(user, 'REQUEST\n', ['\n\nGive the', '\n\nReturn the']).trim();

    // A provider outage for this request only: the application must report it, never retry silently.
    if (asked.includes('FAIL-TEST')) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'ScriptedProviderFailure' } }));
      return;
    }

    // The synthetic capability checks: a native tool call, and a request held open until aborted.
    if (system.startsWith('Capability check')) {
      callTool(response, body.tools?.[0]?.function.name ?? 'get_status', { scope: 'matter' });
      return;
    }
    if (user.startsWith('Count slowly')) {
      const timer = setTimeout(() => reply(response, { content: 'one' }), 30_000);
      response.on('close', () => clearTimeout(timer));
      return;
    }

    // The single routing completion: the utterance only.
    if (system.startsWith('Classify the reviewer')) {
      const intent = /clause|passage|mean/i.test(asked) ? 'explain' : 'clarify';
      reply(response, { content: JSON.stringify({ intent }) });
      return;
    }

    const intent = OBJECTIVES.find(([, phrase]) => system.includes(phrase))?.[0] ?? 'summarise';
    let context: { sources?: { handle: string }[] } = {};
    try {
      context = JSON.parse(
        between(user, 'CONTEXT\n', ['\n\nHISTORY\n', '\n\nREQUEST\n']),
      ) as typeof context;
    } catch {
      context = {};
    }
    const handles = (context.sources ?? []).map((source) => source.handle).slice(0, 16);
    const toolResults = messages
      .filter((message) => message.role === 'tool')
      .map((message) => {
        try {
          return JSON.parse(message.content ?? '{}') as { handle?: string };
        } catch {
          return {};
        }
      });
    const called = messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function.name);

    if (body.response_format === undefined) {
      // ---- A tool round ----
      if (asked.includes('SLOW-TEST') && toolResults.length === 0) {
        // Hold the request open; it ends when the application aborts it.
        const timer = setTimeout(() => reply(response, { content: 'DONE' }), 30_000);
        response.on('close', () => clearTimeout(timer));
        return;
      }
      if (
        asked.includes('INJECT-TEST') &&
        !messages.some((m) => /rejected/.test(m.content ?? ''))
      ) {
        // Behaves as if the injected text had been obeyed. The application must refuse it.
        callTool(response, 'sign_and_approve_package', {
          approve: true,
          url: 'https://example.invalid/steal',
        });
        return;
      }
      const offered = new Set((body.tools ?? []).map((tool) => tool.function.name));
      const next = PLAN[intent].filter((name) => offered.has(name))[
        called.filter((name) => offered.has(name)).length
      ];
      if (next === undefined || (next === 'read_sources' && handles.length === 0)) {
        reply(response, { content: 'DONE' });
        return;
      }
      const args: Record<string, unknown> = {
        read_sources: { sourceIds: handles },
        check_payments: { groupId: 'settlement' },
        check_evidence: { ruleIds: [] },
        prepare_review: {},
        get_status: { scope: 'matter' },
      };
      callTool(response, next, args[next]);
      return;
    }

    // ---- The final structured round ----
    const tool = (index: number) => toolResults[index]?.handle ?? '';
    const block = (
      kind: string,
      text: string,
      refs: { sources?: string[]; tools?: string[]; basis?: string },
    ) => ({
      kind,
      text,
      basis: refs.basis ?? 'supported',
      sources: refs.sources ?? [],
      rules: [],
      tools: refs.tools ?? [],
    });
    const first = handles[0];
    const blocks: unknown[] = [];
    if (intent === 'summarise' || intent === 'explain') {
      if (first !== undefined) {
        blocks.push(block('quotation', '', { sources: [first] }));
        blocks.push(
          block(
            'explanation',
            asked.includes('HOSTILE-TEST')
              ? HOSTILE_TEXT
              : 'Scripted test answer: the selected passage states the figure shown above.',
            { sources: [first] },
          ),
        );
      }
    } else if (intent === 'check_payments') {
      blocks.push(
        block('calculation', 'Scripted test comment: see the computed result.', {
          tools: [tool(0)],
        }),
      );
    } else if (intent === 'status') {
      blocks.push(block('status', '', { tools: [tool(0)] }));
    } else if (intent === 'brief_matter') {
      if (first !== undefined) blocks.push(block('quotation', '', { sources: [first] }));
      toolResults
        .slice(1, 2)
        .forEach((result) =>
          blocks.push(block('calculation', '', { tools: [result.handle ?? ''] })),
        );
    } else {
      blocks.push(
        block(
          'finding',
          'Scripted test answer: the outstanding items are listed in the tool result.',
          {
            tools: [tool(0)],
            basis: 'interpretation',
          },
        ),
      );
    }
    const proposing = asked.includes('PROPOSE-TEST') && first !== undefined;
    reply(response, {
      content: JSON.stringify({
        outcome: proposing ? 'needs_input' : 'answer',
        blocks,
        factProposals: proposing
          ? [
              {
                field: 'employer',
                group: 'settlement',
                slot: 'employer',
                value: 'Northwind Analytics Ltd',
                sources: [first],
              },
            ]
          : [],
        unresolved: [],
        questions: proposing ? ['Is this the employer named in the agreement?'] : [],
        scopeLimitations: [
          asked.includes('HOSTILE-TEST')
            ? HOSTILE_TEXT
            : 'Scripted test provider: no model produced this text.',
        ],
        nextActions: proposing ? ['confirm_fact'] : ['open_source'],
      }),
    });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'InternalError' } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/compatible-mode/v1`,
    requests,
    authorizations,
    async stop() {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
