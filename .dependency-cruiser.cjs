// dependency-cruiser configuration — qmd-team-intent-kb
//
// Purpose: encode the monorepo architecture invariants from
// 000-docs/003-AT-DSGN-system-thesis.md as machine-verifiable import-graph rules.
//
// The repo has two top-level kinds of code:
//
//   packages/*  reusable libraries (schema, common, store, claude-runtime,
//               policy-engine, qmd-adapter, repo-resolver, test-fixtures)
//   apps/*      runnable services (api, curator, edge-daemon, git-exporter,
//               reporting, mcp-server)
//
// Invariants:
//
//   1. Packages must NEVER depend on apps. Libraries are downstream-agnostic.
//   2. Apps may depend on packages freely (that's the whole point of packages).
//   3. Apps may depend on other apps ONLY when both publish a package interface
//      (currently: apps/curator exposes @qmd-team-intent-kb/curator and is the
//      only app permitted as a dependency of other apps).
//   4. No circular dependencies anywhere.
//   5. Test fixtures (packages/test-fixtures) may only be imported by tests.
//   6. Source code may not import from a package's dist/ — always use the
//      workspace package name.
//
// Run locally: pnpm exec depcruise apps packages
// CI-enforced via .github/workflows/ci.yml

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-package-depends-on-app',
      severity: 'error',
      comment:
        'Invariant 1: packages/* must never depend on apps/*. Libraries are downstream-agnostic; ' +
        'allowing a package to reach into an app inverts the dependency direction and creates ' +
        'cycles. If you need shared logic, extract it into a new package.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },

    {
      name: 'no-cross-app-import-except-curator',
      severity: 'error',
      comment:
        'Invariant 3: apps must not import from other apps directly. The single permitted exception ' +
        'is apps/curator, which publishes @qmd-team-intent-kb/curator as a reusable interface ' +
        '(consumed by apps/api, apps/edge-daemon, apps/mcp-server). If you need to share code ' +
        'between other app pairs, extract into a package first.',
      from: { path: '^apps/([^/]+)/' },
      to: {
        path: '^apps/(?!curator)([^/]+)/',
        pathNot: '^apps/$1/',
      },
    },

    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Invariant 4: no circular dependencies. Circular imports defeat module-level reasoning, ' +
        'corrupt initialization order, and indicate missing abstraction.',
      from: {},
      to: { circular: true },
    },

    {
      name: 'no-orphan-source',
      severity: 'warn',
      comment:
        'Source files that nothing imports are usually dead code or forgotten WIP. ' +
        'Either delete or export from the package entry point.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', // dot-files (configs)
          '\\.d\\.ts$', // type definitions
          '(^|/)tsconfig\\.[^/]+\\.json$',
          '(^|/)package\\.json$',
          '(^|/)index\\.(ts|js)$', // package entry points
          '(^|/)types\\.ts$', // types-only modules (consumed via `import type`,
          //   which depcruise's default resolver does not track)
          '(^|/)__tests__/', // test files
          '(^|/)test-fixtures/', // fixture entry points
        ],
      },
      to: {},
    },

    {
      name: 'no-test-fixtures-in-production',
      severity: 'error',
      comment:
        'Invariant 5: @qmd-team-intent-kb/test-fixtures must only be imported by test files. ' +
        'Importing from test-fixtures in production code ships test scaffolding to runtime.',
      from: {
        pathNot: '(__tests__|\\.test\\.ts$|/test-fixtures/)',
      },
      to: { path: '^packages/test-fixtures/' },
    },

    {
      name: 'no-dist-imports',
      severity: 'error',
      comment:
        "Invariant 6: do not import from a package's dist/ output. Always use the workspace " +
        'package name (e.g. @qmd-team-intent-kb/schema), which resolves correctly under both ' +
        'tsc -b and pnpm.',
      from: {},
      to: { path: '(^|/)dist/' },
    },

    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'Imports must resolve. An unresolvable import is either a typo, a missing dep in package.json, ' +
        'or a missing workspace package.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },

    exclude: {
      path: [
        'node_modules',
        '\\.d\\.ts$',
        '(^|/)dist/',
        '(^|/)coverage/',
        '(^|/)\\.stryker-tmp/',
        '\\.test\\.ts$',
        '__tests__',
      ],
    },

    tsConfig: { fileName: 'tsconfig.json' },

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },

    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
