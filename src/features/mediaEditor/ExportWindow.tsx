import React from 'react';
import { motion } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import {
  CheckCircle2,
  FileOutput,
  FolderOpen,
  LoaderCircle,
  Music4,
  RefreshCcw,
  Sparkles,
  Video,
  Waves,
  X,
} from 'lucide-react';
import { formatCompactDuration } from './editorUtils';
import type { ExportProgressPayload, PendingExportSession } from './types';
import styles from './ExportWindow.module.css';

type ExportFormat = 'mp4' | 'mkv' | 'mp3' | 'wav';
type ExportStatus = 'loading' | 'idle' | 'running' | 'done' | 'error';

const FORMAT_OPTIONS: Array<{
  value: ExportFormat;
  label: string;
  detail: string;
  video: boolean;
}> = [
  { value: 'mp4', label: 'MP4', detail: 'H.264 + AAC', video: true },
  { value: 'mkv', label: 'MKV', detail: 'Master archive', video: true },
  { value: 'mp3', label: 'MP3', detail: '320 kbps audio', video: false },
  { value: 'wav', label: 'WAV', detail: 'PCM audio', video: false },
];

const DEFAULT_PROGRESS: ExportProgressPayload = {
  progress: 0,
  stage: 'prepare',
  detail: 'Waiting for export start.',
  done: false,
  failed: false,
};

const clampProgress = (value: number) => Math.min(1, Math.max(0, value));

export const ExportWindow: React.FC = () => {
  const [session, setSession] = React.useState<PendingExportSession | null>(null);
  const [format, setFormat] = React.useState<ExportFormat>('mp4');
  const [outputPath, setOutputPath] = React.useState('');
  const [progress, setProgress] = React.useState<ExportProgressPayload>(DEFAULT_PROGRESS);
  const [status, setStatus] = React.useState<ExportStatus>('loading');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const hasVideo = React.useMemo(
    () => session?.sources.some((source) => source.hasVideo) ?? false,
    [session],
  );

  const selectedFormat = React.useMemo(
    () => FORMAT_OPTIONS.find((option) => option.value === format) ?? FORMAT_OPTIONS[0],
    [format],
  );

  const suggestedFilename = React.useMemo(() => {
    const baseName = session?.suggestedName?.trim() || 'timeline-export';
    return `${baseName}.${format}`;
  }, [format, session]);

  const sessionSummary = React.useMemo(() => {
    if (!session) {
      return null;
    }

    return {
      clips: session.clips.length,
      tracks: session.tracks.length,
      sources: session.sources.length,
      duration: formatCompactDuration(session.timelineDurationMs),
      resolution:
        session.dominantWidth && session.dominantHeight
          ? `${session.dominantWidth} × ${session.dominantHeight}`
          : 'Audio only',
    };
  }, [session]);

  const refreshSession = React.useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      const nextSession = await invoke<PendingExportSession | null>('get_pending_export_session');
      setSession(nextSession);
      setProgress(DEFAULT_PROGRESS);
      setStatus(nextSession ? 'idle' : 'error');
      if (!nextSession) {
        setErrorMessage('No timeline is queued for export yet. Open export again from the main editor.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load pending export session.';
      setSession(null);
      setStatus('error');
      setErrorMessage(message);
    }
  }, []);

  React.useEffect(() => {
    void refreshSession();

    let disposed = false;
    let removeSessionListener: (() => void) | undefined;
    let removeProgressListener: (() => void) | undefined;

    void listen<PendingExportSession>('editor/export-session-updated', (event) => {
      if (disposed) {
        return;
      }

      setSession(event.payload);
      setProgress(DEFAULT_PROGRESS);
      setStatus('idle');
      setErrorMessage(null);
      setOutputPath('');
    }).then((unlisten) => {
      removeSessionListener = unlisten;
    });

    void listen<ExportProgressPayload>('editor/export-progress', (event) => {
      if (disposed) {
        return;
      }

      const next = {
        ...event.payload,
        progress: clampProgress(event.payload.progress),
      };

      setProgress(next);

      if (next.failed) {
        setStatus('error');
        setErrorMessage(next.detail);
        return;
      }

      if (next.done) {
        setStatus('done');
        setErrorMessage(null);
        return;
      }

      setStatus('running');
    }).then((unlisten) => {
      removeProgressListener = unlisten;
    });

    return () => {
      disposed = true;
      removeSessionListener?.();
      removeProgressListener?.();
    };
  }, [refreshSession]);

  React.useEffect(() => {
    if (!hasVideo && (format === 'mp4' || format === 'mkv')) {
      setFormat('wav');
      return;
    }

    if (hasVideo && (format === 'mp3' || format === 'wav')) {
      return;
    }

    if (!hasVideo && format !== 'mp3' && format !== 'wav') {
      setFormat('wav');
    }
  }, [format, hasVideo]);

  const pickOutputPath = React.useCallback(async () => {
    const selectedPath = await save({
      defaultPath: outputPath || suggestedFilename,
    });

    if (!selectedPath) {
      return null;
    }

    let normalizedPath = selectedPath;
    if (!normalizedPath.toLowerCase().endsWith(`.${format}`)) {
      normalizedPath = `${normalizedPath}.${format}`;
    }
    setOutputPath(normalizedPath);
    return normalizedPath;
  }, [format, outputPath, suggestedFilename]);

  const handleExport = React.useCallback(async () => {
    if (!session || status === 'running') {
      return;
    }

    setErrorMessage(null);
    setProgress({
      progress: 0.01,
      stage: 'prepare',
      detail: 'Preparing export command...',
      done: false,
      failed: false,
    });
    setStatus('running');

    try {
      const finalPath = outputPath || (await pickOutputPath());
      if (!finalPath) {
        setStatus('idle');
        setProgress(DEFAULT_PROGRESS);
        return;
      }

      await invoke('process_timeline_export', {
        request: {
          outputPath: finalPath,
          format,
          session,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed.';
      setStatus('error');
      setErrorMessage(message);
      setProgress({
        progress: 0,
        stage: 'error',
        detail: message,
        done: false,
        failed: true,
      });
    }
  }, [format, outputPath, pickOutputPath, session, status]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.985, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      className={styles.window}
    >
      <div className={styles.backdropGlow} />

      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>Unified Export</div>
            <h1>Final render</h1>
            <p>
              Route the edited timeline into a single export target without leaving the desktop app.
            </p>
          </div>

          <button type="button" className={styles.closeButton} onClick={() => void getCurrentWindow().close()}>
            <X size={16} />
          </button>
        </header>

        <section className={styles.heroCard}>
          <div className={styles.heroIcon}>
            <FileOutput size={18} />
          </div>

          <div className={styles.heroCopy}>
            <strong>{session?.suggestedName || 'Pending timeline export'}</strong>
            <span>
              {sessionSummary
                ? `${sessionSummary.clips} clips • ${sessionSummary.duration} • ${sessionSummary.resolution}`
                : 'Waiting for a timeline from the main editor.'}
            </span>
          </div>

          <button type="button" className={styles.ghostAction} onClick={() => void refreshSession()}>
            <RefreshCcw size={15} />
          </button>
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Format</span>
              <span className={styles.panelMeta}>{selectedFormat.detail}</span>
            </div>

            <div className={styles.formatGrid}>
              {FORMAT_OPTIONS.map((option) => {
                const disabled = option.video && !hasVideo;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={disabled || status === 'running'}
                    className={`${styles.formatCard} ${format === option.value ? styles.formatCardActive : ''}`}
                    onClick={() => setFormat(option.value)}
                  >
                    <span className={styles.formatIcon}>
                      {option.video ? <Video size={16} /> : <Music4 size={16} />}
                    </span>
                    <strong>{option.label}</strong>
                    <span>{disabled ? 'Requires at least one video clip' : option.detail}</span>
                  </button>
                );
              })}
            </div>

            <div className={styles.fieldBlock}>
              <label className={styles.fieldLabel}>Output path</label>
              <div className={styles.pathField}>
                <input
                  value={outputPath}
                  onChange={(event) => setOutputPath(event.target.value)}
                  placeholder={suggestedFilename}
                  disabled={status === 'running'}
                />
                <button type="button" onClick={() => void pickOutputPath()} disabled={status === 'running'}>
                  <FolderOpen size={16} />
                </button>
              </div>
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Queue</span>
              <span className={styles.panelMeta}>{session ? 'Synced from editor' : 'Missing session'}</span>
            </div>

            {sessionSummary ? (
              <div className={styles.summaryGrid}>
                <article className={styles.summaryCard}>
                  <Sparkles size={16} />
                  <strong>{sessionSummary.clips}</strong>
                  <span>clips</span>
                </article>
                <article className={styles.summaryCard}>
                  <Waves size={16} />
                  <strong>{sessionSummary.tracks}</strong>
                  <span>tracks</span>
                </article>
                <article className={styles.summaryCard}>
                  <FolderOpen size={16} />
                  <strong>{sessionSummary.sources}</strong>
                  <span>sources</span>
                </article>
                <article className={styles.summaryCard}>
                  <CheckCircle2 size={16} />
                  <strong>{sessionSummary.duration}</strong>
                  <span>duration</span>
                </article>
              </div>
            ) : (
              <div className={styles.emptyState}>
                <FileOutput size={20} />
                <span>Open export from the editor once clips are arranged on the timeline.</span>
              </div>
            )}

            <div className={styles.progressBlock}>
              <div className={styles.progressHeader}>
                <span>{progress.stage}</span>
                <strong>{Math.round(clampProgress(progress.progress) * 100)}%</strong>
              </div>
              <div className={styles.progressBar}>
                <div style={{ width: `${clampProgress(progress.progress) * 100}%` }} />
              </div>
              <p className={styles.progressDetail}>{progress.detail}</p>
            </div>

            {errorMessage ? <div className={styles.errorCard}>{errorMessage}</div> : null}

            <div className={styles.actions}>
              <button type="button" className={styles.secondaryAction} onClick={() => void refreshSession()}>
                Reload session
              </button>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={!session || status === 'loading' || status === 'running'}
                onClick={() => void handleExport()}
              >
                {status === 'running' ? <LoaderCircle size={16} className={styles.spinning} /> : <FileOutput size={16} />}
                {status === 'done' ? 'Export again' : 'Start export'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </motion.div>
  );
};