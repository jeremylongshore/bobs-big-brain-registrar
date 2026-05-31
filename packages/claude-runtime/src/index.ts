// Types
export type {
  RawCaptureEvent,
  GitContext,
  SecretPattern,
  SecretMatch,
  RepoContextProvider,
} from './types.js';

// Config
export {
  SPOOL_DIR,
  FAILED_DIR,
  REDACTION_AUDIT_DIR,
  getSpoolPath,
  getFailedPath,
  getRedactionAuditPath,
  getSpoolFilename,
} from './config.js';

// Secret detection
export { SECRET_PATTERNS, PII_PATTERNS } from './secrets/patterns.js';
export { scanForSecrets, hasSecrets } from './secrets/secret-scanner.js';
export { redactSecrets } from './secrets/redactor.js';
export { classifyContent } from './secrets/content-classifier.js';
export type { SensitivityLevel, ContentClassification } from './secrets/content-classifier.js';

// Capture
export { buildCandidate } from './capture/candidate-builder.js';
export type { CandidateBuildResult } from './capture/candidate-builder.js';
export { DefaultContextProvider } from './capture/context-provider.js';

// Spool
export { writeToSpool } from './spool/spool-writer.js';
export {
  readSpoolFile,
  listSpoolFiles,
  verifySpoolManifest,
  type SpoolManifestStatus,
  type SpoolManifestResult,
} from './spool/spool-reader.js';
export { writeToFailureBucket } from './spool/failure-bucket.js';
export type { FailureRecord } from './spool/failure-bucket.js';
export { writeRedactionAudit } from './spool/redaction-audit.js';
export type { RedactionAuditRecord } from './spool/redaction-audit.js';

// Templates
export { generateHookScript } from './templates/hook-templates.js';
export { generateClaudeMdBlock } from './templates/claudemd-templates.js';
