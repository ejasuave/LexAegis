import {
  jobInputSchema,
  runVerificationJob,
  type JobOutcome,
  type JobProgress,
} from './verification-job';

/*
 * The dedicated local verification worker. It receives bytes by transfer, runs the strict decode
 * and offline verification, and posts progress counts and one result. It makes no network request
 * (it never imports fetch users) and keeps nothing: no storage, no cache, no URL.
 */

export type WorkerRequest = {
  readonly type: 'run';
  readonly generation: number;
  readonly input: unknown;
};
export type WorkerResponse =
  | { readonly type: 'progress'; readonly generation: number; readonly update: JobProgress }
  | { readonly type: 'done'; readonly generation: number; readonly outcome: JobOutcome };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = (event) => {
  const { generation, input } = event.data;
  const parsed = jobInputSchema.safeParse(input);
  if (!parsed.success) {
    scope.postMessage({ type: 'done', generation, outcome: { ok: false, code: 'SCHEMA_INVALID' } });
    return;
  }
  void runVerificationJob(parsed.data, (update) =>
    scope.postMessage({ type: 'progress', generation, update }),
  ).then((outcome) => {
    scope.postMessage({ type: 'done', generation, outcome });
  });
};
