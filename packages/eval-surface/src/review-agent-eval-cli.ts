#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { scoreFrozenReviewDataset, verifyFrozenReviewDataset } from './review-agent-frozen.js';
import { selfTestFrozenReview } from './review-agent-frozen-self-test.js';

function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--self-test')
    return selfTestFrozenReview(fileURLToPath(import.meta.url));
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'review-agent-eval --verify-manifest|--score PREDICTIONS.json --eval-root DIR --manifest-sha256 SHA\n' +
        '  [--previous-manifest FILE --previous-sha256 SHA]\nreview-agent-eval --self-test\n' +
        'Digest approval and human label provenance belong to the caller. No operational qualification is implied.\n',
    );
    return 0;
  }
  const values = new Map<string, string>();
  let verify = false;
  const valued = [
    '--score',
    '--eval-root',
    '--manifest-sha256',
    '--previous-manifest',
    '--previous-sha256',
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--verify-manifest' && !verify) {
      verify = true;
      continue;
    }
    if (!valued.includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--'))
      throw new Error('usage');
    values.set(arg, args[++i]!);
  }
  const root = values.get('--eval-root');
  const manifestSha256 = values.get('--manifest-sha256');
  const predictions = values.get('--score');
  const prior = values.get('--previous-manifest');
  const priorHash = values.get('--previous-sha256');
  if (
    !root ||
    !manifestSha256 ||
    verify === Boolean(predictions) ||
    Boolean(prior) !== Boolean(priorHash)
  )
    throw new Error('usage');
  const options = {
    root,
    manifestSha256,
    ...(prior && priorHash ? { previous: { manifestPath: prior, sha256: priorHash } } : {}),
  };
  const result = verify
    ? verifyFrozenReviewDataset(options)
    : scoreFrozenReviewDataset(options, predictions!);
  process.stdout.write(JSON.stringify(result) + '\n');
  return 'passed' in result && !result.passed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch {
  // Do not echo untrusted paths, source bodies, credentials, parser details or stack traces.
  process.stderr.write('Invalid frozen review evaluation input or evidence. Use --help.\n');
  process.exitCode = 2;
}
