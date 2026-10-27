/** Pinned records explain rule declarations; hashes do not authenticate decisions. */
export interface StalenessSource {
  readonly repository: string;
  readonly path: string;
  readonly revision: string;
  readonly sha256: string;
  readonly visibility: 'public' | 'private';
  readonly locator: string;
}

export interface StalenessAuthority {
  readonly basis: 'historical-decision' | 'documented-topology';
  readonly scope: 'intent-solutions-estate';
  readonly effectiveDate: string;
  readonly authentication: 'unsigned-record';
  readonly currentness: 'not-revalidated';
  readonly sources: readonly StalenessSource[];
  readonly limitations: string;
}

export interface StalenessRule {
  /** Stable historical identifier; it need not equal every event date. */
  readonly id: string;
  readonly because: string;
  /** Literal, case-insensitive tokens on word-ish boundaries. */
  readonly tokens: readonly string[];
  readonly exemptIfHistorical: boolean;
  readonly remedy: 'metadata-review' | 'retirement-review';
  /** null explicitly records that no decision evidence has been supplied. */
  readonly authority: StalenessAuthority | null;
}

const TOPOLOGY: StalenessSource = {
  repository: 'intent-solutions-io/bobs-big-brain-umbrella',
  path: '000-docs/007-AT-SMAP-repo-topology-and-working-surface.md',
  revision: 'f3ad9856d3f150360e6f437a2c724f7ee5b70d37',
  sha256: 'e43d07fd17475060155d77a67f13a1c23b2009542cb2832f6de9dd04eb470f7f',
  visibility: 'public',
  locator: 'section 2',
};

// Source locators and byte hashes only: private decision contents stay private.
const PRIVATE_REVISION = '138932ce0fbf3aa9045e1504c449c4571d691101';
const GCP_DECISION: StalenessSource = {
  repository: 'intent-solutions-io/intent-os',
  path: '000-docs/030-AT-DECR-intendants-naming-and-slice0-supersession-2026-07-10.md',
  revision: PRIVATE_REVISION,
  sha256: '750ad4807a83a3bcbed6781b545ef98f32c59e737386470ab18a3c20470aeb17',
  visibility: 'private',
  locator: 'context, record dated 2026-07-10',
};
const NTFY_DECISION: StalenessSource = {
  repository: 'intent-solutions-io/intent-os',
  path: 'decision-log/003-2026-06-13-foundation-and-notifications.md',
  revision: PRIVATE_REVISION,
  sha256: '5af0773673fe06101891cf71171bdc9f53a109f2cbce2168aca1f17694a8358d',
  visibility: 'private',
  locator: 'D23, record dated 2026-06-13',
};

function authority(
  basis: StalenessAuthority['basis'],
  effectiveDate: string,
  sources: readonly StalenessSource[],
  limitations: string,
): StalenessAuthority {
  return {
    basis,
    scope: 'intent-solutions-estate',
    effectiveDate,
    authentication: 'unsigned-record',
    currentness: 'not-revalidated',
    sources,
    limitations,
  };
}

const TOPOLOGY_LIMITS =
  'Public topology declaration, not a signed teardown receipt or a current URL probe. ' +
  'Repository identity drift does not prove the memory content obsolete.';
const PRIVATE_LIMITS =
  'Private historical decision; public readers cannot independently inspect its contents. ' +
  'Pinned bytes are not signed authorization, a current service inventory or global platform status.';

/** Historical estate declarations, not universal facts about the named platforms. */
export const ESTATE_STALENESS_RULES: readonly StalenessRule[] = [
  {
    id: 'gcp-torn-down-2026-07-09',
    because:
      'A dated estate decision records the Intent Solutions GCP estate torn down on 2026-07-09. ' +
      'Review prescriptions for that estate; external GCP guidance is outside this declaration.',
    tokens: [
      'gcloud',
      'bq',
      'bigquery',
      'vertex ai',
      'vertexai',
      'firebase',
      'firestore',
      'cloud run',
      'app engine',
      'secret manager',
      'gcp project',
    ],
    exemptIfHistorical: true,
    remedy: 'retirement-review',
    authority: authority('historical-decision', '2026-07-09', [GCP_DECISION], PRIVATE_LIMITS),
  },
  {
    id: 'repo-renamed-2026-07-19-compiler',
    because:
      'Public topology records the repository rename intentional-cognition-os to ' +
      'bobs-big-brain-compiler on 2026-07-19; npm name and @ico/* scope are separate identities. ' +
      'Review repository metadata or links; an old URL can redirect.',
    tokens: ['jeremylongshore/intentional-cognition-os'],
    exemptIfHistorical: false,
    remedy: 'metadata-review',
    authority: authority('documented-topology', '2026-07-19', [TOPOLOGY], TOPOLOGY_LIMITS),
  },
  {
    id: 'repo-renamed-2026-07-19-registrar',
    because:
      'Public topology records the repository rename qmd-team-intent-kb to ' +
      'bobs-big-brain-registrar on 2026-07-19; package scope and GHCR image are separate identities. ' +
      'Review repository metadata or links; an old URL can redirect.',
    tokens: ['jeremylongshore/qmd-team-intent-kb'],
    exemptIfHistorical: false,
    remedy: 'metadata-review',
    authority: authority('documented-topology', '2026-07-19', [TOPOLOGY], TOPOLOGY_LIMITS),
  },
  {
    // Preserve the existing id; July 14 refers to the local-directory event.
    id: 'repo-renamed-2026-07-14-plugin',
    because:
      'Public topology records governed-second-brain-plugin renamed to bobs-big-brain-plugin: ' +
      'remote repository on 2026-07-13, local directory on 2026-07-14. ' +
      'Review repository metadata or paths; this is not memory-retirement evidence.',
    tokens: ['governed-second-brain-plugin'],
    exemptIfHistorical: false,
    remedy: 'metadata-review',
    authority: authority('documented-topology', '2026-07-13', [TOPOLOGY], TOPOLOGY_LIMITS),
  },
  {
    id: 'marketplace-retired-2026-07-17',
    because:
      'Public topology records the private team-intent-claude-plugins marketplace ' +
      'retired and archived on 2026-07-17. Review instructions to use that marketplace; ' +
      'team mode in the public plugin is a separate concept.',
    tokens: ['team-intent-claude-plugins'],
    exemptIfHistorical: true,
    remedy: 'retirement-review',
    authority: authority(
      'documented-topology',
      '2026-07-17',
      [TOPOLOGY],
      'Public topology records the retirement date. No signed retirement receipt or fresh ' +
        'private-repository availability verification is supplied.',
    ),
  },
  {
    id: 'ntfy-removed-2026-06-13',
    because:
      'A dated estate decision records ntfy removed on 2026-06-13. Review instructions ' +
      'for that estate service; this does not prescribe a current notification replacement ' +
      'or invalidate external ntfy deployments.',
    tokens: ['ntfy'],
    exemptIfHistorical: true,
    remedy: 'retirement-review',
    authority: authority('historical-decision', '2026-06-13', [NTFY_DECISION], PRIVATE_LIMITS),
  },
];
