# 設定外部工具

<!-- help-source -->

## 4. 設定 external Tools

Executable path 屬於 Tool Type，由同一 Tool Type 的所有 Tool Instances 共用；
個別 Tool Instance 不會各自保存一份 executable path。

在 **工具（Tools）** 的 **選擇要加入的工具（Select tool to add）** 選擇尚未配置的 Tool Type，按 **加入工具（Add Tool）**，
再選擇 external tool distribution 提供的真正 executable。Desktop 會在保存 path 前驗證 executable manifest，以及它
是否符合預期 Tool Type 的 Worker compatibility。Tool ID 錯誤或 Worker 不相容
的 path 會被拒絕，且不會取代原本有效的 path。取消 picker 不會變更設定。
在 Tool card 使用 **變更路徑…（Change Path...）** 替換 path，或使用 **移除工具（Remove Tool）** 只移除
本機 executable configuration。移除 Tool 不會變更 Template instances 或
Workflow steps；該 Tool Type 會回到 Add 候選。

每張 External Tools card 預設收合，保留 Tool 名稱與 executable 狀態。
使用 **+ / −** 可獨立顯示或隱藏詳細資訊及 Change Path／Remove Tool 操作。
Refresh 與切換頁籤會保留各卡片的展開／收合狀態。

Cards 只顯示已配置 executable path 的 Tool Type，即使 path 為 **不存在（Missing）**、
**不是檔案（Not a file）** 或有 compatibility / manifest error，仍會顯示。未配置的 Tool
Type 會出現在 Add 候選。全部未配置時顯示 **尚未設定外部工具。（No external tools configured.）**；
全部已配置時停用 Add。Cards 顯示 availability、compatibility，並在可用時顯示原因。Desktop 不會搜尋
`PATH`、Windows registry 或任意資料夾，也不會靜默 fallback 到其他 executable。

若 external tool 以 PyInstaller `onedir` 形式發行，operator 應選擇該
distribution 裡真正的 executable。Orchestrator Tool 不會搬移或複製 executable
或其 `_internal` 目錄。

