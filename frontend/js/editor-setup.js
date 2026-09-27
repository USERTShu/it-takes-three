// editor-setup.js — Monaco Editor 启动与实例创建（ES 模块）
// 功能：AMD loader 引导（loader.js → editor.main.js），并创建编辑器实例。
// 依赖：vendor/monaco-editor-0.52.2/min/vs/{loader.js,editor/editor.main.js,base/worker/workerMain.js}
//       + vendor/monaco-editor-0.52.2/monaco.worker.js（Worker 路径）
// 可调参数：无（路径固定为 /vendor 版本化目录）。
let monacoPromise = null

function loadMonaco() {
  if (monacoPromise) return monacoPromise
  monacoPromise = new Promise((resolve, reject) => {
    // Worker 必须在本文件全局注入后、创建编辑器前生效
    window.MonacoEnvironment = {
      getWorkerUrl: () => '/vendor/monaco-editor-0.52.2/monaco.worker.js',
    }
    const loader = document.createElement('script')
    loader.src = '/vendor/monaco-editor-0.52.2/min/vs/loader.js'
    loader.onload = () => {
      window.require.config({ paths: { vs: '/vendor/monaco-editor-0.52.2/min/vs' } })
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (err) => reject(new Error('Monaco 加载失败: ' + (err && err.message))))
    }
    loader.onerror = () => reject(new Error('Monaco loader.js 加载失败'))
    document.head.appendChild(loader)
  })
  return monacoPromise
}

export async function createEditor(container) {
  const monaco = await loadMonaco()
  const editor = monaco.editor.create(container, {
    language: 'cpp',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    lineHeight: 20,
    scrollBeyondLastLine: false,
    scrollbar: { verticalScrollbarSize: 10 },
    glyphMargin: true,
    // 折叠用缩进策略：主线程计算，不依赖 editor worker
    // （AMD 部署下 editor.worker.js 缺失，auto 策略的折叠范围计算会失败）
    folding: true,
    foldingStrategy: 'indentation',
    showFoldingControls: 'mouseover',
  })
  return editor
}
