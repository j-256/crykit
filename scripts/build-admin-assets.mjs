import { rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

// Build protected entries separately so neither the public shell nor its offline cache imports admin code
const entries = [
  ['admin.html', 'admin'],
  ['admin-accept.html', 'admin/accept-invitation'],
  ['admin-confirm.html', 'admin/confirm'],
]
for (const [entry, directory] of entries) {
  const output = resolve('dist', directory)
  await rm(output, { recursive: true, force: true })
  await build({
    configFile: false,
    base: `/${directory}/`,
    publicDir: false,
    plugins: [react()],
    build: { outDir: output, emptyOutDir: false, rollupOptions: { input: resolve(entry) }, target: ['es2022'] },
  })
  await rename(resolve(output, entry), resolve(output, 'index.html'))
}
