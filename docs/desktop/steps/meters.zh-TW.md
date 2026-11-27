# Meters 步驟

<!-- help-source -->

## 電表量測（Meter Measure）：單次量測

電表量測步驟對指定的 Meters 工具實例觸發一次量測，並取得一筆讀值。在 Setup 設定量測種類及範圍，不需在每個步驟重複設定。

| 項目 | 說明 |
| --- | --- |
| 前置條件 | Tools 已設定相容的 meters-tool.exe；Setup 有 Meters 實例 |
| 目標 | 選擇要使用的實例 |
| 量測設定 | DC Voltage 或 DC Current 等設定取自該實例 |
| 量測模式 | 前景 Single；背景使用 Background Streaming |
| 結果 | 一筆量測資料；在 Previous step result 選擇 Value（數值）或 Unit（單位） |
| 失敗條件 | 量測或 Worker 失敗時，查看步驟錯誤；不會自動產生 Output 欄 |

## 將讀值保存成資料欄

1. 在 Setup 新增 Meters 實例，關閉 Background Streaming。
2. 在 Workflow 加入電表量測（Meter Measure），選擇實例。
3. 加入 Output，Value Source 選擇 Previous step result。
4. 選擇電表量測步驟及數值（Value）結果，執行 Simulation。
5. 從 Output 頁籤查看該欄資料。

電表量測步驟本身不會建立 Output 欄。若步驟失敗，請查看錯誤訊息；若需要多筆連續量測、Immediate 或 External 觸發，請閱讀[背景擷取](../guide/background-streaming.zh-TW.md)。同一實例不能同時用於前景及背景操作。

儀器參數及資料遺失風險請參閱 [Tool Setup](../guide/tool-setup.zh-TW.md)。
