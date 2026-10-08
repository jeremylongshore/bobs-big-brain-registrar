import { lstatSync, readFileSync } from 'node:fs';

/**
 * Read the removed-text fragments for an index byte scan from a caller-owned
 * file (`--scan-fragments-file`). The file holds secrets, so it must be a
 * regular file readable by its owner only (mode 0600 or tighter); anything
 * looser is refused rather than read. One fragment per line; blank lines are
 * ignored; a trailing CR is dropped. The caller deletes or shreds the file —
 * this never writes, copies or prints it.
 */
export function readFragmentsFile(
  path: string,
): { ok: true; fragments: string[] } | { ok: false; message: string } {
  let mode: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { ok: false, message: `${path} is not a regular file` };
    mode = stat.mode & 0o777;
  } catch (error) {
    return { ok: false, message: `cannot stat ${path}: ${(error as Error).message}` };
  }
  if ((mode & 0o077) !== 0) {
    return {
      ok: false,
      message: `${path} is mode ${mode.toString(8).padStart(4, '0')}; it must be 0600 (chmod 600)`,
    };
  }
  const fragments = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);
  return { ok: true, fragments };
}
