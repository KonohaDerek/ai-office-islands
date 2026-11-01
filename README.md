# AI Office — 島嶼辦公室

React + Vite 的互動原型，支援本機接上 Hermes Agent API 與 Grok／OpenAI 相容 API。

## 功能

- 左側保留使用者截圖中的四個部門、八個群組與 bot 導覽。
- 島上 bot 可漫步；部門區域、群組建築、可拖曳木牌、辦公室切換與建立都可互動。
- 每個部門木牌可切換四款子島初始景觀；選擇依辦公室與部門分開保存。
- 點選 bot 或群組開啟對話遮罩，關閉後回到同一個島嶼畫面。
- 在「連接來源」設定 Hermes 或 Grok API，測試連線、讀取模型、指定目前辦公室的聊天來源。
- 可選擇匯入目前 Hermes profile 回報的 Agent 與工作階段；工作階段訊息會載入島上對話，後續訊息沿用原 Hermes session。
- 選定來源後，bot 私聊會帶入角色描述；群組對話會以該群組的協作窗口回覆。
- 尚未選定 AI 來源時，對話會明確顯示為本機示範，不會假裝已呼叫外部模型。

## 接入方式與範圍

此原型的連線代理只在 Vite 開發伺服器運作。請用 npm run dev -- --host 127.0.0.1 --port 4173 開啟，並在「連接來源」輸入 API 網址和金鑰。Hermes 預設網址為 http://127.0.0.1:8642/v1，需先在 Hermes 啟用 OpenAI-compatible API Server，設定 API_SERVER_ENABLED=true 與 API_SERVER_KEY，並啟動 hermes gateway。Grok 預設使用 https://api.x.ai/v1；也能輸入其他 OpenAI 相容服務網址。

API 金鑰只送到僅監聽本機的 Vite 後端，不會進入 localStorage 或前端 bundle。連線成功後，後端使用 AES-256-GCM 將來源網址、模型與金鑰加密寫入專案根目錄的 `settings.yaml`；解密金鑰存在目前使用者的 macOS Keychain，採用 Keychain 預設的應用程式存取控制且不要求同步。設定檔權限限制為目前使用者。Vite 重啟後會自動解密並重測連線；若 Keychain 無法使用，介面會標示該連線只在本次伺服器執行期間有效。`settings.yaml` 已加入忽略清單，不會隨專案提交。部署成靜態網站時不會提供這個代理。

## 公開展示 Demo（GitHub Pages）

**GitHub Pages 版只供公開互動展示，不支援真實 AI 連接。** 島嶼、角色、群組、建築與對話視窗可以操作；送出的訊息只會產生示範回覆並保存在目前瀏覽器，不會送到 Hermes、Grok、Claude、Codex 或其他模型。公開版不提供 API Key、OAuth、CLI 登入或匯入本機對話功能，也不會讀取你電腦上的資料。

公開展示的[實際操作影片](docs/media/ai-office-demo.m4v)使用本機模擬模式錄製；影片中的對話是示範回覆，不是真實 AI 連線。

GitHub Pages 是靜態網站託管，無法執行本專案的本機整合服務。請勿把 API 金鑰、OAuth 權杖、Hermes profile 或私人對話放進公開 repository。真實連線請在自己控制的電腦上使用本機 Vite 或 Docker Compose；不要把這個原型的本機整合服務直接公開到網際網路。部署設定與 demo 操作請看 [`docs/github-pages.md`](docs/github-pages.md)、[`docs/demo.md`](docs/demo.md) 及 [`docs/local-use.md`](docs/local-use.md)。

### Docker Compose

Docker 版本用專屬的加密金鑰保存 API 設定，並以 named volumes 保存容器內的 Claude Code 與 Codex CLI 登入狀態。首次啟動前，在專案根目錄產生本機金鑰，再建置並啟動：

~~~sh
mkdir -p .secrets
chmod 700 .secrets
{ printf 'AI_OFFICE_ENCRYPTION_KEY='; openssl rand -hex 32; } > .secrets/ai-office.env
chmod 600 .secrets/ai-office.env
docker compose -f docker-compose.yaml up --build -d
~~~

開啟 http://127.0.0.1:4173。首次使用 CLI OAuth 時，在終端機執行：

~~~sh
docker compose -f docker-compose.yaml exec ai-office claude auth login --claudeai
docker compose -f docker-compose.yaml exec ai-office codex login --device-auth
~~~

Claude Code 與 Codex CLI 的登入資料分別保存在 `claude-cli-home`、`codex-cli-home` volumes。macOS 的 Claude 登入憑證在 Keychain，不能靠掛載 `~/.claude` 直接交給 Linux 容器；上述流程是在容器中完成獨立登入。Codex CLI 登入也使用容器內的獨立資料。Compose 只讀掛載主機 `~/.codex/sessions` 與 `~/.codex/agents`，供匯入歷史對話、子代理與角色設定，不會掛載主機的 Codex OAuth 憑證。若路徑不同，可用 `CODEX_SESSIONS_DIR`、`CODEX_AGENTS_DIR` 環境變數指定。

Hermes 預設透過 `host.docker.internal:8642` 連到主機上的 Hermes API Server。API 金鑰以 AES-256-GCM 加密後存進 `office-settings` volume；解密金鑰保存在本機 `.secrets/ai-office.env`，已由 Git 與 Docker build context 排除。`.secrets` 目錄設為 `700`，金鑰檔設為 `600`。Compose 會將金鑰注入容器環境；請限制本機 Docker daemon 的管理權限，並備份金鑰，遺失後既有加密設定將無法解密。停止服務使用 `docker compose -f docker-compose.yaml down`；要一併刪除 CLI 登入與設定資料才使用 `down -v`。

xAI API 提供模型對話，不等於 Grok 網頁裡的自訂 bot、群組和歷史紀錄 API。Hermes 匯入只讀取目前連線 API Server profile 公開的 Agent 與工作階段，不會自動發現其他 profile，也不會匯入 Grok 私有網頁 bot。這版能讓島上角色／群組使用真實 AI 回覆，但同一個群組回覆是單一協作窗口，不代表多個 bot 已各自建立、執行與互相傳訊。自動建立多代理分工需要後續增加調度器與可讀取群組資料的來源介面。

其他辦公室、分組、角色頭像與對話會保存在目前瀏覽器來源的 localStorage／IndexedDB。原型角色和群組成員配置以示範資料為主。

## 開發

使用 Node 22+，安裝相依套件後啟動開發伺服器：

~~~sh
npm install
npm run dev -- --host 127.0.0.1 --port 4173
npm run build
~~~

主要介面在 src/；本機連線代理在 server/integrations.mjs。部署到 Sites 前需再將代理移至具備安全秘密儲存的受信任後端。

完整 demo 說明、GitHub Pages 部署方式、本機私用連線流程與對話 Demo 影片／腳本見 [`docs/`](docs/README.md)。

## License

This repository's original source code, documentation, demo media, and generated art are licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.
