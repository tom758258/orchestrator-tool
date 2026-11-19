# 範本與偏好設定

<!-- help-source -->

## 12. Templates 與 local machine settings

Application 啟動時會建立 blank `Untitled` draft。目前 UI 沒有獨立的 `New` button。

- **開啟範本（Open Template）** 載入既有 Template。
- **儲存範本（Save Template）** 保存目前 Template。

Template 會保存：

- Template name
- Tool Instances
- Tool setup
- Workflow
- 可選的 saved Chart definitions/settings，僅在 **將圖表儲存於範本（Save charts with template）**
  啟用時保存

Template 不會保存：

- executable paths；
- Live Resources 或 last-known resource identity；
- Simulation/Live mode；
- Last Run、Run ID 或 committed results；
- 未選擇保存的 session-only Chart state；
- 目前互動操作產生的 zoom／pan viewport；
- Workflow Chart Options（Sampling、Preserve Significant Changes、Show
  Significant Change Markers 與 Fit Data）；
- loading/error UI state、dialog state 或 export destination/path；或
- runtime Powers authorization。

這個分離讓 Template 保持 portable，同時將 executable paths、resources 及其他
machine/runtime state 保留在 Desktop local configuration。

## 13. 語言與外觀

「外觀（Appearance）」旁的地球按鈕顯示 **English** 或 **繁體中文**，按一下
即可立即切換整個 Desktop 的語言，並保留編輯內容、執行狀態與結果。選擇會記住在
這部電腦。首次啟動時，繁體中文 WebView 語言（`zh-TW` 或 `zh-Hant`）使用繁體中文，
其他語言使用英文。語言與外觀各自獨立，皆不寫入範本或匯出資料。您輸入的名稱與
數值、技術識別碼及原始診斷詳細資料會保留原樣。

「使用說明（Help）」依目前 Desktop 語言開啟離線指南。變更語言或外觀後，再按一次
「使用說明」即可更新已開啟的視窗，視窗標題也會跟隨所選語言。指南保留章節導覽，不另設語言切換。
繁中介面常用操作為「新增範本（New Template）」、「開啟範本（Open Template）」、
「儲存範本（Save Template）」、「工具（Tools）」、「設定（Setup）」、
「工作流程（Workflow）」與「輸出（Output）」。本文保留部分英文操作名稱供對照。

**外觀（Appearance）** 支援 **系統（System）**、**淺色（Light）** 與 **深色（Dark）**。Theme choice 是 Desktop
preference，不屬於 Template contract。

