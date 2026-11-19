//! Bundled, operator-facing CLI Help. Does not launch a Tool, Worker or Workflow.

use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

use clap::{Args, ValueEnum};

const EN_HTML: &[u8] = include_bytes!("cli_help/cli.html");
const ZH_HTML: &[u8] = include_bytes!("cli_help/cli.zh-TW.html");
const CSS: &[u8] = include_bytes!("cli_help/help.css");
const ASSETS: [(&str, &[u8]); 3] = [
    ("cli.html", EN_HTML),
    ("cli.zh-TW.html", ZH_HTML),
    ("help.css", CSS),
];

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Language {
    #[value(name = "en")]
    En,
    #[value(name = "zh-TW")]
    ZhTw,
}

impl Language {
    fn filename(self) -> &'static str {
        match self {
            Self::En => "cli.html",
            Self::ZhTw => "cli.zh-TW.html",
        }
    }
}

#[derive(Debug, Args)]
pub(crate) struct UserGuideArgs {
    /// Guide language (default: en).
    #[arg(long, value_enum, default_value_t = Language::En)]
    lang: Language,
}

impl UserGuideArgs {
    pub(crate) fn run(self) -> ExitCode {
        let result = cache_base().and_then(|base| open_with(&base, self.lang, launch_browser));
        match result {
            Ok(()) => {
                println!("Opened offline CLI user guide in the default browser.");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("orchestrator-tool: cannot open offline CLI user guide: {error}");
                ExitCode::FAILURE
            }
        }
    }
}

fn cache_base() -> io::Result<PathBuf> {
    #[cfg(windows)]
    {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set"))
    }
    #[cfg(not(windows))]
    {
        if let Some(path) = env::var_os("XDG_CACHE_HOME") {
            return Ok(PathBuf::from(path));
        }
        env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".cache"))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))
    }
}

fn fingerprint() -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for (name, bytes) in ASSETS {
        for byte in name.as_bytes().iter().copied().chain([0]).chain(bytes.iter().copied()) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

fn ensure_bundle(base: &Path) -> io::Result<PathBuf> {
    let dir = base
        .join("Orchestrator Tool")
        .join("help")
        .join("cli")
        .join(format!("{:016x}", fingerprint()));
    fs::create_dir_all(&dir)?;
    for (name, bytes) in ASSETS {
        let target = dir.join(name);
        if fs::read(&target).is_ok_and(|existing| existing == bytes) {
            continue;
        }
        let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
        fs::write(&tmp, bytes)?;
        if let Err(error) = fs::remove_file(&target)
            && error.kind() != io::ErrorKind::NotFound
        {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
        if let Err(error) = fs::rename(&tmp, &target) {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
    }
    Ok(dir)
}

fn file_url(path: &Path) -> io::Result<String> {
    let absolute = path.canonicalize()?;
    let normalized = absolute
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Help path is not UTF-8"))?
        .replace('\\', "/");
    let normalized = if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else if let Some(local) = normalized.strip_prefix("//?/") {
        local.to_owned()
    } else {
        normalized
    };
    let mut url = if normalized.starts_with("//") {
        String::from("file:")
    } else if normalized.starts_with('/') {
        String::from("file://")
    } else {
        String::from("file:///")
    };
    for byte in normalized.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            url.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(url, "%{byte:02X}").expect("formatting URL cannot fail");
        }
    }
    Ok(url)
}

fn open_with(
    base: &Path,
    language: Language,
    opener: impl FnOnce(&str) -> io::Result<()>,
) -> io::Result<()> {
    let dir = ensure_bundle(base)?;
    opener(&file_url(&dir.join(language.filename()))?)
}

fn launch_browser(url: &str) -> io::Result<()> {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "browser opener exited with {status}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assets_are_cached_repaired_and_browser_failures_propagate() {
        let path = env::temp_dir().join(format!(
            "orchestrator-cli-help-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        let dir = ensure_bundle(&path).unwrap();
        assert_eq!(fs::read(dir.join("cli.html")).unwrap(), EN_HTML);
        fs::write(dir.join("cli.zh-TW.html"), b"corrupt").unwrap();
        open_with(&path, Language::ZhTw, |url| {
            assert!(url.starts_with("file:///"));
            assert!(url.contains("cli.zh-TW.html"));
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read(dir.join("cli.zh-TW.html")).unwrap(), ZH_HTML);
        assert!(
            open_with(&path, Language::En, |_| Err(io::Error::other(
                "browser unavailable"
            )))
            .is_err()
        );
        fs::remove_dir_all(path).unwrap();
    }
}
