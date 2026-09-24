import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { offlinePlugin } from './scripts/offline-plugin'

export default defineConfig({
  base: './',
  plugins: [
    react(),
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
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
  },
})
