/** Internal owned-worker entry: runtime imports occur only after private env validation. */
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

interface Request {
  basePath: string;
  exportDir: string;
  tenantId: string;
  qmdBinary: string;
}
async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as Request;
  const root = process.cwd();
  const index = join(root, 'brain', 'qmd-index', request.tenantId);
  if (
    request.basePath !== join(root, 'brain') ||
    request.exportDir !== join(root, 'brain', 'kb-export') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(request.tenantId) ||
    resolve(request.qmdBinary) !== request.qmdBinary ||
    process.env['HOME'] !== join(root, 'home') ||
    process.env['TEAMKB_BASE_PATH'] !== request.basePath ||
    process.env['INDEX_PATH'] !== join(index, 'cache', 'qmd', 'index.sqlite') ||
    process.env['QMD_CONFIG_DIR'] !== join(index, 'config', 'qmd') ||
    process.env['XDG_CONFIG_HOME'] !== join(index, 'config') ||
    process.env['XDG_CACHE_HOME'] !== join(index, 'cache')
  )
    throw new Error('Private copied retrieval environment required');

  const { RealQmdExecutor } = await import('../executor/real-executor.js');
  const { liveGroupCount } = await import('../executor/process-groups.js');
  const tenant = { id: request.tenantId, basePath: request.basePath };
  const probe = await new RealQmdExecutor({
    binary: request.qmdBinary,
    tenant,
    timeout: 5_000,
  }).execute(['--version']);
  if (probe.exitCode !== 0) throw new Error('Copied retrieval binary unavailable');
  const [
    { QmdAdapter },
    { reindex },
    { runEval },
    { qmdRetrievalFn },
    { stratify },
    { GOVERNED_BRAIN_V1_DATASET },
  ] = await Promise.all([
    import('../adapter.js'),
    import('../reindex/reindex.js'),
    import('../eval/run-eval.js'),
    import('../eval/qmd-retrieval.js'),
    import('../eval/stratified-report.js'),
    import('../eval/datasets/governed-brain-v1.js'),
  ]);
  const executor = new RealQmdExecutor({ binary: request.qmdBinary, tenant });
  const adapter = new QmdAdapter(
    {
      tenantId: request.tenantId,
      basePath: request.basePath,
      exportDir: request.exportDir,
      qmdBinary: request.qmdBinary,
    },
    executor,
  );
  // Fresh registry + derived qmd/native databases; no source registry/index is copied.
  const indexed = await reindex(adapter);
  if (!indexed.ok) throw new Error('Copied retrieval reindex failed');
  const report = await runEval(
    GOVERNED_BRAIN_V1_DATASET,
    qmdRetrievalFn(adapter, request.tenantId, 'curated'),
    { k: 10, backend: 'copied-corpus-qmd-native' },
  );
  const stratified = stratify(report, GOVERNED_BRAIN_V1_DATASET.queries);
  if (liveGroupCount() !== 0) throw new Error('Copied retrieval commands remain active');
  // Exiting the worker closes process-cached native handles before parent cleanup.
  process.stdout.write(JSON.stringify({ report, stratified, groupsClosed: true }), () =>
    process.exit(0),
  );
}
void main().catch(() => {
  // Never print source markdown, provider output or raw exception diagnostics.
  process.stderr.write('Copied retrieval worker refused\n', () => process.exit(1));
});
