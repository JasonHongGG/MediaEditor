import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, X, Download, Scissors } from 'lucide-react';
import { motion } from 'framer-motion';
import styles from './Header.module.css';

export type Tab = 'youtube' | 'editor';

interface HeaderProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onTabChange }) => {
  const minimize = () => getCurrentWindow().minimize();
  const close = () => getCurrentWindow().close();

  return (
    <div data-tauri-drag-region className={styles.header}>
      <div className={styles.left} data-tauri-drag-region>
        <div className={styles.logo} data-tauri-drag-region>
          <div className={styles.logoIcon}>M</div>
          <span className={styles.logoText}>Media Editor</span>
        </div>
      </div>
      
      <div className={styles.center} data-tauri-drag-region>
        <div className={styles.tabs}>
          <button 
            className={`${styles.tab} ${activeTab === 'youtube' ? styles.active : ''}`}
            onClick={() => onTabChange('youtube')}
          >
            <Download size={15} />
            Download
            {activeTab === 'youtube' && (
              <motion.div layoutId="activeTab" className={styles.activeIndicator} />
            )}
          </button>
          <button 
            className={`${styles.tab} ${activeTab === 'editor' ? styles.active : ''}`}
            onClick={() => onTabChange('editor')}
          >
            <Scissors size={15} />
            Editor
            {activeTab === 'editor' && (
              <motion.div layoutId="activeTab" className={styles.activeIndicator} />
            )}
          </button>
        </div>
      </div>

      <div className={styles.right}>
        <button className={styles.controlBtn} onClick={minimize} title="Minimize">
          <Minus size={14} />
        </button>
        <button className={`${styles.controlBtn} ${styles.closeBtn}`} onClick={close} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
