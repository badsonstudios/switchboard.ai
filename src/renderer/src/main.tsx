import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './i18n';
import { initRendererContributions } from './bootstrap';
import { loadUiState } from './lib/ui-state';
import './theme/tokens.css';

// register the built-in contributions (and log what registered) BEFORE the
// first render — every consumer resolves from this registry
initRendererContributions();

// The ui blob FIRST (P2-E15-06): theme and language live there now, and both
// are needed before the first paint — i18n picks its language at init, and the
// theme has to be on <html> before anything renders or the window flashes the
// default. Reading it here is what keeps both of them synchronous afterwards.
// App calls loadUiState() again behind its own gate; it is idempotent.
void loadUiState()
  .then(initI18n)
  .then(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
