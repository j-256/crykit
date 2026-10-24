import { defineConfig } from 'vite'
import { offlinePlugin } from './scripts/offline-plugin.ts'

// Local fixture assets are emitted separately and are never part of build:assets or deployment
export default defineConfig({
  root: 'worker/testing', base: '/__accounts-proof/', publicDir: false,
  worker: { format: 'es' },
  build: { outDir: '../../.account-tests/browser', emptyOutDir: true, target: 'es2022', rollupOptions: { input: { proof: 'worker/testing/crypto-proof.html', accountUi: 'worker/testing/account-ui.html', workspace: 'worker/testing/account-workspace.html', localSave: 'worker/testing/local-save-performance.html' } } },
  // Account journeys install the same essential shell as players; explicit offline journeys verify the optional assets
  plugins: [offlinePlugin({ publicAssets: [], indexSource: 'crypto-proof.html' })],
})
