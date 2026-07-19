import React, { useEffect, useState } from 'react';
import {
  applyPreference,
  followSystemTheme,
  loadPreference,
  ThemeName,
  ThemePreference,
} from './theme/theme';

// Scaffold shell — real layout arrives with P1-E3-01. The theme toggle exists
// to prove live token-map flipping (P1-E1-03 done-when).
export function App(): React.JSX.Element {
  // fail-open: a broken preload bridge must degrade, not blank the window
  const bridge = window.switchboard ?? { platform: 'bridge unavailable', appVersion: '?' };
  const [pref, setPref] = useState<ThemePreference>(() => loadPreference());
  const [theme, setTheme] = useState<ThemeName>(() => applyPreference(loadPreference()));

  useEffect(() => followSystemTheme(setTheme), []);

  const choose = (next: ThemePreference): void => {
    setPref(next);
    setTheme(applyPreference(next));
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontWeight: 300 }}>switchboard</h1>
        <p style={{ color: 'var(--muted)' }}>
          scaffold OK — {bridge.platform} · v{bridge.appVersion} · theme: {theme} ({pref})
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {(['system', 'nordic', 'daylight'] as const).map((p) => (
            <button
              key={p}
              onClick={() => choose(p)}
              style={{
                background: p === pref ? 'var(--chip)' : 'var(--panel)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '4px 12px',
                cursor: 'pointer',
                fontFamily: 'var(--font-ui)',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
