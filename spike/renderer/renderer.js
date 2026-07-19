/* global Terminal, FitAddon */
const term = new Terminal({
  fontFamily: 'Consolas, "Cascadia Mono", monospace',
  fontSize: 14,
  scrollback: 5000, // probe point: what does scrollback even hold under a TUI?
  theme: { background: '#1e1e1e' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

window.pty.ready(term.cols, term.rows);
window.pty.onData((d) => term.write(d));
term.onData((d) => window.pty.input(d));

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fit.fit();
    window.pty.resize(term.cols, term.rows);
  }, 50);
});

term.focus();
