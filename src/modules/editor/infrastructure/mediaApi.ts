import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { EditorAsset, MediaProbeResult, ProjectAssetRecord, ProjectDocumentV2 } from '../domain/model';
import { basename, createId, detectMediaKind, extensionOf } from '../domain/model';

const SUPPORTED_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'mov',
  'webm',
  'avi',
  'm4v',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
]);

const THUMBNAIL_CAPTURE_TIMEOUT_MS = 4000;

export function isSupportedMediaPath(path: string) {
  return SUPPORTED_EXTENSIONS.has(extensionOf(path));
}

async function captureVideoThumbnail(url: string, durationMs: number) {
  return new Promise<string | null>((resolve) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    let settled = false;

    const timeoutId = window.setTimeout(() => finish(null), THUMBNAIL_CAPTURE_TIMEOUT_MS);

    const finish = (value: string | null) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };

    const drawFrame = () => {
      const width = video.videoWidth || 320;
      const height = video.videoHeight || 180;
      if (width <= 0 || height <= 0) {
        finish(null);
        return;
      }

      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        finish(null);
        return;
      }

      try {
        context.drawImage(video, 0, 0, width, height);
        finish(canvas.toDataURL('image/jpeg', 0.76));
      } catch {
        // Asset protocol videos can taint the canvas; thumbnail capture must never block import.
        finish(null);
      }
    };

    video.addEventListener('error', () => finish(null), { once: true });
    video.addEventListener(
      'loadedmetadata',
      () => {
        const seekTargetSeconds = Math.min(1, Math.max(0.05, durationMs / 2000));
        if (!Number.isFinite(video.duration) || video.duration <= seekTargetSeconds) {
          drawFrame();
          return;
        }

        video.addEventListener('seeked', drawFrame, { once: true });
        try {
          video.currentTime = seekTargetSeconds;
        } catch {
          finish(null);
        }
      },
      { once: true },
    );

    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    video.load();
  });
}

export async function probePath(path: string) {
  return invoke<MediaProbeResult>('probe_media_source', { path });
}

export async function saveProjectDocument(path: string, document: ProjectDocumentV2) {
  return invoke<void>('save_project_document', { path, document });
}

export async function loadProjectDocument(path: string) {
  return invoke<ProjectDocumentV2>('load_project_document', { path });
}

export async function buildEditorAsset(path: string): Promise<EditorAsset> {
  const probe = await probePath(path);
  const url = convertFileSrc(path);
  const thumbnailUrl = probe.hasVideo ? await captureVideoThumbnail(url, probe.durationMs) : null;

  return {
    id: createId('asset'),
    name: basename(path),
    path,
    kind: detectMediaKind(path, probe),
    durationMs: probe.durationMs,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    width: probe.width,
    height: probe.height,
    status: 'ready',
    url,
    thumbnailUrl,
  };
}

export async function hydrateProjectAsset(record: ProjectAssetRecord): Promise<EditorAsset> {
  try {
    const probe = await probePath(record.path);
    const url = convertFileSrc(record.path);
    const thumbnailUrl = probe.hasVideo ? await captureVideoThumbnail(url, probe.durationMs) : null;

    return {
      ...record,
      kind: detectMediaKind(record.path, probe),
      durationMs: probe.durationMs,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      width: probe.width,
      height: probe.height,
      status: 'ready',
      url,
      thumbnailUrl,
    };
  } catch {
    return {
      ...record,
      status: 'missing',
      url: null,
      thumbnailUrl: null,
    };
  }
}