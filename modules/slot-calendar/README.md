# Slot Calendar｜把選定會議匯出成行事曆

排班服務找到四個候選，協調者選了台北 21:30 的交班會議。這個 Python CLI 讀取 Overlap Hours 的 JSON，依指定起點選出一場，產生可以交付的 iCalendar 檔案。範例包含會議時間、標題，以及能全程出席的三位同事與各自看到的當地時間。[行事曆範例](examples/handoff.ics) · [四個候選時段的原始資料](examples/handoff-result.json)

## 跑一次匯出

只需要 Python 3.12 以上。從專案根目錄執行這條命令，產物是目前目錄的 `handoff.ics`。

```sh
python slot_calendar.py examples/handoff-result.json --start 2024-11-04T13:30Z --title "跨站交班會議" --uid handoff-20241104@example.invalid -o handoff.ics
```

| 2024 年 11 月 4 日 | 開始 | 結束 |
| --- | --- | --- |
| UTC | 13:30 | 14:15 |
| 台北 design | 21:30（+08:00） | 22:15（+08:00） |
| 紐約 engineering、support-west | 08:30（−05:00） | 09:15（−05:00） |

`--start` 也可以填 `2024-11-04T21:30+08:00`。工具按同一個絕對時間比對，因此候選排序改變也能選到原本那場。指定的起點須在這份回應中恰好出現一次。若上游用 `limit` 截短結果，請先取得包含目標時段的回應。

## 匯出的內容與改期

檔案含一個 VEVENT，起訖寫成 UTC。說明欄列出該候選的出席者 ID、時區與帶偏移的當地起訖，以便收件人核對。排班 ID 只作為說明文字；工具的輸出是本機檔案，分享與匯入由使用者操作。匯出前會核對每位出席者的當地起訖是否對應同一組 UTC 時間。

替同一場會議改期時，保留原本的 `--uid`，選擇新的起點並將 `--revision` 遞增。版本寫入 `SEQUENCE`，預設為 0。請使用自己產生的全域唯一識別碼，範例採用保留網域。實際匯入既有活動的更新方式依行事曆軟體而定。

文字欄位處理換行、反斜線、逗號及分號。輸出以 CRLF 分行，每行最多 75 個 UTF-8 位元組，續行的空格也計入上限，因此中文和 emoji 可完整重組。若選擇衝突或資料不一致，會回報錯誤並保留原有輸出。[RFC 5545 內容行](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) · [匯出實作](slot_calendar.py)

## 重現互通測試

測試另需 .NET 10 SDK、Node.js 24 與 npm。從 `modules/slot-calendar` 執行。

```sh
dotnet build ../../src -c Release
npm ci
npm test
```

測試會在隨機本機埠啟動固定版本的排班 API，取得真實 HTTP 回應，再以獨立的 JavaScript 解析器 ical.js 讀回 Python 產生的檔案。五項測試涵蓋雙城交班、可下載範例、紐約秋季兩個 01:00、中文折行與標點還原，以及錯誤時保留原檔。[整合測試](test_calendar.js) · [上游排班服務](https://github.com/peca12968/overlap-hours/tree/461fa101230d3b4c6f2a2043cdf10d86b94da780) · [CI](../../.github/workflows/system.yml)

**履歷用語**　以 Python 將跨時區排班 API 串接至 iCalendar，保留會議識別碼、改期版本及出席者當地時間，以跨語言整合測試驗證夏令時間回撥與 UTF-8 文字互通。

本專案使用 AI 輔助開發，出席名單與會議資料皆為合成範例。
