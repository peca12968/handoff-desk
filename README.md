# Overlap Hours｜跨時區會議時段搜尋 API

台北與紐約的同事各自填寫當地工作時間，如何找出雙方都能出席的半小時？這個 ASP.NET Core API 在固定 UTC 搜尋範圍內求出共同可用時段，逐一列出每位參與者看到的當地起訖時間與 UTC 偏移。使用 C#、.NET 10 內建時區資料與分鐘精度運算。

## 三分鐘展示

在專案根目錄建置並啟動本機服務：

```sh
dotnet build src -c Release
dotnet src/bin/Release/net10.0/overlap-hours.dll --urls http://127.0.0.1:5087
```

另開終端機，將[兩地班表範例](examples/taipei-new-york.json)送入 API。PowerShell 可使用：

```powershell
$r = Invoke-RestMethod http://127.0.0.1:5087/availability/search -Method Post -ContentType application/json -InFile examples/taipei-new-york.json
$r.slots | ConvertTo-Json -Depth 5
```

Bash 可使用：

```sh
curl -sS -H 'Content-Type: application/json' --data-binary @examples/taipei-new-york.json http://127.0.0.1:5087/availability/search
```

2024 年 11 月 4 日的示範班表有兩小時重疊。扣除兩段各 30 分鐘的忙碌行程後，30 分鐘會議只剩下列兩個候選。回應中的 `totalSlots` 為 2。

| UTC | 台北 design | 紐約 engineering |
| --- | --- | --- |
| 13:00–13:30 | 21:00–21:30（+08:00） | 08:00–08:30（−05:00） |
| 14:00–14:30 | 22:00–22:30（+08:00） | 09:00–09:30（−05:00） |

## 請求規則

- `POST /availability/search` 接收 JSON。搜尋範圍與忙碌區間都使用帶 Z 或數字偏移的時間，精確到整分鐘。所有區間含起點、排除終點，所以前一場結束的瞬間就能開始下一場。
- `working` 使用每位參與者的當地時間。星期一至星期日以 1 至 7 表示。若班表寫 23:30–01:00，`days` 指開始上班的那一天。00:00–24:00 表示全天。多條工作規則取聯集，可用空陣列表示無可用時段。
- `durationMinutes` 是實際經過時間。`stepMinutes` 從請求的搜尋起點開始對齊。兩者範圍為 1 至 1440 分鐘。每次最多 14 天及 32 位參與者；每人最多 50 條工作規則與 500 筆忙碌區間。
- 回傳依 UTC 起點排序，預設最多列出 20 筆，可用 `limit` 調到 1 至 100。即使截短清單，`totalSlots` 仍包含全部候選。沒有重疊時回傳 HTTP 200 與空清單；無效時區、日期、步長或重複參與者會回傳 HTTP 400。

## 夏令時間的設計取捨

[排程核心](src/Planner.cs)把每週工作規則展開成當地星期與分鐘的查找表，再沿 UTC 時軸逐分鐘檢查所有人的班表。忙碌事件用起訖差分累計，因此重疊事件不會提前解除忙碌狀態。最後掃描連續可用分鐘，依步長產生候選。工作量受搜尋範圍與參與人數限制，適合短期小組排程。

在紐約 2024 年春季調快時鐘的測試中，一場實際 60 分鐘的會議從當地 01:30（−05:00）到 03:30（−04:00）。秋季回撥時，兩個顯示為 01:00 的起點均有各自的 UTC 偏移；指定其中一次的忙碌行程仍保留另一次。服務使用主機安裝的時區規則。

## 驗證

完成 Release 建置後執行 `python -m unittest -v`（Python 3.12）。[整合測試](test_api.py)會在隨機本機埠啟動實際 API，驗證台北與紐約、夏令時間兩個方向、尼泊爾 45 分鐘偏移、週日夜班跨週、重疊行程、回傳筆數上限與輸入錯誤。另外用 12 組固定種子的班表逐筆比對獨立的區間相交算法。[GitHub Actions](.github/workflows/ci.yml)在 Linux 與 Windows 建置及測試相同程式。

**履歷用語**　以 ASP.NET Core 實作跨時區會議排程 API，整合週期班表與忙碌區間，透過真實 HTTP 測試驗證夏令時間、跨午夜及重疊行程的候選結果。

本專案為 AI 輔助開發的作品集示範。所有班表皆為合成資料。
