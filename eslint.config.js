import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['.claude/**', 'dist/**', 'scripts/**', 'tests/fixtures/**', 'playwright-report/**']
  },
  {
    // F-04: the layer boundary. `core/` and `ui/` reach the platform only through the
    // adapter, so the same code builds as an extension and as the website twin.
    files: ['src/core/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}'],
    rules: {
      // Two boundaries in one rule: the platform layer, and blocking dialogs — which
      // freeze the main thread, cannot be themed, and are invisible to the app's own
      // accessibility tree.
      'no-restricted-globals': [
        'error',
        {
          name: 'chrome',
          message:
            'chrome.* is not available in the website build. Go through src/platform (PLAN §2.2).'
        },
        {
          name: 'alert',
          message: 'Use notify() from src/core/notify.ts so the message is themed and announced.'
        },
        {
          name: 'confirm',
          message: 'Use confirmAction() from src/core/notify.ts.'
        },
        {
          name: 'prompt',
          message: 'Use a Modal with a real form field.'
        }
      ]
    }
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests legitimately assert on loosely-typed page evaluation results.
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
);
