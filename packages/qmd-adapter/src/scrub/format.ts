import type { RemovalCounts } from './index-files.js';
import type { IndexFileReport, IndexScrubReport } from './index-scrub.js';

/**
 * Text and JSON renderings of an {@link IndexScrubReport}, shared by
 * `qmd-index scrub-index` and `curator-cli redact`. Both carry paths, statuses
 * and counts only; the report type holds no fragment text to leak.
 */

function countsJson(counts: RemovalCounts): Record<string, number> {
  return {
    targeted_documents: counts.targetedDocuments,
    stale_documents: counts.staleDocuments,
    inactive_documents: counts.inactiveDocuments,
    fts_rows: counts.ftsRows,
    orphan_content: counts.orphanContent,
    orphan_vectors: counts.orphanVectors,
    cache_rows: counts.cacheRows,
    file_rows: counts.fileRows,
  };
}

function fileJson(file: IndexFileReport): Record<string, unknown> {
  return {
    kind: file.kind,
    file: file.file,
    status: file.status,
    removed: countsJson(file.removed),
    fts_rebuilt: file.ftsRebuilt,
    wal_truncated: file.walTruncated,
    vacuumed: file.vacuumed,
    errors: file.errors,
  };
}

/** snake_case JSON body, matching the redact envelope's style. */
export function indexScrubJson(report: IndexScrubReport): Record<string, unknown> {
  const scan = report.fragmentScan;
  return {
    complete: report.complete,
    dry_run: report.dryRun,
    schema_refused: report.schemaRefused,
    index_dir: report.indexDir,
    export_dir: report.exportDir,
    index_dir_exists: report.indexDirExists,
    export_present: report.exportPresent,
    warnings: report.warnings,
    tenants: report.tenants.map((t) => ({ tenant: t.tenant, files: t.files.map(fileJson) })),
    fragment_scan:
      scan === null
        ? null
        : {
            files_scanned: scan.filesScanned,
            fragments_checked: scan.fragmentsChecked,
            residual_fragments: scan.residualFragments,
            unexplained_residual_fragments: scan.unexplainedResidualFragments,
            residual_files: scan.residualFiles,
            explained_by: scan.explainedBy,
          },
  };
}

function countsText(counts: RemovalCounts): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name}=${n}`);
  return parts.length === 0 ? 'nothing to remove' : parts.join(' ');
}

/** Human summary, one line per index file. */
export function formatIndexScrub(report: IndexScrubReport): string {
  const verdict = report.complete ? 'complete' : 'INCOMPLETE';
  const lines = [
    `Index scrub${report.dryRun ? ' (dry-run — nothing written)' : ''}: ${verdict}`,
    `  index dir: ${report.indexDir}${report.indexDirExists ? '' : ' (absent — nothing to scrub)'}`,
  ];
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  for (const tenant of report.tenants) {
    lines.push(`  tenant ${tenant.tenant}:`);
    for (const file of tenant.files) {
      lines.push(`    ${file.file} [${file.status}] ${countsText(file.removed)}`);
      for (const error of file.errors) lines.push(`      ${error}`);
    }
  }
  const scan = report.fragmentScan;
  if (scan !== null) {
    lines.push(
      `  byte scan: ${scan.fragmentsChecked} fragment(s) checked in ${scan.filesScanned} file(s); ` +
        `${scan.residualFragments} still present, ${scan.unexplainedResidualFragments} unexplained`,
    );
    for (const hit of scan.residualFiles) {
      lines.push(`    ${hit.file}: ${hit.fragments} fragment(s)`);
    }
    for (const docId of scan.explainedBy) lines.push(`    still exported by ${docId}`);
  }
  if (report.schemaRefused) {
    lines.push(
      '  A file has an unexpected table layout (qmd version drift?) and was NOT touched.',
      '  Check the pinned qmd version before scrubbing it.',
    );
  }
  if (report.tenants.some((t) => t.files.some((f) => f.status === 'busy'))) {
    lines.push(
      '  A database was busy. Stop the brain API and any MCP-using sessions (or wait for a',
      '  quiet window) and run the scrub again.',
    );
  }
  return lines.join('\n') + '\n';
}
