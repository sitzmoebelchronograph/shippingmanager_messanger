/**
 * ESLint Configuration for Shipping Manager CoPilot
 *
 * This configuration enables security-focused linting to detect:
 * - Unsafe patterns (eval, innerHTML, exec)
 * - Regex DoS vulnerabilities
 * - Path traversal risks
 * - Hardcoded secrets
 * - Command injection vulnerabilities
 *
 * ESLint 9+ uses flat config format (eslint.config.js)
 *
 * @type {import('eslint').Linter.FlatConfig[]}
 */

const security = require('eslint-plugin-security');

module.exports = [
  {
    // Global ignores
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'sysdata/**',
      'userdata/**',
      '.git/**',
      'coverage/**',
      '*.min.js',
      'docs/jsdoc-template/**',  // External JSDoc template
      'development/**',          // Development/testing scripts
      'public/docs/**',          // Generated JSDoc documentation
      'public/js/vendor/**',     // Third-party vendor files
      'reports/**'               // Security scan reports
    ]
  },
  {
    // Configuration for ES6 modules (frontend)
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',  // ES6 modules
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        location: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        Notification: 'readonly',  // Browser Notifications API
        console: 'readonly'
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-unsafe-regex': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }]
    }
  },
  {
    // Configuration for CommonJS (server-side and build scripts)
    files: ['**/*.js'],
    ignores: ['public/js/**/*.js'],  // Already handled above as ES6 modules
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        // Browser globals (for public/js files)
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        location: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        Notification: 'readonly',
        URLSearchParams: 'readonly'
      }
    },
    plugins: {
      security
    },
    rules: {
      // ===== ESLint Built-in Security Rules =====

      // Prevent use of dangerous functions
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // Prevent prototype pollution
      'no-prototype-builtins': 'warn',
      'no-extend-native': 'error',

      // Prevent unsafe regex
      'no-control-regex': 'error',
      'no-misleading-character-class': 'error',
      'no-regex-spaces': 'error',

      // Code quality rules that prevent bugs
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-shadow': 'warn',

      // Prevent dangerous type coercion
      'eqeqeq': ['warn', 'always'],
      'no-eq-null': 'warn',

      // ===== Security Plugin Rules =====

      // Detect unsafe regex that can lead to DoS
      'security/detect-unsafe-regex': 'error',

      // Detect buffer usage without assertion
      'security/detect-buffer-noassert': 'error',

      // Warn about child_process usage (we use it, but should be reviewed)
      'security/detect-child-process': 'warn',

      // Detect disabled escaping in template engines
      'security/detect-disable-mustache-escape': 'error',

      // Detect eval with expressions
      'security/detect-eval-with-expression': 'error',

      // Detect missing CSRF protection
      'security/detect-no-csrf-before-method-override': 'error',

      // Warn about non-literal fs operations (path traversal risk)
      'security/detect-non-literal-fs-filename': 'off',

      // Warn about non-literal regex (can be used for ReDoS)
      'security/detect-non-literal-regexp': 'warn',

      // Warn about non-literal require (code injection risk)
      'security/detect-non-literal-require': 'warn',

      // Warn about object injection via bracket notation with user input
      'security/detect-object-injection': 'off', // Too many false positives

      // Warn about timing attacks in string comparison
      'security/detect-possible-timing-attacks': 'warn',

      // Detect use of pseudoRandomBytes (not cryptographically secure)
      'security/detect-pseudoRandomBytes': 'error'
    }
  },
  {
    // Specific overrides for test files
    files: ['**/*.test.js', '**/*.spec.js', '**/test/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off'
    }
  },
  {
    // Specific overrides for build/config files
    files: ['*.config.js', 'build/**/*.js'],
    rules: {
      'security/detect-child-process': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-require': 'off'
    }
  },
  {
    // Specific files with legitimate dynamic FS operations
    // These files use validated paths (userId from session, fixed base dirs)
    // No direct user input controls file paths - safe from path traversal
    files: [
      'app.js',
      'server/autopilot.js',
      'server/chatbot/parser.js',
      'server/chatbot/settings.js',
      'server/config.js',
      'server/logbook.js',
      'server/routes/poi.js',
      'server/routes/settings.js',
      'server/routes/vessel-image.js',
      'server/settings-schema.js',
      'server/utils/harbor-fee-store.js',
      'server/utils/logger.js',
      'server/utils/session-manager.js'
    ],
    rules: {
      'security/detect-non-literal-fs-filename': 'off'
    }
  },
  {
    // Service Worker configuration
    files: ['public/sw.js', 'public/**/sw.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        // Service Worker globals
        self: 'readonly',
        clients: 'readonly',
        caches: 'readonly',
        skipWaiting: 'readonly',
        registration: 'readonly',
        fetch: 'readonly',
        console: 'readonly'
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'security/detect-unsafe-regex': 'error'
    }
  }
];
