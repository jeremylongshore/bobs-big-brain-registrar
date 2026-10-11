import type { CommandResult, QmdError } from '../types.js';
import { QMD_TIMEOUT_ENV } from '../config.js';
import { QMD_NOT_FOUND_EXIT_CODE } from './resolve-binary.js';
import { isMaintenanceCommand } from './real-executor.js';

/** Max characters of qmd stderr carried into an error message. */
export const STDERR_TAIL_CHARS = 2_000;
/** Max lines of qmd stderr carried into an error message. */
const STDERR_TAIL_LINES = 20;

/**
 * The last few lines of qmd's stderr, bounded. qmd draws progress bars with
 * carriage returns; those are normalised to newlines so the tail shows the
 * final state rather than one enormous redrawn line.
 */
export function stderrTail(stderr: string): string {
  const lines = stderr
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');
  const tail = lines.slice(-STDERR_TAIL_LINES).join('\n');
  return tail.length > STDERR_TAIL_CHARS ? `…${tail.slice(-STDERR_TAIL_CHARS)}` : tail;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Turn a failed qmd run into a {@link QmdError} that says what actually
 * happened (bead compile-then-govern-39z.20). A timeout, a non-zero exit, a
 * signal and a spawn error are different operator actions, so they are never
 * collapsed into one opaque "Failed to …" line:
 *
 *  - timeout     → code `timeout`; elapsed time, the limit, whether the qmd
 *                  process group is confirmed gone, and how to raise the limit.
 *  - spawn / 127 → code `not_available`; the executor's actionable message.
 *  - signal      → code `command_failed`; which signal, plus the stderr tail.
 *  - overflow    → code `command_failed`; the output cap that was exceeded.
 *  - exit N      → code `command_failed`; the exit code plus a bounded stderr tail.
 *
 * Precondition: `result.exitCode !== 0`.
 */
export function describeQmdFailure(args: readonly string[], result: CommandResult): QmdError {
  const command = `qmd ${args.join(' ')}`;
  const tail = stderrTail(result.stderr);
  const withTail = (msg: string): string => (tail === '' ? msg : `${msg}; stderr: ${tail}`);
  const base = { command, stderr: result.stderr };
  const failure = result.failure;

  if (failure?.kind === 'timeout') {
    const cleanup = failure.groupTerminated
      ? 'its process group was terminated, so no qmd process is still writing the index'
      : 'WARNING: its process group could not be confirmed gone — check for a stray qmd process before re-running';
    const raise = isMaintenanceCommand(args)
      ? `Raise the limit with ${QMD_TIMEOUT_ENV}=<ms> or \`qmd-index reindex --timeout-ms <ms>\``
      : 'Interactive qmd commands keep the 30 s limit; investigate why qmd is slow (load, a locked index)';
    return {
      ...base,
      code: 'timeout',
      message:
        `${command} timed out after ${seconds(failure.elapsedMs)} ` +
        `(limit ${failure.timeoutMs} ms); ${cleanup}. ${raise}.`,
    };
  }
  if (failure?.kind === 'spawn' || result.exitCode === QMD_NOT_FOUND_EXIT_CODE) {
    return { ...base, code: 'not_available', message: result.stderr };
  }
  if (failure?.kind === 'signal') {
    return {
      ...base,
      code: 'command_failed',
      message: withTail(
        `${command} was killed by ${failure.signal} after ${seconds(failure.elapsedMs)}`,
      ),
    };
  }
  if (failure?.kind === 'output_overflow') {
    return {
      ...base,
      code: 'command_failed',
      message:
        `${command} produced more than ${failure.limitBytes} bytes of output after ` +
        `${seconds(failure.elapsedMs)}; its process group was terminated`,
    };
  }
  return {
    ...base,
    code: 'command_failed',
    message:
      withTail(`${command} exited with code ${result.exitCode}`) +
      (tail === '' ? ' (no stderr output)' : ''),
  };
}
