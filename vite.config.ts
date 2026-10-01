import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { offlinePlugin } from './scripts/offline-plugin.ts'
import { ocrAssets } from './scripts/ocr-assets.ts'
import { softwareLicenses } from './scripts/software-licenses.ts'

const PERSISTENCE_TEST_TIMEOUT_MS = 30_000
const CI_TEST_WORKERS = 2
const LOCAL_TEST_WORKERS = '25%'
const DOM_TEST_FILES = [
  'src/interchange/xlsx.test.ts',
  'src/ui/KnowledgeValue.test.tsx',
  'src/ui/ClassLearnTree.test.tsx',
  'src/ui/components.test.tsx',
  'src/ui/navigation-controller.test.tsx',
  'src/ui/TravelUnlocksView.test.tsx',
  'src/ui/route-state.test.ts',
  'src/ui/useQueuedTileUpdates.test.tsx',
  'src/ui/mod-inspector/inspector.test.tsx',
]

export default defineConfig({
  base: './',
  plugins: [
    react(),
    ocrAssets(),
    softwareLicenses(),
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
    fs: { deny: ['.env', '.env.*', '**/.git/**', '**/*.{pem,key,crt}', '**/*.xlsx', '**/crystal_project_*', '**/private/**'] },
  },
  test: {
    environment: 'node',
    restoreMocks: true,
    maxWorkers: process.env.CI ? CI_TEST_WORKERS : LOCAL_TEST_WORKERS,
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], exclude: ['src/persistence/**', ...DOM_TEST_FILES] } },
      { test: { name: 'dom', environment: 'jsdom', include: DOM_TEST_FILES } },
      { test: { name: 'persistence', include: ['src/persistence/**/*.test.ts'], testTimeout: PERSISTENCE_TEST_TIMEOUT_MS } },
    ],
  },
})
