import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { offlinePlugin } from './scripts/offline-plugin.ts'
import { ocrAssets } from './scripts/ocr-assets.ts'
import { softwareLicenses } from './scripts/software-licenses.ts'
import { previewPlugin } from './scripts/preview-plugin.ts'

const PERSISTENCE_TEST_TIMEOUT_MS = 30_000
const CI_TEST_WORKERS = 2
// Bound isolated local files within one shared pool
const LOCAL_TEST_WORKERS = '25%'
// Local verification runs independent serial shards so failure never aborts a sibling database case
// Standalone and hosted commands retain one native worker per invocation
const WORKER_TEST_WORKERS = 1
const SERVICE_PERSISTENCE_TEST_FILES = [
  'src/persistence/conflicts.test.ts',
  'src/persistence/copied-conflict-journey.test.ts',
  'src/persistence/lineage-conflicts.test.ts',
  'src/persistence/mapping-bulk-conflicts.test.ts',
  'src/persistence/mapping-conflicts.test.ts',
  'src/persistence/publication-empty-page.test.ts',
  'src/persistence/sync-integration.test.ts',
]
const CI_PERSISTENCE_TEST_WORKERS = 1
const persistenceTestWorkers = process.env.CI ? CI_PERSISTENCE_TEST_WORKERS : undefined
const DOM_TEST_FILES = [
  'src/ui/admin/admin.test.tsx',
  'src/ui/admin/admin-workflows.test.tsx',
  'src/ui/PublicSharedView.viewer.test.tsx',
  'src/ui/mods/FolderImportPreview.test.tsx',
  'src/ui/mods/PrivateArtwork.test.tsx',
  'src/ui/account/sync-status.test.tsx', 'src/ui/account/storage-panel.test.tsx', 'src/ui/account/LocalCopyPreview.test.tsx', 'src/ui/account/account.test.tsx', 'src/ui/account/DeletionPanel.test.tsx', 'src/ui/account/ConflictPanel.test.tsx', 'src/ui/account/ConflictFileVersion.test.tsx', 'src/ui/workspace-provider.test.tsx',
  'src/interchange/xlsx.test.ts',
  'src/ui/KnowledgeValue.test.tsx',
  'src/ui/ClassLearnTree.test.tsx',
  'src/ui/components.test.tsx',
  'src/ui/definitions-provider.test.tsx',
  'src/ui/navigation-controller.test.tsx',
  'src/ui/TravelUnlocksView.test.tsx',
  'src/ui/SummonsView.test.tsx',
  'src/ui/route-state.test.ts',
  'src/ui/useQueuedTileUpdates.test.tsx',
  'src/ui/BuildDetailsControl.test.tsx',
  'src/ui/CombatPreview.test.tsx',
  'src/ui/mod-inspector/inspector.test.tsx',
  'src/ui/mod-inspector/editor-persistence.test.tsx',
]

export default defineConfig({
  base: './',
  plugins: [
    react(),
    ocrAssets(),
    softwareLicenses(),
    previewPlugin(),
    offlinePlugin(),
    {
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: html => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]+>/, ''),
    },
  ],
  build: { target: ['es2022'], sourcemap: false },
  server: {
    host: '127.0.0.1',
    fs: { deny: ['**/.account-tests/**', '.dev.vars', '.dev.vars.*', '.env', '.env.*', '**/.git/**', '**/*.{pem,key,crt}', '**/*.xlsx', '**/crystal_project_*', '**/private/**'] },
  },
  test: {
    environment: 'node',
    restoreMocks: true,
    maxWorkers: process.env.CI ? CI_TEST_WORKERS : LOCAL_TEST_WORKERS,
    // Bundle-only imports have no Vitest module graph edge, so source changes must trigger reruns
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/worker/**', '**/src/account/**', '**/wrangler.local.jsonc', '**/wrangler.alerts.example.jsonc', '**/scripts/build-account-tests.mjs', '**/scripts/opaque-worker-module.mjs', '**/node_modules/@serenity-kit/opaque/**'],
    projects: [
      { test: { name: 'worker', include: ['worker/**/*.test.ts'], globalSetup: ['worker/testing/watch-setup.ts'], testTimeout: 30_000, maxWorkers: WORKER_TEST_WORKERS } },
      { test: { name: 'unit', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], exclude: ['src/persistence/**', ...DOM_TEST_FILES] } },
      { test: { name: 'dom', environment: 'jsdom', include: DOM_TEST_FILES } },
      { test: { name: 'persistence', include: ['src/persistence/**/*.test.ts', 'e2e/accounts/cleanup-persistence.proof.mjs'], exclude: SERVICE_PERSISTENCE_TEST_FILES, testTimeout: PERSISTENCE_TEST_TIMEOUT_MS, maxWorkers: persistenceTestWorkers } },
      { test: { name: 'persistence-service', include: SERVICE_PERSISTENCE_TEST_FILES, testTimeout: PERSISTENCE_TEST_TIMEOUT_MS, maxWorkers: WORKER_TEST_WORKERS } },
    ],
  },
})
