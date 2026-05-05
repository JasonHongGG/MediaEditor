import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, MonitorPlay, Music, Video as VideoIcon, CheckCircle2, AlertCircle, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { Button } from '../../components/Button/Button';
import { Card } from '../../components/Card/Card';
import { Select } from '../../components/Select/Select';
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

  // Cleanup event listener on unmount
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
    // Ask user to pick a save directory first
    const selectedDir = await open({
      directory: true,
      multiple: false,
      title: 'Choose download location',
    });

    if (!selectedDir) {
      log.info('User cancelled folder selection');
      return;
    }

    const saveDir = selectedDir as string;
    log.info('Save directory:', saveDir);

    setIsDownloading(true);
    setProgress(0);
    setStatusText('Starting download...');
    setDownloadDone(false);
    setError(null);
    log.info(`Starting download: format=${format}, quality=${quality}, saveDir=${saveDir}`);

    // Listen for progress events from the Rust backend
    unlistenRef.current = await listen<{ percent: number; status: string; status_text: string; phase: string }>('download-progress', (event) => {
      const { percent, status_text } = event.payload;
      log.debug(`Progress: ${percent.toFixed(1)}% — ${status_text}`);
      setProgress(Math.round(percent));
      if (status_text) {
        setStatusText(status_text);
      }
    });

    try {
      await invoke('download_youtube', { url, format, quality, saveDir });
      setProgress(100);
      setStatusText('Download complete!');
      setDownloadDone(true);
      log.info('Download completed successfully');
    } catch (e: any) {
      const errMsg = e.toString();
      log.error('Download failed:', errMsg);
      setError(errMsg);
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

  const videoFormats = [
    { value: 'mp4', label: 'MP4' },
    { value: 'mkv', label: 'MKV' }
  ];

  const audioFormats = [
    { value: 'mp3', label: 'MP3' },
    { value: 'm4a', label: 'M4A' },
    { value: 'wav', label: 'WAV' }
  ];

  const videoQualities = [
    { value: '2160p', label: '4K (2160p)' },
    { value: '1440p', label: '2K (1440p)' },
    { value: '1080p', label: 'FHD (1080p)' },
    { value: '720p', label: 'HD (720p)' }
  ];

  const audioQualities = [
    { value: '320kbps', label: '320 kbps (High)' },
    { value: '192kbps', label: '192 kbps (Medium)' },
    { value: '128kbps', label: '128 kbps (Low)' }
  ];

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={styles.container}
    >
      <div className={styles.header}>
        <MonitorPlay className={styles.headerIcon} size={32} />
        <h1>YouTube Downloader</h1>
        <p>Download high-quality videos and audio instantly.</p>
      </div>

      <div className={styles.searchSection}>
        <div className={styles.inputWrapper}>
          <Search className={styles.inputIcon} size={20} />
          <input 
            type="text" 
            placeholder="Paste YouTube URL here..." 
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
            className={styles.input}
          />
        </div>
        <Button 
          size="lg" 
          onClick={handleAnalyze} 
          loading={isAnalyzing}
          disabled={!url}
          tooltip="Analyze the pasted URL and load available download options"
        >
          Analyze
        </Button>
      </div>

      <AnimatePresence mode="wait">
        {error && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }} 
            animate={{ opacity: 1, height: 'auto' }} 
            exit={{ opacity: 0, height: 0 }}
            className={styles.errorAlert}
          >
            <AlertCircle size={18} />
            {error}
          </motion.div>
        )}

        {info && !isAnalyzing && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={styles.resultSection}
          >
            <Card padding="none" className={styles.previewCard}>
              <div className={styles.previewImage}>
                <img src={info.thumbnail} alt="Thumbnail" />
                <span className={styles.duration}>{formatDuration(info.duration)}</span>
              </div>
              <div className={styles.previewInfo}>
                <h3 className={styles.videoTitle} title={info.title}>{info.title}</h3>
                
                <div className={styles.modeToggle}>
                  <button 
                    className={`${styles.toggleBtn} ${mode === 'video' ? styles.active : ''}`}
                    onClick={() => { setMode('video'); setFormat('mp4'); setQuality('1080p'); }}
                  >
                    <VideoIcon size={16} /> Video
                  </button>
                  <button 
                    className={`${styles.toggleBtn} ${mode === 'audio' ? styles.active : ''}`}
                    onClick={() => { setMode('audio'); setFormat('mp3'); setQuality('320kbps'); }}
                  >
                    <Music size={16} /> Audio
                  </button>
                </div>

                <div className={styles.settingsGrid}>
                  <div className={styles.settingGroup}>
                    <label>Format</label>
                    <Select 
                      options={mode === 'video' ? videoFormats : audioFormats} 
                      value={format} 
                      onChange={setFormat} 
                    />
                  </div>
                  <div className={styles.settingGroup}>
                    <label>Quality</label>
                    <Select 
                      options={mode === 'video' ? videoQualities : audioQualities} 
                      value={quality} 
                      onChange={setQuality} 
                    />
                  </div>
                </div>

                <div className={styles.actionSection}>
                  {isDownloading ? (
                    <div className={styles.progressContainer}>
                      <div className={styles.progressHeader}>
                        <span className={styles.progressLabel}>{statusText || 'Preparing...'}</span>
                        <span className={styles.progressPercent}>{progress}%</span>
                      </div>
                      <div className={styles.progressBar}>
                        <motion.div 
                          className={styles.progressFill}
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          transition={{ duration: 0.3, ease: 'easeOut' }}
                        />
                      </div>
                    </div>
                  ) : downloadDone ? (
                    <div className={styles.successMessage}>
                      <CheckCircle2 size={20} />
                      Downloaded Successfully
                    </div>
                  ) : (
                    <Button 
                      size="lg" 
                      onClick={handleDownload} 
                      className={styles.downloadBtn}
                      icon={<FolderOpen size={18} />}
                      tooltip={`Download the ${mode === 'video' ? 'video' : 'audio'} with the selected format and quality`}
                    >
                      Download {mode === 'video' ? 'Video' : 'Audio'}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
