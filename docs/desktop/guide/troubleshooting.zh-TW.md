# 常見問題與安全

<!-- help-source -->

## 常見問題速查

| 現象 | 建議先檢查 |
| --- | --- |
| 工具未設定或 EXE 被拒絕 | 正確的 CLI／Worker EXE、工具版本及相容性 |
| Missing / Not a file | 執行檔是否已搬移 |
| Live Resource 遺失／未儲存／重複 | Setup 的連線位址及 Save Resource |
| Simulation 要求筆數 | Meters SIM Max Samples |
| 無法匯出 | 是否已結束執行且有可匯出的資料 |
| CSV 失敗 | 錯誤詳情與輸出資料夾 |
| 無法開啟程式 | WebView2 Runtime 及啟動錯誤詳情 |

### 詳細排查方法

### 工具尚未設定

在 **工具（Tools）** 的 **選擇要加入的工具（Select tool to add）** 選擇 Tool Type，再使用 **加入工具（Add Tool）** 配置正確的
external executable。

### 執行檔被拒絕

Executable 可能有錯誤的 manifest Tool ID，或 Worker 不相容。請選擇符合預期
Tool Type 的 executable。

### 執行檔不存在或不是檔案

已保存的 path 不存在，或不是一個 file。請使用 **變更路徑…（Change Path...）** 選擇目前的
executable；Desktop 不會靜默搜尋替代檔案。

### 未設定 Live Resource

在 **設定（Setup）** 為 referenced Tool Instance 選擇或輸入 resource，並在執行 Live 前
保存。

### 實體連線設定尚未儲存

使用 **儲存資源（Save Resource）**，再重新開始 Live，讓 confirmation 使用已保存的 backend、
resource 與 identity。切換 backend 會清空草稿，請重新列出或輸入 resource 再保存。

### 實體連線重複

同一次 Live run 中，不同 referenced Tool Instances 不可指向相同 resource。請
指定不同 resources。

### 模擬要求 Meters 量測筆數

填寫每個 Instance 的 SIM Max Samples，或按 Cancel；這不會改變 Unlimited
While。Custom 模式僅供 Background 使用。

### 無法手動匯出

Manual export 需要 run 已經結束，且目前 export scope 存在 committed rows。Run
仍 active 時 export 會維持 disabled。Failed 或 incomplete run 可以把已 committed
rows 作為 partial results 匯出；若選取範圍為 zero-row，仍不提供 export。

### 即時 CSV 寫入失敗

CSV 建立、寫入或最後 flush 失敗會使 Run Failed 並執行安全 Cleanup。
Committed rows、已收到的 Background Samples 與部分 CSV 仍可查看及手動匯出。

### 缺少 WebView2

使用 native warning 的 Yes 開啟 Microsoft 官方 WebView2 下載頁，安裝或修復系統
Runtime 後重新啟動 application。若 availability check 通過後仍出現 Startup failed
對話框，請保留 Details 內容供診斷，並確認 Windows 受支援且 WebView2 已安裝並更新。

## 安全注意事項

- Live mode 可能影響連接中的 hardware。
- 在 confirmation 前確認每個 Live Resource。
- Powers output writes 需要 Live confirmation 與 runtime authorization。
- Run-level Powers `safe-off` 是 cleanup behavior，不取代 external tool 或 instrument
  的 safety requirements。
- Meters DC Current 使用 10 A terminal 時，確認 physical lead connection 後再
  確認 Live。
- External tools 仍負責 instrument-specific limits 與 safety behavior。
