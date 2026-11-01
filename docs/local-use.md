# 本機私用與真實連線

真實 AI 來源只應在你控制的本機執行環境使用。GitHub Pages 版是模擬展示，不能沿用這些連線。

## Docker Compose

先依 README 的 Docker Compose 步驟建立 `.secrets/ai-office.env`，再啟動：

```sh
docker compose -f docker-compose.yaml up --build -d
```

應用程式只綁定本機 `127.0.0.1:4173`。Hermes API Server 預設透過 `host.docker.internal:8642` 連到主機；Claude Code 與 Codex CLI 的容器登入資料分別使用 Docker named volumes。Codex 的主機 sessions/agents 目錄以唯讀方式掛載，供匯入歷史資料。

在本機開啟 `http://127.0.0.1:4173`，從「連接來源」設定 Hermes、Grok、Claude 或 Codex 支援的連線方式。API Key 由本機整合服務加密保存；公開網站不會使用這些設定。

## 私人存取

目前 Compose 範本只在 loopback 提供服務，沒有反向代理、使用者登入或遠端存取控制。不要把容器直接映射到公網或接上未受保護的 tunnel。若要遠端私人使用，需先另行部署具備 TLS、身分驗證與網路存取限制的閘道。

Hermes、Grok、Claude、Codex 的權限與計費方式不同；Codex CLI 歷史匯入是唯讀，Hermes 群組則使用單一協作窗口回覆，並不代表多個 bot 已各自執行任務。
