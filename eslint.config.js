import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-a', 'dist-b', 'node_modules', 'test-results', 'playwright-report', 'dev-dist', 'relay/.wrangler', 'mockups'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'Use the seeded RNG (src/engine/rng.ts).' },
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'Never use innerHTML; build nodes with textContent.' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // The relay runs on Cloudflare Workers; the reference build scripts run in Node.
  {
    files: ['relay/**/*.js'],
    languageOptions: { globals: { Response: 'readonly', Request: 'readonly', Headers: 'readonly', fetch: 'readonly', caches: 'readonly' } },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { fetch: 'readonly', Buffer: 'readonly', performance: 'readonly' } },
  },
);
