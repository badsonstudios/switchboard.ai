import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './i18n';
import { initRendererContributions } from './bootstrap';
import './theme/tokens.css';

// register the built-in contributions (and log what registered) BEFORE the
// first render — every consumer resolves from this registry
initRendererContributions();

void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
