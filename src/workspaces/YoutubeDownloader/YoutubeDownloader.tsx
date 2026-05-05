import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, MonitorPlay, Music, Video as VideoIcon, CheckCircle2, AlertCircle, FolderOpen, ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { createLogger } from '../../utils/logger';
import styles from './YoutubeDownloader.module.css';

const log = createLogger('YoutubeDownloader');

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
}

export const YoutubeDownloader: React.FC = () => {
  const [url, setUrl] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<'video' | 'audio'>('video');
  const [format, setFormat] = useState('mp4');
  const [quality, setQuality] = useState('1080p');
  
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [downloadDone, setDownloadDone] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  const handleAnalyze = async () => {
    if (!url) return;
    setIsAnalyzing(true);
    setError(null);
    setDownloadDone(false);
    log.info('Analyzing URL:', url);
    try {
      const data = await invoke<VideoInfo>('get_youtube_info', { url });
      log.info('Video info received:', data);
      setInfo(data);
      setFormat(mode === 'video' ? 'mp4' : 'mp3');
      setQuality(mode === 'video' ? '1080p' : '320kbps');
    } catch (e: any) {
      const errMsg = e.toString();
      log.error('Failed to analyze URL:', errMsg);
      setError(errMsg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDownload = async () => {
    const selectedDir = await open({
      directory: true,
      multiple: false,
      title: 'Choose download location',
    });

    if (!selectedDir) {
      return;
    }

    const saveDir = selectedDir as string;
    setIsDownloading(true);
    setProgress(0);
    setStatusText('Preparing download...');
    setDownloadDone(false);
    setError(null);

    unlistenRef.current = await listen<{ percent: number; status: string; status_text: string; phase: string }>('download-progress', (event) => {
      const { percent, status_text } = event.payload;
      setProgress(Math.round(percent));
      if (status_text) {
        setStatusText(status_text);
      }
    });

    try {
      await invoke('download_youtube', { url, format, quality, saveDir });
      setProgress(100);
      setStatusText('Complete');
      setDownloadDone(true);
    } catch (e: any) {
      setError(e.toString());
      setProgress(0);
      setStatusText('');
    } finally {
      setIsDownloading(false);
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const videoFormats = ['mp4', 'mkv'];
  const audioFormats = ['mp3', 'm4a', 'wav'];
  const videoQualities = ['2160p', '1440p', '1080p', '720p'];
  const audioQualities = ['320kbps', '192kbps', '128kbps'];

  const hasSearched = info !== null || isAnalyzing || error !== null;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ ease: "easeOut", duration: 0.2 }}
      className={styles.container}
    >
      <motion.div 
        layout
        transition={{ ease: "easeInOut", duration: 0.4 }}
        className={styles.searchSection}
        data-centered={!hasSearched}
      >
        <motion.div layout className={styles.inputWrapper}>
          <Search className={styles.inputIcon} size={18} />
          <input 
            type="text" 
            placeholder="Paste YouTube URL and press Enter..." 
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (info) {
                setInfo(null);
                setError(null);
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
            className={styles.input}
            spellCheck={false}
          />
          {isAnalyzing && (
            <motion.div className={styles.spinner} animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} />
          )}
          {!isAnalyzing && url && !hasSearched && (
            <button className={styles.analyzeBtn} onClick={handleAnalyze}>
              <ChevronRight size={18} />
            </button>
          )}
        </motion.div>
      </motion.div>

      <AnimatePresence mode="wait">
        {error && (
          <motion.div 
            key="error"
            initial={{ opacity: 0, y: -10 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: -10 }}
            className={styles.errorAlert}
          >
            <AlertCircle size={16} />
            {error}
          </motion.div>
        )}

        {info && !isAnalyzing && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ ease: "easeOut", duration: 0.3 }}
            className={styles.resultSection}
          >
            <div className={styles.previewCard}>
              <div className={styles.previewImage}>
                <img src={info.thumbnail} alt="Thumbnail" />
                <span className={styles.duration}>{formatDuration(info.duration)}</span>
              </div>
              
              <div className={styles.previewInfo}>
                <h3 className={styles.videoTitle} title={info.title}>{info.title}</h3>
                
                <div className={styles.segmentedControl}>
                  <button 
                    className={`${styles.segmentBtn} ${mode === 'video' ? styles.active : ''}`}
                    onClick={() => { setMode('video'); setFormat('mp4'); setQuality('1080p'); }}
                  >
                    <VideoIcon size={14} /> Video
                  </button>
                  <button 
                    className={`${styles.segmentBtn} ${mode === 'audio' ? styles.active : ''}`}
                    onClick={() => { setMode('audio'); setFormat('mp3'); setQuality('320kbps'); }}
                  >
                    <Music size={14} /> Audio
                  </button>
                </div>

                <div className={styles.settingsGrid}>
                  <div className={styles.settingGroup}>
                    <span className={styles.settingLabel}>Format</span>
                    <div className={styles.pillGrid}>
                      {(mode === 'video' ? videoFormats : audioFormats).map(f => (
                        <button 
                          key={f}
                          className={`${styles.pillBtn} ${format === f ? styles.activePill : ''}`}
                          onClick={() => setFormat(f)}
                        >
                          {f.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <div className={styles.settingGroup}>
                    <span className={styles.settingLabel}>Quality</span>
                    <div className={styles.pillGrid}>
                      {(mode === 'video' ? videoQualities : audioQualities).map(q => (
                        <button 
                          key={q}
                          className={`${styles.pillBtn} ${quality === q ? styles.activePill : ''}`}
                          onClick={() => setQuality(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.actionSection}>
                  {isDownloading ? (
                    <div className={styles.progressContainer}>
                      <div className={styles.progressHeader}>
                        <span className={styles.progressLabel}>{statusText}</span>
                        <span className={styles.progressPercent}>{progress}%</span>
                      </div>
                      <div className={styles.progressBar}>
                        <motion.div 
                          className={styles.progressFill}
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          transition={{ ease: "linear", duration: 0.2 }}
                        />
                      </div>
                    </div>
                  ) : downloadDone ? (
                    <div className={styles.successMessage}>
                      <CheckCircle2 size={16} />
                      Download Complete
                    </div>
                  ) : (
                    <button 
                      className={styles.downloadBtn}
                      onClick={handleDownload} 
                    >
                      <FolderOpen size={16} />
                      Download
                    </button>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
