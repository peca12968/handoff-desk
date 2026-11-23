# Focus Receipt｜用鍵盤重播找出焦點中斷的位置

用鍵盤封存一份文件後，下一次操作會從哪裡開始？這個 Node.js CLI 讀取一份按鍵流程，在 Chromium 或 Firefox 裡逐步操作，再按「角色＋可存取名稱」核對焦點。若某一步失敗，JSON 報告會列出按鍵、預期目標、符合目標的元素數量，以及當時取得焦點的元素。

## 重現封存後的焦點問題

需要 Node.js 22 以上。從專案目錄安裝依賴與測試用瀏覽器。

```sh
npm ci
npx playwright install chromium firefox
node cli.mjs examples/archive-flow.json "inbox.html#regression"
node cli.mjs examples/archive-flow.json
```

第三行啟用範例中的回歸情境，預期退出碼為 1。第四行使用修正版，預期退出碼為 0。也可用瀏覽器直接開啟 HTML，手動按相同順序體驗。[按鍵與焦點清單](examples/archive-flow.json) · [文件封存範例](examples/inbox.html)

| 時機 | 按鍵 | 預期焦點 |
| --- | --- | --- |
| 開啟第一份文件的封存對話框 | Tab、Enter | 取消 |
| 由第一個按鈕反向移動，再由最後一個按鈕正向移動 | Shift+Tab、Tab | 確認封存，再回到取消 |
| 關閉後重新開啟對話框 | Escape、Enter | 先回到原先的「封存 盤點清單」，再回到取消 |
| 確認封存第一份文件 | Tab、Enter | 下一份文件的「封存 到貨紀錄」 |
| 封存最後一份文件 | Enter、Tab、Enter | 「待封存文件」標題 |

第 8 步最容易在只測資料異動的測試裡漏掉。原本的按鈕隨著文件移除，未移交焦點時，回報會顯示 `reason: "wrong-focus"`、`matches: 1` 與 `active.tag: "body"`。修正版在移除前先找到下一筆，清單變空時則將焦點移到可程式化聚焦的標題。這個決定依循對話框關閉時讓使用者接續操作的設計原則。[W3C 對話框鍵盤操作指引](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

## 在自己的頁面使用

### 同名按鈕分別位在兩層嵌入表單

執行 `node cli.mjs examples/embedded-flow.json`。從訂單頁按 Tab 進入配送地址，再進入內嵌的收件人表單。兩個表單各有一個名為「確認」的按鈕。七步鍵盤流程驗證正向及反向順序，報告列出實際元素 ID 以及由外到內的 iframe 標題。收件人按鈕包在開放的 Shadow DOM 內。

指定 `"frames":["配送資料","收件人"]` 表示沿兩個 iframe 的精確 title 尋找角色與可存取名稱。省略此欄位時從頁面本身搜尋。若途中找不到框架或同層有多個符合的框架，報告會指出哪個標題失敗及符合數量。

測試用兩個不同的本機 HTTP 來源重播相同流程。刻意略過收件人表單時，第三步仍然落在一個叫「確認」的按鈕，但報告顯示實際焦點在配送層的 `delivery-save`。另一個案例把焦點從內層移出後再次檢查原按鈕，會得到 `wrong-focus`。[流程檔](examples/embedded-flow.json) · [跨來源測試](embedded.test.mjs)

### 流程檔格式

流程 JSON 的 `page` 可填相對於該 JSON 的頁面位置，或測試環境的完整 URL。每步包含 `key`、`role`、`name`。例如 `{"key":"Tab","role":"button","name":"儲存草稿"}` 會從瀏覽器當下的焦點送出 Tab，再以完整可存取名稱尋找唯一的按鈕。第二個命令列參數可覆寫頁面位置，同一份流程即可驗證前後兩個版本。

支援 Tab、Shift+Tab、Enter、Escape、Space、四向方向鍵、Home、End。每個步驟最多等待兩秒讓介面更新，遇到第一個不符預期的步驟就停止。退出碼 0 表示所有焦點檢查通過，1 表示檢查失敗，2 表示流程檔、頁面載入或執行環境出錯。報告驗證指定旅程中的焦點移動。螢幕閱讀器朗讀內容、視覺對比及其他操作路徑需另行測試。[檢查邏輯](focus.mjs)

```sh
npm test
```

預設使用 Chromium。以 PowerShell 切換 Firefox 可執行 `$env:FOCUS_BROWSER='firefox'` 再跑同一命令，Bash 可用 `FOCUS_BROWSER=firefox npm test`。測試涵蓋實際 CLI 退出碼、找不到目標、同名按鈕、延遲更新與開放式 Shadow DOM 內的焦點。CI 會在兩個瀏覽器分別執行相同測試與示範。[整合測試](focus.test.mjs) · [CI 設定](.github/workflows/test.yml)

本作品使用 AI 輔助開發，範例文件均為合成資料。
