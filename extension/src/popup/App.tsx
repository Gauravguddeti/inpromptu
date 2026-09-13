import React, { useState, useEffect } from 'react';
import { SettingsTab } from './SettingsTab';
import { MemoryTab } from './MemoryTab';
import { AccountTab } from './AccountTab';
import { ContextTab } from './ContextTab';
import { AuthState, ExtensionSettings, DEFAULT_SETTINGS } from '../types';

type Tab = 'settings' | 'context' | 'memory' | 'account';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('settings');
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    userId: null,
    email: null,
    accessToken: null,
  });
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE', payload: {} }, (resp) => {
      if (resp?.payload) setAuthState(resp.payload);
    });
    chrome.storage.local.get(['settings'], (result) => {
      if (result.settings) {
        setSettings({ ...DEFAULT_SETTINGS, ...result.settings });
      }
    });
  }, []);

  const updateSettings = (patch: Partial<ExtensionSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    chrome.storage.local.set({ settings: next });
  };

  const updateAuth = (newAuth: AuthState) => {
    setAuthState(newAuth);
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGE', payload: newAuth });
  };

  const isActive = settings.analysisEnabled;

  return (
    <div className="fade-in">
      <header className="header">
        <div className="logo">
          <div className="logo-icon">✨</div>
          <span className="logo-text">PromptCoach</span>
        </div>
        <div className="header-badge">
          <span className={`badge-dot ${isActive ? '' : 'inactive'}`} />
          {isActive ? 'Active' : 'Paused'}
        </div>
      </header>

      <nav className="tabs">
        {(['settings', 'context', 'memory', 'account'] as Tab[]).map((tab) => (
          <button
            key={tab}
            id={`tab-${tab}`}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'settings' && '⚙ Settings'}
            {tab === 'context' && '🗪 Context'}
            {tab === 'memory' && '🧠 Memory'}
            {tab === 'account' && '👤 Account'}
          </button>
        ))}
      </nav>

      <main className="content">
        {activeTab === 'settings' && (
          <SettingsTab settings={settings} onChange={updateSettings} />
        )}
        {activeTab === 'context' && (
          <ContextTab isOnSupportedSite={true} />
        )}
        {activeTab === 'memory' && (
          <MemoryTab authState={authState} />
        )}
        {activeTab === 'account' && (
          <AccountTab authState={authState} onAuthChange={updateAuth} />
        )}
      </main>
    </div>
  );
}
