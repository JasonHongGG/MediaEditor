use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaProbePayload {
    duration_ms: u64,
    has_video: bool,
    has_audio: bool,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAssetRecord {
    id: String,
    name: String,
    path: String,
    kind: String,
    duration_ms: u64,
    has_video: bool,
    has_audio: bool,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineTrackPayload {
    id: String,
    name: String,
    order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineClipPayload {
    id: String,
    asset_id: String,
    track_id: String,
    start_ms: u64,
    in_point_ms: u64,
    out_point_ms: u64,
    muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDocumentPayload {
    version: u32,
    name: String,
    saved_at: String,
    assets: Vec<ProjectAssetRecord>,
    tracks: Vec<TimelineTrackPayload>,
    clips: Vec<TimelineClipPayload>,
    playhead_ms: u64,
    zoom: f64,
    preview_volume: f64,
    preview_muted: bool,
}

#[derive(Debug)]
struct YtdlpProgress {
    percent: f64,
    size: String,
    speed: String,
    eta: String,
}

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

    for (index, part) in parts.iter().enumerate() {
        if part.ends_with('%') {
            if let Ok(value) = part.trim_end_matches('%').parse::<f64>() {
                percent = Some(value);
            }
        }
        if *part == "of" {
            if let Some(value) = parts.get(index + 1) {
                size = value.trim_start_matches('~').to_string();
            }
        }
        if *part == "at" {
            if let Some(value) = parts.get(index + 1) {
                speed = value.to_string();
            }
        }
        if *part == "ETA" {
            if let Some(value) = parts.get(index + 1) {
                eta = value.to_string();
            }
        }
    }

    percent.map(|progress| YtdlpProgress {
        percent: progress,
        size,
        speed,
        eta,
    })
}

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
        .map_err(|error| format!("Failed to execute yt-dlp: {}", error))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error: {}", error));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|error| format!("Failed to parse JSON: {}", error))?;

    Ok(VideoInfo {
        title: value["title"].as_str().unwrap_or("Unknown").to_string(),
        thumbnail: value["thumbnail"].as_str().unwrap_or("").to_string(),
        duration: value["duration"].as_u64().unwrap_or(0) as u32,
    })
}

#[tauri::command]
async fn download_youtube(
    app: AppHandle,
    url: String,
    format: String,
    quality: String,
    save_dir: String,
) -> Result<(), String> {
    let ytdlp = find_bundled("yt-dlp")?;
    let output_template = format!(
        "{}{}%(title)s.%(ext)s",
        save_dir,
        if save_dir.ends_with('\\') || save_dir.ends_with('/') {
            ""
        } else {
            "\\"
        }
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
        .map_err(|error| format!("Failed to execute yt-dlp: {}", error))?;

    let (sender, receiver) = mpsc::channel::<(String, bool)>();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_sender = sender.clone();
    let stdout_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if stdout_sender.send((line, false)).is_err() {
                    break;
                }
            }
        }
    });

    let stderr_sender = sender;
    let stderr_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if stderr_sender.send((line, true)).is_err() {
                    break;
                }
            }
        }
    });

    let mut current_phase = if is_video {
        "downloading_video".to_string()
    } else {
        "downloading".to_string()
    };

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            percent: 0.0,
            status: "downloading".to_string(),
            status_text: "Starting download...".to_string(),
            phase: current_phase.clone(),
        },
    );

    for (line, _is_stderr) in receiver {
        if let Some(phase) = detect_phase(&line) {
            current_phase = phase;
            let phase_text = match current_phase.as_str() {
                "merging" => "Merging video and audio...".to_string(),
                "converting" => "Converting audio format...".to_string(),
                "finalizing" => "Finalizing...".to_string(),
                _ => String::new(),
            };
            if !phase_text.is_empty() {
                let _ = app.emit(
                    "download-progress",
                    ProgressPayload {
                        percent: 99.0,
                        status: "processing".to_string(),
                        status_text: phase_text,
                        phase: current_phase.clone(),
                    },
                );
            }
        }

        if let Some(progress) = parse_ytdlp_progress(&line) {
            let _ = app.emit(
                "download-progress",
                ProgressPayload {
                    percent: progress.percent,
                    status: if progress.percent >= 100.0 {
                        "done".to_string()
                    } else {
                        "downloading".to_string()
                    },
                    status_text: build_status_text(&current_phase, &progress),
                    phase: current_phase.clone(),
                },
            );
        }
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait on yt-dlp: {}", error))?;
    if !status.success() {
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                percent: 0.0,
                status: "error".to_string(),
                status_text: "Download failed. Check if ffmpeg is installed.".to_string(),
                phase: "error".to_string(),
            },
        );
        return Err("Download failed. Check if ffmpeg is installed for merging video/audio.".to_string());
    }

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            percent: 100.0,
            status: "done".to_string(),
            status_text: "Download complete!".to_string(),
            phase: "done".to_string(),
        },
    );

    Ok(())
}

fn build_status_text(phase: &str, progress: &YtdlpProgress) -> String {
    let mut parts: Vec<String> = Vec::new();

    if !progress.size.is_empty() && progress.size != "NA" {
        parts.push(progress.size.clone());
    }
    if !progress.speed.is_empty() && progress.speed != "NA" {
        parts.push(progress.speed.clone());
    }
    if !progress.eta.is_empty() && progress.eta != "NA" {
        parts.push(format!("ETA {}", progress.eta));
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

fn parse_decimal_seconds_to_ms(value: &str) -> Option<u64> {
    let seconds = value.trim().parse::<f64>().ok()?;
    Some((seconds * 1000.0).round().max(0.0) as u64)
}

fn parse_clock_to_ms(value: &str) -> Option<u64> {
    let mut parts = value.trim().split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    Some((((hours * 3600.0) + (minutes * 60.0) + seconds) * 1000.0).round().max(0.0) as u64)
}

fn parse_stream_resolution(line: &str) -> Option<(u32, u32)> {
    for token in line.split(|character: char| character == ',' || character.is_whitespace()) {
        let candidate = token.trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != 'x');
        let Some((width, height)) = candidate.split_once('x') else {
            continue;
        };
        if width.is_empty() || height.is_empty() {
            continue;
        }

        if let (Ok(width), Ok(height)) = (width.parse::<u32>(), height.parse::<u32>()) {
            return Some((width, height));
        }
    }

    None
}

fn probe_with_ffprobe(path: &str) -> Result<MediaProbePayload, String> {
    let ffprobe = find_bundled("ffprobe")?;
    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .map_err(|error| format!("Failed to execute ffprobe: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ffprobe failed to inspect the media file.".to_string()
        } else {
            stderr
        });
    }

    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse ffprobe output: {}", error))?;

    let duration_ms = value
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| match duration {
            serde_json::Value::String(value) => parse_decimal_seconds_to_ms(value),
            serde_json::Value::Number(value) => parse_decimal_seconds_to_ms(&value.to_string()),
            _ => None,
        })
        .unwrap_or(0)
        .max(1000);

    let streams = value
        .get("streams")
        .and_then(|streams| streams.as_array())
        .cloned()
        .unwrap_or_default();

    let mut has_video = false;
    let mut has_audio = false;
    let mut width = None;
    let mut height = None;

    for stream in &streams {
        match stream.get("codec_type").and_then(|codec_type| codec_type.as_str()) {
            Some("video") => {
                has_video = true;
                width = width.or_else(|| {
                    stream
                        .get("width")
                        .and_then(|value| value.as_u64())
                        .and_then(|value| u32::try_from(value).ok())
                });
                height = height.or_else(|| {
                    stream
                        .get("height")
                        .and_then(|value| value.as_u64())
                        .and_then(|value| u32::try_from(value).ok())
                });
            }
            Some("audio") => {
                has_audio = true;
            }
            _ => {}
        }
    }

    if !has_video && !has_audio {
        return Err("ffprobe did not report any playable audio or video streams.".to_string());
    }

    Ok(MediaProbePayload {
        duration_ms,
        has_video,
        has_audio,
        width,
        height,
    })
}

fn probe_with_ffmpeg(path: &str) -> Result<MediaProbePayload, String> {
    let ffmpeg = find_bundled("ffmpeg")?;
    let output = Command::new(&ffmpeg)
        .args(["-hide_banner", "-i", path])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Failed to execute ffmpeg: {}", error))?;

    let stderr_output = String::from_utf8_lossy(&output.stderr).to_string();
    let mut duration_ms = 0;
    let mut has_video = false;
    let mut has_audio = false;
    let mut width = None;
    let mut height = None;

    for raw_line in stderr_output.lines() {
        let line = raw_line.trim();

        if duration_ms == 0 {
            if let Some(duration_section) = line.strip_prefix("Duration:") {
                if let Some(duration_value) = duration_section.split(',').next() {
                    duration_ms = parse_clock_to_ms(duration_value.trim()).unwrap_or(0);
                }
            }
        }

        if line.contains("Video:") {
            has_video = true;
            if width.is_none() || height.is_none() {
                if let Some((parsed_width, parsed_height)) = parse_stream_resolution(line) {
                    width = Some(parsed_width);
                    height = Some(parsed_height);
                }
            }
        }

        if line.contains("Audio:") {
            has_audio = true;
        }
    }

    if !has_video && !has_audio {
        let detail = stderr_output
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if detail.trim().is_empty() {
            "ffmpeg could not inspect the media file.".to_string()
        } else {
            detail
        });
    }

    Ok(MediaProbePayload {
        duration_ms: duration_ms.max(1000),
        has_video,
        has_audio,
        width,
        height,
    })
}

#[tauri::command]
async fn probe_media_source(path: String) -> Result<MediaProbePayload, String> {
    let file_name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&path)
        .to_string();

    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Unable to access {}: {}", file_name, error))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file.", file_name));
    }

    match probe_with_ffprobe(&path) {
        Ok(payload) => Ok(payload),
        Err(ffprobe_error) => probe_with_ffmpeg(&path).map_err(|ffmpeg_error| {
            format!(
                "Unable to read metadata for {}.\nffprobe: {}\nffmpeg: {}",
                file_name, ffprobe_error, ffmpeg_error
            )
        }),
    }
}

#[tauri::command]
fn save_project_document(path: String, document: ProjectDocumentPayload) -> Result<(), String> {
    if document.version != 1 {
        return Err("Unsupported project document version.".to_string());
    }

    let target_path = PathBuf::from(&path);
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create project directory: {}", error))?;
        }
    }

    let contents = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("Failed to serialize project document: {}", error))?;

    fs::write(&target_path, contents)
        .map_err(|error| format!("Failed to save project file: {}", error))?;
    Ok(())
}

#[tauri::command]
fn load_project_document(path: String) -> Result<ProjectDocumentPayload, String> {
    let target_path = PathBuf::from(&path);
    let contents = fs::read_to_string(&target_path)
        .map_err(|error| format!("Failed to read project file: {}", error))?;
    let document: ProjectDocumentPayload = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse project file: {}", error))?;

    if document.version != 1 {
        return Err(format!(
            "Unsupported project version {}. Expected version 1.",
            document.version
        ));
    }

    Ok(document)
}

fn find_bundled(name: &str) -> Result<String, String> {
    let exe_name = format!("{}.exe", name);

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

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let candidate = PathBuf::from(&manifest_dir).join("bin").join(&exe_name);
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_youtube_info,
            download_youtube,
            probe_media_source,
            save_project_document,
            load_project_document
        ])
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