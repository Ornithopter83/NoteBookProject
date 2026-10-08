import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@northstar/psd-bridge', 'ag-psd'] })]
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: appRoot,
    resolve: { alias: { '@': resolve(appRoot, 'src/renderer/src') } },
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: {
      outDir: resolve(appRoot, 'out/renderer'),
      rollupOptions: { input: resolve(appRoot, 'index.html') }
    }
  }
})
