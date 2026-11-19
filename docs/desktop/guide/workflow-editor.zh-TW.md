# Workflow 編輯器

<!-- help-source -->

## 6. Workflow Editor

Workflow editor 用來建立有順序的 steps。目前的 step types 是：

- **Assert** — 檢查 condition，不成立時使 Workflow failure。
- **Set Variable** — 建立或更新 Workflow variable。
- **輸出（Output）** — 將值發布為 final workflow result column，不控制 Powers output。
- **Wait** — 等待指定時間。
- **Tool Action** — 對設定好的 Tool Instance 執行 action，例如 Powers set、
  output action 或 Meters measurement。
- **For** — 依 exact decimal range 重複執行 body。
- **While** — 在 condition 為 true 時重複執行 body。
- **If / Else** — 依 comparison 執行 THEN 或 ELSE，ELSE 可為空。

**步驟（Steps）** 分類在各群組內維持原本順序：**工作流程（Workflow）**、
**Background Workflow**、**FG/BG Interaction**、**Meters**、**Powers**、
**Scopes**、**Serial**。可用分類優先顯示，鎖定分類集中放到最下方的
**不可用分類（N）** 區塊。這個區塊預設收合；展開後可查看各鎖定分類及原有原因。
若沒有鎖定分類，區塊會隱藏。Workflow 永遠可用。Background Workflow
需要在 Setup 啟用 Background Binding；FG/BG Interaction 還需要在
Workflow 左側勾選 **啟用前景／背景互動（Enable FG/BG Interaction）**。
儀器分類需要 Template 內有對應的 Tool Instance。鎖定分類不能展開或選取；
新增或移除 Binding、Tool Instance 會更新分組，但不會刪除既有 Steps。
Live Resource、EXE 配置、capabilities 與 Execution Mode
都不影響這些分類的鎖定條件。

點擊可用分類的標題，可獨立展開或收合該分類。展開時顯示 **−**；
收合時顯示 **+** 並隱藏該分類的步驟按鈕。App 開啟時可用分類預設展開；
分類的可用狀態改變不會清除各自的展開／收合選擇。成功新增或開啟
Template 後，不可用分類區塊重新收合。UI 收合狀態不會儲存於 Template。
**Scopes File Output** 維持獨立面板及自己的展開／收合狀態，
並採用相同的 Scopes Tool Instance 鎖定條件。

Steps 可以放在 root workflow、loop body 或 If 分支中。使用 step properties 編輯選取的
step；需要先檢查目前 Template 時可使用 Validate，Simulation 與 Live 在 run
啟動時也會驗證 Template，因此先按 Validate 有用，但不是獨立的 run 必要條件。
在屬性（Properties）的步驟 ID 旁按鉛筆可重新命名；按 Enter 或儲存套用，按 Esc 或取消放棄。ID 只能使用小寫英文字母、數字及區段間的單一連字號，且在整個 Workflow 中不可重複。重新命名會同步更新其他步驟對該 ID 的引用；Workflow 忙碌時不可編輯。

在 **步驟（Steps）** 中，滑鼠停留於可用的 Step 按鈕上，可透過原生
提示視窗查看該步驟的簡短功能說明。點擊 Step 類型只會選取，不會立即加入
Workflow。**已選取的步驟（Selected Step）** 與 **新增步驟（Add Step）**
固定在可捲動的分類清單上方。未選取類型時 **新增步驟（Add Step）**
停用；按下後才會將 Step 加入 **ADDING STEP TO** 顯示的目標位置。
新增成功後會清除 Palette 的類型選取，但 Workflow 中新加入的 Step
仍保持選取，方便編輯。**Set Target to Root** 只切換新增目標，不會
新增 Step。建立或開啟 Template 也會清除 Palette 的選取。
所有 Step Palette 按鈕採相同的單行高度。過長名稱會縮短或顯示省略號；滑鼠提示仍提供完整名稱與功能說明。

也可以從 **步驟（Steps）** 將 Step 類型拖曳到 **序列（Sequence）** 指定位置，依滑鼠放開時的
落點新增，不使用 **ADDING STEP TO** 目標。可放在既有 Step 前後、Root 末端，
或 IF 的 **THEN**／**ELSE**、FOR／WHILE Body（包括空白區塊）。放在無效位置
不會新增 Step。新增成功後會選取新 Step，在 **屬性（Properties）** 顯示設定，
並清除 Palette 類型選取。Workflow 編輯忙碌時不可拖曳新增。

**驗證（Validate）**、**執行模擬／執行真實硬體（Run Simulation / Run Live）**、**停止工作流程（Stop Workflow）** 與 active loop 的 **Stop** 控制項
位於 Workflow summary 右上方，與 **Template**、**步驟（Steps）** 資訊並排。驗證、
執行中、Stop 與 run 失敗回饋顯示在控制項下方、Builder 上方，並可在該處
查看詳細 run 錯誤。視窗較窄時控制項會換行。**清除工作流程（Clear Workflow）** 仍位於
**序列（Sequence）** header。

**清除工作流程（Clear Workflow）** 右側的 **步驟顯示密度（Step Display Density）** 下拉選單提供
**精簡（Compact）**、**標準（Standard）**（預設）及 **寬鬆（Comfortable）**。顯示密度儲存在本機，
不同 Template 共用，不會修改 Workflow 資料。

在 **序列（Sequence）**，每個 **FOR**、**WHILE**、**IF** Step 都有獨立的展開／收合箭頭；
**IF** 的 **THEN**、**ELSE** 也能分別收合。Sequence 標題下方提供
**全部展開（Expand All）** 與 **全部收合（Collapse All）**。收合時隱藏子 Steps，但保留數量及必要的
選取、驗證警告、執行失敗提示。切換頁籤會保留目前收合狀態；新建或開啟 Template
會全部展開。拖曳到收合的容器前須先展開；使用 **新增步驟（Add Step）** 成功新增後會展開目標。

修改 Workflow steps、Tool Setup 的執行設定，或 Background Binding／Setup 時，
Workflow summary 會立即隱藏上次 run failure 或 Live 啟動錯誤。即使沒有修改，
按下 **驗證（Validate）** 也會立即隱藏這些回饋。驗證會顯示自己的結果；**有效（Valid）** 不保證
run 一定成功。新的 run 若失敗，仍會顯示該次錯誤與 **Technical details**。
選取 step、切換 tab 或調整顯示選項會保留目前的錯誤回饋。

這些操作會保留 Last Run 原本的狀態、診斷、Execution Results、已提交的 Output
rows、Background datasets 與 partial export 能力。Failed Last Run 在 **輸出（Output）**
中仍維持 Failed。Live Preflight failure 維持獨立回饋，表示 Live run 尚未開始。

在 **序列（Sequence）** 點擊 step 可單選；**Ctrl+Click** 加入或移除個別 step，
**Shift+Click** 從選取起點選取連續範圍。多選只限同一 sibling list：root
steps，或同一個 For／While 的 body。在另一個 list 使用 Ctrl／Shift 點擊時，
會改為該處的新選取。**屬性（Properties）** 只可編輯單一 step；多選時顯示選取數量。

拖曳 step 旁的 handle 可排序，也可在 Root、For Body 與 While Body 間搬移。
拖到卡片上半部或下半部可插入其前方或後方；拖到 Body 空白處可加到最後，
空白 Body 也可接收。插入線會顯示目標位置。拖到 Root list 最後的空白處即可
移回 Root。拖曳已選取 step 會搬移整個 selection，包括不相鄰的 steps，並保持
原本相對順序。搬移 Loop 會保留整個 Body；ID、參數、Binding 與引用皆保留。
Editor 禁止將控制區塊放入自己或其子孫，以及超過八層 If／For／While 巢狀深度；拖曳時
不驗證執行語意。接近 Sequence 上下邊界時會自動捲動。

**Up**／**Down** 在同一 list 內將 selection 移動一個位置；任何選取 step 碰到
該方向邊界時會停用。已選取 step 的 **Delete** 按鈕會刪除整個 selection；
未選取 step 的 Delete 按鈕只刪除該 step。刪除 Loop 也會刪除其 Body。

焦點位於 Workflow editor 時：

- **Ctrl+C** 複製選取的 steps。
- **Ctrl+X** 剪下選取的 steps 到應用程式內部 Clipboard。首次貼上若無 ID 衝突，
  保留原 ID 與內部引用；後續重複貼上或首次已有 ID 衝突時，沿用 Copy／Paste
  的 ID 重配與唯一 Output Name 規則。Output Name 或 Page 衝突也沿用既有 Paste 規則。
- **Ctrl+V** 貼到最後一個選取 step 後；未選取時貼到 Root 最後。貼上的 steps
  會成為新 selection。
- **Delete** 鍵刪除目前 selection；沒有選取 step 時不動作。
- **Ctrl+A** 全選 active step 的直接 siblings；沒有選取時全選 Root steps，
  不會同時選取巢狀 Loop Body 內的子 steps。

內部 Clipboard 在本次 application session 內保留。input、textarea、select 與
可編輯文字保留原生快捷鍵。Workflow busy 時仍可選取與 Copy，但 Drag、Up／Down、
Cut、Delete 與 Paste 會停用。

**驗證（Validate）**、**執行模擬（Run Simulation）** 與 **執行真實硬體（Run Live）** 使用相同的 Core Template 驗證。
失敗時保留整體錯誤訊息；若錯誤能可靠定位 Step，該卡片會有紅框與警告圖示，
選取後可在 Properties 查看原因。無法可靠定位的錯誤只顯示整體訊息。
修改 Workflow 後會清除舊標記，下次 Validate 或 Run 才重新檢查。
無效 Template 不會啟動 Worker。搬移後可使用 Validate 檢查引用與作用域：
For 變數不能在 Body 外使用，除非該外層作用域原本已有該變數值。
在 Loop 內新建的一般變數限該次迭代使用；更新繼承變數的值則會保留。
驗證會檢出可靜態確定無法取得的變數，需要實際值才能判斷的錯誤仍由執行期處理。

