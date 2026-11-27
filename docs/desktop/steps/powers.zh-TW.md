# Powers 步驟

<!-- help-source -->

## 電源供應器步驟總覽

| 步驟 | 用途 |
| --- | --- |
| Power Set Output | 設定電壓或電流限制，不會開啟輸出 |
| Power Output ON | 開啟選定通道輸出 |
| Power Output OFF | 關閉選定通道輸出 |
| Power Measure | 讀取實際電壓及電流 |
| Power Protection Status | 讀取保護觸發狀態，不會清除 |

### 選擇通道

**Power Set Output**、**Power Output ON**、
**Power Output OFF**、**Power Measure**，以及 **Power Protection Status** 的 **Specific channel**
共用 Channel 下拉選單。選單僅列出目標 instance 的 capabilities 已確認支援的
通道，顯示為 **CH1**、**CH2** 等。Simulation 使用模擬器通道；Live 使用 Setup
中已儲存 Resource 所辨識的型號。切換目標 instance、Execution Mode 或 Powers
執行檔時，可選通道也會更新。

載入中、缺少 Live 型號、capabilities 查詢失敗或通道清單為空時，會顯示提示並
停用固定通道選擇。已儲存但不在支援清單內的通道仍會顯示，標示為不支援或
無法確認，儲存及重新載入時也會保留。既有 Channel binding 顯示為
**Bound channel (preserved)**。只有明確選擇支援的固定通道，才會取代原通道值
或其 binding；capabilities 不會自動改寫它。

## Power Set Output

加入 **Power Set Output** 可設定通道的 Voltage、Current Limit，或同時設定兩者。
Channel 為必填；兩個設定值至少須選取一項。使用 **Set Voltage** 與
**Set Current Limit** 核取方塊加入或移除設定值；取消勾選會維持儀器該項設定不變。
輸入欄位顯示 **Voltage (V)** 與 **Current Limit (A)**。
Power Set Output 的設定值只允許數值 **Fixed value**、
**Variable** 或 **Calculation**。Calculation 的運算元只允許固定數值或變數，
運算子只允許 Add、Subtract、Multiply 或 Divide。設定值不能使用 Previous step result、
Elapsed time、Timestamp 或比較計算；Template 也會驗證這些限制。
變數解析後仍必須是數值，否則 Powers action validation 會失敗。
**Current Limit** 是電源供應器的輸出電流限制設定值，單位為 A，並非強制輸出的
電流值。此步驟僅設定 setpoints；需要啟用輸出時，另加 **Power Output ON**。

## Power Output ON / OFF

選擇目標 Powers 實例與支援的 Channel。ON 開啟該通道輸出，OFF 關閉。設定電壓或電流限制不會自動開啟輸出。真實硬體操作須先確認接線與安全限制，並完成 Live 確認。

模擬範例：Power Set Output → Power Output ON → Power Measure → Power Output OFF。真實硬體須依設備限制選擇安全設定值，流程結束後的 Safe-Off 仍會執行。

## Power Measure

加入 **Power Measure** 可對指定通道量測一次實際 Voltage（V）與 Current（A）。
此唯讀步驟使用固定 Channel 下拉選單，不會啟用輸出或修改 setpoints。
後續 Output、Assert、Calculation 可透過 Step Output 選取 **Voltage** 或
**Current**；數值 JSON Pointer 分別為 `/data/measurements/voltage` 與
`/data/measurements/current`。此功能僅供 Foreground Workflow 使用，不啟動
Background Streaming。若沒有新增 Output step，量測結果不會自動成為 Result column。

## Power Protection Status

加入 **Power Protection Status** 可讀取 protection trip 狀態，不會改變儀器設定。
Channel 可選 **All**，或選擇 **Specific channel** 後從 Channel 下拉選單指定通道。
主動從 All 切換至 Specific 時，會選取第一個支援的通道。capabilities 不可用或
未提供通道時，Specific 無法選取，並保留 All；既有 Specific 值仍會保留。
結果提供 **Protection Tripped**、
**Over Voltage Tripped** 與 **Over Current Tripped**。只要過電壓或過電流
protection 任一觸發，Protection Tripped 即為 true。實際型號支援由 Powers Tool
驗證。

若 trip 時需要讓 Workflow 失敗，請在 Power Protection Status 後加入 **Assert**：
左側選 **Previous step result → Protection Tripped**，運算子選 `==`，右側選
**Boolean → False**。Status 本身不會停止 Workflow、清除 protection 或修改電源
供應器。

在 IF／ELSE 中，三個 Protection Status 結果都是 Boolean：true 代表對應保護已觸發，false 代表未觸發。比較的另一側請選 Boolean；選取 Result 欄位不會自動修改比較值。
