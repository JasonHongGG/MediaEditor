import React from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle,
  CheckCircle2,
  FileOutput,
  FolderOpen,
  LoaderCircle,
  Music4,
  RefreshCcw,
  Video,
  Waves,
  X,
} from 'lucide-react';
import { createLogger, getErrorMessage, serializeError } from '../../utils/logger';
import { getPendingExportSession, processTimelineExport } from './exportApi';
import type {
  AudioBitrateKbps,
  ExportFormat,
  ExportProgressPayload,
  PendingExportSession,
  VideoQuality,
} from './exportTypes';
import { formatTransportTime } from './model';
import styles from './ExportWindow.module.css';

type ExportStatus = 'loading' | 'idle' | 'running' | 'done' | 'error';
const log = createLogger('ExportWindow');

const FORMAT_OPTIONS: Array<{
  value: ExportFormat;
  label: string;
  description: string;
  kind: 'video' | 'audio';
}> = [
  { value: 'mp4', label: 'MP4', description: 'H.264 video container', kind: 'video' },
  { value: 'mkv', label: 'MKV', description: 'Matroska archive', kind: 'video' },
  { value: 'mp3', label: 'MP3', description: 'Compressed audio', kind: 'audio' },
  { value: 'm4a', label: 'M4A', description: 'AAC audio container', kind: 'audio' },
  { value: 'wav', label: 'WAV', description: 'PCM lossless audio', kind: 'audio' },
];

const VIDEO_QUALITY_OPTIONS: VideoQuality[] = ['source', '2160p', '1440p', '1080p', '720p', '480p'];
const AUDIO_BITRATE_OPTIONS: AudioBitrateKbps[] = [320, 256, 192, 128, 96];

const DEFAULT_PROGRESS: ExportProgressPayload = {
  progress: 0,
  stage: 'idle',
  detail: 'Ready to export.',
  done: false,
  failed: false,
};

function defaultFormatForSession(session: PendingExportSession | null): ExportFormat {
  return session?.hasVideo ? 'mp4' : 'mp3';
}

function suggestedFilename(session: PendingExportSession | null, format: ExportFormat) {
  return `${session?.suggestedName?.trim() || 'timeline-export'}.${format}`;
}

export const ExportWindow: React.FC = () => {
  const [session, setSession] = React.useState<PendingExportSession | null>(null);
  const [format, setFormat] = React.useState<ExportFormat>('mp4');
  const [videoQuality, setVideoQuality] = React.useState<VideoQuality>('1080p');
  const [audioBitrateKbps, setAudioBitrateKbps] = React.useState<AudioBitrateKbps>(320);
  const [outputPath, setOutputPath] = React.useState('');
  const [progress, setProgress] = React.useState<ExportProgressPayload>(DEFAULT_PROGRESS);
  const [status, setStatus] = React.useState<ExportStatus>('loading');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const isVideoOutput = format === 'mp4' || format === 'mkv';
  const usesAudioBitrate = format === 'mp3' || format === 'm4a';

  const refreshSession = React.useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      const nextSession = await getPendingExportSession();
      log.info('Loaded pending export session.', nextSession ? {
        projectName: nextSession.projectName,
        clipCount: nextSession.clips.length,
      } : 'empty');
      setSession(nextSession);
      setFormat((current) => (current ? current : defaultFormatForSession(nextSession)));
      if (!nextSession) {
        setStatus('error');
        setErrorMessage('No timeline is queued for export yet. Open export again from the main editor.');
        return;
      }

      setFormat(defaultFormatForSession(nextSession));
      setOutputPath('');
      setProgress(DEFAULT_PROGRESS);
      setStatus('idle');
    } catch (error) {
      log.error('Failed to load export session.', serializeError(error));
      setStatus('error');
      setErrorMessage(getErrorMessage(error, 'Failed to load export session.'));
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

      log.info('Received export session update event.', {
        projectName: event.payload.projectName,
        clipCount: event.payload.clips.length,
      });
      setSession(event.payload);
      setFormat(defaultFormatForSession(event.payload));
      setOutputPath('');
      setProgress(DEFAULT_PROGRESS);
      setStatus('idle');
      setErrorMessage(null);
    }).then((unlisten) => {
      removeSessionListener = unlisten;
    });

    void listen<ExportProgressPayload>('editor/export-progress', (event) => {
      if (disposed) {
        return;
      }

      const nextProgress = {
        ...event.payload,
        progress: Math.max(0, Math.min(1, event.payload.progress)),
      };

      log.info('Received export progress event.', nextProgress);

      setProgress(nextProgress);

      if (nextProgress.failed) {
        setStatus('error');
        setErrorMessage(nextProgress.detail);
        return;
      }

      if (nextProgress.done) {
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

  const pickOutputPath = React.useCallback(async () => {
    const selectedPath = await save({
      title: 'Export timeline',
      defaultPath: outputPath || suggestedFilename(session, format),
      filters: [
        {
          name: format.toUpperCase(),
          extensions: [format],
        },
      ],
    });

    if (!selectedPath) {
      return null;
    }

    const normalizedPath = selectedPath.toLowerCase().endsWith(`.${format}`)
      ? selectedPath
      : `${selectedPath}.${format}`;
    setOutputPath(normalizedPath);
    return normalizedPath;
  }, [format, outputPath, session]);

  const handleExport = React.useCallback(async () => {
    if (!session || status === 'running') {
      return;
    }

    setErrorMessage(null);
    setStatus('running');
    setProgress({
      progress: 0.01,
      stage: 'prepare',
      detail: 'Preparing export command...',
      done: false,
      failed: false,
    });

    try {
      const finalPath = outputPath || (await pickOutputPath());
      if (!finalPath) {
        setStatus('idle');
        setProgress(DEFAULT_PROGRESS);
        return;
      }

      await processTimelineExport({
        outputPath: finalPath,
        format,
        videoQuality,
        audioBitrateKbps,
        session,
      });
    } catch (error) {
      log.error('Export failed.', {
        error: serializeError(error),
        format,
        outputPath,
      });
      const message = getErrorMessage(error, 'Export failed.');
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
  }, [audioBitrateKbps, format, outputPath, pickOutputPath, session, status, videoQuality]);

  return (
    <div className={styles.window}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Export</div>
          <h1>Render timeline</h1>
          <p>Create a final video or audio file in a dedicated export window.</p>
        </div>

        <button type="button" className={styles.iconButton} onClick={() => void getCurrentWindow().close()}>
          <X size={16} />
        </button>
      </header>

      {!session ? (
        <section className={styles.emptyState}>
          <AlertCircle size={18} />
          <strong>{errorMessage ?? 'No pending timeline export.'}</strong>
          <button type="button" className={styles.secondaryButton} onClick={() => void refreshSession()}>
            <RefreshCcw size={15} />
            Refresh
          </button>
        </section>
      ) : (
        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>Output format</div>
                <p>Choose the final container and compression settings.</p>
              </div>
            </div>

            <div className={styles.optionGrid}>
              {FORMAT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`${styles.optionCard} ${format === option.value ? styles.optionCardActive : ''}`}
                  onClick={() => setFormat(option.value)}
                >
                  <span className={styles.optionIcon}>
                    {option.kind === 'video' ? <Video size={16} /> : <Music4 size={16} />}
                  </span>
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>

            {isVideoOutput ? (
              <div className={styles.fieldBlock}>
                <label className={styles.fieldLabel} htmlFor="video-quality">Video quality</label>
                <select
                  id="video-quality"
                  className={styles.selectField}
                  value={videoQuality}
                  onChange={(event) => setVideoQuality(event.target.value as VideoQuality)}
                >
                  {VIDEO_QUALITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === 'source' ? 'Source resolution' : option}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className={styles.fieldBlock}>
                <label className={styles.fieldLabel} htmlFor="audio-bitrate">Audio bitrate</label>
                <select
                  id="audio-bitrate"
                  className={styles.selectField}
                  value={audioBitrateKbps}
                  onChange={(event) => setAudioBitrateKbps(Number(event.target.value) as AudioBitrateKbps)}
                  disabled={!usesAudioBitrate}
                >
                  {AUDIO_BITRATE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option} kbps
                    </option>
                  ))}
                </select>
                {!usesAudioBitrate && <span className={styles.helperText}>WAV exports use lossless PCM audio and ignore kbps.</span>}
              </div>
            )}

            <div className={styles.fieldBlock}>
              <label className={styles.fieldLabel} htmlFor="output-path">Save to</label>
              <div className={styles.pathField}>
                <input
                  id="output-path"
                  type="text"
                  placeholder={suggestedFilename(session, format)}
                  value={outputPath}
                  onChange={(event) => setOutputPath(event.target.value)}
                />
                <button type="button" className={styles.iconButton} onClick={() => void pickOutputPath()}>
                  <FolderOpen size={16} />
                </button>
              </div>
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>Session summary</div>
                <p>{session.projectName}</p>
              </div>
            </div>

            <div className={styles.summaryGrid}>
              <div className={styles.summaryCard}>
                <span>Duration</span>
                <strong>{formatTransportTime(session.timelineDurationMs)}</strong>
              </div>
              <div className={styles.summaryCard}>
                <span>Clips</span>
                <strong>{session.clips.length}</strong>
              </div>
              <div className={styles.summaryCard}>
                <span>Tracks</span>
                <strong>{session.tracks.length}</strong>
              </div>
              <div className={styles.summaryCard}>
                <span>Resolution</span>
                <strong>
                  {session.dominantWidth && session.dominantHeight
                    ? `${session.dominantWidth} x ${session.dominantHeight}`
                    : 'Audio only'}
                </strong>
              </div>
            </div>

            <div className={styles.progressCard}>
              <div className={styles.progressHeader}>
                <div>
                  <span>Status</span>
                  <strong>{status === 'done' ? 'Completed' : status === 'running' ? 'Rendering' : 'Ready'}</strong>
                </div>

                {status === 'running' ? <LoaderCircle size={16} className={styles.spinning} /> : null}
                {status === 'done' ? <CheckCircle2 size={16} className={styles.successIcon} /> : null}
              </div>

              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${Math.round(progress.progress * 100)}%` }} />
              </div>

              <div className={styles.progressDetail}>{progress.detail}</div>
              {errorMessage && <div className={styles.errorCard}><AlertCircle size={14} /> {errorMessage}</div>}
            </div>

            <div className={styles.actions}>
              <button type="button" className={styles.secondaryButton} onClick={() => void refreshSession()}>
                <RefreshCcw size={15} />
                Refresh
              </button>
              <button type="button" className={styles.primaryButton} onClick={() => void handleExport()} disabled={status === 'running'}>
                <FileOutput size={16} />
                {status === 'running' ? 'Exporting...' : 'Start Export'}
              </button>
            </div>

            <div className={styles.notes}>
              <div className={styles.note}><Video size={14} /> MP4 and MKV exports include video plus mixed timeline audio.</div>
              <div className={styles.note}><Waves size={14} /> MP3, M4A and WAV export the mixed timeline audio only.</div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};