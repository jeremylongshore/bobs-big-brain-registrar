// Types
export type { QmdError, CommandResult, QmdHealthStatus, QmdSearchResult } from './types.js';

// Config
export type { QmdAdapterConfig } from './config.js';
export {
  QMD_INDEX_DIR,
  getQmdIndexBasePath,
  getQmdTenantIndexPath,
  getQmdCollectionIndexPath,
  getQmdTenantEnv,
  DEFAULT_QMD_BINARY,
  DEFAULT_TIMEOUT,
} from './config.js';

// Executor
export type { QmdExecutor } from './executor/executor.js';
export { RealQmdExecutor } from './executor/real-executor.js';
export { MockQmdExecutor } from './executor/mock-executor.js';

// Collections
export type { CollectionDef } from './collections/collection-registry.js';
export {
  KNOWN_COLLECTIONS,
  getDefaultSearchCollections,
  getAllCollectionNames,
  getExportableCollections,
  isKnownCollection,
  isDefaultSearchCollection,
} from './collections/collection-registry.js';
export { CollectionManager } from './collections/collection-manager.js';

// Index management
export { getTenantDataDir, getCollectionDataDir } from './index-manager/index-paths.js';
export { IndexLifecycleManager } from './index-manager/index-lifecycle.js';

// Search
export { SearchClient } from './search/search-client.js';
export { parseQueryOutput, deriveCollectionFromPath } from './search/result-parser.js';

// Health
export { checkHealth } from './health/health-check.js';

// Facade
export { QmdAdapter } from './adapter.js';
