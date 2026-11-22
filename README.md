# Handoff Desk｜交班簿

兩個班別在瀏覽器裡編輯同一份交班紀錄。如果有人先儲存，後送出的草稿會留在編輯區，頁面下方會並排顯示編輯時的原稿與伺服器最新版本。接班者可自行整合文字，再決定要儲存哪些內容。範例使用繁體中文介面與真實的 [Handoff Notes API](https://github.com/peca12968/handoff-notes-api/tree/033d91434d169d557d438ddd11c0a87fc5f7c4e5)。

![晚班草稿仍在編輯區，下方並列第 1 版原稿與第 2 版早班修改](docs/review.png)

## 在本機重現

需要 Git、.NET 10 SDK 與 Node.js 24。從同一個父目錄取得這兩個專案，在第一個終端機啟動 API。

```sh
git clone https://github.com/peca12968/handoff-desk.git
git clone https://github.com/peca12968/handoff-notes-api.git
git -C handoff-notes-api checkout 033d91434d169d557d438ddd11c0a87fc5f7c4e5
cd handoff-notes-api
dotnet restore src --locked-mode
dotnet build src -c Release --no-restore
dotnet src/bin/Release/net10.0/HandoffNotes.dll --urls http://127.0.0.1:5087
```

在第二個終端機從同一父目錄啟動前端。

```sh
cd handoff-desk
npm ci
npm run dev
```

開啟 `http://127.0.0.1:4177`，依序操作。

1. 輸入「冷藏庫溫度已記錄」，按「建立紀錄」，再按「在新分頁開啟」。
2. 在第一個分頁追加「早班已換感測器」並儲存。在第二個分頁追加「晚班待複查」並儲存。第二個分頁會出現版本對照。
3. 保留晚班文字，把早班的更新加入編輯區，按「儲存合併結果」。重新整理第一個分頁，即可看到雙方修改。

## 版本與草稿

每次讀取都保存當時的內容、版號與 ETag。編輯器儲存時用 `If-Match` 帶回使用者看過的版本。收到 HTTP 412 後會取得最新內容並保留本頁草稿。使用者按下合併按鈕時，編輯器會帶上對照欄的 ETag。若第三筆修改搶先寫入，頁面會重新開啟對照，剛才整合的文字仍在編輯區。[編輯流程](ui/desk.js)

此示範透過綁定本機的 Vite 代理連線至 SQLite API，信任同一台電腦上的使用者。草稿保存在目前分頁，成功儲存後才會寫入資料庫。關閉含修改的分頁時，編輯器會向瀏覽器申請離開提示。

## 用鍵盤完成一次衝突合併

在較早開啟的分頁修改草稿，以 Tab 移到「儲存修改」並按 Enter。若另一班已寫入新版，焦點會落在「版本對照」標題。閱讀兩版內容後，按 Tab 到「返回草稿編輯」，再按 Enter 即可繼續編輯。合併成功時焦點回到編輯區。若送出時斷線，焦點回到儲存按鈕，恢復連線後可直接按 Enter 重試。

測試先讓早班存入第 2 版，再以晚班的舊草稿觸發 HTTP 412。它使用作品集內的 Focus Receipt 比對八次按鍵後的焦點，最後從 SQLite 歷史 API 讀回第 3 版，核對兩班文字都已保存。另一個測試延後伺服器回應，確認等待期間已移到其他連結的焦點會留在原處。[鍵盤整合測試](tests/desk.spec.js) · [Focus Receipt 固定版本](https://github.com/peca12968/focus-receipt/tree/e339536fcfaba6cd909cd43234a3ebd723e23eb8)

## 自動化驗證

保留已建置的 API，先結束上述兩個示範服務，再在前端目錄執行以下指令。Playwright 會啟動獨立 API 與前端預覽，每次執行使用新的本機測試資料庫。

```sh
npm run build
npx playwright install chromium firefox
npm test
```

七個案例分別在 Chromium 與 Firefox 執行，涵蓋鍵盤合併、連續兩次編輯衝突、360 像素寬度與 UTF-8 大小邊界、斷線儲存與重新讀取、等待期間的焦點及錯誤連結。連續衝突測試先後由兩頁寫入，最後從歷史 API 驗證全部四版原文。GitHub Actions 在 Ubuntu 使用固定提交的後端重跑相同測試。[測試](tests/desk.spec.js) · [CI](.github/workflows/ci.yml)

**履歷用語**　以 JavaScript、HTTP ETag 與 Playwright 實作交班編輯器，保留衝突草稿並提供版本對照，透過兩個瀏覽器分頁與 SQLite 整合測試驗證連續衝突後的四版歷史。

本專案使用 AI 輔助開發。交班內容使用合成範例。
