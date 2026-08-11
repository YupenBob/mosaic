import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'worker/.wrangler/**',
      '**/vendor/**',
      'test-results/**',
      '.playwright-cli/**',
      '__pycache__/**',
      'video/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['src/assets/js/**', 'cloud-admin/js/**', 'cloud-admin/src/**', 'tests/**'],
    languageOptions: {
      globals: { ...globals.browser, self: 'off', __API_BASE__: 'readonly' },
    },
  },
];
