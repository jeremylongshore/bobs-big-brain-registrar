/**
 * Registry of live qmd process groups owned by this process.
 *
 * The executor spawns qmd `detached` (its own process group) so a timeout can
 * signal the launcher AND the `node qmd.js` it re-execs. The cost of a
 * separate group is that a terminal Ctrl-C (SIGINT to the foreground group) or
 * a SIGTERM/SIGHUP to this process no longer reaches qmd. Without this
 * registry, interrupting `reindex` would recreate the exact orphan the
 * detached spawn exists to prevent.
 *
 * Handlers are installed only while at least one group is live, and removed
 * with the last one, so a long-running host (API server, MCP server) keeps its
 * own signal semantics between qmd calls. On a signal we SIGTERM every live
 * group, then re-raise the signal only if nobody else is listening for it —
 * a host with its own handler keeps control of its shutdown.
 */
const live = new Set<number>();
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function killAll(signal: NodeJS.Signals): void {
  for (const pgid of live) {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* already gone */
    }
  }
}

const onExit = (): void => killAll('SIGTERM');

const onSignal = (signal: NodeJS.Signals): void => {
  killAll('SIGTERM');
  uninstall();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
};

function install(): void {
  process.on('exit', onExit);
  for (const s of FORWARDED) process.on(s, onSignal);
}

function uninstall(): void {
  process.off('exit', onExit);
  for (const s of FORWARDED) process.off(s, onSignal);
}

/** Register a live process group (its leader's pid). */
export function trackGroup(pgid: number): void {
  if (live.size === 0) install();
  live.add(pgid);
}

/** Forget a process group once it has exited. */
export function untrackGroup(pgid: number): void {
  if (!live.delete(pgid)) return;
  if (live.size === 0) uninstall();
}

/** Number of live tracked groups (diagnostics/tests). */
export function liveGroupCount(): number {
  return live.size;
}
