# Simulation 與 Live 執行

<!-- help-source -->

## 7. Run Simulation

執行 Simulation 前，先為每個 referenced external executable 完成設定，並確認
manifest 與 Worker compatibility checks 通過。需要明確檢查 Template 時可先
使用 Validate；run 啟動時也會驗證 Template。

在 Execution Mode 選擇 **模擬（Simulation）**，並使用唯一的 **執行模擬（Run Simulation）** button。
Simulation 不需要 Live Resources，會使用 external Workers 的 simulate contract，
不應操作實體 hardware。Powers Protection Setup 與 final Safe-Off 仍會送到
powers-tool 進行 simulation 或 planning；這是 orchestration validation，不是
Live hardware validation。無法推導數量的 Simple Software 來源會顯示本次執行的
Sample 警告；Custom 模式僅供 Background 使用。

## 8. Run Live

在 Execution Mode 選擇 **真實硬體（Live）** 後，同一個 Run control 會變成 **執行真實硬體（Run Live）**。
Desktop 會自動依每個 referenced instance 已保存的型號 Capability，檢查 Powers 與
Scopes 的 Workflow 固定參數及 Setup。**Live Preflight: Checking** 表示檢查中，
此時不能 Run；**Passed** 才能進入既有的 Live confirmation 流程。**Failed** 會以
紅色顯示已發現的不相容設定，修正並重新檢查成功前不能 Run。無法取得必要 Capability
或 Model ID 也會阻擋 Live；未使用的 instance 與未使用的選用 Capability 欄位不會阻擋。

更換 Template、修改 Workflow 參數或 Setup、保存 Resource／型號，或更換 Powers／Scopes
executable，都會使舊結果失效並重新檢查。Resource 或 identity draft 變更必須先保存。
For／While 內的固定值也會檢查，但不執行迴圈；被 binding 覆蓋的值仍由 Worker 在執行時
驗證。Preflight 不會修改 Template 或自動替換成支援的通道。自動檢查不驗證
Workflow 引用或作用域；完整 Template 驗證只在 Validate 或 Run 執行。Simulation 不受影響。

後端在啟動 Worker、建立 Powers write authorization 或替換 Last Run 前，會再次檢查
當次已保存的設定。Preflight 拒絕執行時會保留原 Last Run、結果與 Output，並顯示為
Preflight failure，不會呈現成已執行 Workflow 的 failure。

開始 Live 前，Desktop 會：

- 確認 referenced Tool Instances；
- 取得已保存的 Live Resources 與 backends；
- 拒絕尚未保存的 Live Resource、backend 或 identity draft changes；
- 顯示列出每個 referenced instance、Tool Type、backend、resource 與可用 identity 的 Live confirmation；
- 提醒 Live mode 可能改變 Powers outputs；以及
- 對適用的 Meters setup 額外顯示 10 A terminal warning。

請在確認前檢查畫面中的 resources 與連接中的 hardware。Run 會再次驗證 backend
與 resource 仍與確認時完全相同。Backend 或 resource 改變，或 resource 重複使用，
都會使 Live execution 被拒絕，並要求
重新確認。

目前支援 Live 的 external tools 是 Powers、Meters、Scopes 與 Serial。Powers 與 Scopes 的
Preflight 使用已保存的 canonical model ID。Scopes 使用原樣保存的 Resource；
未知 identity 不會被替換成其他型號。
Wavegen runtime execution 仍不支援。Scopes Shutdown 不會 reset 或 restore 儀器設定。

### 8.1 Powers actions 與 cleanup

Powers Live actions 包括設定值，以及 `output-on` 與 `output-off` actions。Live
Powers write authorization 只存在於該次 Live run 的 runtime。

Run 結束時，以及 Workflow failure 或後續 Worker startup failure path，orchestrator
會在 Worker shutdown 前對每個已啟動的 Powers instance 要求 `safe-off`。Cleanup
failure 會使 run failure；若原本已有 Workflow failure，仍保留原始 failure。Temporary
runtime authorization file 只用於該次 run，並會 best-effort remove。

明確的 Powers `output-off` Tool Action 不會取代 run-level cleanup。Simulation
會在相同 cleanup 位置透過 powers-tool 送出 simulated Safe-Off，但不宣稱真實
outputs 已被改變。

