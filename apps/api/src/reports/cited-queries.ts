/**
 * Weekly cited-query report — the governed brain's adoption KPI.
 *
 * The search route emits one `query-access` access-log line per read (see
 * `routes/search.ts`): `{ event, actor, query, scope, resultCount, citations }`.
 * This module aggregates those lines into a per-teammate count of how many
 * queries each person ran and how many came back with at least one `qmd://`
 * citation — the "weekly cited-query count per teammate" the brain is judged on.
 *
 * Pure and I/O-free on purpose: it takes raw log lines (strings) plus an
 * explicit time window, so it behaves identically whether the lines come from
 * journald, a teed file, or a test fixture. The CLI
 * (`weekly-cited-queries-cli.ts`) is the only piece that touches the journal.
 */

/** The fields the report needs out of one parsed `query-access` event. */
export interface QueryAccessEvent {
  /** Audit actor — the teammate (or agent) the bearer token resolved to. */
  actor: string;
  /** The `qmd://` citations returned for this query (empty = uncited). */
  citations: string[];
  /** Event timestamp, epoch milliseconds (pino `time`). */
  time: number;
}

/** Per-teammate roll-up for the window. */
export interface ActorCitedSummary {
  actor: string;
  /** Every query-access event in-window for this actor. */
  totalQueries: number;
  /** Queries that returned at least one citation. */
  citedQueries: number;
  /** Sum of citations returned across all this actor's in-window queries. */
  citationsReturned: number;
}

/** The full report over a window. */
export interface CitedQueryReport {
  sinceMs: number;
  untilMs: number;
  /** Actors, sorted by citedQueries desc then actor asc (stable, deterministic). */
  perActor: ActorCitedSummary[];
  totalQueries: number;
  totalCitedQueries: number;
}

/** A half-open-free, inclusive window `[sinceMs, untilMs]`. */
export interface ReportWindow {
  sinceMs: number;
  untilMs: number;
}

/** The pino `event` value the search route stamps on every read. */
export const QUERY_ACCESS_EVENT = 'query-access';

/** Milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse one access-log line into a {@link QueryAccessEvent}, or `undefined` if
 * the line is not a well-formed query-access event. Defensive by design:
 * journald interleaves startup banners, other pino lines, and fields we ignore.
 */
export function parseQueryAccessLine(line: string): QueryAccessEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const rec = parsed as Record<string, unknown>;
  if (rec.event !== QUERY_ACCESS_EVENT) return undefined;
  if (typeof rec.actor !== 'string') return undefined;
  if (typeof rec.time !== 'number') return undefined;

  const citations = Array.isArray(rec.citations)
    ? rec.citations.filter((c): c is string => typeof c === 'string')
    : [];

  return { actor: rec.actor, citations, time: rec.time };
}

/**
 * Aggregate access-log lines into a per-actor cited-query report, counting only
 * events whose timestamp falls within the inclusive window `[since, until]`.
 */
export function summarizeCitedQueries(
  lines: Iterable<string>,
  window: ReportWindow,
): CitedQueryReport {
  const byActor = new Map<string, ActorCitedSummary>();
  let totalQueries = 0;
  let totalCitedQueries = 0;

  for (const line of lines) {
    const event = parseQueryAccessLine(line);
    if (event === undefined) continue;
    if (event.time < window.sinceMs || event.time > window.untilMs) continue;

    let summary = byActor.get(event.actor);
    if (summary === undefined) {
      summary = { actor: event.actor, totalQueries: 0, citedQueries: 0, citationsReturned: 0 };
      byActor.set(event.actor, summary);
    }

    summary.totalQueries += 1;
    summary.citationsReturned += event.citations.length;
    totalQueries += 1;

    if (event.citations.length > 0) {
      summary.citedQueries += 1;
      totalCitedQueries += 1;
    }
  }

  const perActor = [...byActor.values()].sort(
    (a, b) => b.citedQueries - a.citedQueries || a.actor.localeCompare(b.actor),
  );

  return {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    perActor,
    totalQueries,
    totalCitedQueries,
  };
}

/** A rolling N-day window ending at `nowMs`. `days` defaults to 7 ("weekly"). */
export function rollingWindow(nowMs: number, days = 7): ReportWindow {
  return { sinceMs: nowMs - days * MS_PER_DAY, untilMs: nowMs };
}

/** Render a report as a fixed-width human table. Pure (returns the string). */
export function formatReport(report: CitedQueryReport): string {
  const out: string[] = [];
  out.push('Weekly cited-query count per teammate');
  out.push(
    `Window: ${new Date(report.sinceMs).toISOString()} -> ${new Date(report.untilMs).toISOString()}`,
  );
  out.push('');

  if (report.perActor.length === 0) {
    out.push('(no queries in window)');
  } else {
    out.push('actor             cited / total   citations');
    out.push('----------------- -------------   ---------');
    for (const a of report.perActor) {
      const actor = a.actor.padEnd(17);
      const ratio = `${a.citedQueries} / ${a.totalQueries}`.padEnd(13);
      out.push(`${actor} ${ratio}   ${a.citationsReturned}`);
    }
  }

  out.push('');
  out.push(`Total: ${report.totalCitedQueries} cited / ${report.totalQueries} queries`);
  return out.join('\n');
}
