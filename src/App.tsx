import { useState } from 'react';
import { Header, type Tab } from './components/Header/Header';
import { YoutubeDownloader } from './workspaces/YoutubeDownloader/YoutubeDownloader';
import { MediaEditor } from './workspaces/MediaEditor/MediaEditor';
import './index.css';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('youtube');

  return (
    <div className="app-container">
      <Header activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="workspace-content">
        {activeTab === 'youtube' && <YoutubeDownloader />}
        {activeTab === 'editor' && <MediaEditor />}
      </div>
    </div>
  );
}

export default App;
