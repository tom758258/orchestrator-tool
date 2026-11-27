# 設定外部工具

<!-- help-source -->

## 選擇正確的執行檔

外部工具是獨立的程式。Orchestrator 只記住各工具的執行檔路徑，並在需要時啟動其 CLI／Worker。它不會附帶或安裝這些工具，也不需要你先開啟外部工具的 Desktop 或 WebUI。

| 工具類型（Tool Type） | 用途 | Tools 應選擇的 EXE |
| --- | --- | --- |
| [Meters](https://github.com/tom758258/meters-tool) | 數位電表 | `meters-tool.exe` |
| [Powers](https://github.com/tom758258/powers-tool) | 電源供應器 | `powers-tool.exe` |
| [Scopes](https://github.com/tom758258/scopes-tool) | 示波器 | `scopes-tool.exe` |
| [Serial](https://github.com/tom758258/serial-tool) | UART／TCP 通訊 | `serial-tool.exe` |
| [Wavegen](https://github.com/tom758258/wavegen-tool) | 波形產生器 | 尚不支援工作流程執行；獨立專案目前說明 Python CLI，並未提供獨立 Windows 發行包的建置方式。 |

只需準備你會使用的工具。相容版本及支援的儀器請以各專案發行說明為準；檔名正確不代表一定相容。

### 為什麼同一個工具有好幾個 EXE？

Meters、Powers、Scopes 的 Windows 發行包可能包含多個執行檔。只有 CLI／Worker 執行檔應在 Tools 中選取，其餘檔案仍須保留在原發行包中。

| 工具 | Orchestrator 要選的 CLI／Worker | 其他介面與輔助程式（不要選） |
| --- | --- | --- |
| Meters | `meters-tool.exe` | `Meters Tool.exe`、`meters-tool-webui-launcher.exe`、`meters-tool-webui-host.exe` |
| Powers | `powers-tool.exe` | `Powers Tool.exe`、`powers-tool-webui-launcher.exe`、`powers-tool-webui-host.exe` |
| Scopes | `scopes-tool.exe` | `Scopes Tool.exe`、`scopes-tool-webui-launcher.exe`、`scopes-tool-webui-host.exe` |

| 檔案類別 | 用途 |
| --- | --- |
| Desktop（例如 `Meters Tool.exe`） | 獨立圖形操作介面 |
| WebUI Launcher | 啟動瀏覽器操作介面 |
| WebUI Host | Desktop 使用的內部輔助程式 |
| `_internal/` | 共用 Python 執行環境及相依檔案 |

Serial 使用不同的 Windows 發行方式：`Serial Tool.exe` 為獨立 Desktop，`serial-tool.exe` 為 CLI／Worker。發行包包含兩個獨立 EXE 及授權文件，不是上述 Python onedir 結構。

## 完整解壓縮並保留資料夾

如果外部工具使用 PyInstaller `onedir` 發行，EXE 需要同資料夾的執行環境。請完整解壓縮 ZIP、保留所有檔案及資料夾，再選取原本位置的 CLI 執行檔。不要只複製一個 EXE 到 Orchestrator 資料夾，也不需要先開啟外部工具的 Desktop 或 WebUI。

以下為資料夾配置範例，並非強制路徑或完整檔案清單：

```text
D:/InstrumentTools/
  Orchestrator/
    Orchestrator Tool.exe
    orchestrator-tool.exe
  Meters/
    Meters Tool.exe
    meters-tool.exe              <-- 選擇此檔案
    meters-tool-webui-launcher.exe
    meters-tool-webui-host.exe
    _internal/                   <-- 與 EXE 一起保留
    resources/
    ...
  Serial/
    Serial Tool.exe
    serial-tool.exe              <-- 選擇此檔案
    ...
```

Powers 與 Scopes 的 Python 發行包也適用相同原則。Orchestrator 不會搬移或複製 EXE 或 `_internal` 目錄。若日後搬移整個發行包，請使用變更路徑重新指定位置。

## 新增外部工具

1. 開啟 **工具（Tools）** 頁面。
2. 在 **選擇要加入的工具（Select tool to add）** 選擇尚未設定的工具類型。
3. 按 **加入工具（Add Tool）**，選擇對應的 CLI／Worker 執行檔。
4. 確認檔案可用且相容。程式會在儲存路徑前檢查 Manifest（工具身分及支援的介面資訊）及 Worker 相容性。
5. 前往 **設定（Setup）** 新增想使用的工具實例。

選錯工具類型（Tool ID）或 Worker 不相容時會拒絕設定，不會覆蓋原本有效的路徑。取消檔案選擇視窗也不會變更設定。

## 如何看懂工具狀態

| 狀態或情況 | 代表意義 | 處理方式 |
| --- | --- | --- |
| 執行檔可用 | 找得到已設定的檔案 | 繼續確認相容性；不代表已完成實體儀器測試。 |
| 不存在（Missing） | 原路徑的檔案已不存在 | 使用變更路徑選擇目前的 EXE。 |
| 不是檔案（Not a file） | 路徑不是檔案 | 選擇正確的 EXE。 |
| Manifest 或相容性錯誤 | 工具身分或介面檢查失敗 | 確認執行檔、版本及畫面顯示的原因。 |
| 尚未設定外部工具。（No external tools configured.） | 沒有已儲存的路徑 | 使用加入工具。 |

卡片只顯示已設定的工具類型，即使檔案遺失或相容性錯誤也會保留。未設定的類型出現在新增清單；全部已設定時無法再新增。程式不會搜尋 `PATH`、Windows 登錄檔或任意資料夾，也不會擅自改用其他執行檔。

## 管理已設定的工具

| 操作 | 用途 |
| --- | --- |
| 變更路徑…（Change Path...） | 通過驗證後更換已儲存的執行檔路徑。 |
| 移除工具（Remove Tool） | 只移除本機執行檔設定，該類型回到新增清單。 |
| 重新整理（Refresh） | 重新檢查工具狀態。 |
| + / − | 展開或收合卡片詳細資訊與操作。 |

工具卡片預設收合，保留名稱及執行檔狀態。重新整理與切換頁籤會保留卡片的展開狀態。移除工具不會刪除程式檔案、範本內的工具實例或工作流程步驟。

## 一個執行檔，多個工具實例

在 Tools 中，每種工具類型只需設定一次執行檔。Setup 中的每個具名工具實例可以有自己的量測設定及受支援的本機實體儀器連線。

```text
Tools: Meters -> meters-tool.exe
                  |
                  +-- Setup: 電表 A（DC Voltage）
                  |
                  +-- Setup: 電表 B（DC Current）
```

兩個實例共用同一個 EXE；個別實例不會另存執行檔路徑。路徑屬於本機設定，不會隨範本攜帶。
