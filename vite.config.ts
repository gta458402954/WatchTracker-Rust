import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

function resolveGitCommit(): string {
  const injectedCommit = process.env.WATCHTRACKER_GIT_COMMIT?.trim()
  if (injectedCommit) return injectedCommit

  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

const gitCommit = resolveGitCommit()

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
  define: {
    'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
  },
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
