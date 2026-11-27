# 快速開始

<!-- help-source -->

## 認識 Orchestrator Tool

Orchestrator Tool 用來建立並執行可重複使用的測試與量測流程。你可以選擇儀器、安排操作步驟，再查看或匯出結果。與儀器通訊的工作由各個獨立的外部工具負責。

```text
Orchestrator Tool（圖形介面）
        |
        +-- Meters Tool  --> 數位電表
        +-- Powers Tool  --> 電源供應器
        +-- Scopes Tool  --> 示波器
        +-- Serial Tool  --> UART / TCP 設備
```

上圖為真實硬體模式的概念示意。模擬模式則使用各工具的模擬器。Wavegen 是另一個獨立專案，目前尚不支援在 Orchestrator 的工作流程中執行。

## 使用前的準備

| 需求 | 如何準備 |
| --- | --- |
| Windows | 取得 Windows Desktop 發行包並完整解壓縮。 |
| Microsoft Edge WebView2 Runtime | 若尚未安裝，請安裝系統執行環境。 |
| 外部工具 EXE | 依需求另外取得，請參閱[設定外部工具](external-tools.zh-TW.md)。 |
| 實體儀器 | 本章的模擬教學不需要；真實硬體操作才需要受支援的儀器與連線。 |

程式不會自動安裝 WebView2 或外部工具。若缺少 WebView2，啟動警告可開啟 Microsoft 官方下載頁，主視窗不會建立。若檢查通過但仍無法開啟主視窗，程式會顯示含技術細節的啟動錯誤並結束；請保留詳細訊息供排查。

## 主畫面導覽

| 頁籤 | 可以做什麼 |
| --- | --- |
| 工具（Tools） | 設定外部工具的執行檔，確認檔案是否可用及相容。 |
| 設定（Setup） | 新增工具實例、設定儀器參數，並在支援時儲存本機的實體儀器連線。 |
| 工作流程（Workflow） | 新增及排列步驟、驗證範本、執行或停止流程、設定即時 CSV。 |
| 輸出（Output） | 查看最近一次執行、訊息、圖表、統計、資料及匯出結果。 |

右上方有 **外觀**、**語言** 與 **使用說明**。下一列左側是 **範本（Template）** 的新增、開啟與儲存按鈕；右側是 **執行模式（Execution Mode）**。使用說明會在獨立視窗離線開啟。

## 先認識幾個名詞

| 名詞 | 簡單說明 |
| --- | --- |
| Tool Type（工具類型） | 儀器種類，例如 Meters。每種工具類型只需設定一次執行檔路徑。 |
| Tool Instance（工具實例） | 工作流程使用的一組具名工具設定，可以有多個相同類型的實例。 |
| Step（步驟） | 工作流程中的一個動作，例如量測、等待或輸出資料。 |
| Template（範本） | 可儲存、再次使用的工具設定與工作流程，不包含本機執行檔路徑或量測結果。 |
| Worker | 由 Orchestrator 啟動的外部工具程序，負責執行儀器操作，不需要手動啟動。 |

## 第一次執行模擬

先試著完成一次模擬電壓量測。這個範例不需要實體電表或 VISA 連線。

1. 將 Orchestrator Tool 及相容的 Meters Tool 發行包分別完整解壓縮。開啟 `Orchestrator Tool.exe`。
2. 在 **工具（Tools）** 選擇 Meters，按 **加入工具（Add Tool）**，選取 `meters-tool.exe`，確認檔案可用且相容。
3. 在 **設定（Setup）** 新增一個 Meters 工具實例。量測選擇 **DC Voltage**、範圍選擇 Auto、保持 Background Streaming 關閉。選擇支援的 NPLC 與 Auto Zero 設定；前景量測使用 Single。
4. 在 **工作流程（Workflow）** 左側步驟清單選擇 Meters 的 **電表量測（Meter Measure）**，按 **新增步驟（Add Step）**。在屬性選擇剛新增的 Meters 實例，再於後方新增 **輸出（Output）** 步驟。
5. 在 Output 屬性設定名稱（例如 `Voltage`）與 Page（例如 `Results`），來源選擇 **Previous step result**，指定前面的電表量測步驟，再選擇 **數值（Value）** 結果。
6. 保持 **模擬（Simulation）** 模式，按 **驗證（Validate）** 檢查範本，再按 **執行模擬（Run Simulation）**。
7. 開啟 **輸出（Output）** 頁籤，查看執行狀態及 Results 頁面的 Voltage 欄位。此數值來自模擬器，並非真實電壓。
8. 執行結束後可將資料匯出成 CSV 或 XLSX。使用 **儲存範本（Save Template）** 保存可重複使用的流程，而不是量測結果。

```text
工具 -> 設定 -> 工作流程 -> 執行模擬 -> 輸出
                                    -> 儲存範本
```

若儀器步驟分類無法使用，請先確認是否新增對應的工具實例。若執行失敗，請閱讀錯誤訊息並參閱[常見問題與安全](troubleshooting.zh-TW.md)。

## 選擇執行模式

| 模式 | 意義 |
| --- | --- |
| 模擬（Simulation） | 不操作實體硬體，測試流程是否正確；啟動程式、新增或開啟範本時的預設模式。 |
| 真實硬體（Live） | 儲存儀器連線設定並確認後，操作真實設備。 |

執行模式適用於整次操作，不是由各個工具實例分別選擇。畫面及每張工具實例卡片均顯示 **模擬 · 無硬體 I/O（SIMULATION · NO HARDWARE I/O）** 或 **真實硬體 · 實際硬體操作（LIVE · REAL HARDWARE）**。工作流程或手動外部操作期間無法切換模式。模式是暫時設定，不會寫入範本或本機設定。標示不代表 Wavegen 已支援執行。

操作實體儀器前，請先閱讀[模擬與真實硬體執行](execution.zh-TW.md)及安全注意事項。
