// cpp-semantic.js — C++ 语义令牌（VSCode 风格标识符着色）
// 功能：注册 DocumentSemanticTokensProvider（cpp），对标识符输出
//       namespace/type/function/variable/member/macro 令牌；定义 vp-dark/vp-light
//       主题（语义色贴近 VS Code dark+/light+）。
// 依赖：window.monaco（AMD 加载后）。可调参数：无。

const TOKEN_TYPES = ['namespace', 'type', 'function', 'variable', 'member', 'macro']

// C++ 关键字：不输出语义令牌（避免与 Monarch 语法令牌重叠）
const KW = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool',
  'break', 'case', 'catch', 'char', 'char16_t', 'char32_t', 'class', 'compl', 'concept',
  'const', 'constexpr', 'const_cast', 'continue', 'decltype', 'default', 'delete',
  'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern',
  'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable',
  'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq',
  'private', 'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return',
  'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast', 'struct',
  'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef',
  'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
  'wchar_t', 'while', 'xor', 'xor_eq',
])

// 已知类型（STL 容器等）：输出 type 令牌
const KNOWN_TYPES = new Set([
  'size_t', 'string', 'vector', 'map', 'set', 'pair', 'queue', 'stack', 'list',
  'deque', 'unordered_map', 'unordered_set', 'priority_queue', 'stringstream',
  'istream', 'ostream', 'ifstream', 'ofstream', 'fstream', 'istringstream',
  'ostringstream', 'FILE', 'iterator', 'const_iterator', 'reverse_iterator',
  'unique_ptr', 'shared_ptr', 'optional', 'array', 'tuple', 'bitset', 'multiset',
  'multimap', 'unordered_multimap', 'unordered_multiset',
])

// 类型声明关键字：后随标识符登记为类型
const TYPE_DECL = new Set(['class', 'struct', 'enum', 'union'])

const T_IDX = {}
TOKEN_TYPES.forEach((t, i) => { T_IDX[t] = i })

function isAllCaps(name) {
  let hasUpper = false
  for (const ch of name) {
    if (ch === '_') continue
    if (ch >= 'A' && ch <= 'Z') hasUpper = true
    else if (ch >= 'a' && ch <= 'z') return false
  }
  return hasUpper
}

/**
 * 分析 C++ 文本，输出语义令牌（不含关键字/注释/字符串内部）。
 * @param {string} text
 * @returns {{line:number,start:number,length:number,type:number}[]}
 */
function analyzeCpp(text) {
  const out = []
  const knownTypes = new Set(KNOWN_TYPES) // 每文件独立，登记用户类型
  const lines = text.split('\n')
  let inBlock = false // 跨行块注释状态
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const n = line.length
    let i = 0
    let pendingMember = false // 前遇 . / ->，下一标识符为成员
    let pendingScope = false // 前遇 ::，下一标识符为成员/类型/函数
    while (i < n) {
      const ch = line[i]
      if (inBlock) {
        const end = line.indexOf('*/', i)
        if (end === -1) { i = n; break }
        inBlock = false
        i = end + 2
        continue
      }
      if (ch === '/' && line[i + 1] === '/') break // 行注释，结束本行
      if (ch === '/' && line[i + 1] === '*') { inBlock = true; i += 2; continue }
      if (ch === '"' || ch === "'") {
        const q = ch
        i++
        while (i < n) {
          if (line[i] === '\\') i += 2
          else if (line[i] === q) { i++; break }
          else i++
        }
        continue
      }
      if (ch === '#') {
        if (line.slice(i, i + 7) === '#define') {
          let j = i + 7
          while (j < n && (line[j] === ' ' || line[j] === '\t')) j++
          const s = j
          while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++
          if (j > s) out.push({ line: li, start: s, length: j - s, type: T_IDX.macro })
        }
        break // 其余预处理指令（include 等）由 Monarch 上色，整行跳过
      }
      if (/[A-Za-z_]/.test(ch)) {
        const s = i
        while (i < n && /[A-Za-z0-9_]/.test(line[i])) i++
        const name = line.slice(s, i)
        const rest = line.slice(i)
        let type = -1
        // 类型声明上下文：class/struct/enum/union Foo、typedef … Foo;、using Foo =
        const before = line.slice(0, s).trimEnd()
        const words = before.split(/[\s{;:<>()]+/).filter(Boolean)
        const prevWord = words[words.length - 1]
        if (prevWord && TYPE_DECL.has(prevWord)) {
          knownTypes.add(name)
          type = T_IDX.type
        } else if (prevWord === 'typedef' || (prevWord === 'using' && /^\s*=/.test(rest))) {
          knownTypes.add(name)
          type = T_IDX.type
        } else if (!KW.has(name)) {
          if (/^\s*::/.test(rest)) {
            type = T_IDX.namespace
          } else if (knownTypes.has(name)) {
            type = T_IDX.type
          } else if (/^\s*\(/.test(rest)) {
            type = T_IDX.function // 函数调用（控制关键字已在 KW 排除）
          } else if (pendingMember) {
            type = T_IDX.member // 对象/结构体成员
          } else if (pendingScope) {
            type = T_IDX.member // std::cout / std::endl 等
          } else if (isAllCaps(name)) {
            type = T_IDX.macro
          } else {
            type = T_IDX.variable
          }
        }
        if (type >= 0) out.push({ line: li, start: s, length: i - s, type })
        pendingMember = false
        pendingScope = false
        continue
      }
      if (ch === ':' && line[i + 1] === ':') { pendingScope = true; i += 2; continue }
      if (ch === '-' && line[i + 1] === '>') { pendingMember = true; i += 2; continue }
      if (ch === '.' && !/[0-9]/.test(line[i + 1] || '')) { pendingMember = true; i++; continue }
      i++
    }
  }
  return out
}

/**
 * 编码为 vscode 语义令牌格式：5 元组相对编码
 * [deltaLine, deltaStartChar, length, tokenTypeIndex, modifierBitmask]
 * 同行相对列、跨行绝对列；列 0 基 UTF-16。
 */
function encodeTokens(tokens) {
  tokens.sort((a, b) => a.line - b.line || a.start - b.start)
  const data = []
  let prevLine = 0
  let prevStart = 0
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    let deltaLine, deltaStart
    if (k === 0) {
      deltaLine = t.line
      deltaStart = t.start
    } else if (t.line === prevLine) {
      deltaLine = 0
      deltaStart = t.start - prevStart
    } else {
      deltaLine = t.line - prevLine
      deltaStart = t.start
    }
    data.push(deltaLine, deltaStart, t.length, t.type, 0)
    prevLine = t.line
    prevStart = t.start
  }
  return new Uint32Array(data)
}

/** 注册 cpp 文档级语义令牌 provider */
function registerCppSemanticProvider(monaco) {
  monaco.languages.registerDocumentSemanticTokensProvider('cpp', {
    getLegend() {
      return { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }
    },
    provideDocumentSemanticTokens(model) {
      const tokens = analyzeCpp(model.getValue())
      return { data: encodeTokens(tokens) }
    },
  })
}

/** 定义 vp-dark / vp-light 主题（语义色贴近 VS Code dark+/light+） */
async function defineSemanticThemes(monaco) {
  monaco.editor.defineTheme('vp-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'function', foreground: 'dcdcaa' },
      { token: 'variable', foreground: '9cdcfe' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'namespace', foreground: '4ec9b0' },
      { token: 'macro', foreground: 'c586c0' },
      { token: 'member', foreground: '9cdcfe' },
    ],
    colors: {},
    semanticHighlighting: true,
  })
  monaco.editor.defineTheme('vp-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'function', foreground: '795E26' },
      { token: 'variable', foreground: '001188' },
      { token: 'type', foreground: '267f99' },
      { token: 'namespace', foreground: '267f99' },
      { token: 'macro', foreground: 'AF00DB' },
      { token: 'member', foreground: '001188' },
    ],
    colors: {},
    semanticHighlighting: true,
  })
}

/** 打开语义着色开关（0.52.2 只能通过点号键走 schema 校验） */
function enableSemantic(editor) {
  editor.updateOptions({ 'semanticHighlighting.enabled': true })
}

export { TOKEN_TYPES, defineSemanticThemes, registerCppSemanticProvider, enableSemantic }
