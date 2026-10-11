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
 * group (SIGKILL after a short blocking grace), then re-raise the signal only
 * if nobody else is listening for it — a host with its own handler keeps
 * control of its shutdown. Every listener on a signal is called, so a host
 * handler registered before or after ours still runs; `uninstall` removes
 * only our own listeners.
 */
const live = new Set<number>();
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * How long a dying host waits for its qmd groups to honour SIGTERM before
 * SIGKILLing them. This runs synchronously (the host is about to exit, so an
 * async timer would never fire), hence shorter than the executor's grace.
 */
const SHUTDOWN_GRACE_MS = 2_000;
const SHUTDOWN_POLL_MS = 50;

function killAll(signal: NodeJS.Signals): void {
  for (const pgid of live) {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* already gone */
    }
  }
}

function anyAlive(): boolean {
  for (const pgid of live) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return false;
}

/**
 * SIGTERM every live group, wait (blocking) up to {@link SHUTDOWN_GRACE_MS}
 * for them to exit, then SIGKILL whatever remains. Synchronous on purpose:
 * it runs on the way out of the process, where no timer will ever fire, and a
 * qmd that ignores SIGTERM must not outlive the host that started it.
 */
function shutdownGroups(): void {
  if (live.size === 0) return;
  killAll('SIGTERM');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (anyAlive() && Date.now() < deadline) Atomics.wait(pause, 0, 0, SHUTDOWN_POLL_MS);
  if (anyAlive()) killAll('SIGKILL');
}

const onExit = (): void => shutdownGroups();

const onSignal = (signal: NodeJS.Signals): void => {
  shutdownGroups();
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
