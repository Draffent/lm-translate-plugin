# LM Translate Plugin — 架构文档 v1.0

## 系统边界

```
┌──────────────────────────────────────────────────┐
│ LM Studio Electron App                           │
│  ┌──────────── renderer ────────────────┐        │
│  │ lm-translate.js (IIFE, ~1040 lines)  │        │
│  │                                       │        │
│  │  Modules:                            │        │
│  │  ├─ DiagPanel   (诊断面板 + 自动隐藏) │        │
│  │  ├─ WebSocket   (ws://18999 桥接)     │        │
│  │  ├─ Translate   (百度API 批量翻译)     │        │
│  │  ├─ Collect     (DOM文本扫描)         │        │
│  │  ├─ Inject      (按钮注入 FAB/搜索/页) │        │
│  │  └─ RouteWatch  (hash变化监听)        │        │
│  └───────────────────────────────────────┘        │
│              │ HTTP (fetch)                        │
└──────────────┼────────────────────────────────────┘
               │
┌──────────────┼────────────────────────────────────┐
│ Local Machine │                                    │
│  ┌───────────▼────────────────────────────┐       │
│  │ lm-translate-proxy.mjs (Node.js, :18990)│       │
│  │  ├─ GET  /health                       │       │
│  │  ├─ GET  /translate?q=&from=&to=        │       │
│  │  └─ POST /batch  {texts:[],from,to}    │       │
│  └────────────┬───────────────────────────┘       │
└───────────────┼───────────────────────────────────┘
                │ HTTPS
                ▼
    Baidu Translate API (fanyi-api.baidu.com)
```

## 模块职责

### lm-translate.js (浏览器端)

| 模块 | 函数 | 职责 |
|------|------|------|
| 诊断面板 | `createDiagPanel()`, `scheduleDiagAutoHide()`, `showDiagPanel()`, `updateDiagVisibility()` | 启动时显示连接状态，自动隐藏逻辑，手动关闭标记 |
| 代理检查 | `checkProxyHealth()`, `updateFabIndicator()` | 静默检查代理连通性，更新FAB颜色指示器 |
| DOM扫描 | `collectTexts()`, `isLayoutContainer()`, `isNearControl()` | 扫描页面英文文本节点，过滤UI组件/布局容器 |
| 翻译引擎 | `baiduBatch()`, `tsFetch()`, `doInlineTranslate()`, `removeTranslations()` | 批量翻译 → 内联显示中文 → 还原 |
| 按钮注入 | `injectSearchBtn()`, `injectPageBtn()`, `injectFab()`, `injectSidebarBtn()` | 动态注入UI控件 |
| 页面检测 | `isDiscoverPage()`, `findSearchInput()`, `findSidebarContainer()` | 检测当前页面类型，定位注入锚点 |
| 路由监听 | `onRouteChange()` | hash变化时清理翻译 + 重新注入 |
| WebSocket | `wsConnect()`, `wsSend()`, `wsTranslate()`, `wsBatch()` | WebSocket 桥接回退（tsApi不可用时） |
| 词典 | `translateQuery()`, `dictEntries[]` | 中文→英文搜索词本地词典 |

### lm-translate-proxy.mjs (Node.js)

| 端点 | 方法 | 功能 |
|------|------|------|
| `/health` | GET | 健康检查 → `{status:"ok"}` |
| `/translate` | GET | 单文本翻译 → `{ok:true, translations:[...]}` |
| `/batch` | POST | 批量翻译 → `{ok:true, translations:[...]}` |

## 数据流

```
用户点击"翻译此页"
  → doInlineTranslate()
    → collectTexts()         // scan DOM
      → filter by: tag, position, text length, English ratio
      → return [{el, text}, ...]
    → baiduBatch(texts, en, zh)
      → POST /batch → proxy → Baidu API
      ← translations[]
    → for each item:
        el.appendChild(trSpan)  // <span class="ts-inline-tr">
  → updateFabState() → "还原英文"
```

## 安全约束

- Baidu API 密钥硬编码（LM Studio 本地插件上下文，不暴露到浏览器外）
- 本地代理仅监听 127.0.0.1（不接受外部连接）
- 无用户数据外传（仅翻译请求到百度 API）
