import { AsyncLocalStorage } from 'node:async_hooks';
import { EmbedFailure } from '../../packages/qmd-adapter/src/dense/embed-client.js';
import type { RetrievalContext } from '../../packages/qmd-adapter/src/eval/eval-types.js';

/** Only fixed categories reach reports; raw errors can contain private paths. */
export function classifyDenseFailure(reason: unknown): string {
  if (reason instanceof EmbedFailure) {
    switch (reason.category) {
      case 'timeout':
      case 'transport-failure':
      case 'http-error':
      case 'invalid-json':
      case 'invalid-response':
        return reason.category;
    }
  }
  const message = reason instanceof Error ? reason.message : '';
  switch (message) {
    case 'dense arm unavailable after construction':
      return 'construction-unavailable';
    case 'dense index is empty or unbuilt':
      return 'unbuilt-or-empty';
    case 'query vector dimension does not match dense index':
      return 'dimension-mismatch';
    default:
      return 'query-failure';
  }
}

/** Attribution is invocation-local; only fixed fields enter the bounded event list. */
export class EstateDenseDiagnostics {
  private readonly context = new AsyncLocalStorage<RetrievalContext | undefined>();
  readonly categories: Record<string, number> = {};
  readonly events: Array<{
    phase: RetrievalContext['phase'] | 'unattributed';
    queryId: string | null;
    category: string;
    httpStatus?: number;
  }> = [];
  total = 0;
  droppedEvents = 0;

  run<T>(context: RetrievalContext | undefined, operation: () => Promise<T>): Promise<T> {
    return this.context.run(context, operation);
  }

  observe(reason: unknown): void {
    const category = classifyDenseFailure(reason);
    this.total++;
    this.categories[category] = (this.categories[category] ?? 0) + 1;
    if (this.events.length >= 1000) {
      this.droppedEvents++;
      return;
    }
    const context = this.context.getStore();
    // Worker supplies dataset IDs or generated probe IDs. Omit IDs outside the safe format.
    const valid =
      context !== undefined &&
      ['scored', 'gap', 'probe'].includes(context.phase) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(context.queryId);
    const status = reason instanceof EmbedFailure ? reason.httpStatus : undefined;
    this.events.push({
      phase: valid ? context.phase : 'unattributed',
      queryId: valid ? context.queryId : null,
      category,
      ...(category === 'http-error' &&
      status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? { httpStatus: status }
        : {}),
    });
  }
}
