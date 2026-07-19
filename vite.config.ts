import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const projectRoot = path.resolve(__dirname)

export default defineConfig({
  plugins: [
    react(),
  ],
  root: projectRoot,
  base: './',
  // 防止 Vite 倾倒不相关的错误
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Tauri 需要固定的端口
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // 环境变量前缀
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: path.join(projectRoot, 'dist'),
    emptyOutDir: true,
    // 为 Chrome 105+ 或类似的 Tauri 环境进行构建
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
    // 在非 debug 构建中不生成 sourcemap
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  resolve: {
    alias: {
      '@': path.join(projectRoot, 'src'),
    },
  },
})
