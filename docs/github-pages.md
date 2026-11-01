# GitHub Pages 公開 Demo

本 repository 附有 `.github/workflows/deploy-pages.yml`。它會把 Vite 前端建置成 GitHub Pages 可發布的靜態網站；建置時設定 `VITE_PUBLIC_DEMO=true`，所以網站不會讀取整合 API、恢復已儲存的來源路由或顯示連線設定。對話使用模擬回覆。

## 啟用部署

1. 將 repository 推送到 GitHub，並使用 `main` 作為預設分支。
2. 在 GitHub repository 開啟 **Settings → Pages → Build and deployment → Source**，選擇 **GitHub Actions**。
3. 推送到 `main` 會觸發建置與部署；也可在 **Actions → Publish public demo → Run workflow** 手動啟動。
4. 首次部署完成後，GitHub Actions 的部署摘要會顯示公開網址。

一般 project repository 的網址會在 `https://<帳號>.github.io/<repository>/`，workflow 會用 repository 名稱設定 Vite 的 base path。若改用 `https://<帳號>.github.io/` repository 或自訂網域，請把 workflow 的 `VITE_BASE_PATH` 改成 `/`。

`npm install --no-package-lock` 是刻意用來避開目前尚未同步的 npm lockfile；workflow 安裝完成後以 `npm run build` 產生 `dist/client`，只上傳該靜態目錄，不發布本機整合伺服器或 Site worker。

## 公開安全範圍

- GitHub Pages 網站是公開的；不得加入 `.secrets`、`settings.yaml`、API Key、OAuth 權杖、CLI 登入資料或私有對話。
- 公開版不支援真實 AI 對話。介面不提供來源連接、同步、OAuth、CLI 或匯入按鈕。
- Vite API 整合只用於受你控制的本機開發環境。GitHub Pages 不會替你執行 Hermes、Codex CLI、Claude Code CLI 或整合伺服器。
- 靜態版聊天內容僅存於使用者自己的瀏覽器，不會同步到其他人或其他裝置。

此部署是公開視覺與操作 demo。私人實際使用請依[本機私用與真實連線](local-use.md)在自己的電腦執行。
