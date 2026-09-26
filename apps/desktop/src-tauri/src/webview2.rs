use std::ptr::{null, null_mut};

use windows_sys::{
    Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{
                IDYES, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_YESNO, MessageBoxW, SW_SHOWNORMAL,
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

pub fn show_startup_error(error: &str) {
    let message = format!(
        "Orchestrator Tool could not start.\n\nThe desktop runtime could not be initialized. Make sure Windows is supported and Microsoft Edge WebView2 Runtime is installed and up to date.\n\nDetails:\n{error}"
    );
    let wide_message: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            null_mut(),
            wide_message.as_ptr(),
            w!("Orchestrator Tool - Startup failed"),
            MB_OK | MB_ICONERROR,
        );
    }
}
