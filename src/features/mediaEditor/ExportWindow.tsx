import React from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2,
  FileOutput,
  FolderOpen,
  LoaderCircle,
  Music4,
  RefreshCcw,
  Video,
  X,
  Settings2,
  AlertTriangle,
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
import { Select } from '../../components/Select/Select';

type ExportStatus = 'loading' | 'idle' | 'running' | 'done' | 'error';
const log = createLogger('ExportWindow');

const FORMAT_OPTIONS: Array<{
  value: ExportFormat;
  label: string;
  kind: 'video' | 'audio';
}> = [
  { value: 'mp4', label: 'MP4', kind: 'video' },
  { value: 'mkv', label: 'MKV', kind: 'video' },
  { value: 'mp3', label: 'MP3', kind: 'audio' },
  { value: 'm4a', label: 'M4A', kind: 'audio' },
  { value: 'wav', label: 'WAV', kind: 'audio' },
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
        setErrorMessage('No timeline is queued for export yet.');
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
    if (!outputPath) return;

    const lastDotIndex = outputPath.lastIndexOf('.');
    if (lastDotIndex === -1) {
      setOutputPath(`${outputPath}.${format}`);
      return;
    }

    // Replace existing extension with the new format
    const base = outputPath.slice(0, lastDotIndex);
    setOutputPath(`${base}.${format}`);
  }, [format]);

  React.useEffect(() => {
    void refreshSession();

    let disposed = false;
    let removeSessionListener: (() => void) | undefined;
    let removeProgressListener: (() => void) | undefined;

    void listen<PendingExportSession>('editor/export-session-updated', (event) => {
      if (disposed) return;
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
      if (disposed) return;
      const nextProgress = {
        ...event.payload,
        progress: Math.max(0, Math.min(1, event.payload.progress)),
      };
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
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });

    if (!selectedPath) return null;

    const normalizedPath = selectedPath.toLowerCase().endsWith(`.${format}`)
      ? selectedPath
      : `${selectedPath}.${format}`;
    setOutputPath(normalizedPath);
    return normalizedPath;
  }, [format, outputPath, session]);

  const handleExport = React.useCallback(async () => {
    if (!session || status === 'running') return;

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
      let finalPath = outputPath || (await pickOutputPath());
      if (!finalPath) {
        setStatus('idle');
        setProgress(DEFAULT_PROGRESS);
        return;
      }

      // Final safety check for extension synchronization
      if (!finalPath.toLowerCase().endsWith(`.${format}`)) {
        const lastDot = finalPath.lastIndexOf('.');
        if (lastDot !== -1) {
          finalPath = `${finalPath.slice(0, lastDot)}.${format}`;
        } else {
          finalPath = `${finalPath}.${format}`;
        }
        setOutputPath(finalPath);
      }

      await processTimelineExport({
        outputPath: finalPath,
        format,
        videoQuality,
        audioBitrateKbps,
        session,
      });
    } catch (error) {
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

  const handleClose = async () => {
    await getCurrentWindow().close();
  };

  return (
    <div className={styles.windowContainer}>
      <header className={styles.titlebar} data-tauri-drag-region>
        <div className={styles.titlebarLeft} data-tauri-drag-region>
          <Settings2 size={16} />
          <span>Export Options</span>
        </div>
        <button className={styles.closeButton} onClick={handleClose}>
          <X size={16} />
        </button>
      </header>

      <main className={styles.mainContent}>
        <AnimatePresence mode="wait">
          {!session ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={styles.emptyState}
            >
              <div className={styles.iconCircle}>
                <AlertTriangle size={24} />
              </div>
              <p>{errorMessage ?? 'No pending timeline export.'}</p>
              <button className={styles.outlineBtn} onClick={() => void refreshSession()}>
                <RefreshCcw size={14} /> Refresh
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="content"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={styles.contentLayout}
            >
              {/* Top Section: Overview */}
              <div className={styles.sessionOverview}>
                <div className={styles.projectName}>{session.projectName}</div>
                <div className={styles.metaRow}>
                  <div className={styles.metaBadge}>
                    <Video size={14} />
                    {session.dominantWidth && session.dominantHeight
                      ? `${session.dominantWidth}x${session.dominantHeight}`
                      : 'Audio'}
                  </div>
                  <div className={styles.metaBadge}>
                    <Music4 size={14} />
                    {formatTransportTime(session.timelineDurationMs)}
                  </div>
                  <div className={styles.metaBadge}>
                    {session.clips.length} Clips
                  </div>
                </div>
              </div>

              {/* Form Settings */}
              <div className={styles.settingsPanel}>
                <div className={styles.settingGroup}>
                  <label>Format</label>
                  <div className={styles.formatSelector}>
                    {FORMAT_OPTIONS.map((opt) => {
                      const isActive = format === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => setFormat(opt.value)}
                          className={`${styles.formatPill} ${isActive ? styles.active : ''}`}
                        >
                          {isActive && (
                            <motion.div
                              layoutId="formatPillBg"
                              className={styles.pillBg}
                              initial={false}
                              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                            />
                          )}
                          <span className={styles.pillText}>{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.settingGroup}>
                  <label>{isVideoOutput ? 'Quality' : 'Bitrate'}</label>
                  {isVideoOutput ? (
                    <div className={styles.selectWrapper}>
                      <Select
                        value={videoQuality}
                        onChange={(val) => setVideoQuality(val as VideoQuality)}
                        options={VIDEO_QUALITY_OPTIONS.map((opt) => ({
                          value: opt,
                          label: opt === 'source' ? 'Source' : opt,
                        }))}
                      />
                    </div>
                  ) : (
                    <div className={styles.selectWrapper}>
                      <Select
                        value={audioBitrateKbps.toString()}
                        onChange={(val) => setAudioBitrateKbps(Number(val) as AudioBitrateKbps)}
                        disabled={!usesAudioBitrate}
                        options={AUDIO_BITRATE_OPTIONS.map((opt) => ({
                          value: opt.toString(),
                          label: `${opt} kbps`,
                        }))}
                      />
                    </div>
                  )}
                </div>

                <div className={styles.settingGroup}>
                  <label>Save to</label>
                  <div className={styles.pathInputGroup}>
                    <input
                      type="text"
                      placeholder={suggestedFilename(session, format)}
                      value={outputPath}
                      onChange={(e) => setOutputPath(e.target.value)}
                      className={styles.pathInput}
                    />
                    <button className={styles.folderBtn} onClick={() => void pickOutputPath()}>
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Progress & Action */}
              <div className={styles.actionPanel}>
                <AnimatePresence mode="wait">
                  {status === 'running' ? (
                    <motion.div
                      key="running"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className={styles.progressContainer}
                    >
                      <div className={styles.progressHeader}>
                        <span className={styles.progressDetail}>{progress.detail}</span>
                        <span className={styles.progressPercent}>{Math.round(progress.progress * 100)}%</span>
                      </div>
                      <div className={styles.progressBarBg}>
                        <motion.div
                          className={styles.progressBarFill}
                          initial={{ width: 0 }}
                          animate={{ width: `${progress.progress * 100}%` }}
                          transition={{ ease: 'linear', duration: 0.2 }}
                        />
                      </div>
                    </motion.div>
                  ) : status === 'done' ? (
                    <motion.div
                      key="done"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={styles.successMessage}
                    >
                      <CheckCircle2 size={18} />
                      <span>Export completed successfully</span>
                    </motion.div>
                  ) : status === 'error' && errorMessage ? (
                    <motion.div
                      key="error"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={styles.errorMessage}
                    >
                      <AlertTriangle size={16} />
                      <span>{errorMessage}</span>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <div className={styles.actionRow}>
                  <button className={styles.secondaryBtn} onClick={handleClose}>
                    Cancel
                  </button>
                  <motion.button
                    className={styles.primaryBtn}
                    onClick={() => void handleExport()}
                    disabled={status === 'running'}
                    whileHover={{ scale: status === 'running' ? 1 : 1.02 }}
                    whileTap={{ scale: status === 'running' ? 1 : 0.98 }}
                  >
                    {status === 'running' ? (
                      <LoaderCircle className={styles.spin} size={18} />
                    ) : (
                      <FileOutput size={18} />
                    )}
                    {status === 'running' ? 'Rendering...' : 'Export Media'}
                  </motion.button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};