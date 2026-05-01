import React, { useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { Video as VideoIcon, Music, Upload, Settings, GripVertical, VolumeX, Volume2, SplitSquareHorizontal, Play, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button/Button';
import { Card } from '../../components/Card/Card';
import { Select } from '../../components/Select/Select';
import { Tooltip } from '../../components/Tooltip/Tooltip';
import { createLogger } from '../../utils/logger';
import styles from './MediaEditor.module.css';

const log = createLogger('MediaEditor');

interface MediaClip {
  id: string;
  filename: string;
  duration: number; // in seconds
  thumbnail?: string;
  isMuted: boolean;
  file?: File;
}

export const MediaEditor: React.FC = () => {
  const [mode, setMode] = useState<'video' | 'audio'>('video');
  const [clips, setClips] = useState<MediaClip[]>([]);
  const [format, setFormat] = useState('mp4');
  const [quality, setQuality] = useState('1080p');
  
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleModeSwitch = (newMode: 'video' | 'audio') => {
    if (clips.length > 0) {
      if (!window.confirm('Switching modes will clear your current timeline. Continue?')) {
        return;
      }
    }
    setMode(newMode);
    setClips([]);
    setFormat(newMode === 'video' ? 'mp4' : 'mp3');
    setQuality(newMode === 'video' ? '1080p' : '320kbps');
    log.info(`Switched to ${newMode} mode`);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    
    // Mock processing files
    const newClips: MediaClip[] = Array.from(files).map((f) => ({
      id: Math.random().toString(36).substring(7),
      filename: f.name,
      duration: Math.floor(Math.random() * 300) + 30, // Mock duration
      isMuted: false,
      file: f,
      thumbnail: mode === 'video' ? 'https://images.unsplash.com/photo-1536240478700-b869070f9279?q=80&w=200&auto=format&fit=crop' : undefined
    }));

    setClips((prev) => [...prev, ...newClips]);
    log.info(`Added ${newClips.length} clip(s) to timeline`, newClips.map(c => c.filename));
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const toggleMute = (id: string) => {
    setClips(clips.map(c => c.id === id ? { ...c, isMuted: !c.isMuted } : c));
  };

  const removeClip = (id: string) => {
    setClips(clips.filter(c => c.id !== id));
  };

  const splitClip = (id: string) => {
    // Mock split: split exactly in half
    const clipIndex = clips.findIndex(c => c.id === id);
    if (clipIndex === -1) return;
    
    const clip = clips[clipIndex];
    const halfDuration = Math.floor(clip.duration / 2);
    
    const clip1: MediaClip = { ...clip, id: Math.random().toString(36).substring(7), duration: halfDuration, filename: `${clip.filename} (Part 1)` };
    const clip2: MediaClip = { ...clip, id: Math.random().toString(36).substring(7), duration: clip.duration - halfDuration, filename: `${clip.filename} (Part 2)` };
    
    const newClips = [...clips];
    newClips.splice(clipIndex, 1, clip1, clip2);
    setClips(newClips);
  };

  const handleExport = async () => {
    if (clips.length === 0) return;
    setIsExporting(true);
    setProgress(10);
    log.info(`Starting export: format=${format}, quality=${quality}, clips=${clips.length}`);
    try {
      // Pass the actual file paths or identifiers to Rust
      const fileNames = clips.map(c => c.filename);
      await invoke('process_media', { files: fileNames, format, quality });
      setProgress(100);
      log.info('Export completed successfully');
    } catch (e) {
      log.error('Export failed:', e);
      console.error(e);
      setProgress(0);
    } finally {
      setIsExporting(false);
      setTimeout(() => setProgress(0), 2000);
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const totalDuration = clips.reduce((acc, clip) => acc + clip.duration, 0);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={styles.container}
    >
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1>Media Editor</h1>
          <p>Concatenate, split, and process your media files.</p>
        </div>
        
        <div className={styles.modeToggle}>
          <button 
            className={`${styles.toggleBtn} ${mode === 'video' ? styles.active : ''}`}
            onClick={() => handleModeSwitch('video')}
          >
            <VideoIcon size={16} /> Video Mode
          </button>
          <button 
            className={`${styles.toggleBtn} ${mode === 'audio' ? styles.active : ''}`}
            onClick={() => handleModeSwitch('audio')}
          >
            <Music size={16} /> Audio Mode
          </button>
        </div>
      </div>

      <div className={styles.workspace}>
        <div className={styles.mainArea}>
          {clips.length === 0 ? (
            <div 
              className={styles.dropzone}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={48} className={styles.dropIcon} />
              <h3>Drag & Drop files here</h3>
              <p>or click to browse from your computer</p>
              <span className={styles.formatHint}>
                Supported formats: {mode === 'video' ? 'mp4, mkv' : 'mp3, wav, m4a'}
              </span>
            </div>
          ) : (
            <div className={styles.timeline}>
              <div className={styles.timelineHeader}>
                <h3>Timeline</h3>
                <div className={styles.timelineStats}>
                  <span>{clips.length} clips</span>
                  <span className={styles.dot}>•</span>
                  <span>Total duration: {formatDuration(totalDuration)}</span>
                </div>
              </div>
              
              <Reorder.Group axis="y" values={clips} onReorder={setClips} className={styles.clipList}>
                <AnimatePresence>
                  {clips.map((clip) => (
                    <Reorder.Item 
                      key={clip.id} 
                      value={clip}
                      className={styles.clipItem}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      <Card padding="sm" className={styles.clipCard}>
                        <div className={styles.dragHandle} title="Drag to reorder">
                          <GripVertical size={16} />
                        </div>
                        
                        {clip.thumbnail && (
                          <div className={styles.clipThumbnail}>
                            <img src={clip.thumbnail} alt="thumb" />
                          </div>
                        )}
                        
                        <div className={styles.clipInfo}>
                          <span className={styles.clipName} title={clip.filename}>{clip.filename}</span>
                          <span className={styles.clipDuration}>{formatDuration(clip.duration)}</span>
                        </div>
                        
                        <div className={styles.clipActions}>
                          <Tooltip content="Split Clip">
                            <button className={styles.iconBtn} onClick={() => splitClip(clip.id)}>
                              <SplitSquareHorizontal size={16} />
                            </button>
                          </Tooltip>
                          {mode === 'video' && (
                            <Tooltip content={clip.isMuted ? "Unmute" : "Mute"}>
                              <button 
                                className={`${styles.iconBtn} ${clip.isMuted ? styles.isMuted : ''}`}
                                onClick={() => toggleMute(clip.id)}
                              >
                                {clip.isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip content="Remove">
                            <button className={`${styles.iconBtn} ${styles.dangerBtn}`} onClick={() => removeClip(clip.id)}>
                              <Trash2 size={16} />
                            </button>
                          </Tooltip>
                        </div>
                      </Card>
                    </Reorder.Item>
                  ))}
                </AnimatePresence>
              </Reorder.Group>
              
              <Button 
                variant="secondary" 
                className={styles.addMoreBtn}
                onClick={() => fileInputRef.current?.click()}
                icon={<Upload size={16} />}
              >
                Add More Files
              </Button>
            </div>
          )}
          
          <input 
            type="file" 
            multiple 
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept={mode === 'video' ? '.mp4,.mkv' : '.mp3,.wav,.m4a'}
            onChange={handleFileUpload}
          />
        </div>

        <div className={styles.sidePanel}>
          <Card padding="md" className={styles.settingsCard}>
            <div className={styles.settingsHeader}>
              <Settings size={18} />
              <h3>Export Settings</h3>
            </div>
            
            <div className={styles.settingGroup}>
              <label>Output Format</label>
              <Select 
                options={mode === 'video' 
                  ? [{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }] 
                  : [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }, { value: 'm4a', label: 'M4A' }]} 
                value={format} 
                onChange={setFormat} 
              />
            </div>
            
            <div className={styles.settingGroup}>
              <label>Quality</label>
              <Select 
                options={mode === 'video' 
                  ? [{ value: '1080p', label: 'FHD (1080p)' }, { value: '720p', label: 'HD (720p)' }] 
                  : [{ value: '320kbps', label: '320 kbps' }, { value: '192kbps', label: '192 kbps' }]} 
                value={quality} 
                onChange={setQuality} 
              />
            </div>

            <div className={styles.exportSection}>
              {progress > 0 ? (
                <div className={styles.progressContainer}>
                  <div className={styles.progressHeader}>
                    <span>Exporting...</span>
                    <span>{progress}%</span>
                  </div>
                  <div className={styles.progressBar}>
                    <motion.div 
                      className={styles.progressFill} 
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              ) : (
                <Button 
                  size="lg" 
                  className={styles.exportBtn}
                  onClick={handleExport}
                  disabled={clips.length === 0}
                  loading={isExporting}
                  icon={<Play size={18} />}
                >
                  Export Media
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    </motion.div>
  );
};
