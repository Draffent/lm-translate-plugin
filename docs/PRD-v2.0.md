# PRD: LM Translate Plugin v2.0 — 模型数据采集 + LLM 信息桥接

## 1. Objective

将 lm-translate.js 从"翻译工具"升级为"LM Studio 数据桥接层"：不仅能翻译页面英文，还能**结构化采集模型搜索页面的全部可见数据**，供给大模型 (Claude) 进行信息检索、分析和推荐。

**用户画像**: LM Studio 重度用户，通过 Claude Code 进行 AI 辅助工作，需要 Claude 能够"看到" LM Studio 中的模型列表、描述、参数等信息，以便：
- 根据需求推荐模型
- 比较模型能力
- 分析模型趋势
- 搜索特定类型模型

## 2. Success Criteria

- [ ] `__ts.scrape()` 返回结构化 JSON，包含页面上所有模型卡片的完整数据
- [ ] 数据可通过 WebSocket 被外部 Agent 主动查询（请求-响应模式）
- [ ] WebSocket 支持 `scrape` 命令 → 返回完整页面数据
- [ ] WebSocket 支持 `search` 命令 → 搜索特定模型名/关键词
- [ ] WebSocket 支持 `watch` 命令 → 页面变化时主动推送更新
- [ ] 数据导出面板：一键复制 JSON 到剪贴板
- [ ] 审计日志：记录每次查询的时间、数据量、错误
- [ ] 代理健康检查增强：显示 WebSocket + 代理 + 数据采集三重状态
- [ ] 不破坏现有翻译功能（向后兼容 v1.0）

## 3. Commands

```bash
# 代理启动（不变）
node src/lm-translate-proxy.mjs

# WebSocket 桥接（需新增数据查询命令）
node src/lm-translate-ws-bridge.mjs

# 部署插件（不变）
cp src/lm-translate.js "D:\AI\LM Studio\resources\app\.webpack\renderer\"
```

## 4. Code Style

- 保持 IIFE 结构，与 v1.0 风格一致
- 新功能通过 `window.__ts` 命名空间暴露
- 所有异步操作用 Promise/async-await
- 数据采集函数保持纯函数模式（输入 DOM → 输出数据）
- 审计日志统一使用 `audit()` 函数

## 5. Architecture (v2.0)

```
┌────────────────────────────────────────────────────┐
│ LM Studio Renderer                                 │
│  lm-translate.js v2.0                              │
│                                                    │
│  NEW: __ts.scrape()        → 结构化采集模型数据      │
│  NEW: __ts.scrapeCards()   → 仅采集模型卡片          │
│  NEW: __ts.search(q)       → 客户端搜索              │
│  NEW: __ts.export()        → 导出+复制到剪贴板       │
│  NEW: audit log            → 审计日志缓冲区          │
│                                                    │
│  EXISTING: 翻译 / FAB / 诊断面板 (不变)              │
└──────────────────┬─────────────────────────────────┘
                   │ WebSocket (:18999) or CDP
                   ▼
┌────────────────────────────────────────────────────┐
│ Claude Code Agent                                  │
│  - mcp__chrome-devtools__evaluate_script            │
│    → __ts.scrape()                                 │
│  - or: ws.send({type:"scrape"})                    │
│  - or: read local audit file                       │
└────────────────────────────────────────────────────┘
```

## 6. Data Schema

```json
{
  "page": "discover",
  "url": "#/discover",
  "timestamp": "2026-06-25T12:00:00Z",
  "searchQuery": "qwen",
  "totalVisible": 20,
  "models": [
    {
      "name": "Qwen3-235B-A22B-GGUF",
      "author": "Qwen",
      "size": "235B",
      "quantization": "Q4_K_M",
      "capabilities": ["chat", "code", "reasoning"],
      "description": "...",
      "downloads": "1.2M",
      "likes": 3500,
      "updated": "2026-06-20",
      "url": "https://huggingface.co/...",
      "tags": ["gguf", "chat", "large"]
    }
  ],
  "filters": {
    "active": ["gguf", "chat"],
    "sort": "trending"
  },
  "audit": {
    "scrapeCount": 5,
    "lastError": null
  }
}
```

## 7. Testing Strategy

- 单元测试：`scrapeCards()`, `extractModelData()`, `auditLog()`
- 集成测试：WebSocket 命令 → scrape 响应
- E2E：LM Studio 实际页面 → __ts.scrape() → 验证 JSON schema

## 8. Boundaries

**Always**:
- 所有新功能通过 `__ts` 命名空间暴露
- 保持与 v1.0 翻译功能的完全向后兼容
- 数据采集仅读取 DOM，不修改任何元素
- 审计日志仅存内存，不写磁盘

**Ask first**:
- 修改 index.html 注入方式
- 新增依赖（保持零外部依赖）
- 数据通过网络发送到外部服务

**Never**:
- 采集用户个人信息
- 向外部服务器发送采集数据
- 修改 LM Studio 原有 DOM 结构
- 破坏翻译功能

## 9. Vertical Slices

| Slice | 功能 | 优先级 |
|-------|------|--------|
| S1 | `__ts.scrape()` — 结构化采集模型数据 | P0 |
| S2 | WebSocket 查询接口 (`scrape`/`search` 命令) | P0 |
| S3 | 数据导出面板 + 剪贴板复制 | P1 |
| S4 | 审计日志系统 | P1 |
| S5 | WebSocket `watch` 推送 | P2 |

## 10. Risk

- LM Studio DOM 结构可能随版本变化 → 使用启发式选择器 + fallback
- 大页面采集可能耗时 → 分批采集，设置 timeout
- WebSocket 端口冲突 → 可配置端口
