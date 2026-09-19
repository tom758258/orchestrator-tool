use std::ptr::{null, null_mut};

use windows_sys::{
    Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{
                IDYES, MB_ICONWARNING, MB_OK, MB_YESNO, MessageBoxW, SW_SHOWNORMAL,
            },
        },
    },
    core::w,
};

/// Runs before Tauri creates any window; no WebView is needed for this dialog.
pub fn preflight() -> bool {
    if tauri::webview_version().is_ok_and(|version| !version.trim().is_empty()) {
        return true;
    }

    // All native calls use null owners and static, null-terminated strings.
    unsafe {
        let answer = MessageBoxW(
            null_mut(),
            w!(
                "Microsoft Edge WebView2 Runtime is required to run Orchestrator Tool.\n\nPlease install WebView2 Runtime and restart the application.\n\nOpen the official Microsoft download page?\nYes: Download WebView2\nNo: Close\n\nhttps://developer.microsoft.com/microsoft-edge/webview2/"
            ),
            w!("Orchestrator Tool - WebView2 required"),
            MB_YESNO | MB_ICONWARNING,
        );
        if answer == IDYES {
            let initialized = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) >= 0;
            let result = ShellExecuteW(
                null_mut(),
                w!("open"),
                w!("https://developer.microsoft.com/microsoft-edge/webview2/"),
                null(),
                null(),
                SW_SHOWNORMAL,
            );
            if initialized {
                CoUninitialize();
            }
            if result as isize <= 32 {
                MessageBoxW(
                    null_mut(),
                    w!(
                        "Could not open your browser. Please visit:\n\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\nInstall WebView2 Runtime, then restart Orchestrator Tool."
                    ),
                    w!("Orchestrator Tool - WebView2 required"),
                    MB_OK | MB_ICONWARNING,
                );
            }
        }
    }
    false
}
