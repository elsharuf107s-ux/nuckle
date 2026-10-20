export default [
  {
    files: ['src/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', Event: 'readonly', HTMLCanvasElement: 'readonly', performance: 'readonly', console: 'readonly',
        requestAnimationFrame: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setTimeout: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
];
