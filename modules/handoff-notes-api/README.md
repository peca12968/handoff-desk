# Handoff Notes｜多人交班紀錄 API

早班和值晚班的同事同時開啟同一份交班紀錄。早班先存檔，晚班手上的舊稿還能直接覆寫嗎？這個 ASP.NET Core API 讓用戶端在更新時附上讀取當時的 ETag。版本已變動時，晚班可以取回原稿與最新內容，決定如何合併。

## 跑一次兩人交班

需要 .NET 10 SDK 與 Python 3.11 以上。於專案根目錄啟動服務。

```sh
dotnet restore src --locked-mode
dotnet build src -c Release --no-restore
dotnet src/bin/Release/net10.0/HandoffNotes.dll --urls http://127.0.0.1:5080
```

另開終端機執行 `python demo.py`。每次展示都建立一份新紀錄，內容以 UTF-8 純文字傳送。預設資料庫為目前目錄的 `handoff.db`，可用環境變數 `HANDOFF_DB` 指定位置。[可重現的 HTTP 用戶端](demo.py)

| 動作 | HTTP | 已儲存版本 |
| --- | ---: | --- |
| 建立紀錄，兩位同事各自讀取 | 201、200、200 | 第 1 版 |
| 早班補上「早班已核對庫存。」並存檔 | 204 | 第 2 版 |
| 晚班拿第 1 版的 ETag 送出修改 | 412 | 第 2 版 |
| 晚班取回最新內容，保留早班的文字，再加上出貨提醒 | 204 | 第 3 版 |

## HTTP 介面

- `POST /notes` 建立紀錄，從 `Location` 取得網址。建立及更新均接受 1 至 16,384 位元組的 UTF-8 `text/plain`。
- `GET /notes/{id}` 回傳原始位元組、強 ETag 與 `Handoff-Revision`。帶入相符的 `If-None-Match` 會得到 304，適合在編輯前重新確認內容。
- `PUT /notes/{id}` 需要明確的 `If-Match` 版本標籤。缺少條件或僅給萬用字元會得到 428。舊標籤或僅有弱標籤會得到 412。資料與版本皆相同的儲存回傳 204，沿用原版號。
- `GET /notes/{id}/revisions/{version}` 可讀取歷史內容。示範用戶端根據已知的兩段獨立增補來合併。一般編輯器可顯示原稿、自己的修改與最新版本，交由使用者決定。
- `PATCH /notes/{id}` 接受 `application/json` 及正整數欄位 `restoreRevision`。帶上目前版本的 `If-Match` 即可從指定歷史版本還原原始 UTF-8 位元組。原稿與目前內容不同時會新增一版。內容已相同時，沿用目前版號及標籤。

例如在第 2 版發現出貨提醒有誤，可以帶上第 2 版 ETag 送出 `{"restoreRevision":1}`。成功會收到 204、第 3 版及全新的 ETag，第 2 版仍可查閱。若另一位同事已存檔而使標籤過期，還原會收到 412。在兩個服務程序的演練中，還原與新編輯同時使用第 2 版標籤，只有一筆能產生第 3 版。[還原與並行驗證](test_api.py)

ETag 是不透明字串，客戶端應原樣保留引號。讀取的快取驗證採弱比較，修改的先決條件採強比較。[HTTP 條件式請求](https://www.rfc-editor.org/rfc/rfc9110.html#section-13) · [HTTP 428](https://www.rfc-editor.org/rfc/rfc6585.html#section-3)

## 如何防止覆寫

更新交易先取得 SQLite 寫入鎖，再讀取最新版本、核對標籤及新增歷史列。兩個服務程序共用同一個本機資料庫時，完成第一筆交易後，第二筆才會核對版本。每份新版本都保存自己的 ETag。即使內容後來改回相同文字，中間版本的存在仍可辨認。[儲存實作](src/NoteStore.cs)

Release 建置後執行 `python -m unittest -v`。並行案例讓 12 個 HTTP 用戶端帶同一個 ETag，同時向兩個服務程序送出不同內容，逐筆驗證 1 個成功、11 個收到 412，並讀回勝出的文字。其他測試涵蓋程序重啟、歷史原文、條件標頭與 UTF-8 位元組上限。[端對端測試](test_api.py)

這個作品使用單機 SQLite，服務預設在示範指令中綁定 loopback。適用情境為可信任的本機編輯者，歷史紀錄保留在同一份資料庫內。

**履歷用語**　以 ASP.NET Core、SQLite 交易與 HTTP ETag 實作多人編輯衝突偵測，並以兩個服務程序的並行寫入驗證歷史版本與資料一致性。

本專案使用 AI 輔助開發，交班文字均為合成資料。
