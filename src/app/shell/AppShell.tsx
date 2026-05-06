import React, { useMemo, useState } from 'react';
import { Header, type Tab } from '../../components/Header/Header';
import { MediaEditorWorkspace } from '../../modules/editor/presentation/MediaEditorWorkspace';
import { YoutubeDownloader } from '../../modules/downloader/presentation/YoutubeDownloader';

interface WorkspaceDefinition {
  id: Tab;
  render: () => React.ReactNode;
}

const WORKSPACES: WorkspaceDefinition[] = [
  {
    id: 'youtube',
    render: () => <YoutubeDownloader />,
  },
  {
    id: 'editor',
    render: () => <MediaEditorWorkspace />,
  },
];

export function AppShell() {
  const [activeTab, setActiveTab] = useState<Tab>('youtube');
  const activeWorkspace = useMemo(
    () => WORKSPACES.find((workspace) => workspace.id === activeTab) ?? WORKSPACES[0],
    [activeTab],
  );

  return (
    <div className="app-container">
      <Header activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="workspace-content">{activeWorkspace.render()}</div>
    </div>
  );
}