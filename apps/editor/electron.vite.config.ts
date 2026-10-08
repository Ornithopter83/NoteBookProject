import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve('.'),
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: { rollupOptions: { input: resolve('index.html') } }
  }
})
