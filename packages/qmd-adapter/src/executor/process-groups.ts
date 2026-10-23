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
 * Handlers are armed before spawning and remain while a spawn or group is live.
 * They are removed with the last one, so a long-running host (API server, MCP server) keeps its
 * signal listeners between qmd calls. On a signal we SIGTERM every live
 * group (SIGKILL after a short blocking grace), then re-raise the signal only
 * if nobody else is listening for it — a host with its own handler keeps
 * control when another listener remains at that check. An earlier once-handler
 * has already removed itself by then; preserving that callback's control is a
 * separate follow-up. `uninstall` removes only our own listeners.
 */
const live = new Set<number>();
let pendingSpawns = 0;
let installed = false;
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
 * tracked qmd group that ignores SIGTERM receives SIGKILL before host shutdown.
 * This does not confirm post-SIGKILL reaping or cover a host killed with SIGKILL,
 * descendants that leave the group, or an uninterruptible kernel state.
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
  if (installed) return;
  installed = true;
  process.on('exit', onExit);
  for (const s of FORWARDED) process.on(s, onSignal);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  process.off('exit', onExit);
  for (const s of FORWARDED) process.off(s, onSignal);
}

/**
 * Arm signal handlers BEFORE spawn. A child can run before spawn returns its
 * PID; a fatal default signal in that interval would leave it unowned. Signal
 * callbacks run after the synchronous spawn/registration stack has completed.
 * The returned release also removes handlers after a failed/no-PID spawn.
 */
export function beginGroupSpawn(): () => void {
  install();
  pendingSpawns++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingSpawns--;
    if (live.size === 0 && pendingSpawns === 0) uninstall();
  };
}

/** Register a live process group (its leader's pid). */
export function trackGroup(pgid: number): void {
  install();
  live.add(pgid);
}

/** Forget a process group once it has exited. */
export function untrackGroup(pgid: number): void {
  if (!live.delete(pgid)) return;
  if (live.size === 0 && pendingSpawns === 0) uninstall();
}

/** Number of live tracked groups (diagnostics/tests). */
export function liveGroupCount(): number {
  return live.size;
}
