import React from 'react';

// Scaffold shell — real layout arrives with P1-E3-01. Deliberately unstyled
// beyond proving the renderer boots; theme tokens land in P1-E1-03.
export function App(): React.JSX.Element {
  // fail-open: a broken preload bridge must degrade, not blank the window
  const bridge = window.switchboard ?? { platform: 'bridge unavailable', appVersion: '?' };
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        color: '#d4d4d4',
        background: '#1e1e1e',
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        margin: 0,
      }}
    >
      <div>
        <h1 style={{ fontWeight: 300 }}>switchboard</h1>
        <p style={{ opacity: 0.6 }}>
          scaffold OK — {bridge.platform} · v{bridge.appVersion}
        </p>
      </div>
    </main>
  );
}
