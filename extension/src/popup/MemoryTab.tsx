import React, { useState, useEffect } from 'react';
import { MemoryEntry, AuthState } from '../types';

interface Props {
  authState: AuthState;
}

export function MemoryTab({ authState }: Props) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  useEffect(() => {
    if (!authState.isAuthenticated) return;
    loadMemories();
  }, [authState.isAuthenticated]);

  const loadMemories = () => {
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'GET_MEMORIES', payload: {} }, (resp) => {
      setLoading(false);
      if (resp?.payload && Array.isArray(resp.payload)) {
        setMemories(resp.payload);
      }
    });
  };

  const deleteMemory = (id: string) => {
    chrome.runtime.sendMessage({ type: 'DELETE_MEMORY', payload: { id } }, () => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
    });
  };

  const startEdit = (mem: MemoryEntry) => {
    setEditingId(mem.id);
    setEditContent(mem.content);
  };

  const saveEdit = (id: string) => {
    chrome.runtime.sendMessage(
      { type: 'UPDATE_MEMORY', payload: { id, content: editContent } },
      () => {
        setMemories((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: editContent } : m))
        );
        setEditingId(null);
      }
    );
  };

  const kindClass: Record<string, string> = {
    preference: 'kind-preference',
    glossary: 'kind-glossary',
    project: 'kind-project',
    correction: 'kind-correction',
  };

  if (!authState.isAuthenticated) {
    return (
      <div className="memory-empty">
        <div className="memory-empty-icon">🔒</div>
        <div className="memory-empty-title">Sign in to use Memory</div>
        <div className="memory-empty-desc">
          Your preferences, glossary, and project context are stored securely in your account.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="memory-empty">
        <div className="memory-empty-icon">⏳</div>
        <div className="memory-empty-title">Loading memories…</div>
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="memory-empty">
        <div className="memory-empty-icon">🧠</div>
        <div className="memory-empty-title">No memories yet</div>
        <div className="memory-empty-desc">
          Inpromptu will learn your writing style, terminology, and project context as you use it.
          All entries are visible and editable here.
        </div>
      </div>
    );
  }

  return (
    <div>
      {memories.map((mem) => (
        <div key={mem.id} className="memory-item fade-in">
          <div className="memory-item-header">
            <span className={`memory-kind-badge ${kindClass[mem.kind] ?? ''}`}>
              {mem.kind}
            </span>
            <div className="memory-actions">
              <button
                id={`edit-memory-${mem.id}`}
                className="icon-btn"
                title="Edit"
                onClick={() => (editingId === mem.id ? saveEdit(mem.id) : startEdit(mem))}
              >
                {editingId === mem.id ? '✓' : '✏'}
              </button>
              <button
                id={`delete-memory-${mem.id}`}
                className="icon-btn danger"
                title="Delete"
                onClick={() => deleteMemory(mem.id)}
              >
                ✕
              </button>
            </div>
          </div>

          {editingId === mem.id ? (
            <textarea
              id={`edit-input-${mem.id}`}
              className="form-input"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={3}
              style={{ resize: 'vertical', fontSize: '12px' }}
              autoFocus
            />
          ) : (
            <div className="memory-content">{mem.content}</div>
          )}

          <div className="memory-date">
            Added {new Date(mem.created_at).toLocaleDateString()}
            {mem.last_used_at && ` · Used ${new Date(mem.last_used_at).toLocaleDateString()}`}
          </div>
        </div>
      ))}
    </div>
  );
}
