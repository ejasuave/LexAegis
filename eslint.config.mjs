import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** Builds a no-restricted-imports rule from a list of { group, message } patterns. */
const restrict = (patterns, paths = []) => ({
  'no-restricted-imports': ['error', { patterns, paths }],
});

const NODE_ONLY = {
  group: ['node:*'],
  message: 'This module must run in the browser; do not import Node built-ins.',
};
const FRAMEWORK = (extra = []) => [
  {
    group: ['next', 'next/*', 'react', 'react-dom', 'react-dom/*', ...extra],
    message: 'Framework-neutral package: no Next.js or React imports.',
  },
];
const SERVER_ONLY = {
  group: ['server-only'],
  message: 'server-only marks server modules; this package must not use it.',
};
// Exact-name restriction so the browser-safe subpath @lexaegis/agent/contracts stays importable.
const AGENT_RUNTIME = {
  name: '@lexaegis/agent',
  message:
    'The agent runtime is server-only. Browser code may import @lexaegis/agent/contracts only.',
};
// The run-store port is for server code and its tests.
const AGENT_STORE = {
  name: '@lexaegis/agent/run-store',
  message:
    'The run-store port is server-side. Browser code may import @lexaegis/agent/contracts only.',
};
// The scripted provider and in-memory run store exist for tests only.
const AGENT_TESTING = {
  name: '@lexaegis/agent/testing',
  message: 'Agent test adapters are for tests only.',
};
const AGENT_TESTING_CONTRACT = {
  name: '@lexaegis/agent/testing/run-store-contract',
  message: 'Agent test suites are for tests only.',
};

const APPS_PRIVATE_SOURCE = {
  group: [
    '@lexaegis/*/src',
    '@lexaegis/*/src/*',
    '**/packages/*/src/**',
    '../../packages/**',
    '../../../packages/**',
  ],
  message: 'Import workspace packages through their declared exports.',
};
const WEB_BROWSER_PATTERNS = [
  {
    group: ['@lexaegis/*/src', '@lexaegis/*/src/*', '**/packages/*/src/**'],
    message: 'Import workspace packages through their declared exports.',
  },
  {
    group: ['@/server/*', '@/server/**', '**/server/*', 'server-only'],
    message: 'Browser code must not import server modules.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '.private/**',
      '.tools/**',
      'contracts/out/**',
      'contracts/cache/**',
      'contracts/broadcast/**',
      'indexer/.envio/**',
      'indexer/envio-env.d.ts',
      '**/node_modules/**',
      '**/.next/**',
      '**/.next-check/**',
      '**/.next-vault-check/**',
      '**/.next-review-check/**',
      '**/.next-assistant-check/**',
      '**/dist/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'build_instructions/**',
      'project_brief/**',
      'UI_UX_Instructions/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'apps/web/postcss.config.mjs',
            'apps/verifier/postcss.config.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': true,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      'no-warning-comments': 'off',
    },
    linterOptions: { reportUnusedDisableDirectives: 'error', noInlineConfig: false },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node scripts: the fixture generators must stay independent of the implementations they test.
    files: ['fixtures/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly' } },
    rules: restrict([
      {
        group: ['@lexaegis/*', '**/packages/**', '**/contracts/**', 'viem', 'viem/*'],
        message: 'The fixture generator must not import the implementation it is used to test.',
      },
    ]),
  },
  {
    // contracts: build scripts and the local Anvil harness. Test signers live here only, so no
    // application or package may depend on it, and it never reaches application code.
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/^@lexaegis\\u002F(contracts|tooling)|(contracts\\u002F(scripts|integration)|tooling)\\u002F/]',
          message:
            'Contract and repository tooling (build scripts, harnesses, gates) must not be imported by packages or applications.',
        },
      ],
    },
  },
  {
    files: ['contracts/**/*.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      {
        group: ['@lexaegis/web', '@lexaegis/verifier', '@lexaegis/agent', '@lexaegis/agent/*'],
        message: 'contracts tooling must not import applications or the agent.',
      },
    ]),
  },
  {
    // indexer: read-only projection. It consumes the registry ABI and nothing else from the app.
    files: ['indexer/**/*.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      {
        group: [
          '@lexaegis/web',
          '@lexaegis/verifier',
          '@lexaegis/agent',
          '@lexaegis/agent/*',
          '@lexaegis/vault',
          '@lexaegis/vault/*',
          '@scure/*',
          '**/apps/**',
        ],
        message: 'The indexer is read-only and must not import applications, the agent or the vault.',
      },
    ]),
  },
  // Package boundaries --------------------------------------------------------------------
  {
    // protocol: no application, server integration or wallet implementation imports.
    files: ['packages/protocol/src/**/*.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      NODE_ONLY,
      SERVER_ONLY,
      {
        group: [
          '@lexaegis/sdk',
          '@lexaegis/vault',
          '@lexaegis/agent',
          '@lexaegis/agent/*',
          '@lexaegis/web',
          '@lexaegis/verifier',
          'viem',
          'viem/*',
          '@category-labs/*',
          '@scure/*',
          '**/features/account/**',
        ],
        message:
          'protocol must not import applications, other workspace packages or wallet/chain libraries.',
      },
    ]),
  },
  {
    // sdk: no Next.js runtime, agent implementation or hosted-service singleton.
    files: ['packages/sdk/src/**/*.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      NODE_ONLY,
      SERVER_ONLY,
      {
        group: [
          '@lexaegis/agent',
          '@lexaegis/agent/*',
          '@lexaegis/vault',
          '@lexaegis/web',
          '@lexaegis/verifier',
          '@category-labs/*',
          '@scure/*',
          '**/features/account/**',
        ],
        message: 'sdk must not import the agent, vault, applications or account providers.',
      },
    ]),
  },
  {
    // vault: browser-only; no server credential access.
    files: ['packages/vault/src/**/*.ts'],
    rules: {
      ...restrict([
        ...FRAMEWORK(),
        NODE_ONLY,
        SERVER_ONLY,
        {
          group: [
            '@lexaegis/agent',
            '@lexaegis/agent/*',
            '@lexaegis/sdk',
            '@lexaegis/web',
            '@lexaegis/verifier',
          ],
          message: 'vault must not import the agent, SDK or applications.',
        },
      ]),
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'vault must not read server environment variables.',
        },
      ],
    },
  },
  {
    // agent: server runtime may use server-only, but must not import applications or browser code.
    files: ['packages/agent/src/**/*.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      {
        group: [
          '@lexaegis/web',
          '@lexaegis/verifier',
          '@lexaegis/vault',
          '@category-labs/*',
          '@scure/*',
          '**/features/account/**',
        ],
        message: 'agent must not import applications, the vault or account providers.',
      },
    ]),
  },
  {
    // The browser-safe contracts export must stay free of server modules and credentials.
    files: ['packages/agent/src/contracts/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      NODE_ONLY,
      SERVER_ONLY,
      {
        group: ['../*', '!./*', '@lexaegis/web', '@lexaegis/verifier', '@lexaegis/vault'],
        message: 'contracts may only depend on protocol primitives and zod.',
      },
    ]),
  },
  {
    // The browser-safe review export stays pure: no server runtime, provider adapter or test double.
    files: ['packages/agent/src/review/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      NODE_ONLY,
      SERVER_ONLY,
      {
        group: [
          '../runtime/*',
          '../server/*',
          '../testing/*',
          '../ports',
          '@lexaegis/web',
          '@lexaegis/verifier',
          '@lexaegis/vault',
          '@category-labs/*',
          '@scure/*',
        ],
        message: 'review functions must not import the server runtime, provider or test doubles.',
      },
    ]),
  },
  {
    // The production runtime never loads a scripted provider or in-memory store.
    files: ['packages/agent/src/runtime/**/*.ts', 'packages/agent/src/server/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: restrict([
      ...FRAMEWORK(),
      {
        group: ['../testing/*', '../testing', '@lexaegis/agent/testing'],
        message: 'Test adapters are isolated from the production runtime.',
      },
      {
        group: [
          '@lexaegis/web',
          '@lexaegis/verifier',
          '@lexaegis/vault',
          '@category-labs/*',
          '@scure/*',
          '**/features/account/**',
        ],
        message: 'agent must not import applications, the vault or account providers.',
      },
    ]),
  },
  {
    // Applications consume declared package exports, never private source paths.
    files: ['apps/**/*.{ts,tsx}'],
    rules: restrict([APPS_PRIVATE_SOURCE]),
  },
  {
    // Browser-reachable web code must not import server modules or the agent runtime.
    files: [
      'apps/web/src/components/**/*.{ts,tsx}',
      'apps/web/src/features/**/*.{ts,tsx}',
      'apps/web/src/lib/**/*.{ts,tsx}',
      'apps/web/src/config/**/*.ts',
    ],
    rules: restrict(WEB_BROWSER_PATTERNS, [AGENT_RUNTIME, AGENT_STORE]),
  },
  {
    // UI code reaches the account only through its public surface: status and a few commands.
    // The signer, session, PRF access and derivation never cross into components or pages.
    files: ['apps/web/src/components/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts'],
    rules: restrict(
      [
        ...WEB_BROWSER_PATTERNS,
        {
          group: [
            '@/features/account/*',
            '!@/features/account/public',
            '@category-labs/*',
            '@scure/*',
          ],
          message:
            'Import the account through @/features/account/public only; key-bearing modules are private to it.',
        },
      ],
      [AGENT_RUNTIME, AGENT_STORE, AGENT_TESTING, AGENT_TESTING_CONTRACT],
    ),
  },
  {
    // Pages and layouts are server components: they may read server modules, but still reach
    // the account only through its public surface.
    files: ['apps/web/src/app/**/*.tsx'],
    rules: restrict([
      APPS_PRIVATE_SOURCE,
      {
        group: [
          '@/features/account/*',
          '!@/features/account/public',
          '@category-labs/*',
          '@scure/*',
        ],
        message: 'Import the account through @/features/account/public only.',
      },
    ]),
  },
  {
    // Server code never loads account or key modules: derivation and signing are browser-only.
    files: ['apps/web/src/server/**/*.ts', 'apps/web/src/app/api/**/*.ts', 'apps/web/src/proxy.ts'],
    ignores: ['**/*.test.ts', '**/*.pgtest.ts'],
    rules: restrict(
      [
        APPS_PRIVATE_SOURCE,
        {
          group: [
            '@/features/account/*',
            '**/features/account/**',
            '@category-labs/*',
            '@scure/*',
            '@/test-support/*',
          ],
          message: 'Account, key and test-support modules must not be imported by server code.',
        },
      ],
      [AGENT_TESTING, AGENT_TESTING_CONTRACT],
    ),
  },
  {
    // Production web code never imports test support.
    files: [
      'apps/web/src/features/**/*.ts',
      'apps/web/src/lib/**/*.ts',
      'apps/web/src/config/**/*.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: restrict(
      [
        ...WEB_BROWSER_PATTERNS,
        {
          group: ['@/test-support/*', '**/test-support/**'],
          message: 'Test support is for tests only.',
        },
      ],
      [AGENT_RUNTIME, AGENT_STORE, AGENT_TESTING, AGENT_TESTING_CONTRACT],
    ),
  },
  {
    // The independent verifier needs no LexAegis backend, agent, vault or account layer.
    files: ['apps/verifier/src/**/*.{ts,tsx}'],
    rules: restrict(
      [
        {
          group: ['@lexaegis/*/src', '@lexaegis/*/src/*'],
          message: 'Import workspace packages through their declared exports.',
        },
        {
          group: [
            '@lexaegis/agent/*',
            '@lexaegis/vault',
            '@lexaegis/web',
            '@category-labs/*',
            '@scure/*',
            '**/features/account/**',
            '**/apps/web/**',
            'next',
            'next/*',
          ],
          message: 'The verifier must stay independent of LexAegis application code.',
        },
      ],
      [{ name: '@lexaegis/agent', message: 'The verifier must not import the agent.' }],
    ),
  },
  {
    files: ['**/*.{tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
);
