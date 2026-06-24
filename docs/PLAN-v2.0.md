# PLAN: LM Translate Plugin v2.0 — 技术实现方案

## 修订后架构（最终版）

```
lm-translate.js (浏览器端, IIFE)
├── [NEW]  ScrapeEngine    — DOM→结构化数据 采集引擎
│   ├── scrapeDiscover()   — 发现页模型列表
│   ├── scrapeDetail()     — 模型详情页
│   ├── scrapeRuntime()    — 运行时/GPU状态
│   └── scrapeGeneric()    — 通用页面文本
├── [NEW]  DataBridge      — 数据输出通道
│   ├── postToProxy()      — POST /store → 代理写文件
│   ├── copyToClipboard()  — 复制JSON到剪贴板
│   └── exportPanel()      — 导出面板UI
├── [NEW]  AuditLog        — 审计日志
│   ├── audit()            — 记录事件
│   └── flushAudit()       — POST /audit → 代理写文件
├── [EXIST] TranslateEngine — 翻译引擎 (不变)
├── [EXIST] DiagPanel      — 诊断面板 (扩展)
├── [EXIST] Injectors      — UI按钮注入 (扩展导出按钮)
└── [EXIST] RouteWatch     — 路由监听 (扩展自动采集触发)

lm-translate-proxy.mjs (Node.js, :18990)
├── [NEW]  POST /store     — 接收采集数据 → 写JSON文件
├── [NEW]  POST /audit     — 接收审计日志 → 写JSONL文件
├── [NEW]  GET /data       — 返回最新快照
├── [EXIST] GET /translate — 翻译 (不变)
├── [EXIST] POST /batch    — 批量翻译 (不变)
└── [EXIST] GET /health    — 健康检查 (扩展状态)
```

## 垂直切片

### Slice 1: DOM 采集引擎 (P0)
**文件**: `lm-translate.js` (新增 scrape 模块)
**依赖**: 无（独立模块）
**验收**:
- [ ] `__ts.scrape()` 在发现页返回 ≥10 个模型的结构化数据
- [ ] 每个模型包含: name, author, size, quantization, capabilities, description, downloads, likes
- [ ] 返回数据通过 JSON schema 验证
- [ ] 非发现页返回 `{page, error}`

### Slice 2: 代理 /store + /data 端点 (P0)
**文件**: `lm-translate-proxy.mjs` (新增端点)
**依赖**: Slice 1 (需要采集数据来测试)
**验收**:
- [ ] POST /store 接收 JSON → 写入 `E:\临时文件\claude 临时文件\<date>\lm-studio-scrape.json`
- [ ] GET /data 返回最新快照
- [ ] 自动创建日期子目录
- [ ] 文件大小限制 (< 5MB 自动轮转)

### Slice 3: 自动采集 + 代理推送 (P0)
**文件**: `lm-translate.js` (DataBridge 模块)
**依赖**: Slice 1, Slice 2
**验收**:
- [ ] 进入发现页 1.5 秒后自动触发采集
- [ ] 采集完成自动 POST 到代理 /store
- [ ] 推送失败时显示诊断面板警告
- [ ] 诊断面板显示 "📊 已采集 N 个模型 → 已同步"

### Slice 4: 导出面板 + 剪贴板 (P1)
**文件**: `lm-translate.js` (exportPanel)
**依赖**: Slice 3
**验收**:
- [ ] FAB 旁边新增 "📋" 按钮
- [ ] 点击复制 JSON 到剪贴板 → 显示 "✅ 已复制"
- [ ] 导出面板显示模型数量、最后采集时间
- [ ] 面板 3 秒自动隐藏

### Slice 5: 审计日志 (P1)
**文件**: `lm-translate.js` (AuditLog) + `lm-translate-proxy.mjs` (POST /audit)
**依赖**: Slice 3
**验收**:
- [ ] 每次采集记录: 时间戳, 页面, 模型数, 耗时, 错误
- [ ] 每 30 秒 POST /audit 推送审计日志
- [ ] 代理写入 `lm-studio-audit.jsonl`
- [ ] 诊断面板显示最近 5 条审计记录

### Slice 6: 模型详情页采集 (P2)
**文件**: `lm-translate.js` (scrapeDetail)
**依赖**: Slice 1
**验收**:
- [ ] `__ts.scrapeDetail()` 采集详情页: 文件列表, 量化选项, VRAM, 描述
- [ ] 自动检测页面类型 (discover vs detail vs chat)

## 数据 Schema（最终版）

```json
{
  "version": "2.0",
  "page": "discover",
  "url": "#/discover",
  "timestamp": "2026-06-25T12:00:00.000Z",
  "pageStats": {
    "totalVisible": 20,
    "scraped": 18,
    "skipped": 2
  },
  "searchQuery": "qwen",
  "filters": {
    "active": ["gguf", "chat"],
    "sort": "trending"
  },
  "models": [
    {
      "id": "card-0",
      "name": "Qwen3-235B-A22B-GGUF",
      "author": "Qwen",
      "size": "235B",
      "quantization": "Q4_K_M",
      "capabilities": ["chat", "code", "reasoning"],
      "description": "...",
      "downloads": "1.2M",
      "likes": 3500,
      "updated": "2026-06-20",
      "tags": ["gguf", "chat", "large"],
      "sourceElement": "div[data-testid='model-card']"
    }
  ],
  "runtime": {
    "gpu": "AMD Radeon RX 9070 XT",
    "backend": "llama.cpp ROCm v2.21.0",
    "loadedModel": null,
    "vramUsed": null
  }
}
```

## 实现顺序

```
S1 (采集引擎) → S2 (代理端点) → S3 (自动推送) → S4 (导出UI) → S5 (审计) → S6 (详情页)
                                     ↘ S2+S3 完成即 MVP ✓
```

## 文件变更清单

| 文件 | 操作 | 预估行数变化 |
|------|------|-------------|
| `src/lm-translate.js` | 修改 | +400 行 (scrape/bridge/audit/export 模块) |
| `src/lm-translate-proxy.mjs` | 修改 | +80 行 (/store /audit /data 端点) |
| `docs/PRD-v2.0.md` | 已存在 | 更新为最终版 |
| `tests/test-scrape.js` | 新增 | 单元测试 |
| `CHANGELOG.md` | 修改 | 追加 v2.0 条目 |
