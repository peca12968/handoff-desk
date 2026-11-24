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

### 必要成員與支援人數

台北設計與紐約工程兩位都要參加 45 分鐘的交班會議，另外需要兩位支援同事中的至少一位全程參加。支援東班在 UTC 13:30 下班，西班同時開始上班。雖然 13:00 到 13:45 每分鐘都有人值班，這段無法讓同一位支援同事從頭參加到尾。

將前面 POST 指令的輸入檔換成 [support-handoff.json](examples/support-handoff.json)。以 15 分鐘為步長，會得到 4 個可行起點：UTC 13:30、13:45、14:00、14:15。最早一場在台北是 21:30–22:15，在紐約是 08:30–09:15，由支援西班參加。若只需要最早一場，設 `limit: 1` 即可；`totalSlots` 仍為 4。

```json
{"attendance":{"optionalIds":["support-east","support-west"],"minimumOptional":1}}
```

- 未列在 `optionalIds` 的人均須全程有空。選填名單中的每一人也須全程有空才可計入 `minimumOptional`。每個候選的 `local` 依輸入順序列出所有能全程出席的人與他們的當地時間。
- 門檻可為 0，若所有人都列為選填，門檻至少為 1。名單須使用請求裡的唯一參與者 ID。省略 `attendance` 時延用全員出席規則。

### 指定日期的休假與臨時班表

參與者可選填 `overrides`。每一筆以該人的當地日期取代當天整份週期班表。例如，台北同事在 11 月 4 日只開放 22:00–22:30：

```json
{"overrides":[{"date":"2024-11-04","working":[{"start":"22:00","end":"22:30"}]}]}
```

將相同指令的輸入檔換成 [special-hours.json](examples/special-hours.json)，原本兩個候選會剩一個：台北 22:00、紐約 09:00。將這一天的 `working` 改為空陣列即可展示整日休假，候選數降為零。

例外以當地午夜為界。當天休假也會遮蔽前一晚夜班延續到當日的部分；下一個日期依自己的例外或週期班表判定。臨時跨午夜時段可拆成兩筆日期，前一日以 `24:00` 作結。同一日的多個工作區間取聯集，忙碌行程照常扣除。夏令時間回撥時，當日開放的 01:00 可能出現兩次；可用帶偏移的 busy 區間單獨排除其中一次。

每人最多 366 筆日期例外，每日最多 50 個時段。重複日期、無效日曆日期或缺少工作時段陣列，都會收到 HTTP 400。省略 overrides 的既有請求沿用每週班表。

### 按出席與偏好排序

把 [preferred-hours.json](examples/preferred-hours.json) 送到同一個端點。台北同事偏好當地 22:00–23:00，紐約同事偏好 09:00–10:00。兩種排序都找到 4 個可行時段。「最早先列」第一場是 UTC 13:30，有 60 人分鐘落在偏好外。「依偏好排序」第一場改為 UTC 14:00，三人都能全程出席，偏好外分鐘為 0。[兩種排序的實際回應](examples/preferred-hours-result.json)

- 指定 `rankBy: "preferred"` 後，先按全程出席人數排名，再優先選擇單一出席者的偏好外分鐘上限較低、全體偏好外分鐘總和較低的時段。各項相同時以 UTC 起點排序。`limit` 在排序後套用，`totalSlots` 仍計入所有符合出席門檻的時段。
- `preferred` 與 `working` 使用相同的每週當地時間格式，每人最多 50 條。省略或傳入 `null` 表示沒有偏好限制，空陣列表示沒有偏好時段。每日例外與忙碌期間仍決定實際可出席範圍。
- 回應的 `preference.maximumOutsideMinutes` 與 `totalOutsideMinutes` 以實際經過分鐘計算，夏令時間回撥的兩個當地 01:30 各有自己的 UTC 偏移。省略 `rankBy` 或使用 `earliest` 時，回應沿用原有欄位與 UTC 起點排序。

可將排名後的回應交給同庫的 Slot Calendar，依起點匯出 iCalendar。整合測試選取第一名時段，驗證產物的 UTC 起訖與兩地當地時間。[匯出整合測試](modules/slot-calendar/test_calendar.js)

### 搜尋區間與回應

- `POST /availability/search` 接收 JSON。搜尋範圍與忙碌區間都使用帶 Z 或數字偏移的時間，精確到整分鐘。所有區間含起點、排除終點，所以前一場結束的瞬間就能開始下一場。
- `working` 使用每位參與者的當地時間。星期一至星期日以 1 至 7 表示。若班表寫 23:30–01:00，`days` 指開始上班的那一天。00:00–24:00 表示全天。多條工作規則取聯集，可用空陣列表示無可用時段。
- `durationMinutes` 是實際經過時間。`stepMinutes` 從請求的搜尋起點開始對齊。兩者範圍為 1 至 1440 分鐘。每次最多 14 天及 32 位參與者；每人最多 50 條工作規則與 500 筆忙碌區間。
- 預設回傳依 UTC 起點排序，最多列出 20 筆，可用 `limit` 調到 1 至 100。即使截短清單，`totalSlots` 仍包含全部候選。沒有重疊時回傳 HTTP 200 與空清單；無效時區、日期、步長或重複參與者會回傳 HTTP 400。

## 夏令時間的設計取捨

[排程核心](src/Planner.cs)把每週工作規則展開成當地星期與分鐘的查找表，再沿 UTC 時軸為每個人累計連續可用分鐘。忙碌事件用起訖差分累計，因此重疊事件不會提前解除忙碌狀態。對每個符合步長的起點，以 32 位元遮罩記錄哪些人能參加整場，最後核對必要成員與選填人數。工作量受搜尋範圍與參與人數限制，適合短期小組排程。

在紐約 2024 年春季調快時鐘的測試中，一場實際 60 分鐘的會議從當地 01:30（−05:00）到 03:30（−04:00）。秋季回撥時，兩個顯示為 01:00 的起點均有各自的 UTC 偏移；指定其中一次的忙碌行程仍保留另一次。服務使用主機安裝的時區規則。

## 驗證

完成 Release 建置後執行 `python -m unittest -v`（Python 3.12）。[整合測試](test_api.py)會在隨機本機埠啟動實際 API，驗證台北與紐約、夏令時間兩個方向、尼泊爾 45 分鐘偏移、週日夜班跨週、重疊行程、回傳筆數上限與輸入錯誤。另外用 12 組固定種子的班表逐筆比對獨立的區間相交算法。[GitHub Actions](../../.github/workflows/system.yml)在 Linux 與 Windows 建置及測試相同程式。

出席門檻另用 64 組合成班表獨立逐人檢查忙碌區間，核對候選總數、回傳起點及每場出席名單。邊界案例驗證 32 人上限，以及夏令時間回撥當天兩個不同偏移的 01:00。

**履歷用語**　以 ASP.NET Core 實作跨時區會議排程 API，利用連續空檔與位元遮罩篩選必要成員及選填人數，以 HTTP 整合測試驗證完整出席、跨午夜和夏令時間邊界。

本專案為 AI 輔助開發的作品集示範。所有班表皆為合成資料。

[同庫模組與整合測試](modules/README.md)
