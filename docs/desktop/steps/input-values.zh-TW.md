# 輸入值與資料流

<!-- help-source -->

### 6.1 Input values 與 data flow

Editor 目前的 InputValue 選項是：

- **Fixed value** — literal value。
- **Variable** — Workflow variable 的目前值。
- **Previous step result** — 較早且可見的 step result。目前 UI 會提供先前
  Tool Actions、BG Get Latest／Wait Next／Get Command Result，以及 String Process／Byte Process 的 results。
- **Calculation** — 四則運算／比較使用左右兩個 operand；Round、Floor、Ceil、Trunc 僅使用一個 operand（Round 的 0.5 中點遠離零、Trunc 朝零捨去小數）。
- **Elapsed time** — runtime elapsed-time value。
- **Timestamp** — runtime timestamp value。

Set Variable 會建立或更新 variables。Fixed value 支援 Number、String、Boolean、Null。
Boolean 使用 True／False 選項；Null 不需額外輸入。String 的 "true" 與 "null" 是文字，
並非 Boolean 或 Null。Previous step result 只能引用目前 lexical
scope 中較早且可見的 step。Calculation 使用 arithmetic 與 comparison
operators。Assert、While 與 If 提供 `==`、`!=`、`>`、`>=`、`<`、`<=`。
Assert、While 與 If 的 Fixed value 皆可選 Number、String、Boolean、Null。
Equality 不進行型別轉換，字串區分大小寫；arithmetic 與大小比較僅接受數值。
缺少的 Variable 或 Result Path 是錯誤，不是 Null。
Calculation 不是任意 nested expression tree。

Output 的 **Elapsed time** 來源提供 **Time Format**：**Seconds**（預設）、
**Minutes:Seconds**、**Hours:Minutes:Seconds** 與 **Days (Decimal)**。分鐘與小時
可累積超過 60 分鐘與 24 小時；Output Data 的秒數顯示三位小數，十進位天數顯示
九位小數。例如 90061.123 秒可顯示為 1501:01.123、25:01:01.123 或 1.042374109 d。

**Timestamp** Output 的 **Include Date** 與 **Include UTC Offset** 預設勾選，
顯示如 `2026-10-12T23:24:10.123+08:00`。取消任一選項只隱藏對應部分；底層保留
完整 UTC+08:00 日期時間，跨午夜也不會丟失日期。設定屬於各個 Output，Template
儲存／載入及 Step 複製／貼上會保留；切換 Value Source 時清除舊時間設定。
Set Variable 與 Tool Action 的時間來源維持原有行為。

只有 Output step 會建立 ResultRow column；Input value 被引用本身不會使它成為
result column。

