/** Disposable copied-corpus test lane; not an atomic snapshot or same-UID sandbox. */
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getExportableCollections } from '../collections/collection-registry.js';
import type { EvalReport } from '../eval/eval-types.js';
import type { StratifiedReport } from '../eval/stratified-report.js';

export interface CopiedRetrievalOptions {
  sourceBase: string;
  tenantId: string;
  /** Explicit trusted executable; this helper does not sandbox arbitrary binaries. */
  qmdBinary: string;
  timeoutMs?: number;
}
export interface CopiedRetrievalResult {
  report: EvalReport;
  stratified: StratifiedReport;
  copiedFiles: number;
  copiedBytes: number;
}
const MAX_BYTES = 2 * 1024 ** 3;
const MAX_FILE_BYTES = 16 * 1024 ** 2;
const MAX_FILES = 100_000;
const MAX_OUTPUT = 2 * 1024 ** 2;

function checkTime(deadline: number): void {
  if (Date.now() >= deadline) throw new Error('Copied retrieval deadline exceeded');
}
function assertDirectoryAncestors(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (!lstatSync(current).isDirectory())
      throw new Error('Copy source requires regular directories');
  }
}
function unchanged(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function copyRegularFile(
  source: string,
  target: string,
  deadline: number,
  remainingBytes: number,
): number {
  const input = openSync(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.size > Math.min(MAX_FILE_BYTES, remainingBytes))
      throw new Error('Unsupported export file');
    const current = lstatSync(source);
    if (!current.isFile() || !unchanged(opened, current))
      throw new Error('Export source changed before copy');
    output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.alloc(256 * 1024);
    let total = 0;
    while (total <= opened.size) {
      checkTime(deadline);
      const count = readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, opened.size - total + 1),
        null,
      );
      if (count === 0) break;
      total += count;
      if (total > opened.size) throw new Error('Export source grew during copy');
      let written = 0;
      while (written < count) written += writeSync(output, buffer, written, count - written);
    }
    if (
      total !== opened.size ||
      !unchanged(opened, fstatSync(input)) ||
      !unchanged(opened, lstatSync(source))
    )
      throw new Error('Export source changed during copy');
    return total;
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}

/** Testable preparation primitive. Cleanup capability closes over only its fresh owned root. */
export function createRetrievalCopy(sourceBase: string, deadline = Date.now() + 120_000) {
  if (!isAbsolute(sourceBase)) throw new Error('Explicit absolute copy source required');
  assertDirectoryAncestors(sourceBase);
  const sourceExport = join(sourceBase, 'kb-export');
  assertDirectoryAncestors(sourceExport);
  const root = mkdtempSync(join(tmpdir(), 'teamkb-retrieval-copy-'));
  const basePath = join(root, 'brain');
  const exportDir = join(basePath, 'kb-export');
  let copiedFiles = 0;
  let copiedBytes = 0;
  const copyDirectory = (source: string, target: string, depth: number): void => {
    checkTime(deadline);
    if (depth > 8) throw new Error('Export directory depth exceeded');
    const before = lstatSync(source);
    if (!before.isDirectory()) throw new Error('Unsupported export directory');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source).sort()) {
      const input = join(source, name);
      const output = join(target, name);
      const stat = lstatSync(input);
      if (stat.isDirectory()) copyDirectory(input, output, depth + 1);
      else if (!stat.isFile()) throw new Error('Unsupported export entry');
      else if (name.endsWith('.md')) {
        copiedFiles++;
        if (copiedFiles > MAX_FILES || copiedBytes + stat.size > MAX_BYTES)
          throw new Error('Export copy budget exceeded');
        copiedBytes += copyRegularFile(input, output, deadline, MAX_BYTES - copiedBytes);
      } else if (name !== '.gitkeep') throw new Error('Unsupported export filename');
    }
    if (!unchanged(before, lstatSync(source)))
      throw new Error('Export directory changed during copy');
  };
  try {
    // Never enumerate/copy the source base's databases, registries, caches or secrets.
    for (const collection of getExportableCollections()) {
      const source = join(sourceExport, collection.sourceSubdir);
      try {
        lstatSync(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      copyDirectory(source, join(exportDir, collection.sourceSubdir), 0);
    }
    if (copiedFiles === 0 || copiedBytes === 0)
      throw new Error('Copy source has no exported content');
    return {
      root,
      basePath,
      exportDir,
      copiedFiles,
      copiedBytes,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
function startTicks(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)?.split(' ')[19];
  } catch {
    return undefined;
  }
}

export async function runCopiedRetrieval(
  options: CopiedRetrievalOptions,
): Promise<CopiedRetrievalResult> {
  if (process.platform !== 'linux')
    throw new Error('Copied retrieval worker requires Linux PID witnesses');
  if (startTicks(process.pid) === undefined)
    throw new Error('Copied retrieval worker requires readable proc PID witnesses');
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error('Invalid copied retrieval timeout');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.tenantId) || !isAbsolute(options.qmdBinary))
    throw new Error('Explicit tenant and absolute trusted qmd binary required');
  const deadline = Date.now() + timeout;
  const copy = createRetrievalCopy(options.sourceBase, deadline);
  let terminal = true;
  try {
    const home = join(copy.root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const index = join(copy.basePath, 'qmd-index', options.tenantId);
    const request = {
      basePath: copy.basePath,
      exportDir: copy.exportDir,
      tenantId: options.tenantId,
      qmdBinary: resolve(options.qmdBinary),
    };
    const require = createRequire(import.meta.url);
    const loader = pathToFileURL(require.resolve('tsx/esm')).href;
    const executable = realpathSync(process.execPath);
    const worker = fileURLToPath(new URL('./live-retrieval-copy-worker.ts', import.meta.url));
    const env = {
      PATH: dirname(executable) + ':/usr/bin:/bin',
      HOME: home,
      TMPDIR: copy.root,
      LANG: 'C.UTF-8',
      TEAMKB_BASE_PATH: copy.basePath,
      XDG_CONFIG_HOME: join(index, 'config'),
      XDG_CACHE_HOME: join(index, 'cache'),
      QMD_CONFIG_DIR: join(index, 'config', 'qmd'),
      INDEX_PATH: join(index, 'cache', 'qmd', 'index.sqlite'),
      COREPACK_ENABLE_NETWORK: '0',
      DO_NOT_TRACK: '1',
    };
    checkTime(deadline);
    const response = await new Promise<CopiedRetrievalResult>((fulfill, reject) => {
      const child = spawn(executable, ['--import', loader, worker], {
        cwd: copy.root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      terminal = false;
      const pid = child.pid;
      const witness = pid === undefined ? undefined : startTicks(pid);
      const output: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      let settled = false;
      let escalator: ReturnType<typeof setTimeout> | undefined;
      let hardLimit: ReturnType<typeof setTimeout> | undefined;
      const retainedError = () =>
        new Error(`Copied retrieval worker failed; scratch retained at ${copy.root}`);
      const signal = (kind: NodeJS.Signals) => {
        if (pid !== undefined && witness !== undefined && startTicks(pid) === witness)
          child.kill(kind);
      };
      const stop = () => {
        if (failed || settled) return;
        failed = true;
        signal('SIGTERM');
        escalator = setTimeout(() => signal('SIGKILL'), 4_000);
        hardLimit = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (escalator !== undefined) clearTimeout(escalator);
          // Unknown/unclosed writers may remain. Never delete this scratch.
          // Release only our pipes/handle; no guessed PID or process-group kill.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(retainedError());
        }, 8_000);
      };
      const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) stop();
        else output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) stop();
      });
      child.stdin.on('error', stop);
      child.on('error', stop);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (escalator !== undefined) clearTimeout(escalator);
        if (hardLimit !== undefined) clearTimeout(hardLimit);
        if (settled) return;
        settled = true;
        if (failed || code !== 0) {
          reject(retainedError());
          return;
        }
        try {
          const result = JSON.parse(
            Buffer.concat(output).toString('utf8'),
          ) as CopiedRetrievalResult & { groupsClosed: boolean };
          if (
            !result.report ||
            !result.stratified ||
            !Number.isInteger(result.report.queryCount) ||
            result.groupsClosed !== true
          )
            throw new Error('Invalid copied retrieval worker report');
          // Code zero alone is insufficient: validate the report before cleanup.
          terminal = true;
          fulfill({ ...result, copiedFiles: copy.copiedFiles, copiedBytes: copy.copiedBytes });
        } catch {
          reject(retainedError());
        }
      });
      if (witness === undefined) {
        stop();
        // No startup request without a verified child identity. The normal
        // worker refuses empty stdin, while the hard limit covers missing close.
        child.stdin.end();
      } else child.stdin.end(JSON.stringify(request));
    });
    return response;
  } finally {
    if (terminal) copy.cleanup();
  }
}
