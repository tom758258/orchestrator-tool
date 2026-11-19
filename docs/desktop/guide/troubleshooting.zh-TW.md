# 常見問題與安全

<!-- help-source -->

## 14. Common problems

### Tool shows Not configured

在 **工具（Tools）** 的 **選擇要加入的工具（Select tool to add）** 選擇 Tool Type，再使用 **加入工具（Add Tool）** 配置正確的
external executable。

### Selected executable is rejected

Executable 可能有錯誤的 manifest Tool ID，或 Worker 不相容。請選擇符合預期
Tool Type 的 executable。

### Executable shows Missing or Not a file

已保存的 path 不存在，或不是一個 file。請使用 **變更路徑…（Change Path...）** 選擇目前的
executable；Desktop 不會靜默搜尋替代檔案。

### Live Resource is missing

在 **設定（Setup）** 為 referenced Tool Instance 選擇或輸入 resource，並在執行 Live 前
保存。

### Live Resource changes are unsaved

使用 **儲存資源（Save Resource）**，再重新開始 Live，讓 confirmation 使用已保存的 backend、
resource 與 identity。切換 backend 會清空草稿，請重新列出或輸入 resource 再保存。

### Duplicate Live Resource

同一次 Live run 中，不同 referenced Tool Instances 不可指向相同 resource。請
指定不同 resources。

### Simulation asks for Meters sample counts

填寫每個 Instance 的 SIM Max Samples，或按 Cancel；這不會改變 Unlimited
While。Custom 模式僅供 Background 使用。

### Manual export is unavailable

Manual export 需要 run 已經結束，且目前 export scope 存在 committed rows。Run
仍 active 時 export 會維持 disabled。Failed 或 incomplete run 可以把已 committed
rows 作為 partial results 匯出；若選取範圍為 zero-row，仍不提供 export。

### Streaming CSV failed

CSV 建立、寫入或最後 flush 失敗會使 Run Failed 並執行安全 Cleanup。
Committed rows、已收到的 Background Samples 與部分 CSV 仍可查看及手動匯出。

### WebView2 is missing

使用 native warning 的 Yes 開啟 Microsoft 官方 WebView2 下載頁，安裝或修復系統
Runtime 後重新啟動 application。若 availability check 通過後仍出現 Startup failed
對話框，請保留 Details 內容供診斷，並確認 Windows 受支援且 WebView2 已安裝並更新。

## 15. Safety notes

- Live mode 可能影響連接中的 hardware。
- 在 confirmation 前確認每個 Live Resource。
- Powers output writes 需要 Live confirmation 與 runtime authorization。
- Run-level Powers `safe-off` 是 cleanup behavior，不取代 external tool 或 instrument
  的 safety requirements。
- Meters DC Current 使用 10 A terminal 時，確認 physical lead connection 後再
  確認 Live。
- External tools 仍負責 instrument-specific limits 與 safety behavior。

