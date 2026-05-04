use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, State};

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
struct ExportSource {
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
struct ExportTrack {
    id: String,
    kind: String,
    name: String,
    order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportMutedRange {
    id: String,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportClip {
    id: String,
    source_id: String,
    track_id: String,
    start_ms: u64,
    in_point_ms: u64,
    out_point_ms: u64,
    muted_ranges: Vec<ExportMutedRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingExportSession {
    sources: Vec<ExportSource>,
    tracks: Vec<ExportTrack>,
    clips: Vec<ExportClip>,
    timeline_duration_ms: u64,
    suggested_name: String,
    dominant_width: Option<u32>,
    dominant_height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineExportRequest {
    output_path: String,
    format: String,
    session: PendingExportSession,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgressPayload {
    progress: f64,
    stage: String,
    detail: String,
    done: bool,
    failed: bool,
}

struct EditorState {
    pending_export_session: Mutex<Option<PendingExportSession>>,
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

    let metadata = std::fs::metadata(&path)
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

/// Locate an executable bundled in src-tauri/bin/ (dev) or next to the app binary (prod).
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
        let candidate = std::path::PathBuf::from(&manifest_dir).join("bin").join(&exe_name);
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
            for line in reader.lines().flatten() {
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
            for line in reader.lines().flatten() {
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

#[tauri::command]
fn set_pending_export_session(
    state: State<EditorState>,
    session: PendingExportSession,
) -> Result<(), String> {
    let mut guard = state
        .pending_export_session
        .lock()
        .map_err(|_| "Failed to lock export session state.".to_string())?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
fn get_pending_export_session(state: State<EditorState>) -> Result<Option<PendingExportSession>, String> {
    let guard = state
        .pending_export_session
        .lock()
        .map_err(|_| "Failed to lock export session state.".to_string())?;
    Ok(guard.clone())
}

fn seconds_from_ms(value: u64) -> String {
    format!("{:.3}", value as f64 / 1000.0)
}

fn emit_export_progress(
    app: &AppHandle,
    progress: f64,
    stage: &str,
    detail: String,
    done: bool,
    failed: bool,
) {
    let _ = app.emit(
        "editor/export-progress",
        ExportProgressPayload {
            progress,
            stage: stage.to_string(),
            detail,
            done,
            failed,
        },
    );
}

fn build_filter_graph(request: &TimelineExportRequest) -> Result<(Vec<String>, String, Option<String>), String> {
    let session = &request.session;
    let format = request.format.to_lowercase();
    let is_video_output = matches!(format.as_str(), "mp4" | "mkv");
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
    ];

    let total_ms = session.timeline_duration_ms.max(1000);
    let total_seconds = seconds_from_ms(total_ms);
    let (width, height) = (
        session.dominant_width.unwrap_or(1280),
        session.dominant_height.unwrap_or(720),
    );

    if is_video_output {
        args.extend([
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            format!("color=c=#09090b:s={}x{}:d={}:r=30", width, height, total_seconds),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            format!("anullsrc=channel_layout=stereo:sample_rate=48000:d={}", total_seconds),
        ]);
    } else {
        args.extend([
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            format!("anullsrc=channel_layout=stereo:sample_rate=48000:d={}", total_seconds),
        ]);
    }

    let mut next_input_index = if is_video_output { 2usize } else { 1usize };
    let used_source_ids: HashSet<&str> = session.clips.iter().map(|clip| clip.source_id.as_str()).collect();
    let used_sources: Vec<&ExportSource> = session
        .sources
        .iter()
        .filter(|source| used_source_ids.contains(source.id.as_str()))
        .collect();
    if used_sources.is_empty() {
        return Err("No media sources available for export.".to_string());
    }

    let mut source_input_indices: HashMap<&str, usize> = HashMap::new();
    for source in &used_sources {
        source_input_indices.insert(source.id.as_str(), next_input_index);
        args.extend(["-i".to_string(), source.path.clone()]);
        next_input_index += 1;
    }

    let track_order_map: HashMap<&str, i32> = session
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track.order))
        .collect();
    let track_kind_map: HashMap<&str, &str> = session
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track.kind.as_str()))
        .collect();
    let source_map: HashMap<&str, &ExportSource> = session
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();

    let mut filters: Vec<String> = Vec::new();

    let video_output_label = if is_video_output {
        filters.push("[0:v]format=yuv420p[vbase0]".to_string());
        let mut current_video_label = "vbase0".to_string();
        let mut video_clips: Vec<&ExportClip> = session
            .clips
            .iter()
            .filter(|clip| {
                track_kind_map.get(clip.track_id.as_str()) == Some(&"video")
                    && source_map
                        .get(clip.source_id.as_str())
                        .map(|source| source.has_video)
                        .unwrap_or(false)
            })
            .collect();
        video_clips.sort_by_key(|clip| {
            (
                track_order_map.get(clip.track_id.as_str()).copied().unwrap_or_default(),
                clip.start_ms,
            )
        });

        for (index, clip) in video_clips.iter().enumerate() {
            let input_index = source_input_indices
                .get(clip.source_id.as_str())
                .ok_or_else(|| "Missing ffmpeg input index for video clip.".to_string())?;
            let clip_label = format!("vclip{}", index);
            let next_label = format!("vbase{}", index + 1);
            let clip_end_ms = clip.start_ms + clip.out_point_ms.saturating_sub(clip.in_point_ms);

            filters.push(format!(
                "[{input}:v]trim=start={trim_start}:end={trim_end},setpts=PTS-STARTPTS+{timeline_start}/TB,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x09090b[{label}]",
                input = input_index,
                trim_start = seconds_from_ms(clip.in_point_ms),
                trim_end = seconds_from_ms(clip.out_point_ms),
                timeline_start = seconds_from_ms(clip.start_ms),
                width = width,
                height = height,
                label = clip_label,
            ));

            filters.push(format!(
                "[{base}][{clip}]overlay=eof_action=pass:enable='between(t,{enable_start},{enable_end})'[{next}]",
                base = current_video_label,
                clip = clip_label,
                enable_start = seconds_from_ms(clip.start_ms),
                enable_end = seconds_from_ms(clip_end_ms),
                next = next_label,
            ));

            current_video_label = next_label;
        }

        Some(current_video_label)
    } else {
        None
    };

    let mut audio_mix_inputs = vec![format!("[{}:a]", if is_video_output { 1 } else { 0 })];
    let mut audio_clips: Vec<&ExportClip> = session
        .clips
        .iter()
        .filter(|clip| {
            source_map
                .get(clip.source_id.as_str())
                .map(|source| source.has_audio)
                .unwrap_or(false)
        })
        .collect();
    audio_clips.sort_by_key(|clip| {
        (
            track_order_map.get(clip.track_id.as_str()).copied().unwrap_or_default(),
            clip.start_ms,
        )
    });

    for (index, clip) in audio_clips.iter().enumerate() {
        let input_index = source_input_indices
            .get(clip.source_id.as_str())
            .ok_or_else(|| "Missing ffmpeg input index for audio clip.".to_string())?;
        let clip_duration_ms = clip.out_point_ms.saturating_sub(clip.in_point_ms);
        let mut filter_chain = format!(
            "[{input}:a]atrim=start={trim_start}:end={trim_end},asetpts=PTS-STARTPTS",
            input = input_index,
            trim_start = seconds_from_ms(clip.in_point_ms),
            trim_end = seconds_from_ms(clip.out_point_ms),
        );

        for range in &clip.muted_ranges {
            let start_local_ms = range.start_ms.min(clip_duration_ms);
            let end_local_ms = range.end_ms.min(clip_duration_ms);
            if end_local_ms <= start_local_ms {
                continue;
            }
            filter_chain.push_str(&format!(
                ",volume=enable='between(t,{start},{end})':volume=0",
                start = seconds_from_ms(start_local_ms),
                end = seconds_from_ms(end_local_ms),
            ));
        }

        let audio_label = format!("aclip{}", index);
        filter_chain.push_str(&format!(",adelay={}:all=1[{}]", clip.start_ms, audio_label));
        filters.push(filter_chain);
        audio_mix_inputs.push(format!("[{label}]", label = audio_label));
    }

    filters.push(format!(
        "{inputs}amix=inputs={count}:duration=longest:normalize=0[aout]",
        inputs = audio_mix_inputs.join(""),
        count = audio_mix_inputs.len(),
    ));

    args.extend([
        "-filter_complex".to_string(),
        filters.join(";"),
        "-t".to_string(),
        total_seconds,
    ]);

    Ok((
        args,
        "[aout]".to_string(),
        video_output_label.map(|label| format!("[{label}]")),
    ))
}

fn codec_args_for_format(format: &str) -> Vec<String> {
    match format {
        "mp4" => vec![
            "-c:v".to_string(),
            "libx264".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
        ],
        "mkv" => vec![
            "-c:v".to_string(),
            "libx264".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
        ],
        "mp3" => vec![
            "-c:a".to_string(),
            "libmp3lame".to_string(),
            "-b:a".to_string(),
            "320k".to_string(),
        ],
        "wav" => vec!["-c:a".to_string(), "pcm_s16le".to_string()],
        _ => vec!["-c:a".to_string(), "aac".to_string()],
    }
}

#[tauri::command]
async fn process_timeline_export(app: AppHandle, request: TimelineExportRequest) -> Result<(), String> {
    let ffmpeg = find_bundled("ffmpeg")?;
    let total_ms = request.session.timeline_duration_ms.max(1000);
    let format = request.format.to_lowercase();
    let is_video_output = matches!(format.as_str(), "mp4" | "mkv");

    emit_export_progress(
        &app,
        0.02,
        if is_video_output { "render" } else { "mix" },
        "Preparing ffmpeg graph...".to_string(),
        false,
        false,
    );

    let (mut args, audio_map, video_map) = build_filter_graph(&request)?;
    if let Some(video_map) = video_map {
        args.extend(["-map".to_string(), video_map]);
    }
    args.extend(["-map".to_string(), audio_map]);
    args.extend(codec_args_for_format(&format));
    args.push(request.output_path.clone());

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to execute ffmpeg: {}", error))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture ffmpeg progress output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture ffmpeg error output.".to_string())?;

    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut lines = Vec::new();
        for line in reader.lines().flatten() {
            lines.push(line);
        }
        lines.join("\n")
    });

    let progress_reader = BufReader::new(stdout);
    let mut last_out_time_ms = 0u64;
    let mut last_speed = String::new();
    for line in progress_reader.lines().flatten() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("out_time_us=") {
            if let Ok(parsed) = value.parse::<u64>() {
                last_out_time_ms = parsed / 1000;
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("out_time_ms=") {
            if let Ok(parsed) = value.parse::<u64>() {
                last_out_time_ms = parsed / 1000;
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("speed=") {
            last_speed = value.trim().to_string();
            continue;
        }
        if trimmed == "progress=continue" || trimmed == "progress=end" {
            let progress = (last_out_time_ms as f64 / total_ms as f64).clamp(0.0, 0.98);
            let detail = if last_speed.is_empty() {
                format!("{} / {}", seconds_from_ms(last_out_time_ms), seconds_from_ms(total_ms))
            } else {
                format!(
                    "{} / {}  •  {}",
                    seconds_from_ms(last_out_time_ms),
                    seconds_from_ms(total_ms),
                    last_speed
                )
            };

            emit_export_progress(
                &app,
                if trimmed == "progress=end" { 0.99 } else { progress },
                if is_video_output { "render" } else { "mix" },
                detail,
                false,
                false,
            );
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait on ffmpeg: {}", error))?;
    let stderr_output = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        let detail = if stderr_output.trim().is_empty() {
            "ffmpeg exited with a failure status.".to_string()
        } else {
            stderr_output
                .lines()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        };
        emit_export_progress(&app, 0.0, "error", detail.clone(), false, true);
        return Err(detail);
    }

    emit_export_progress(
        &app,
        1.0,
        "done",
        format!("Saved to {}", request.output_path),
        true,
        false,
    );

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EditorState {
            pending_export_session: Mutex::new(None),
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_youtube_info,
            download_youtube,
            probe_media_source,
            set_pending_export_session,
            get_pending_export_session,
            process_timeline_export
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