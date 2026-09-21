import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    resolve: { alias: { '@renderer': new URL('./src/renderer', import.meta.url).pathname } },
    plugins: [react()],
  },
})
