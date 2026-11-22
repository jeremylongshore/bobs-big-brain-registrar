import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { Uuid, Sha256Hash } from '@qmd-team-intent-kb/schema';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const notificationRequestSchema = z
  .object({
    version: z.literal(1),
    attemptId: Uuid,
    destinationId: identifier,
    message: z.string().min(1).max(8192),
  })
  .strict();
export type NotificationRequest = z.infer<typeof notificationRequestSchema>;
const receiptSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('live'),
    attemptId: Uuid,
    destinationId: identifier,
    outcome: z.enum(['delivered', 'failed', 'unknown']),
  })
  .strict();
export interface NotificationTransport {
  executable: string;
  sha256: string;
  timeoutMs: number;
}
export interface NotificationTransportResult {
  outcome: 'delivered' | 'failed' | 'unknown';
  reason: 'receipt' | 'invalid_configuration' | 'unconfirmed_process' | 'invalid_receipt';
  /** The bounded raw receipt is hashed, never returned or copied into audit text. */
  receiptDigest?: string;
}

/** Trusted executable, not a shell command; this is not a sandbox against its OS identity. */
function openExecutable(config: NotificationTransport): number {
  Sha256Hash.parse(config.sha256);
  if (
    !isAbsolute(config.executable) ||
    realpathSync(config.executable) !== config.executable ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 30000 ||
    process.platform !== 'linux'
  )
    throw new Error('Invalid notification configuration');
  const fd = openSync(
    config.executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0 ||
      (stat.uid !== process.getuid?.() && stat.uid !== 0) ||
      stat.size > 1024 * 1024
    )
      throw new Error('Unsafe notification executable');
    if (createHash('sha256').update(readFileSync(fd)).digest('hex') !== config.sha256)
      throw new Error('Notification executable changed');
    const after = fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('Executable changed during read');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Read-only preflight; no process is launched. Execution revalidates the descriptor. */
export function verifyNotificationTransport(config: NotificationTransport): void {
  closeSync(openExecutable(config));
}

/**
 * Send one pre-authorized, audience-safe message. Caller must persist intent first.
 * No shell interpolation, command-line payload, inherited stdin or raw error output.
 * The adapter must emit one strict JSON receipt and exit zero. Exit zero alone,
 * preview receipts, destination drift, malformed output and process failures never
 * establish delivery. The adapter is trusted to implement the provider contract.
 */
export async function runNotificationTransport(
  request: NotificationRequest,
  config: NotificationTransport,
): Promise<NotificationTransportResult> {
  let input: NotificationRequest;
  let executableFd: number;
  try {
    input = notificationRequestSchema.parse(request);
    executableFd = openExecutable(config);
  } catch {
    return { outcome: 'failed', reason: 'invalid_configuration' };
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/proc/self/fd/3', [], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', executableFd],
        shell: false,
      });
    } catch {
      resolve({ outcome: 'unknown', reason: 'unconfirmed_process' });
      return;
    } finally {
      closeSync(executableFd);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let done = false;
    const terminate = () => {
      failed = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    };
    const timer = setTimeout(() => {
      terminate();
      child.stdin!.destroy();
      child.stdout!.destroy();
      child.stderr!.destroy();
    }, config.timeoutMs);
    child.on('error', () => {
      failed = true;
    });
    child.stdin!.on('error', terminate);
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) terminate();
      else chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) terminate();
    });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // End remaining children in the adapter's process group. A trusted adapter
      // must not daemonize or escape this group; detached descendants are outside
      // this process boundary and cannot be treated as a bounded integration.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
      }
      if (failed || code !== 0 || signal !== null) {
        resolve({ outcome: 'unknown', reason: 'unconfirmed_process' });
        return;
      }
      const output = Buffer.concat(chunks);
      try {
        const receipt = receiptSchema.parse(JSON.parse(output.toString('utf8')));
        if (receipt.attemptId !== input.attemptId || receipt.destinationId !== input.destinationId)
          throw new Error('Receipt binding mismatch');
        resolve({
          outcome: receipt.outcome,
          reason: 'receipt',
          receiptDigest: createHash('sha256').update(output).digest('hex'),
        });
      } catch {
        resolve({ outcome: 'unknown', reason: 'invalid_receipt' });
      }
    });
    child.stdin!.end(JSON.stringify(input) + '\n');
  });
}
