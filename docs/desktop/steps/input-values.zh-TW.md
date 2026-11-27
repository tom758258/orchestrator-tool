# 輸入值與資料流

<!-- help-source -->

## 選擇輸入值來源

| 來源 | 用途 | 範例 |
| --- | --- | --- |
| Fixed value | 直接輸入固定值 | 3.3 |
| Variable | 使用工作流程的變數 | voltage |
| Previous step result | 使用較早且可引用的步驟結果 | Measure 量測值 |
| Calculation | 四則運算、比較或取整 | voltage × 2 |
| Elapsed time | 執行期間經過的時間 | 10.5 秒 |
| Timestamp | 執行期間的日期時間 | 2026-10-12T23:24:10.123+08:00 |

Previous step result 提供較早的 Tool Action、BG Get Latest／Wait Next／Get Command Result／Get Buffer Data／Get Buffer Status，以及 String／Byte／Array Process 結果。通常在下拉選單選擇結果名稱即可，特殊欄位才需要自訂 JSON Pointer（資料路徑）。

Calculation 的四則運算與比較使用兩個運算元；Round、Floor、Ceil、Trunc 使用一個。Round 的 0.5 中點遠離零；Trunc 朝零捨去小數。

```text
Measure -> Set Variable: voltage -> Output: voltage
  3.3 V           3.3                   3.3
```

這是資料流示意，並非實際量測結果。

## 資料型態與比較

Set Variable 會建立或更新 variables。Fixed value 支援 Number、String、Boolean、Null。
Boolean 使用 True／False 選項；Null 不需額外輸入。String 的 "true" 與 "null" 是文字，
並非 Boolean 或 Null。Previous step result 只能引用目前 lexical
scope 中較早且可見的 step。Calculation 使用 arithmetic 與 comparison
operators。Assert、While 與 If 提供 `==`、`!=`、`>`、`>=`、`<`、`<=`。
Assert、While 與 If 的 Fixed value 皆可選 Number、String、Boolean、Null。
Equality 不進行型別轉換，字串區分大小寫；arithmetic 與大小比較僅接受數值。
缺少的 Variable 或 Result Path 是錯誤，不是 Null。
Calculation 不是任意 nested expression tree。

## 經過時間及日期時間

Output 的 **Elapsed time** 來源提供 **Time Format**：**Seconds**（預設）、
**Minutes:Seconds**、**Hours:Minutes:Seconds** 與 **Days (Decimal)**。分鐘與小時
可累積超過 60 分鐘與 24 小時；Output Data 的秒數顯示三位小數，十進位天數顯示
九位小數。例如 90061.123 秒可顯示為 1501:01.123、25:01:01.123 或 1.042374109 d。

**Timestamp** Output 的 **Include Date** 與 **Include UTC Offset** 預設勾選，
顯示如 `2026-10-12T23:24:10.123+08:00`。取消任一選項只隱藏對應部分；底層保留
完整 UTC+08:00 日期時間，跨午夜也不會丟失日期。設定屬於各個 Output，Template
儲存／載入及 Step 複製／貼上會保留；切換 Value Source 時清除舊時間設定。
Set Variable 與 Tool Action 的時間來源維持原有行為。

## 將結果加入資料表

只有 Output step 會建立 ResultRow column；Input value 被引用本身不會使它成為
result column。

Get Buffer Data、Get Buffer Status 與 Array Process 的結果也可選為 Previous step result。
Step 回傳的 Array 可存為 Variable，再由 Array Process 動態 Index 取得元素；不提供手動 Fixed Value Array 編輯器。
