use tauri::{AppHandle, Emitter};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct VideoInfo {
    title: String,
    thumbnail: String,
    duration: u32,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    percent: f64,
    status: String,
}

/// Locate an executable bundled in src-tauri/bin/ (dev) or next to the app binary (prod).
fn find_bundled(name: &str) -> Result<String, String> {
    let exe_name = format!("{}.exe", name);

    // 1. Check next to current executable (for production builds)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            let candidate = dir.join("bin").join(&exe_name);
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().to_string());
            }
            let candidate = dir.join(&exe_name);
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().to_string());
            }
        }
    }

    // 2. Check CARGO_MANIFEST_DIR/bin (for dev mode with `cargo run`)
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let candidate = std::path::PathBuf::from(&manifest_dir).join("bin").join(&exe_name);
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    // 3. Try system PATH as last resort
    if Command::new(name)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return Ok(name.to_string());
    }

    Err(format!(
        "{} not found. Expected it in src-tauri/bin/{} or in system PATH.",
        name, exe_name
    ))
}

/// Parse yt-dlp output lines to extract download percentage.
/// yt-dlp outputs lines like: [download]  45.2% of 5.07MiB at 1.23MiB/s ETA 00:03
fn parse_ytdlp_progress(line: &str) -> Option<f64> {
    if !line.contains("[download]") {
        return None;
    }
    // Look for a pattern like "XX.X%" 
    let trimmed = line.trim();
    for part in trimmed.split_whitespace() {
        if part.ends_with('%') {
            if let Ok(val) = part.trim_end_matches('%').parse::<f64>() {
                return Some(val);
            }
        }
    }
    None
}

#[tauri::command]
async fn get_youtube_info(url: String) -> Result<VideoInfo, String> {
    let ytdlp = find_bundled("yt-dlp")?;

    let output = Command::new(&ytdlp)
        .args(["--dump-json", "--no-playlist", &url])
        .output()
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error: {}", err));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);

    let v: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    let title = v["title"].as_str().unwrap_or("Unknown").to_string();
    let thumbnail = v["thumbnail"].as_str().unwrap_or("").to_string();
    let duration = v["duration"].as_u64().unwrap_or(0) as u32;

    Ok(VideoInfo { title, thumbnail, duration })
}

#[tauri::command]
async fn download_youtube(app: AppHandle, url: String, format: String, quality: String) -> Result<(), String> {
    let ytdlp = find_bundled("yt-dlp")?;

    let mut args = vec!["--newline".to_string(), "--progress".to_string(), "-o".to_string(), "%(title)s.%(ext)s".to_string()];

    if format == "mp4" || format == "mkv" {
        args.push("-f".to_string());
        let height = match quality.as_str() {
            "2160p" => 2160,
            "1440p" => 1440,
            "1080p" => 1080,
            "720p" => 720,
            _ => 1080,
        };
        args.push(format!("bestvideo[height<={}]+bestaudio/best[height<={}]", height, height));
        args.push("--merge-output-format".to_string());
        args.push(format.clone());
    } else {
        args.push("-x".to_string());
        args.push("--audio-format".to_string());
        args.push(format.clone());
        let abr = match quality.as_str() {
            "320kbps" => "320",
            "192kbps" => "192",
            "128kbps" => "128",
            _ => "192",
        };
        args.push("--audio-quality".to_string());
        args.push(abr.to_string());
    }

    args.push(url);

    let mut child = Command::new(&ytdlp)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    // Read stdout line-by-line to parse and emit progress
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                if let Some(percent) = parse_ytdlp_progress(&line) {
                    let _ = app.emit("download-progress", ProgressPayload {
                        percent,
                        status: if percent >= 100.0 { "done".to_string() } else { "downloading".to_string() },
                    });
                }
            }
        }
    }

    let status = child.wait().map_err(|e| format!("Failed to wait on yt-dlp: {}", e))?;

    if !status.success() {
        return Err("Download failed. Check if ffmpeg is installed for merging video/audio.".to_string());
    }

    // Emit 100% completion
    let _ = app.emit("download-progress", ProgressPayload {
        percent: 100.0,
        status: "done".to_string(),
    });

    Ok(())
}

#[tauri::command]
async fn process_media(_app: AppHandle, _files: Vec<String>, _format: String, _quality: String) -> Result<(), String> {
    std::thread::sleep(std::time::Duration::from_secs(2));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_youtube_info, download_youtube, process_media])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
