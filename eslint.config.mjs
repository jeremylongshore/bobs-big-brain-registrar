import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'plugin-runtime/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '.claude/worktrees/**',
    ],
  },

  // Base config for all JS/TS files
  ...tseslint.configs.recommended,

  // TypeScript-specific overrides
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Relaxed rules for config files
  {
    files: ['**/*.config.{js,mjs,cjs,ts,mts}', '**/vitest.*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
