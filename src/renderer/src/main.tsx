import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { App } from './App';
import { initI18n } from './i18n';
import { initRendererContributions } from './bootstrap';
import { loadUiState } from './lib/ui-state';
import { publishContextMenuLabels } from './lib/context-menu-labels';
import { rootIdentifierPrefix } from './lib/root-identity';
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
  // Right-click menus are built in main and labelled from here (#526). Before
  // the first render, so a right-click on the boot screen already has words.
  publishContextMenuLabels(i18next);
  // #673: every `useId`-derived id in the app gets a per-launch random
  // namespace, so content rendered in the feed or the viewer cannot name a
  // live control id (the capture rules are in `markdown.tsx`'s profile note;
  // the generator's own comment says why crypto-random and why once).
  createRoot(document.getElementById('root')!, {
    identifierPrefix: rootIdentifierPrefix(),
  }).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
