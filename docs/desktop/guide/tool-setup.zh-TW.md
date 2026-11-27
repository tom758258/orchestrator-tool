# Tool Setup 與 Instance

<!-- help-source -->

## 認識工具實例

工具實例（Tool Instance）是範本中具名的一組儀器設定。你可以在同一份範本建立多個同類型實例，例如兩個 Meters 分別量測電壓與電流。

| 資料 | 保存位置 |
| --- | --- |
| 工具實例、各實例的儀器設定 | 範本 |
| 執行檔路徑 | 本機，同類型共用 |
| 實體儀器連線（Live Resource） | 本機，各實例獨立 |

### 設定區塊

```text
Tool Instance
  +-- 工具專屬設定
  +-- Background Streaming（預設收合）
  +-- Live Device（預設展開）
```

每個工具實例預設展開，可用 **+ / −** 獨立收合。新增工具實例上方的 **Tool Instance Summary** 按工具類型統計實例數（包含未在本機設定的類型）；沒有實例時隱藏。

**Background Streaming**（背景擷取）與 **Live Device**（即時裝置）可獨立收合。勾選 Enable Background Streaming 後顯示適用設定；不支援的工具類型會停用並提示原因。使用 Worker 與 Capture 步驟控制資料來源及記錄。

編輯、切換頁籤或收合外層卡片時，展開狀態會保留。成功新增或開啟範本後，卡片與設定區塊恢復預設狀態，包含 External Tools。收合狀態不寫入範本或本機設定。

### 新增及命名實例

1. 在 **工具（Tools）** 設定所需外部工具。
2. 在 **設定（Setup）** 的 **工具類型** 下拉選單選擇類型，再按 **新增工具實例（Add Tool Instance）**。
3. 展開實例，可編輯 **顯示名稱（選填）（Display Name (optional)）**。留空使用原始 Instance ID。

已設定執行檔的類型即使為 Missing 或 Error 仍可新增實例；沒有任何已設定類型時新增按鈕停用。既有實例若缺少本機工具設定仍保留並顯示警告；重新設定後警告消失。

| 名稱規則 | 行為 |
| --- | --- |
| 允許值 | 中文、英文、數字、空格；不同實例可同名 |
| 留空或全空白 | 顯示原始 Instance ID；離開欄位或保存時去除前後空白 |
| 顯示位置 | Setup 標題、Workflow Target 及序列目標摘要即時更新；保留 ID、可用的型號及序號資訊 |
| 保存與執行 | 隨範本保存；忙碌時不可編輯。名稱不改變流程引用、執行模式或實體連線；Wavegen 尚未支援執行仍可保存名稱 |

數值欄位可直接輸入，或用上下方向鍵調整。

## Meters：量測設定

Meters 的 **Measurement Setup** 預設展開，可用 **− / +** 隱藏或顯示量測與觸發
設定，不影響 Background Streaming 或 Live Device。這些設定依所選模式供 Foreground
或 Background 使用。目前提供：

| 欄位 | 選項及用途 |
| --- | --- |
| Measurement | DC Voltage（直流電壓）、DC Current（直流電流） |
| Range Mode | Auto、Manual |
| Manual Range | 依工具支援能力提供固定選項，不可任意輸入 |
| NPLC | 0.02、0.2、1、10、100；量測積分時間 |
| Auto Zero | On、Off、Once |
| DCV Input Impedance | 直流電壓：Not specified、Default、10 MΩ、Auto |
| Current Terminal | 直流電流：Not specified、3 A terminal、10 A terminal |
| VM Comp Slope | 直流電壓／電流：Not specified、Positive、Negative；未指定保留原設定 |

### 量測及觸發模式

先選擇是否啟用 Background Streaming。前景只能使用 Single，每次 Measure 取得一筆讀值。

| 模式 | 設定 |
| --- | --- |
| Single（前景） | 每次 Measure 觸發一次 |
| Software、Immediate、External（背景 Simple） | 有限筆數使用 Max Samples |
| Software Custom、Immediate Custom、External Custom（背景） | Sample Count、選用 Buffer Drain Size、Allow Buffer Overflow Risk；有限來源使用 Trigger Count |
| External / External Custom | 選用 Hardware Trigger Slope 與 Hardware Trigger Delay (s)；未指定使用工具預設 |

取得型號支援能力後，不支援的模式會停用。已知的讀值記憶體容量會顯示；預期筆數超過容量時顯示 Reading memory exceeded，須明確接受溢位風險。

Measurement 欄位會固定顯示；不適用的欄位會 disabled。實際 model capability 與 numeric
limits 仍由 external meters-tool 最終驗證；Desktop 不會重新建立它的
capability database。Simulation 會使用 meter simulator profile 的 capability，
不會受已保存的 Live meter identity 影響；Live 才使用已保存的 identity。

### 警告：Custom 量測可能遺失資料

在 Custom 模式勾選 **Allow Buffer Overflow Risk**，表示明確接受可能無法恢復的
資料遺失。勾選後即會顯示 **High Buffer Overflow Risk Accepted**，即使預期筆數
未超限或尚未取得能力資料也一樣。只要擷取速度超過 Worker 排空讀值記憶體的速度，
就可能遺失 Samples；較低 NPLC 可能提高此風險。反之，即使預期筆數超過容量，
只要及時排空，仍可能完整取得資料。預期超限本身不代表已發生 Overflow。

有限 Custom 擷取若遺失 Samples，即使所有預定 Trigger 已完成，Worker 仍可能
持續等待不足的 Samples，無法自然結束。這不一定代表程式已無法回應：Worker
仍可能接受既有 Workflow 或 Worker Stop 控制。請依需要使用這些控制結束作業；
Stop 無法恢復已遺失的資料。這些警告適用於 Simulation 與 Live。持續等待的現象
已在 Simulation 重現，尚未確認實體儀器是否有相同行為。

`summary.ok=true` 或 Process Exit Code 0 都不保證取得全部預期讀值。請一起核對
**Captured**、**Expected Readings**、**Stop Reason** 與 **Data Integrity**。
Allow Risk 不保證已啟用 Overflow Monitoring，Meters Setup 也沒有獨立的監測
控制項。沒有監測結果時，未偵測到 Overflow 不能作為沒有資料遺失的證據。

## 設定實體儀器連線

實體儀器連線（Live Resource）是各實例實際要連接的設備位址，只儲存在本機。上次保存的型號及序號不代表現在已連線。

| 工具 | 如何指定連線 |
| --- | --- |
| Meters、Powers、Scopes | 選擇 VISA Backend，再 List Resources 或手動輸入 |
| Serial | UART 的 COM Port 或 TCP 的 Host / Port；詳見 [Serial 步驟](../steps/serial.zh-TW.md) |
| Wavegen | 尚不支援工作流程執行 |

1. 展開實例的 Live Device。
2. 選擇適用的後端或通訊方式。
3. 列出或輸入位址，確認儀器資訊。
4. 按 **儲存資源（Save Resource）**；若要移除連線設定，使用 Clear Resource。

### VISA Backend 與未儲存的設定

每個支援 VISA 的工具實例可獨立選擇 **System VISA**（預設，包含舊版設定）或 **PyVISA-py (@py)**，再按 **List Resources**。

- 切換後端會清除該實例的連線位址與設備識別草稿、探索結果、錯誤及舊 Powers Device Status，不影響其他實例。
- 重新列出或輸入連線位址後，按 **儲存資源（Save Resource）** 才會一起保存後端、位址與設備資訊。不同後端的位址不會自動轉換或比對。
- 未儲存變更會阻擋 Live 並使先前的 Live Preflight 失效。後端不可用時會明確報錯，不會自動替換。

後端及實體連線屬本機設定，不寫入範本。Simulation 不要求也不使用實體連線；仍可為未來的 Live 執行列出、編輯及保存連線，不會因此切換執行模式或建立假的模擬資源。

### 型號與支援功能

Powers 的設備探索可能提供標準型號識別碼（canonical model ID）。程式將它保存在本機，透過離線能力查詢取得支援的通道與保護功能；此查詢不會連線儀器。

Live 若缺少型號識別或能力資訊，請選擇並儲存受支援的資源後再新增保護設定。Simulation 使用 Powers 模擬器型號的能力，不需要探索或儲存連線。切換至不支援的型號時，範本既有設定仍會顯示。

### 讀取並排空錯誤佇列（Read & Drain Errors）

展開 Powers、Meters 或 Scopes 實例的 **即時裝置（Live Device）**，在
**錯誤佇列** 按下 **讀取並排空錯誤佇列**。Meters 需要支援 `read-errors` 命令的 CLI。
Desktop 會離線檢查 CLI 及已知的 Meters 保存型號。若在同一路徑更換 Meters 執行檔，
請在 **工具（Tools）** 選擇 **重新整理（Refresh）**，重新確認支援。Live 模式下，
請選取並儲存搜尋到的 Scopes 資源，以便 Desktop 確認型號支援。

- **Simulation** 使用對應 Tool 的模擬器，結果顯示 **NO HARDWARE I/O**。
- **Live** 使用已儲存的 Live Resource 及 VISA Backend，即使 Resource 欄位目前
  顯示草稿。確認視窗會顯示已儲存的位址。讀取會從儀器佇列移除已回傳的項目，
  過程中不會執行 `*CLS` 或清除其他儀器狀態。

從 Workflow 啟動到停止與收尾完成，所有實例的按鈕都會停用。此診斷須手動操作，
結果僅顯示於 Setup。

結果依讀取順序顯示原始錯誤代碼及訊息。

| 結果 | 意義 |
| --- | --- |
| 佇列原已為空 | 第一次讀取即確認為空 |
| 已確認排空 | 已讀取項目並確認佇列為空 |
| 尚未確認排空 | 達 20 次讀取上限，仍未確認為空 |
| 失敗 | 顯示原因並保留已回傳的項目 |

連線若在讀取途中失敗，儀器可能已移除項目，但尚未回傳。

## Powers：保護設定

保護設定（Protection Setup）為選用功能，預設收合。展開後可查看保護欄位、Device Status、Refresh Status、Protection Summary、各通道狀態及清除操作；收合不會讀取或操作儀器，也不會清除設定及操作結果。下方 Live Device、後端、資源探索及移除實例相關控制項仍可見。

勾選 **Use Protection Setup** 後才能編輯支援欄位；每個實例共用一個核取方塊，新實例預設未勾選。只勾選而未指定值，不會寫入保護資料或勾選狀態。表格列出工具回報的通道及範本既有通道；不支援欄位仍顯示但停用，既有不支援值會提示並保留。實際型號能力與限制由外部工具驗證。

### 保護設定欄位

| 欄位 | 意義 |
| --- | --- |
| OVP Voltage (V) | 過電壓保護門檻；輸入型號支援的電壓值。 |
| OCP | 過電流保護：On／Off。 |
| OCP Delay (s) | 過電流保護延遲秒數；依型號限制。 |
| OCP Delay Trigger | 延遲起算條件：Setting Change（設定變更）或 CC Transition（進入定電流），依型號支援。 |

### 清除與儲存設定

數值欄位留白或選擇 **Unchanged** 表示保留儀器原有設定，不會寫入 Template。
只保存有設定的通道與欄位。開啟既有 Protection Setup 時，核取方塊會自動勾選。
清空某通道最後一項設定時，會移除該通道 record；全部清空後會回到空 setup，
取消勾選 **Use Protection Setup** 並停用欄位。取消勾選也會清除整個 Protection
Setup，所有欄位回到 Unchanged。通道列仍依 capability 顯示，不提供新增或移除
channel 的控制項。Protection Setup 與 Device Status 表格的 **Channel** 欄只顯示
通道數字；確認訊息與 clear plan 使用 **Channel 1**。Workflow Sequence 的 compact
summary 保留 **CH1**。

### 保護設定執行順序

兩種執行模式都對流程引用且有保護設定的 Powers 實例依序執行：

1. Safe-Off（關閉輸出）。
2. 讀取 Protection Status；若回報保護觸發，阻止執行且不自動清除。
3. 狀態正常時逐通道套用保護設定，才開始工作流程。
4. 流程結束仍執行最終 Safe-Off。

Simulation 只透過 powers-tool 模擬或規劃上述順序，不進行真實硬體 I/O。若希望執行期間偵測到保護觸發也使流程失敗，請使用 **Power Protection Status** 與 **Assert**。

### 真實硬體安全檢查

Live 前，每個被流程引用的受支援工具實例都必須有已儲存且非空的連線資源。同次執行不可由不同引用實例共用同一資源。確認視窗列出實例、工具類型、後端、連線位址及可用設備資訊；若確認後後端或位址改變，必須重新確認。

Meters 直流電流使用 **10 A terminal** 時，還須確認實體導線接在 10 A 端子。

## Powers：狀態與清除保護

展開 Protection Setup 可查看 **Device Status**。它只在執行期間保留，不寫入範本；開啟 Setup 不會連線 Worker 或進行背景輪詢。Live Device 位於下方，兩種模式均保持可見。

- **Protection Summary** 集中顯示整體保護、OVP、OCP；讀取前皆為 **—**，之後依回報顯示 CLEAR / OK 或 TRIPPED。
- 通道列來自離線能力、範本既有設定與成功 **Refresh Status** 的回傳；重新整理也更新各列狀態。
- Simulation 使用模擬器通道，不需儲存連線；Live 依已保存的型號資訊建立通道列，不會因此連線儀器。能力不明時保留已設定通道，不猜測其他通道。即使無型號資訊，成功重新整理後也會顯示實際回傳通道，符合條件的保護觸發通道可使用 Clear Protection。
- 切換模式會清除舊狀態為 **—**，並顯示新模式已知的通道。

### 模擬：產生清除計畫

在 Simulation 按 Refresh Status，會啟動已設定的 powers-tool 模擬 Worker，不需 Live Resource。沒有操作執行中時，每個模擬器支援的通道皆可使用 **Generate Clear Plan...**，不要求保護已觸發。

確認後，程式送出模擬 Safe-Off All 及所選通道的 `clear-protection`，直接關閉 Worker，不重新讀取狀態。結果顯示 **PLAN GENERATED · SIMULATION** 與 **NO HARDWARE I/O**。**Show Plan** 顯示目標通道、先關閉輸出、清除保護、輸出維持關閉及無硬體 I/O；不顯示原始 JSON 或儀器指令，也不會改變真實保護狀態。

### 真實硬體：讀取及清除保護

1. 儲存後端及 Live Resource。若尚未儲存或有草稿，Device Status 會提示；此時不能讀取或清除。
2. 按 **Refresh Status**，使用已儲存的設定暫時連線 Powers。
3. 只有回報 OVP／OCP 觸發且沒有其他作業執行時，該通道的 **Clear Protection...** 才可用；操作前必須明確確認。
4. 程式先 Safe-Off All，只清除所選通道的保護鎖定，再重新讀取完整狀態。

清除保護不會排除觸發原因，也不會重新開啟輸出。若保護仍觸發，畫面會顯示尚未解除；若回讀顯示輸出仍開啟，程式會顯示警告，不隱藏或自動改變。

流程或其他手動外部操作執行期間，Refresh Status 與 Clear Protection 不可用。型號若不支援遠端清除，請依儀器安全規則從面板清除，再按 Refresh Status。

## Scopes：示波器設定

Scopes Setup 為選用設定。新的 instance 所有欄位都是 **Unchanged**。
**Acquisition Setup** 與 **Channel Configuration** 預設收合，可分別使用標題旁的
**+ / −** 獨立操作。收合會保留設定，Live Resource 維持在兩個群組之外。
**擷取類型（Acquisition Type）** 可選 **一般（Normal）**、**平均（Average）**、
**高解析度（High Resolution）** 或 **峰值偵測（Peak）**；只有選擇 **平均（Average）**
時才能編輯 Average Count。各通道列提供 Input Coupling、Probe Ratio、Bandwidth
Limit、Waveform Invert 與 Channel Units。只保存、套用及回讀明確指定的值；留白或選擇
Unchanged 不會送出命令。

### 設定項目對照

| 欄位 | 用途及可用值 |
| --- | --- |
| Acquisition Type | 擷取方式：Normal、Average、High Resolution、Peak。依型號支援。 |
| Average Count | 平均次數；僅 Average 可編輯，必須是型號支援的整數。 |
| Input Coupling | 輸入耦合：AC 或 DC。 |
| Probe Ratio | 探棒衰減倍率；依實際探棒及型號限制輸入數值。 |
| Bandwidth Limit | 頻寬限制：On／Off。 |
| Waveform Invert | 波形反相：On／Off。 |
| Channel Units | 通道單位：Volt 或 Amp。 |

Acquisition Setup 包含前兩項；Channel Configuration 按通道設定其餘欄位。所有欄位預設不變更（Unchanged／留白），只有明確指定的值才保存並送至儀器。實際支援範圍由工具提供。

### 型號、回讀確認及錯誤

控制項使用 Scopes 提供的離線 capabilities。Simulation 使用 Scopes 預設的
Keysight DSOX4024A profile；Live 使用所選 Resource 一起保存的 canonical model ID。
資訊未知或不可取得時，會停用新的設定並顯示原因。不支援的欄位仍顯示但反灰；
切換型號會保留既有值。實際型號支援與儀器限制由 Scopes 在套用 Setup 時驗證。
回讀失敗、缺少資料或與要求的值不符時，執行結果會顯示 Setup FAIL。錯誤會指出 instance，
若為通道設定也會指出 channel。Setup 成功後才會開始執行 Workflow Step。
例如將通道 2 的 Waveform Invert 設為 On，其餘維持 Unchanged，Setup 會先回讀確認通道 2
已反相，再開始 Workflow。

## Serial：通訊設定

在 Communication Setup 選擇 UART（COM Port）或 TCP Client。通訊參數保存於範本，COM Port 或 TCP Host／Port 則在 Live Device 保存於本機。

| 介面 | 欄位 | 用途及選項 |
| --- | --- | --- |
| UART | Baud Rate | 傳輸速率，正整數；新實例預設 115200，須與設備一致。 |
| UART | Data Bits | 每字元資料位元數：5、6、7、8，預設 8。 |
| UART | Parity | 同位檢查：None（預設）、Odd、Even。 |
| UART | Stop Bits | 停止位元數：1（預設）、2。 |
| UART | Flow Control | 流量控制：None（預設）、Software、Hardware。 |
| UART | Timeout (ms) | I/O 逾時毫秒數，非負整數，預設 1000。 |
| TCP | Connect Timeout (ms) | 建立連線的逾時，正整數；預設顯示 3000。 |
| TCP | I/O Timeout (ms) | 通訊 I/O 逾時，正整數；預設顯示 1000。 |

UART 參數應與設備一致；TCP 不提供探索，模擬不需要 Host 或 Port。詳細接收完成條件及逾時規則見 [Serial 步驟](../steps/serial.zh-TW.md)。
