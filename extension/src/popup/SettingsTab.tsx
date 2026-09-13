import React from 'react';
import { ExtensionSettings } from '../types';

interface Props {
  settings: ExtensionSettings;
  onChange: (patch: Partial<ExtensionSettings>) => void;
}

export function SettingsTab({ settings, onChange }: Props) {
  return (
    <div>
      <div className="settings-group">
        <div className="settings-label">Analysis</div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-name">Enable analysis</div>
            <div className="setting-desc">Underline and suggest improvements as you type</div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              id="toggle-analysis"
              checked={settings.analysisEnabled}
              onChange={(e) => onChange({ analysisEnabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-name">Model speed</div>
            <div className="setting-desc">
              {settings.modelSpeed === 'fast' ? 'Fast (Groq only)' : 'Quality (Gemini + Groq)'}
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              id="toggle-speed"
              checked={settings.modelSpeed === 'quality'}
              onChange={(e) => onChange({ modelSpeed: e.target.checked ? 'quality' : 'fast' })}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-label">Memory & Privacy</div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-name">Cloud memory</div>
            <div className="setting-desc">Learn your style, glossary, and projects</div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              id="toggle-memory"
              checked={settings.memoryEnabled}
              onChange={(e) => onChange({ memoryEnabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-name">Privacy mode</div>
            <div className="setting-desc">Local heuristics only — no prompts sent to cloud</div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              id="toggle-privacy"
              checked={settings.privacyMode}
              onChange={(e) => onChange({ privacyMode: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-label">About</div>
        <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
          <div className="setting-name" style={{ fontSize: '12px' }}>PromptCoach v0.1.0</div>
          <div className="setting-desc">Grammarly for AI prompts ✨</div>
          <div className="setting-desc" style={{ marginTop: '4px', fontSize: '10px', lineHeight: '1.5' }}>
            ⚠️ Analysis uses free-tier LLM providers that may use your prompts for model training.
            Enable Privacy Mode for sensitive content.
          </div>
        </div>
      </div>
    </div>
  );
}
