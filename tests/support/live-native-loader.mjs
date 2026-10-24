// ESM half of the synthetic native-import sentinel; no application loader use.
import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, next) {
  const native = (value) => /(?:^|[/\\])(?:better-sqlite3|sqlite-vec)(?:[/\\]|$)/.test(value);
  if (native(specifier)) {
    appendFileSync(
      process.env.TEAMKB_TEST_SENTINEL_LOG,
      JSON.stringify({ kind: 'native-import' }) + '\n',
    );
    throw new Error('Synthetic sentinel refused native-import');
  }
  const result = await next(specifier, context);
  if (native(result.url)) {
    appendFileSync(
      process.env.TEAMKB_TEST_SENTINEL_LOG,
      JSON.stringify({ kind: 'native-import' }) + '\n',
    );
    throw new Error('Synthetic sentinel refused native-import');
  }
  return result;
}
