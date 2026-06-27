# LM Studio 版本适配记录

## 当前适配版本

| 项目 | 版本/信息 |
|------|----------|
| **LM Studio** | **0.4.18** (更新于 2026-06-27) |
| **插件版本** | **v2.2.0** |
| **注入点** | `resources/app/.webpack/renderer/index.html` |
| **关键桥接** | `window.tsApi.fetchJSON` (preload注入) |
| **Electron版本** | 38.6.0 (Chromium内核) |

## LM Studio 更新后需检查的适配点

### 1. DOM 选择器 (最高风险)
- [ ] `button[aria-label="Chat"]` — 侧边栏聊天按钮（启动检测锚点）
- [ ] 搜索框 placeholder: `"搜索模型"` / `"Search models"` / `"Discover"` / `"Filter models"`
- [ ] 模型卡片选择器: `[class*="card"]` / `[class*="model"]` / `[class*="item"]`

### 2. tsApi 桥接 (高风险)
- [ ] `window.tsApi.fetchJSON()` 是否存在
- [ ] `window.tsApi.ping()` 是否可用
- [ ] Electron 沙箱策略是否变化

### 3. 渲染进程路径
- [ ] `resources/app/.webpack/renderer/index.html` 路径是否变化
- [ ] renderer 打包方式是否从 webpack 变为其他

### 4. 页面路由
- [ ] `#/discover` hash 是否变化
- [ ] `#/search` 是否存在

### 5. 模型卡片DOM结构
- [ ] 模型名称的 heading 元素结构
- [ ] 标签/能力 pill 的 class 命名
- [ ] 描述文本的容器选择器

## 更新后适配流程

1. 更新 LM Studio 后启动插件
2. 打开诊断面板（右上角，悬停在discover页）
3. 检查 tsApi 状态、WebSocket 状态
4. 在控制台运行 `__ts.scrape()` 验证数据采集
5. 根据诊断信息修复失效的选择器
6. 更新本文件的版本信息
7. 打新 tag 并推送
