/// Terminable worker for the CPU-heavy part of a version comparison: the text diff only.
import { runTextDiff } from '@lexaegis/agent/review';

interface Request {
  readonly job: string;
  readonly oldText: string;
  readonly newText: string;
}
const scope = self as unknown as {
  onmessage: ((event: { data: Request }) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (event) => {
  const { job, oldText, newText } = event.data;
  scope.postMessage({ job, outcome: runTextDiff(oldText, newText) });
};
