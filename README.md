# LM Studio Translate Plugin

LM Studio 模型搜索页面的中英文翻译增强插件。通过注入到 LM Studio Electron 渲染进程，实现百度翻译 API 驱动的整页内联翻译、搜索框中文转英文、浮动翻译按钮等功能。

## 版本

| 版本 | 说明 |
|------|------|
| v1.0 | 翻译核心：内联翻译 + 搜索框翻译 + FAB 浮动按钮 + 诊断面板 |

## 架构

```
LM Studio (Electron)
  └── renderer/index.html
       └── <script defer src="lm-translate.js">  ← 注入点
            ├── collectTexts()     → 扫描页面英文文本
            ├── baiduBatch()       → 批量翻译
            ├── doInlineTranslate() → 内联显示译文
            └── 诊断面板 / FAB / 按钮
                     │
                     │ HTTP (fetch)
                     ▼
            lm-translate-proxy.mjs (Node.js :18990)
                     │ CORS bypass
                     ▼
            Baidu Translate API
```

## 文件

| 文件 | 用途 |
|------|------|
| `src/lm-translate.js` | 浏览器端插件（注入 LM Studio renderer） |
| `src/lm-translate-proxy.mjs` | 本地 HTTP 代理（Node.js 18+，绕过 CORS） |

## 部署

### 1. 启动代理

```bash
node src/lm-translate-proxy.mjs
# 监听 http://127.0.0.1:18990
```

### 2. 注入插件

在 LM Studio 的 `resources/app/.webpack/renderer/index.html` 中添加：

```html
<script defer="defer" src="lm-translate.js"></script>
```

并将 `lm-translate.js` 复制到同目录。

## 功能

- **翻译此页 (FAB)**：右下角浮动按钮，发现页自动显示，一键翻译整页英文
- **翻译整页按钮**：搜索框旁，翻译模型描述
- **🌐 翻译按钮**：搜索框旁，中文搜索词 → 英文
- **诊断面板**：启动时显示连接状态，3 秒自动隐藏，悬停保持
- **百度翻译 API**：通过本地代理绕过 CORS，支持批量翻译
