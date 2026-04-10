# Subaru Agent — Seed & Spawn Guide

此目錄包含建立全新 subaru agent 所需的最小設定，可隨時從零開始部署。

---

## 目錄結構

```
.seed/
├── README.md                          # 本文件
├── openclaw.json                      # 主設定（模型、Telegram、gateway auth）
├── spawn.sh                           # 一鍵啟動腳本
├── agents/
│   └── main/agent/
│       └── auth-profiles.json         # Anthropic API Key
└── workspace/
    └── config/
        └── mcporter.json              # Tavily MCP server 設定
```

---

## 前置需求

- Docker 已安裝並運行
- `openclaw` Docker image 已建置（在 repo 根目錄執行 `docker build -t openclaw .`）

---

## 快速啟動

```bash
bash .seed/spawn.sh
```

預設會：

- 將 seed config 複製到 `~/Realms/first.abode/subaru.suite/`
- 停掉並移除舊容器 `subaru.agent`（如果存在）
- 啟動全新容器，對外開放 port `18789` 和 `50001`

### 自訂參數

```bash
bash .seed/spawn.sh [suite-dir] [container-name]

# 範例：使用不同的 suite 目錄和容器名稱
bash .seed/spawn.sh ~/Realms/other.abode/my.suite my.agent
```

---

## 啟動後操作

### 1. 確認 Gateway 正常運行

```bash
docker logs subaru.agent | tail -20
# 應看到：[gateway] agent model: anthropic/claude-haiku-4-5
# 應看到：[gateway] listening on ws://0.0.0.0:18789
# 應看到：[telegram] starting provider (@subaru_openclaw_bot)
```

### 2. Telegram 配對

在 Telegram 對 `@subaru_openclaw_bot` 發送任意訊息，bot 會回覆配對碼（如 `DUKFC477`）。

取得配對碼後執行：

```bash
# 查看 pending 請求
docker exec subaru.agent node openclaw.mjs pairing list --channel telegram

# 批准配對（替換 CODE 為實際配對碼）
docker exec subaru.agent node openclaw.mjs pairing approve --channel telegram CODE
```

### 3. 驗證裝置清單

```bash
docker exec subaru.agent node openclaw.mjs devices list
```

---

## 目前設定摘要

| 項目           | 值                                   |
| -------------- | ------------------------------------ |
| 模型           | `anthropic/claude-haiku-4-5`         |
| Context Window | `16,384 tokens（16K）`               |
| Telegram Bot   | `@subaru_openclaw_bot`               |
| Gateway Port   | `18789`（內部），`50001`（對外別名） |
| Gateway Auth   | Token（見 `openclaw.json`）          |
| DM Policy      | `pairing`（需手動批准）              |
| Web Search     | Tavily MCP（透過 mcporter skill）    |

---

## Tavily 網路搜尋（MCP via mcporter）

openclaw 本身不原生支援 MCP server，改以 `mcporter` skill 橋接。

### 架構

```
Agent → mcporter CLI → Tavily MCP server (https://mcp.tavily.com/mcp/)
```

- **mcporter** 安裝於容器內 `/home/node/.local/bin/mcporter`
- **Tavily 設定** 存於 `workspace/config/mcporter.json`（agent workspace 的預設讀取位置，不需環境變數）
- **skill** 在 `openclaw.json` 中以 `skills.allowBundled: ["mcporter"]` 啟用

### 注意：mcporter 不隨容器重啟持久化

mcporter binary 安裝在容器的非掛載路徑，**容器重啟後需重新安裝**：

```bash
docker exec subaru.agent npm install -g mcporter --prefix /home/node/.local
```

若需要永久持久化，可將安裝步驟加入 Dockerfile：

```dockerfile
RUN npm install -g mcporter --prefix /home/node/.local
```

### 驗證 Tavily 連線

```bash
docker exec -w /home/node/.openclaw/workspace \
  subaru.agent /home/node/.local/bin/mcporter list
# 應看到：tavily (5 tools, ...)
```

---

## 常用維運指令

| 操作              | 指令                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| 查看 logs         | `docker logs subaru.agent -f`                                                                    |
| 重啟容器          | `docker restart subaru.agent`                                                                    |
| 停止容器          | `docker stop subaru.agent`                                                                       |
| 進入容器 shell    | `docker exec -it subaru.agent bash`                                                              |
| 列出已配對裝置    | `docker exec subaru.agent node openclaw.mjs devices list`                                        |
| 移除已配對裝置    | `docker exec subaru.agent node openclaw.mjs devices remove <deviceId>`                           |
| 查看 pending 配對 | `docker exec subaru.agent node openclaw.mjs pairing list --channel telegram`                     |
| 批准配對          | `docker exec subaru.agent node openclaw.mjs pairing approve --channel telegram <CODE>`           |
| 執行健康檢查      | `docker exec subaru.agent node openclaw.mjs doctor`                                              |
| 重新安裝 mcporter | `docker exec subaru.agent npm install -g mcporter --prefix /home/node/.local`                    |
| 驗證 Tavily 連線  | `docker exec -w /home/node/.openclaw/workspace subaru.agent /home/node/.local/bin/mcporter list` |

---

## 注意事項

1. **不要將 `.seed/` 提交到公開 repo**，內含 API Key 和 Bot Token 等敏感資訊。
2. **每次全新部署後，裝置配對資料不會保留**，需重新執行 Telegram 配對流程。
3. **`spawn.sh` 會覆蓋** `suite-dir` 內的 `openclaw.json`、`auth-profiles.json`、`workspace/config/mcporter.json`，但不會刪除其他資料（sessions、logs 等）。若需完全乾淨的環境，請先手動清空 suite 目錄。
4. **重建 image** 後需重新執行 `spawn.sh` 才能讓新版本的 image 生效。
5. **容器重啟後需重新安裝 mcporter**（見上方指令），或將安裝步驟加入 Dockerfile 以永久解決。
6. Gateway 綁定模式為 `lan`（`0.0.0.0`），確保防火牆或路由器有適當存取控制。
