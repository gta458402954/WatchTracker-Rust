import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App.tsx'
import ErrorBoundary from './shared/components/ErrorBoundary.tsx'
import './index.css'

// 禁用全局右键菜单 (屏蔽浏览器默认的上下文菜单)
document.addEventListener('contextmenu', e => e.preventDefault());

// 立即挂载 React 应用
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
