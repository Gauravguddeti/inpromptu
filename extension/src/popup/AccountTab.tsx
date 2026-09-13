import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { AuthState } from '../types';

const SUPABASE_URL = 'https://bakcqcfmikaiifgcwllq.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJha2NxY2ZtaWthaWlmZ2N3bGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4ODg2NTUsImV4cCI6MjEwNDQ2NDY1NX0.uwSRJmZn7163diI5o83PSph_zSYFZgNclcm8_3OP2hA';

// Supabase client (anon key is safe in the extension — it's public by design)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface Props {
  authState: AuthState;
  onAuthChange: (auth: AuthState) => void;
}

type Mode = 'login' | 'signup';

export function AccountTab({ authState, onAuthChange }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        if (data.session) {
          onAuthChange({
            isAuthenticated: true,
            userId: data.user?.id ?? null,
            email: data.user?.email ?? null,
            accessToken: data.session.access_token,
          });
        }
      } else {
        const { error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        setMessage('Check your email to confirm your account, then sign in.');
        setMode('login');
      }
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    onAuthChange({
      isAuthenticated: false,
      userId: null,
      email: null,
      accessToken: null,
    });
  };

  if (authState.isAuthenticated) {
    const initial = authState.email?.[0]?.toUpperCase() ?? '?';
    return (
      <div className="auth-container fade-in">
        <div className="profile-card">
          <div className="avatar">{initial}</div>
          <div className="profile-info">
            <div className="profile-email">{authState.email}</div>
            <div className="profile-status">✓ Signed in</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
          <div
            className="setting-row"
            style={{ justifyContent: 'center', fontSize: '12px', color: 'var(--text-muted)' }}
          >
            Your memories and preferences sync across all your devices.
          </div>
        </div>

        <button id="btn-signout" className="btn-secondary" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="auth-container fade-in">
      <div className="auth-title">{mode === 'login' ? 'Welcome back' : 'Create account'}</div>
      <div className="auth-subtitle">
        {mode === 'login'
          ? 'Sign in to sync your memory and preferences.'
          : 'Create a free account to enable cloud memory.'}
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        <input
          id="auth-email"
          className="form-input"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          id="auth-password"
          className="form-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />

        {error && <div className="error-msg">{error}</div>}
        {message && (
          <div className="error-msg" style={{ background: 'rgba(16,185,129,0.08)', color: 'var(--green)' }}>
            {message}
          </div>
        )}

        <button id="btn-auth-submit" className="btn-primary" type="submit" disabled={loading}>
          {loading ? 'Loading…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button
        id="btn-auth-toggle"
        className="btn-secondary"
        onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setMessage(''); }}
      >
        {mode === 'login' ? 'No account? Sign up' : 'Have an account? Sign in'}
      </button>
    </div>
  );
}
