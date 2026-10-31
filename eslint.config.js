import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['build/**', 'node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error', {
        selector: 'TSUnknownKeyword',
        message: 'Declare the actual shape instead of unknown.',
      }],
    },
  },
);
