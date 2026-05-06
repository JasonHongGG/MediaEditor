import React, { useCallback, useState } from 'react';
import { Header, type Tab } from '../../components/Header/Header';
import { MediaEditorWorkspace } from '../../modules/editor/presentation/MediaEditorWorkspace';
import { YoutubeDownloader } from '../../modules/downloader/presentation/YoutubeDownloader';
import styles from './AppShell.module.css';

interface WorkspaceDefinition {
  id: Tab;
  render: (isActive: boolean) => React.ReactNode;
}

const WORKSPACES: WorkspaceDefinition[] = [
  {
    id: 'youtube',
    render: (isActive) => <YoutubeDownloader isActive={isActive} />,
  },
  {
    id: 'editor',
    render: (isActive) => <MediaEditorWorkspace isActive={isActive} />,
  },
];

export function AppShell() {
  const [activeTab, setActiveTab] = useState<Tab>('youtube');
  const [mountedTabs, setMountedTabs] = useState<Tab[]>(['youtube']);

  const handleTabChange = useCallback((nextTab: Tab) => {
    setActiveTab(nextTab);
    setMountedTabs((currentTabs) => (currentTabs.includes(nextTab) ? currentTabs : [...currentTabs, nextTab]));
  }, []);

  return (
    <div className="app-container">
      <Header activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="workspace-content">
        <div className={styles.workspaceHost}>
          {WORKSPACES.map((workspace) => {
            if (!mountedTabs.includes(workspace.id)) {
              return null;
            }

            const isActive = workspace.id === activeTab;

            return (
              <section
                key={workspace.id}
                className={styles.workspacePane}
                hidden={!isActive}
                aria-hidden={!isActive}
              >
                {workspace.render(isActive)}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}