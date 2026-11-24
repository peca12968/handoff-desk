# Margin Anchor｜文件改版後，找回留言圈選的文字

審閱者在交班手冊的晚班段落圈選「核對箱數」，留言詢問封箱前由誰核對。新版增加標題，還把晚班移到早班之前。兩段都有「核對箱數」，舊座標也已改變。Margin Anchor 儲存選取的文字及前後文，再於新版中尋找留言對應的位置。[舊版](examples/before.txt) · [新版](examples/after.txt)

## 重現交班案例

在專案目錄使用 Node.js 24 或更新版本執行，無須安裝第三方套件。

```sh
node cli.mjs capture examples/before.txt 18 22 night-review.json
node cli.mjs resolve examples/after.txt night-review.json
node --test
```

第一條指令會建立一份文字選取紀錄。第二條指令找出新版中兩處相同的引文。晚班段落前面連續吻合 6 個字素，後面也吻合 6 個，得到唯一最高分。輸出包含 `status: "attached"`、`occurrences: 2`，以及新版中的半開區間 **[13, 17)**。要用同一份紀錄核對其他版本，將第二條指令的文字檔路徑換掉即可。

| 新版中的引文 | 結果 | CLI 退出碼 |
| --- | --- | --- |
| 一處吻合，或多處中有唯一最高分 | `attached`，回傳該區間 | 0 |
| 最高分並列 | `ambiguous`，列出每個並列區間供人工選擇 | 1 |
| 引文被刪除或改寫 | 若找不到相同引文，回傳 `missing` 與空清單 | 1 |
| 檔案格式有誤、選取切開字素或輸出檔已存在 | 印出錯誤訊息 | 2 |

## 比對與座標

- 輸入為 UTF-8 純文字，CLI 讀取時略過開頭的 BOM。座標使用 JavaScript 字串的 UTF-16 索引，起點含、終點不含，可直接交給 `text.slice(start, end)`。選取兩端都需落在完整字素的邊界，例如「👩🏽‍💻」要整個選取。
- `capture` 保留原文，並擷取兩側各最多 32 個字素。欄位沿用 `TextQuoteSelector` 的 `exact`、`prefix` 和 `suffix`。上下文計分及並列處理是本工具的定位策略。[W3C Text Quote Selector](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- `resolve` 先以字素為單位做 NFC 正規化，並將 CRLF 和 LF 視為同一個換行。搜尋採用 KMP，可保留重疊出現的引文。每處出現都從引文兩端向外計算連續相同的字素數，相加作為分數。回傳區間對應新版原始字串，即使正規化前後的長度不同仍可取回原文。
- 唯一出現的引文即使前後文全變，也會回傳該處。因此若原段落被刪除、另一段恰好保有相同引文，結果仍需審閱者確認。報告保留兩側的吻合數，方便檢視這種情形。

## 驗證

測試透過 CLI 實際保存並重新載入選取紀錄，涵蓋段落交換、引文消失、並列、既有檔案保護與無效 UTF-8。另用枚舉所有起點的獨立方法，核對 **3,810 組**短文件與引文的出現次數、最高分區間及結果狀態。Unicode 案例另外核對組合重音、emoji 和換行轉換後的原文座標。[核心實作](anchor.mjs) · [測試](anchor.test.mjs)

本作品使用 AI 輔助開發，交班手冊為合成範例。
