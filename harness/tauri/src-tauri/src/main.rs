//! nanoMuse Desktop on Tauri (spike): start the dsh Host as a sidecar Node
//! process, read its `dsh web: <url>` line, and point the main window at it.
//!
//! The Host tree is the same one `harness/desktop/scripts/prepare-dsh.mjs`
//! stages (`dsh/node_modules/@deepseek-ai/dsh`), shipped as a Tauri resource.
//! The runtime for the hands reaches the Host the same way as under Electron:
//! `NANOMUSE_PY` when set, else the bundled `runtime/` executable, else
//! `nanomuse` on PATH. The operator endpoints (`/info`, `/screenshot`,
//! `/execute`) are still to port — see README.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};

const PROFILE: &str = "nanomuse";
const READY_TIMEOUT_SECS: u64 = 120;
/// 4.5 GiB: at or below this the small-machine profile applies (see is_low_mem).
const LOW_MEM_BYTES: u64 = 4_831_838_208;

struct HostState(Mutex<Option<tokio::process::Child>>);

fn resource_dir() -> PathBuf {
    // Tauri resolves resource paths at runtime; during `cargo run` the tree
    // sits next to this workspace (prepare-dsh.mjs --out ../tauri/dsh-stub).
    if let Ok(dir) = std::env::var("NANOMUSE_DSH_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn host_bin(base: &Path) -> PathBuf {
    for root in [base.join("dsh"), base.join("dsh-stub")] {
        let bin = root.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        if bin.exists() {
            return bin;
        }
    }
    base.join("dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")
}

fn runtime_exe(base: &Path) -> Option<PathBuf> {
    let exe = base.join("runtime").join(if cfg!(windows) {
        "nanomuse.exe"
    } else {
        "nanomuse"
    });
    if exe.exists() {
        return Some(exe);
    }
    // `nanomuse` on PATH: the -min story without a bundled runtime.
    let which = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(which)
        .arg("nanomuse")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8(o.stdout).ok().and_then(|s| {
                s.lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(PathBuf::from)
            })
        })
        .filter(|p| p.exists())
}

fn host_home() -> PathBuf {
    if let Ok(home) = std::env::var("NANOMUSE_DESKTOP_HOME") {
        return PathBuf::from(home);
    }
    let base = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    base.join(".nanomuse/desktop")
}

/// A free loopback port, so the window's origin (and its stored state) stays
/// stable: the last port first, then the default, then any free one.
fn pick_port(last: u16) -> u16 {
    for candidate in [last, 38421] {
        if candidate != 0 && std::net::TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return candidate;
        }
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(38421)
}

async fn spawn_host(port: u16) -> Result<(tokio::process::Child, String), String> {
    let base = resource_dir();
    let bin = host_bin(&base);
    if !bin.exists() {
        return Err(format!(
            "the harness is not staged: {} is missing (run prepare-dsh.mjs)",
            bin.display()
        ));
    }
    let home = host_home();
    let _ = std::fs::create_dir_all(&home);
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg("--expose-internals")
        .arg(&bin)
        .arg(PROFILE)
        .arg("--no-open")
        .arg("--port")
        .arg(port.to_string())
        .env("DSH_HOME", &home)
        .env("NANOMUSE_MCP_CONFIRM", random_hex(24))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if std::env::var("NANOMUSE_PY").is_err() {
        if let Some(exe) = runtime_exe(&base) {
            cmd.env("NANOMUSE_PY", exe);
        }
    }
    if is_low_mem() {
        // the same cap the Electron shell applies (main.ts): the Host holds
        // chats, rooms and trajectory in one Node process.
        if std::env::var("NODE_OPTIONS").is_err() {
            cmd.env("NODE_OPTIONS", "--max-old-space-size=768");
        }
        if std::env::var("UV_THREADPOOL_SIZE").is_err() {
            cmd.env("UV_THREADPOOL_SIZE", "2");
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start node: {e}"))?;
    let stdout = child.stdout.take().ok_or("host has no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let deadline = std::time::Duration::from_secs(READY_TIMEOUT_SECS);
    loop {
        let line = tokio::time::timeout(deadline, lines.next_line())
            .await
            .map_err(|_| "the host did not announce its address in time".to_string())?
            .map_err(|e| format!("could not read the host output: {e}"))?
            .ok_or("the host exited before it was ready".to_string())?;
        if let Some(url) = line.split("dsh web: ").nth(1) {
            return Ok((child, url.trim().to_string()));
        }
    }
}

fn random_hex(bytes: usize) -> String {
    // No extra dependency for one secret: read what the OS offers.
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("/dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_low_mem() -> bool {
    match std::env::var("NANOMUSE_LOW_MEM").as_deref() {
        Ok("1") => return true,
        Ok("0") => return false,
        _ => {}
    }
    // sysinfo would be another dependency; parse /proc/meminfo on Linux.
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| {
            m.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| {
                    l.split_whitespace()
                        .nth(1)
                        .and_then(|kb| kb.parse::<u64>().ok())
                        .map(|kb| kb * 1024 <= LOW_MEM_BYTES)
                })
        })
        .unwrap_or(false)
}

fn main() {
    tauri::Builder::default()
        .manage(HostState(Mutex::new(None)))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let port = pick_port(0);
                match spawn_host(port).await {
                    Ok((child, url)) => {
                        if let Ok(mut slot) = handle.state::<HostState>().0.lock() {
                            *slot = Some(child);
                        }
                        if let (Some(w), Ok(url)) = (handle.get_webview_window("main"), url.parse())
                        {
                            let _ = w.navigate(url);
                        }
                    }
                    Err(e) => eprintln!("nanoMuse: {e}"),
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start nanoMuse");
}
