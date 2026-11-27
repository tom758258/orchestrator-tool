# Workflow 編輯器

<!-- help-source -->

## 編輯工作流程

| 區域 | 用途 |
| --- | --- |
| 步驟（Steps） | 選擇要加入的步驟 |
| 序列（Sequence） | 查看執行順序、選取及移動 |
| 屬性（Properties） | 設定選取步驟的參數 |
| Workflow summary | 驗證、執行、停止與錯誤訊息 |

### 步驟分類與功能索引

| 分類 | 步驟 |
| --- | --- |
| Workflow | For、While、If / Else、Set Variable、Output、Wait、Assert、Show Message、String Process、Byte Process、Array Process |
| Background Workflow | Worker ON / OFF、Capture ON / OFF |
| FG/BG Interaction | BG Command、Get Latest、Wait Next、Get Command Result、Get Buffer Data、Get Buffer Status |
| Meters | 電表量測（Meter Measure） |
| Powers | Power Set Output、Power Output ON / OFF、Power Measure、Power Protection Status |
| Scopes | Channel Display、Channel Scale、Channel Offset、Horizontal Scale、Horizontal Position、Edge Trigger、Single Wait、Measure、Capture、Screenshot、AutoScale |
| Serial | Send、Send File、Receive、Query |

各步驟的用途及限制見對應章節。Output 是輸出資料欄位，不是電源供應器的 Power Output ON。

### 分類何時可以使用？

| 分類 | 解鎖條件 |
| --- | --- |
| Workflow | 永遠可用 |
| Background Workflow | Setup 有背景設定 |
| FG/BG Interaction | 有背景設定且啟用 FG/BG Interaction |
| 儀器分類 | 範本含對應工具實例 |

可用分類依表中類型順序優先顯示；鎖定分類集中在底部的 **不可用分類（N）**，預設收合，沒有鎖定分類時隱藏。展開可查看原因，但不能選取鎖定分類或展開其內容。

- 新增或移除背景設定、工具實例會更新可用分類，不刪除既有步驟。實體連線、EXE 路徑、工具能力與執行模式不影響分類鎖定。
- 點擊可用分類的標題，可獨立展開（−）或收合（+）。程式啟動時可用分類預設展開；可用狀態變動會保留原本收合選擇。
- 成功新增或開啟範本後，不可用分類重新收合。收合狀態不寫入範本。
- Scopes File Output 有獨立收合狀態，與 Scopes 分類使用相同的工具實例解鎖條件。

### 編輯與重新命名

步驟可以放在根流程（Root）、迴圈內容（Body）或 If 分支。選取步驟後，在 **屬性（Properties）** 編輯參數。執行模擬或真實硬體時都會驗證範本，亦可先手動按 **驗證（Validate）**。

重新命名：在步驟 ID 旁按鉛筆，Enter 或儲存套用；Esc 或取消放棄。ID 只能使用小寫英文字母、數字及區段間的單一連字號，整個流程中不得重複。其他步驟對該 ID 的引用會同步更新；流程忙碌時不可編輯。

### 新增步驟

1. 在 **步驟（Steps）** 選擇類型；滑鼠停在按鈕上可查看完整名稱及功能。點擊只選取類型，不會立即新增。
2. 確認 **ADDING STEP TO** 顯示的目標；**Set Target to Root** 只改變目標。
3. 按 **新增步驟（Add Step）**。未選取類型時按鈕停用。
4. 新步驟會保持選取，方便在屬性區編輯；類型選取則清除。建立或開啟範本也會清除類型選取。

亦可直接把步驟類型拖曳至 **序列（Sequence）**，依放開位置新增，不使用 ADDING STEP TO 的目標。可插入既有步驟前後、根流程末端、IF 的 THEN／ELSE 分支或 FOR／WHILE 的內容（包括空白區塊）。放在無效位置不會新增。成功後選取新步驟、顯示屬性並清除類型選取。流程忙碌時不可拖曳新增。

### 工作流程控制項

**驗證（Validate）**、**執行模擬／執行真實硬體（Run Simulation / Run Live）**、**停止工作流程（Stop Workflow）** 與 active loop 的 **Stop** 控制項
位於 Workflow summary 右上方，與 **Template**、**步驟（Steps）** 資訊並排。驗證、
執行中、Stop 與 run 失敗回饋顯示在控制項下方、Builder 上方，並可在該處
查看詳細 run 錯誤。視窗較窄時控制項會換行。**清除工作流程（Clear Workflow）** 仍位於
**序列（Sequence）** header。

### 顯示密度及收合

**清除工作流程（Clear Workflow）** 右側的 **步驟顯示密度（Step Display Density）** 下拉選單提供
**精簡（Compact）**、**標準（Standard）**（預設）及 **寬鬆（Comfortable）**。顯示密度儲存在本機，
不同 Template 共用，不會修改 Workflow 資料。

在 **序列（Sequence）**，每個 **FOR**、**WHILE**、**IF** Step 都有獨立的展開／收合箭頭；
**IF** 的 **THEN**、**ELSE** 也能分別收合。Sequence 標題下方提供
**全部展開（Expand All）** 與 **全部收合（Collapse All）**。收合時隱藏子 Steps，但保留數量及必要的
選取、驗證警告、執行失敗提示。切換頁籤會保留目前收合狀態；新建或開啟 Template
會全部展開。拖曳到收合的容器前須先展開；使用 **新增步驟（Add Step）** 成功新增後會展開目標。

### 編輯後的錯誤訊息

修改工作流程步驟、工具執行設定或背景設定時，摘要區會立即隱藏上次執行失敗或 Live 啟動錯誤。即使沒有修改，按 **驗證（Validate）** 也會隱藏舊回饋；驗證顯示自己的結果，**有效（Valid）** 不代表一定能成功執行。新執行失敗時仍顯示錯誤及 **Technical details**。只選取步驟、切換頁籤或調整顯示選項則保留目前錯誤。

上述操作不會清除 Last Run：原本的狀態、診斷、執行記錄、已提交資料列、背景資料集及部分匯出仍保留。上次失敗在輸出頁仍是 Failed；Live Preflight 失敗是獨立回饋，代表真實硬體執行尚未開始。

### 選取及移動步驟

| 操作 | 效果 |
| --- | --- |
| Click | 單選步驟 |
| Ctrl+Click | 加入或移除個別步驟 |
| Shift+Click | 選取從起點開始的連續範圍 |
| Up／Down | 在同一清單內移動選取項一個位置；任一項到邊界即停用 |
| Delete | 已選取步驟的按鈕刪除整組選取；未選取的按鈕只刪除該步驟 |

多選限同一層清單（根流程或同一個 For／While 的內容）；跨清單使用 Ctrl／Shift 點擊會建立新選取。屬性區只能編輯單一步驟，多選時顯示數量。刪除迴圈也刪除其內容。

拖曳步驟旁的把手可排序，亦可在根流程、For Body、While Body 之間搬移：

- 拖到卡片上半部或下半部，分別插入前方或後方；拖到 Body 空白處加入末端，空 Body 也可接收。
- 拖到根流程末端的空白處可移回 Root。插入線顯示目標；接近序列上下邊界時自動捲動。
- 拖曳已選取步驟時搬移整組選取（包括不相鄰項），保留相對順序。搬移迴圈時連同內容搬移，ID、參數、繫結及引用均保留。
- 控制區塊不得放入自己或其子孫，If／For／While 巢狀不得超過八層。拖曳不驗證執行語意，完成後請使用 Validate。

### 快捷鍵

| 快捷鍵 | 功能 |
| --- | --- |
| Ctrl+C | 複製選取步驟 |
| Ctrl+X | 剪下至程式內部剪貼簿 |
| Ctrl+V | 貼到最後一個選取步驟後；未選取時貼到 Root 最後 |
| Delete | 刪除選取步驟；未選取時不動作 |
| Ctrl+A | 全選目前同層步驟；未選取時全選 Root，不含巢狀 Body |

剪下後首次貼上若無 ID 衝突，保留原 ID 與內部引用。重複貼上或有衝突時，沿用 ID 重配及唯一 Output Name 規則；Output Name 或 Page 衝突也依既有規則處理。貼上後選取新增步驟。

內部 Clipboard 在本次 application session 內保留。input、textarea、select 與
可編輯文字保留原生快捷鍵。Workflow busy 時仍可選取與 Copy，但 Drag、Up／Down、
Cut、Delete 與 Paste 會停用。

### 驗證與引用範圍

**驗證（Validate）**、**執行模擬（Run Simulation）** 與 **執行真實硬體（Run Live）** 使用相同的 Core Template 驗證。
失敗時保留整體錯誤訊息；若錯誤能可靠定位 Step，該卡片會有紅框與警告圖示，
選取後可在 Properties 查看原因。無法可靠定位的錯誤只顯示整體訊息。
修改 Workflow 後會清除舊標記，下次 Validate 或 Run 才重新檢查。
無效 Template 不會啟動 Worker。搬移後可使用 Validate 檢查引用與作用域：
For 變數不能在 Body 外使用，除非該外層作用域原本已有該變數值。
在 Loop 內新建的一般變數限該次迭代使用；更新繼承變數的值則會保留。
驗證會檢出可靜態確定無法取得的變數，需要實際值才能判斷的錯誤仍由執行期處理。
