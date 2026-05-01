use tauri::{AppHandle, Emitter};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
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
    status_text: String,
    phase: String,
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

/// Parsed progress info from yt-dlp output
struct YtdlpProgress {
    percent: f64,
    size: String,
    speed: String,
    eta: String,
}

/// Parse yt-dlp output lines to extract download progress details.
/// Handles both standard lines like: [download]  45.2% of 5.07MiB at 1.23MiB/s ETA 00:03
/// and --progress-template lines like: [progress]  45.2% of 5.07MiB at 1.23MiB/s ETA 00:03
fn parse_ytdlp_progress(line: &str) -> Option<YtdlpProgress> {
    if !line.contains("[download]") && !line.contains("[progress]") {
        return None;
    }
    let trimmed = line.trim();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();

    let mut percent: Option<f64> = None;
    let mut size = String::new();
    let mut speed = String::new();
    let mut eta = String::new();

    for (i, part) in parts.iter().enumerate() {
        if part.ends_with('%') {
            if let Ok(val) = part.trim_end_matches('%').parse::<f64>() {
                percent = Some(val);
            }
        }
        // "of" is followed by file size, e.g. "of 5.07MiB"
        if *part == "of" {
            if let Some(s) = parts.get(i + 1) {
                // Skip the '~' prefix if present (e.g. "~5.07MiB")
                size = s.trim_start_matches('~').to_string();
            }
        }
        // "at" is followed by speed, e.g. "at 1.23MiB/s"
        if *part == "at" {
            if let Some(s) = parts.get(i + 1) {
                speed = s.to_string();
            }
        }
        // "ETA" is followed by time remaining, e.g. "ETA 00:03"
        if *part == "ETA" {
            if let Some(s) = parts.get(i + 1) {
                eta = s.to_string();
            }
        }
    }

    percent.map(|p| YtdlpProgress {
        percent: p,
        size,
        speed,
        eta,
    })
}

/// Detect the current phase from yt-dlp output lines
fn detect_phase(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with("[download] Destination:") {
        if trimmed.contains(".f") || trimmed.contains("video") {
            return Some("downloading_video".to_string());
        }
        return Some("downloading".to_string());
    }
    if trimmed.starts_with("[Merger]") || trimmed.starts_with("[Merge]") || trimmed.contains("Merging") {
        return Some("merging".to_string());
    }
    if trimmed.starts_with("[ExtractAudio]") || trimmed.starts_with("[ffmpeg]") {
        return Some("converting".to_string());
    }
    if trimmed.starts_with("[download] 100%") {
        return Some("finalizing".to_string());
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
async fn download_youtube(app: AppHandle, url: String, format: String, quality: String, save_dir: String) -> Result<(), String> {
    let ytdlp = find_bundled("yt-dlp")?;

    // Build output path template using user-chosen directory
    let output_template = format!("{}{}%(title)s.%(ext)s",
        save_dir,
        if save_dir.ends_with('\\') || save_dir.ends_with('/') { "" } else { "\\" }
    );

    let mut args = vec![
        "--no-playlist".to_string(),
        "--newline".to_string(),
        "--progress".to_string(),
        "--progress-template".to_string(),
        "[progress] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s".to_string(),
        "-o".to_string(),
        output_template,
    ];

    let is_video = format == "mp4" || format == "mkv";

    if is_video {
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

    // Use a channel to receive progress from the reader threads
    let (tx, rx) = mpsc::channel::<(String, bool)>();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let tx_stdout = tx.clone();
    let stdout_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if tx_stdout.send((line, false)).is_err() {
                    break;
                }
            }
        }
    });

    let tx_stderr = tx;
    let stderr_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if tx_stderr.send((line, true)).is_err() {
                    break;
                }
            }
        }
    });

    let mut current_phase = if is_video { "downloading_video".to_string() } else { "downloading".to_string() };

    // Emit initial status
    let _ = app.emit("download-progress", ProgressPayload {
        percent: 0.0,
        status: "downloading".to_string(),
        status_text: "Starting download...".to_string(),
        phase: current_phase.clone(),
    });

    for (line, _is_stderr) in rx {
        // Detect phase changes
        if let Some(phase) = detect_phase(&line) {
            current_phase = phase;

            // Emit phase change event with descriptive text
            let phase_text = match current_phase.as_str() {
                "merging" => "Merging video and audio...".to_string(),
                "converting" => "Converting audio format...".to_string(),
                "finalizing" => "Finalizing...".to_string(),
                _ => String::new(),
            };
            if !phase_text.is_empty() {
                let _ = app.emit("download-progress", ProgressPayload {
                    percent: 99.0,
                    status: "processing".to_string(),
                    status_text: phase_text,
                    phase: current_phase.clone(),
                });
            }
        }

        // Parse progress percentage and details
        if let Some(prog) = parse_ytdlp_progress(&line) {
            let status_text = build_status_text(&current_phase, &prog);
            let status = if prog.percent >= 100.0 {
                "done".to_string()
            } else {
                "downloading".to_string()
            };

            let _ = app.emit("download-progress", ProgressPayload {
                percent: prog.percent,
                status,
                status_text,
                phase: current_phase.clone(),
            });
        }
    }

    // Wait for reader threads to finish
    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let status = child.wait().map_err(|e| format!("Failed to wait on yt-dlp: {}", e))?;

    if !status.success() {
        let _ = app.emit("download-progress", ProgressPayload {
            percent: 0.0,
            status: "error".to_string(),
            status_text: "Download failed. Check if ffmpeg is installed.".to_string(),
            phase: "error".to_string(),
        });
        return Err("Download failed. Check if ffmpeg is installed for merging video/audio.".to_string());
    }

    // Emit 100% completion
    let _ = app.emit("download-progress", ProgressPayload {
        percent: 100.0,
        status: "done".to_string(),
        status_text: "Download complete!".to_string(),
        phase: "done".to_string(),
    });

    Ok(())
}

/// Build a human-readable status text from the current phase and progress info
fn build_status_text(phase: &str, prog: &YtdlpProgress) -> String {
    let mut parts: Vec<String> = Vec::new();

    if !prog.size.is_empty() && prog.size != "NA" {
        parts.push(prog.size.clone());
    }
    if !prog.speed.is_empty() && prog.speed != "NA" {
        parts.push(prog.speed.clone());
    }
    if !prog.eta.is_empty() && prog.eta != "NA" {
        parts.push(format!("ETA {}", prog.eta));
    }

    let phase_label = match phase {
        "downloading_video" => "Downloading video",
        "downloading" => "Downloading",
        "merging" => "Merging",
        "converting" => "Converting",
        "finalizing" => "Finalizing",
        _ => "Downloading",
    };

    if parts.is_empty() {
        format!("{}...", phase_label)
    } else {
        format!("{}  •  {}", phase_label, parts.join("  •  "))
    }
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
