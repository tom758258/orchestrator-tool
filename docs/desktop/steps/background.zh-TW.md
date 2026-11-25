# Background 互動步驟

<!-- help-source -->

### FG/BG Interaction

Workflow 左側最下方、**Chart Options** 下方的 **FG/BG Interaction**
設定面板預設收合。沒有 Background Binding 時面板鎖定、隱藏設定內容；
在 Setup 啟用 Background Streaming 後，才能展開並勾選
**啟用前景／背景互動（Enable FG/BG Interaction）** 以解鎖互動 Steps。移除最後一個未被
Step 引用的 Background Binding 時會關閉 Interaction 與 Buffer，但保留命令容量數值。
**Max Active Command Status** 預設 **4096**，範圍 **1–65536**，限制同一
Run 所有 Background 仍需追蹤的命令數，不限制累計命令數。這些設定（含必填 Buffer 設定）都會隨
Template 儲存。0.3.0 要求新版 Template；缺少這些設定的舊範本無法載入。

先在 Setup 為 Tool Instance 啟用 Background Streaming，再於互動 Steps 前加入
**Worker ON**。啟用 Interaction 不會自動啟動 Worker；Capture 可以保持 OFF。

- **BG Command**：支援 Meters **Software (Simple)** 與 Serial **Send／Send File**。Meters 在 Background Setup
  勾選 **Trigger with BG Command**，以明確命令取代自動計時觸發。Worker 確認接受
  觸發後 Step 即成功；勾選 **Wait for Completion** 可在同一 Step 等待量測完成。
  Serial 可選 Send 或 Send File，沿用前景 TX 輸入方式，不需額外開關；
  Wait for Completion 等待該 TX Job 完成。
- **Get Latest**：取得最新一筆完整原生 Background 事件。最新資料不存在或無效時
  Step 失敗，不會改用較舊的有效值。
- **Wait Next**：等待 Step 開始後到達的第一筆事件；首筆無效即失敗。可等待尚在
  啟動的 Source，但 Source 已結束時立即失敗。
- **Get Command Result**：選擇先前的 **Source BG Command Step**，等待該命令
  完成且結果就緒，再取得原生事件。在 Loop 中，來源必須已於適用的迭代執行；
  IF 分支跳過來源時 Get 會失敗，不會拿其他命令的結果替代。

Get Steps 會將完整原生事件作為 Step Output，例如可在既有 Binding 或 Output
使用 Meters 的 `/value`：選擇 **Previous step result**、指定 Get Step，再從 **結果** 選擇常用欄位；其他欄位可透過 **自訂指標…** 輸入
**JSON Pointer**。BG Command 本身不提供資料輸出；Get Command Result 依來源
Step 在內部配對該次命令。Latest／Next 也支援既有 Scopes 數值週期與 Serial RX
事件。Custom 批次與 Scopes 不提供 Command／Result；Serial Command／Result
僅支援 TX，Latest／Next 仍取得 RX。Powers 與 Wavegen 不支援 Background。

**Step timeout (ms)** 可留白以使用 action timeout；整個 Step 共用一個期限。
每個 Background 最多保留一筆待取結果，請先取用結果，再派送另一個需要結果的
命令。Busy 或容量不足會直接失敗，不會排入佇列。已接受的命令稍後失敗時，Run
仍會失敗並開始清理，先前成功的派送 Step 不會改寫。無法確認派送結果時不會重送。
若 IF 跳過 Get Command Result，結果仍保留至所在 Loop 當次迭代結束；Loop 外的
命令則保留至 Run 結束。在同一範圍派送另一筆需要結果的命令前，請先取用該結果。

正常 Run 結束時，以一個 action timeout 等待尚未完成的命令；Worker OFF 在
自己的期限內等待必要命令與關閉。未讀結果不增加等待，既有有限筆數與擷取品質
規則仍適用。Stop Workflow 採合作式清理，不額外等待普通命令。Worker OFF 後
重新 ON 會使舊資料與結果引用失效。若無法確認關閉，同一資源即使改用計時觸發
或 Foreground 仍會被阻擋。重新啟動應用程式前，請先確認外部工具已停止；
重新啟動本身不代表已驗證關閉。

### Data Buffer（選用）

在同一個 FG/BG Interaction 面板啟用 **Enable Buffer（啟用 Buffer）**，
預設 OFF，必須先啟用 FG/BG Interaction。選擇 FIFO／Ring Buffer 及
Overflow Policy（預設 Fail Run，或 Continue）。所有 Background 共用設定，
每個 Worker 各自保存固定最多 **1024 組 Event 與 16 MiB**
（16,777,216 Bytes）。容量以完整緊湊 JSON 的 UTF-8 Bytes（或序列化錯誤資訊）
計算，不是原始 Serial Bytes，也不是全域 RAM 上限。FIFO 空間不足時丟棄新資料；
Ring Buffer 依序移除最舊資料直到空間足夠。單筆超限時拒絕該筆，不清除既有資料。
不截斷、不等待空間。Fail Run 即使 FG 正執行其他 Step 也通知既有失敗收尾；
Continue 保留遺失狀態供 IF／ELSE 判斷。Capture、Latest、Next 與 Command
Result 獨立；Buffer 遺失不等於 Capture 遺失。

- **Get Buffer Data**：選擇 Background、Peek／Pop、Count／ALL。Count
  支援 Fixed Value、Variable、Previous step result，範圍 1～1024 整數。
  由最舊開始立即回傳，資料不足回傳現有數量，空 Buffer 回傳 count 0 與空 Array。
  Peek 保留資料，Pop 僅在整批成功時移除。選取範圍含無效 Event 時 Step
  失敗，整批不消耗。Peek 與後續 Pop 不保證取得相同資料。
- **Get Buffer Status**：只選擇 Background，查詢狀態、不讀取或移除 Event。
  兩個 Buffer Step 均不等待資料累積，沒有 Step timeout。

Get Buffer Data 回傳 `/count`（實際取得數量）、`/data`（完整原生 Event
Array）與 `/status/...`（操作後快照）。Get Buffer Status 在根層級回傳同一組
狀態欄位。可於 IF／ELSE、Assert、Output 或其他 Step 引用。

| Status | 意義 |
| --- | --- |
| capacity | 固定 1024 組 |
| count | 目前 Buffer 組數 |
| byte_capacity | 16,777,216 Bytes |
| buffered_bytes | 目前緊湊 JSON UTF-8 Bytes |
| full | 任一容量已達上限 |
| overflowed | 本次 Worker 生命週期曾遺失資料 |
| dropped_count | 累計丟棄或覆蓋的 Event 組數 |

即使 Full 為 false，下一筆過大的 Event 仍可能造成 Overflow。
Peek、Pop、Pop ALL、Capture ON／OFF 不重置遺失狀態。
Worker ON 初始化空 Buffer；Source Ended 保留資料直到 Worker OFF 才釋放。
新 Worker 或 Run 從空 Buffer 開始；已取回 FG 的 Array 遵循原有 Step Output
或 Variable 作用範圍。

使用 Array Process Length 或 Get Item 操作 `/data`。Serial RX Event
不保證為完整封包；不提供封包組裝或 TX/RX 自動配對。

