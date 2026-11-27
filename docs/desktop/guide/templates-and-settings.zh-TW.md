# 範本與偏好設定

<!-- help-source -->

## 新增、開啟與儲存範本

啟動程式時會建立空白 Untitled 範本。使用主畫面的 **新增範本（New Template）** 建立新範本、**開啟範本（Open Template）** 載入既有範本、**儲存範本（Save Template）** 保存目前範本。

## 哪些資料會保存？

| 資料 | 保存位置 |
| --- | --- |
| 範本名稱、Tool Instances、Tool Setup、Workflow | 範本 |
| FG/BG Interaction 及 Data Buffer 設定 | 範本（即使停用也需保存必要設定） |
| Chart definitions / settings | 選用；勾選 Save charts with template 才保存 |
| 外部工具 EXE 路徑 | 本機 |
| Live Resource、VISA Backend、上次識別的設備資訊 | 本機 |
| 語言、外觀、Step Display Density | 本機偏好 |
| Simulation / Live 模式、Last Run、Run ID、已取得的結果 | 暫時保留 |
| Data Buffer 的資料及狀態 | 暫時保留 |
| 未選擇保存的圖表、Zoom／Pan 位置 | 暫時保留 |
| Workflow Chart Options（Sampling、Preserve Significant Changes、Show Significant Change Markers、Fit Data） | 暫時保留 |
| 載入／錯誤狀態、對話框、匯出路徑、Powers 執行授權 | 不隨範本保存 |

### 將範本交給其他電腦

例如把 A 電腦的範本交給 B 電腦，同事可直接使用工具實例、儀器設定及工作流程，但需要在自己的電腦重新設定執行檔路徑，以及真實硬體模式所需的 Live Resource。範本不會帶走量測結果；請另外匯出資料。

### 舊範本的相容性

目前範本必須明確包含 FG/BG Buffer 設定，即使停用亦同。缺少必要設定的舊範本會被拒絕，不提供轉換或自動補值。

## 語言與外觀

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
