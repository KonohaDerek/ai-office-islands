# 本機私用與真實連線

真實 AI 來源只應在你控制的本機執行環境使用。GitHub Pages 版是模擬展示，不能沿用這些連線。

## 本機 Vite（建議）

本機啟動可直接連到同一台電腦上的 Hermes API。先確認 Hermes Gateway 與 OpenAI-compatible API Server 已啟動，再於專案根目錄執行：

```sh
npm install
npm run dev:local
```

開啟 `http://127.0.0.1:4173`。本機啟動腳本會綁定 loopback，並使用 `http://127.0.0.1:8642/v1` 作為 Hermes API 網址。API 設定會以 AES-256-GCM 加密保存於 `.local-data/settings.yaml`，加密金鑰由 macOS Keychain 管理；首次使用時系統可能要求允許 Keychain 存取。原生本機啟動不讀取專案內的明文金鑰檔，也不會覆寫或輪替既有 Keychain 金鑰。

接著在「連接來源」輸入 API 金鑰。Hermes 預設使用 `http://127.0.0.1:8642/v1`；需在 Hermes 設定 `API_SERVER_ENABLED=true` 與 `API_SERVER_KEY`。Grok 預設使用 `https://api.x.ai/v1`。停止本機 Vite 可在執行中的終端機按 `Ctrl+C`。

## Docker Compose（可選）

一般本機使用不需要 Docker。若需要容器隔離，可另外啟動 Compose：

```sh
docker compose -f docker-compose.yaml up --build -d
```

Docker 版 Hermes 網址是 `http://host.docker.internal:8642/v1`；主機本機 Vite 則使用 `http://127.0.0.1:8642/v1`。兩種執行方式使用不同的加密設定儲存；切換時需遷移設定，API 金鑰不會自動同步。停止容器但保留設定與 CLI 登入資料，使用：

```sh
docker compose -f docker-compose.yaml stop ai-office
```

不要使用 `docker compose down -v`，那會刪除 Docker 的設定與 CLI 登入 volumes。Claude Code 和 Codex CLI 的 Docker 登入也使用獨立 volumes；Codex sessions/agents 只讀掛載供匯入歷史資料，不包含主機上的 OAuth 憑證。

## AI 額度面板

本機側欄左下「個人辦公室」下方會統一列出已連線的 API 來源與已登入的 CLI 帳戶，以來源圖示和進度條顯示；滑鼠移上去可看剩餘比例及重置時間。啟動本機頁面時讀取一次，點選任一列可開啟完整額度面板並重新整理，不會在背景持續輪詢。來源沒有可讀數值時會顯示斜線狀未知狀態，不會拿其他來源的數值代替。

- Codex CLI OAuth 使用 Codex app-server 的帳戶 rate-limit 讀取介面，顯示供應商回報的主要／週用量視窗、剩餘百分比、重置時間，以及帳戶有回報時的 credits／用量上限。讀取需要 Codex CLI 登入，且 Docker 部署需使用容器內的 Codex CLI 登入資料。
- Claude Code OAuth 會嘗試使用 Claude CLI 本機 OAuth 憑證讀取方案用量；Claude CLI 的這項用量介面不是 Anthropic 對一般整合公開承諾的穩定 API，格式或存取政策變動時可能無法取得。憑證不會送到瀏覽器。
- Hermes 可代理不同上游模型，沒有通用的額度查詢介面。Grok 一般 API Key、Claude API Key 與 OpenAI API Key 不會回報帳戶剩餘額度和重置時間；面板會提供供應商帳戶頁連結，不會以對話 token 數推算餘額。xAI 另有以 Management API Key 和 Team ID 查詢預付餘額及月支出上限的管理 API；AI Office 尚未接入這組憑證。若要查看 Claude 組織層級的歷史使用量，Anthropic 的 Usage and Cost API 需 Admin API credentials，這和 Claude Code 訂閱額度不同。

這些數值由供應商即時回報，只有按下重新整理時的快照；面板不會預測用量或重置後的額度。

## 私人存取

目前 Compose 範本只在 loopback 提供服務，沒有反向代理、使用者登入或遠端存取控制。不要把容器直接映射到公網或接上未受保護的 tunnel。若要遠端私人使用，需先另行部署具備 TLS、身分驗證與網路存取限制的閘道。

Hermes、Grok、Claude、Codex 的權限與計費方式不同；Codex CLI 歷史匯入是唯讀，Hermes 群組則使用單一協作窗口回覆，並不代表多個 bot 已各自執行任務。
