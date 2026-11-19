# Serial Background RX 與動作

<!-- help-source -->

## 16. Serial Background RX

在 Tools 註冊 `serial-tool.exe`，再到 Setup 新增 Serial Tool Instance、設定串列埠參數，勾選 Enable Background Streaming。Background Simulation 使用 Serial Tool 的 `periodic-rx-v1`，不需 TX 也會自行產生 RX（約每 100 ms 一筆 4 Bytes 計數資料）；Foreground Simulation 維持 `loopback-v1`。Live 必須選擇並保存 COM Port 或 TCP Endpoint，執行前仍須明確確認。

Serial 同一個 Tool Instance 支援 UART（COM Port）及原始 TCP Client。於預設展開的 **Communication Setup** 選擇 Transport，可用 **− / +** 隱藏或顯示 Transport 與所選 UART／TCP 設定，Background Streaming 和 Live Device 保持可見。切換時 UART 參數及 TCP Timeout 設定皆保留於 Template。TCP Live 須在 Live Device 輸入 TCP Host 與 TCP Port 並按 Save Resource。COM Port 和 TCP Endpoint 僅儲存於本機，不寫入 Template。TCP Simulation 不需要 Host 或設備 Port；TCP 不提供 List Ports 探索。

Worker ON／Worker OFF 控制持續 RX 來源；Capture ON／Capture OFF 可分段建立獨立 Dataset，不會停止來源。每個 RX Event 在 Output Data 形成一列，同一列包含該次收到的所有 Bytes；接收分段不代表通訊封包。選用的 RX-only Live Monitor 在 Capture OFF 時仍可繼續更新。

Serial RX Live Monitor 的 Hex／Text 接收資料區固定高度並有獨立捲軸。收到新資料時會自動追蹤底部；手動向上捲動可查看緩衝區內的舊資料，不會被新資料拉走，捲回底部即恢復自動追蹤。切換 Hex／Text 會回到最新資料。此處只顯示有限的 Monitor 緩衝資料，不能取代 Capture。

Hex 位元組顯示與 Text（UTF-8）只切換顯示，不修改原始 Bytes。Serial Background 可手動匯出 CSV、XLSX 或 BIN；BIN 依接收順序寫入純原始 Bytes，沒有標頭、分隔符或時間戳記，也不能匯出 Meters／Scopes 數值 Dataset。原有 Streaming Background CSV 仍可選用 Serial 顯示格式。

Serial 不提供 Numeric Charts。Worker 停止時仍核對 Stream 終止、Summary、EOF 和 Process Exit；若沒有更強的無遺失證據，Serial 資料品質保持 unknown，Worker／CSV 錯誤仍會使 Run Failed。

Steps Palette 將 Background Worker ON/OFF 與 Background Capture ON/OFF 獨立歸類到 Background Workflow。Template 沒有任何 Background Binding 時分類鎖定；新增 Binding 後預設展開，可自行收合，收合不會刪除現有 Steps。

Serial Foreground 提供 Serial Send、Serial Send File、Serial Receive、Serial Query 四個 Actions，使用一般非 Streaming Serial Worker。同一 Serial Tool Instance 不可同時作為 Foreground 與 Background。既有 Serial Background RX-only Capture／Monitor 不變。

Send／Query TX 可選 Text（僅接受 String，發送 UTF-8）或單一位元組（整數輸入；固定值須為非負整數，僅發送最低 8 bits）。例如在「單一位元組」模式輸入數值 4660，僅會發送 34。固定值若有小數，會在 Validate 時被拒絕。Variable／Calculation／Step Output 的動態數值在執行時先朝零捨去小數；轉換後為負數、型別錯誤或超出範圍時，該 Step Failed，且不傳送資料。支援 Fixed Value、Variable、前面 Step Output；Set Variable 的固定值可選 String。Text 不會將十六進位文字視為原始 Binary Bytes。

RX Delimiter 與 TX 格式互相獨立；Until Delimiter 模式支援多 Byte Text／Hex，Text 可使用反斜線 r、反斜線 n 與跳脫反斜線。Receive 完全不發送 TX；Query 先發送 TX 再接收。舊 Receive Template 預設 Single Read；舊 Query Template 預設 Until Delimiter。

Receive 提供 Single Read（底層只讀取一次）、Until Delimiter（結果包含結束標記）、Fixed Length（累積達 Expected RX Bytes）、Idle Gap（達到資料靜默間隔）四種模式。Query 提供 Delimiter、Fixed Length、Idle Gap，不提供 Single Read。第一次選擇 Fixed Length／Idle Gap 時，Expected RX Bytes／Idle Gap (ms) 預設空白，必須輸入正整數。Fixed Length 的 Expected RX Bytes 同時是目標與讀取上限；其他模式使用 Max RX Bytes（1～1048576，預設 1024），此值是上限而非必須讀滿的長度。Delimiter 或 Idle Gap 尚未完成就達上限時，Step Failed。

正常接收保留 `/rx_hex`（Hex String）、`/rx_bytes`（Number）、`/outcome = completed`、`/timed_out = false`。勾選 **Enable RX Text (UTF-8)** 後額外提供 `/rx_text`（String 或 null），結果包含 Delimiter。無效 UTF-8 回傳 null，不影響接收成功，也不移除原始 Hex／Bytes。IF／ELSE、Assert、Set Variable 可使用上述欄位；Workflow 不會自動解析個別 Binary Bytes。

Receive／Query 使用 Serial Setup 的 UART `timeout_ms` 或 TCP `io_timeout_ms`。Idle Gap 在首個 Byte 前使用 Read Timeout，收到資料後則依最後一次接收時間獨立計算靜默間隔。Delimiter／Fixed Length 在條件滿足或底層 Read Timeout 前持續接收，不另設整筆 RX Timeout。未勾選 **Fail on Read Timeout** 時，已確認的 Read Timeout 回傳 `/outcome = timeout`、`/timed_out = true`、`/partial_rx_hex` 和 `/partial_rx_bytes`；啟用 UTF-8 時額外提供 `/partial_rx_text`（String 或 null）。勾選 Fail on Read Timeout 則讓 Step Failed。Timeout Result 不代表回覆完整或 MCU 測試通過。

普通 Worker Receive／Query 遇到 Read Timeout 或 ReadLimitExceeded 時，只消費 Session Buffer 中已回報的 Partial RX，保留未回報的後續 Bytes。不會清空 OS／設備 RX 佇列；前一次延遲到達的資料可能被下一次 Receive／Query 讀到，使用者必須自行確認後續資料有效性。ReadLimitExceeded、斷線、其他 I/O 錯誤、Worker 失敗與 Action Deadline 到期仍會造成 Step Failed。Text TX 需要 String；單一位元組 TX 需要 Number 且只送最低 Byte。RX Hex String 不能直接當作多 Byte 原始 TX。

Serial Send File 將 Worker 本機絕對路徑儲存於 Template。Template 載入時缺檔會提示但不阻止載入；Run 前有缺失或無效路徑時阻止啟動任何 Worker。執行中檔案消失仍由 Worker 回報 Step Failed。不提供 Serial run-sequence Workflow Action、Background Query 或 Workflow RX FIFO。

### Background RX 執行中的 Serial Send／Send File

啟用 **FG/BG Interaction**，加入 **Worker ON**，再新增指向 Serial Background
的 **BG Command**。Command 可選 **Send** 或 **Send File**；Text、單一位元組、
傳送資料來源、Calculation 與選檔沿用 Serial Foreground 規則。Send File 會在任何
Worker 啟動前預檢，包含 Loop 或 IF 內的命令。Send／Send File 在同一 Worker、
同一 COM／TCP Session 執行，RX 持續接收；Capture 可保持 OFF，需保存 RX 才開啟。

加入 **Get Command Result** 並選擇來源 BG Command，取得完整原生
`job_finished` 事件。Send 可用 `/result/tx_bytes`，Send File 可用
`/result/bytes_written`；BG Command 本身不提供資料。Status Snapshot 只能確認
TX 完成，若缺少原生事件，Get 會在自身期限到達時失敗。完成不表示裝置已回覆或
已執行命令；Get Latest／Wait Next 仍取得獨立的 RX 事件。

無法確認派送結果時不重送。曾嘗試 BG TX 的 Worker 若無法確認 OFF，同一程序內
禁止 Foreground 或 Background 重用相同 COM／TCP Endpoint。重啟應用程式前，
請先確認外部 Tool 已安全停止。純 RX-only 維持原有行為；不提供 Background Query、
自動 TX／RX 配對或 Recovery 畫面。
