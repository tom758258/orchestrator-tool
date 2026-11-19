# 快速開始

<!-- help-source -->

## 1. Overview

Orchestrator Tool Desktop 透過 reusable Template 協調獨立的 external tools。
你可以設定 Tool Type、建立 logical Tool Instance、編排有順序的 Workflow，
並以 Simulation 或 Live mode 執行。Run 完成後，Desktop 會顯示 committed
Results、Output Pages、Charts 與 Data，並可匯出目前可用的結果。

Desktop 是主要的 Workflow 操作介面。External tools 仍是獨立的程式與
distribution，不包含在 orchestrator-tool 內。

## 2. Requirements

- Application 以 Windows 為優先平台。
- Application 使用系統的 Microsoft Edge WebView2 Runtime。若未偵測到可用的
  WebView2 Runtime，Desktop 會在建立 Tauri WebView 前顯示 native warning，並可
  開啟 Microsoft 官方下載頁；application window 不會建立。若 availability check
  已通過但 main Tauri/WebView window 仍無法初始化，Desktop 會顯示包含實際 Tauri
  error detail 的 native startup error 並結束。Application 不會自動下載或安裝
  WebView2。
- Meters、Powers、Scopes 與 Wavegen 是獨立的 external tool distributions。
  請分別安裝與維護，再於 Desktop 設定實際 executable path。

本指南不假設目前存在 external tool 的 installer 或 package deployment 流程。

## 3. Main Desktop areas

Desktop 目前的 tabs 是：

- **工具（Tools）** — 設定各 Tool Type 的 executable path，檢查 availability 與
  compatibility。
- **設定（Setup）** — 建立 Tool Instance、編輯各 instance 的 setup，並在支援時
  保存或清除 local Live Resource。
- **工作流程（Workflow）** — 編輯有順序的 steps、驗證 Template、執行 Simulation 或
  Live、要求 graceful Stop，以及設定 CSV streaming。
- **輸出（Output）** — 檢視 Last Run、execution results、Output Pages、Charts、
  Summary、Output Data，並進行 manual export。

畫面右上角依序提供 **外觀**、**語言** 與 **說明**。下一列左側的
**Template／範本** 集中 **新增範本**、**開啟範本** 與 **儲存範本**；
**執行模式** 維持在右側。點擊 **使用說明** 會在獨立的應用程式視窗開啟
內建的離線 Desktop 使用指南。

全域 **執行模式（Execution Mode）** selector 控制整次 Desktop execution，不是各 Tool Instance
各自選擇。Desktop 啟動時預設為 **模擬（Simulation）**，New Template 或 Open Template
後也會回到 Simulation。醒目的 **模擬 · 無硬體 I/O（SIMULATION · NO HARDWARE I/O）** 或
**真實硬體 · 實際硬體操作（LIVE · REAL HARDWARE）** 標示，以及每個 Tool Instance 上相同的 badge，會顯示
目前 target。Workflow 或 manual external operation 執行期間 selector 會鎖定。
Execution Mode 只屬於 session state，不會保存到 Template 或 local configuration。

Meters、Powers、Scopes 與 Wavegen instances 都會顯示此 badge。Badge 不代表新增
Wavegen runtime 支援；Scopes 支援下方列出的 Workflow actions。

