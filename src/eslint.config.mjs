/* Relik — ESLint. Задача не «причесать всё», а ловить реальные поломки:
   необъявленные переменные, повторные объявления, забытые await-ошибки.
   Стиль не навязываем — иначе диффы на 70 файлов. */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**', 'node_modules/**', 'js/vendor/**', 'shots/**', 'mobile/**',
      'scripts/mail-service/**', 'scripts/push-service/**', 'scripts/ui-shots/**',
      'tools/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-fallthrough': 'warn',
      'no-self-assign': 'warn',
      'no-async-promise-executor': 'warn',
      'no-unsafe-finally': 'error',
      'no-compare-neg-zero': 'error',
      'require-atomic-updates': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
