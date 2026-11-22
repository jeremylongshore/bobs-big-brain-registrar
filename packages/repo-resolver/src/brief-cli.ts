import { buildProjectBrief, serializeProjectBrief } from './brief.js';

// Explicit stdin only: no default paths, live stores, credentials or network.
const MAX_INPUT_BYTES = 262144;
let input = '';
let bytes = 0;
process.stdin.setEncoding('utf8');
try {
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_INPUT_BYTES) {
      process.stdout.write(serializeProjectBrief({ ok: false, error: { kind: 'InvalidInput' } }));
      process.stdin.destroy();
      process.exitCode = 2;
      break;
    }
    input += text;
  }
  if (process.exitCode !== 2) {
    const result = buildProjectBrief(JSON.parse(input));
    process.stdout.write(serializeProjectBrief(result));
    if (!result.ok) process.exitCode = 2;
  }
} catch {
  process.stdout.write(serializeProjectBrief({ ok: false, error: { kind: 'InvalidInput' } }));
  process.exitCode = 2;
}
