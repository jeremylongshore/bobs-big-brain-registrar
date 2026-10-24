/** Exact opt-in only; module collection must never discover live state. */
export function liveTestEnabled(kind: 'DENSE' | 'RERANK' | 'RETRIEVAL'): boolean {
  return process.env[`TEAMKB_TEST_LIVE_${kind}`] === '1';
}

export function requireLiveSetting(name: string): string {
  if (process.env['TEAMKB_TEST_LIVE_LANE'] !== '1') {
    throw new Error('Live tests require --config vitest.live.config.ts');
  }
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Explicit live test configuration required: ${name}`);
  return value;
}

/** Keep maintenance cmd/sub and literal query text in their original positions. */
export function liveQmdArgs(args: string[]): string[] {
  const terminator = args.indexOf('--');
  const at = terminator < 0 ? args.length : terminator;
  return [...args.slice(0, at), '--index', 'index', ...args.slice(at)];
}
