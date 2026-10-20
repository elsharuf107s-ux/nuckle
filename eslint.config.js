export default [
  {
    files: ['src/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', Event: 'readonly', HTMLCanvasElement: 'readonly', performance: 'readonly', console: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', navigator: 'readonly', location: 'readonly', screen: 'readonly', getComputedStyle: 'readonly', URLSearchParams: 'readonly', PointerEvent: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
];
