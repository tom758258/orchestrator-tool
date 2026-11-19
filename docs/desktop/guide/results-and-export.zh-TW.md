# 輸出資料與匯出

<!-- help-source -->

### 10.5 Data 與 Summary

**Output Data** 使用 committed ResultRows。大型 table 會使用 virtualization 顯示，
但 rows 仍保留，可供 charts 與 export 使用。

**Number display** 讓 Summary 與 Output Data 共用一組設定。**Auto**（預設）
顯示最多 15 位有效數字並簡化浮點尾差；**Fixed** 顯示固定 0～12 位小數；
**Raw** 顯示原本 JavaScript Number 的字串。切換立即生效，且可在目前 Desktop
使用期間跨 Run Page 沿用。Count 維持整數，Elapsed Time／Timestamp 格式優先。
這些設定不會改變儲存值、統計結果、Charts、匯出內容或 Template。

**Summary** 預設顯示 Count、Min、Max 與 Avg。**Columns ▾** 可分別控制這些欄位，
以及 Range（Max − Min）、Std Dev（σ）、2σ 與 3σ。Std Dev 為樣本標準差，
計算式為 `sqrt(M2 / (n - 1))`；2σ 與 3σ 為其倍數。只有一筆 sample 時，
三個 σ 欄位均顯示 `—`，Range 仍可顯示；至少兩筆且全部相同的資料其 Std Dev = 0。
Elapsed time Output 的 Min、Max、Avg、Range、Std Dev、2σ 與 3σ 依該次 run 的
Output Time Format 顯示，與 Output Data 和 Scatter X 一致。Count 維持整數，
缺少的統計值維持 `—`。格式化僅影響顯示，底層統計仍保留原始秒數與精度。
欄位選擇僅為暫時的 presentation 設定。若 Page 沒有 numeric Outputs，則不會
顯示 numeric summary。

## 11. Manual export

Manual export 會在 run 不再 active，且目前 export scope 存在 committed Output
rows 時提供。Failed 或 incomplete run 仍維持原本的 failure/incomplete 狀態，
但可把已 committed rows 作為 partial results 匯出。

每次啟動 Application 時，manual export 預設為 **XLSX**。你可以在當次使用期間
切換 **CSV** 與 **XLSX**，此選擇不會保存。Streaming CSV 行為維持不變。

選擇 **Run Page** 或 **All Run Pages**，再選 **CSV** 或 **XLSX**：

- **Run Page / CSV** — 將選取的 Page 匯出為一份 CSV。
- **Run Page / XLSX** — 將選取的 Page 匯出為一個 worksheet。
- **All Run Pages / CSV** — 在指定 destination folder 中為每個 Page 建立一份 CSV。
- **All Run Pages / XLSX** — 建立一個 workbook，每個 Page 一個 worksheet。

所有 XLSX 時間格式都是可計算與繪圖的數值儲存格。Elapsed **Seconds** 儲存秒數；
其他三種格式儲存秒數 / 86400（Excel 天數）。Timestamp 即使隱藏 Date，也保留
完整日期時間序號；`T` 與 `+08:00` 是固定顯示文字。Excel 天數相減後乘以 86400
即可換算為秒。CSV 與 streaming 一律保留原始 Elapsed 秒數與完整 ISO Timestamp。

Export 使用 committed ResultRows。XLSX 會將 Excel 支援範圍內的有限浮點數寫為
Number cells，不對儲存值額外 Round，可依 Excel 原生精度（約 15 位有效數字）
直接計算與繪圖。JSON 整數維持既有精度保護；不安全的整數與 Excel 範圍外的
數值會以原本儲存的 JSON 表示保留為 Text。看起來像數字的字串仍為 Text；布林值寫為
Boolean cells，null 寫為 Blank，Array／Object 保留為 compact JSON Text。
Export 保留已儲存結果，無法還原 JSON 解析時已遺失的精度。匯出不會加入 formulas
或 embedded charts。CSV 輸出維持不變，All-Pages CSV export 不會覆寫既有 Page CSV
files。

迴圈 Stop 本身不是 failure。Stop Workflow 在清理成功後會產生 Stopped 結果。
Execution 停止後，failure 或
incomplete termination 之前已 committed 的 rows 仍可 manual export；仍處於 staged
狀態、尚未通過 owning scope commit point 的 rows 不會被匯出。

