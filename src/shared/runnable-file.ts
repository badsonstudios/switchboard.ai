// Which files a click in the conversation must NEVER open (#1611).
//
// Dan, 2026-11-17: "if it's something that can be run, it should never run
// it." A path the AI wrote is clickable, and a click hands an ordinary file to
// whatever the system has registered for it (`shell.openPath`). For the types
// below, "the app registered for it" is the file ITSELF, or a script host, an
// installer, a shortcut that points somewhere else, or a disk image that mounts
// and then auto-runs. So for these a click opens the FOLDER with the file
// selected (`shell.showItemInFolder`), and there is no "run it anyway" prompt.
//
// A DENY-LIST, and it is deliberately long. The alternative (an allow-list of
// "documents") would refuse the CSV, the PDF and the screenshot that are the
// whole point of the feature. What a deny-list misses is covered twice more in
// main: a POSIX file with an execute bit is revealed whatever it is called,
// and a macOS `.app` bundle is a FOLDER that launches, so it is revealed too.
//
// Shared, because the renderer uses it to TELL the user what a click will do
// ("Show in folder" rather than "Open"), and two lists would drift. Main is the
// guard: it asks this question of the spelling it was handed AND of the real
// path that spelling resolves to.

/** Every extension, lower-case and without the dot, that a click reveals instead of opening. */
export const RUNNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows programs, libraries and their relatives
  'exe', 'com', 'scr', 'pif', 'cpl', 'dll', 'ocx', 'sys', 'drv',
  // command shells and script hosts
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'ps2', 'ps2xml', 'psc2',
  'vbs', 'vbe', 'vb', 'js', 'jse', 'mjs', 'cjs', 'wsf', 'wsh', 'wsc', 'ws', 'sct', 'hta', 'msh', 'msh1', 'msh2', 'mshxml',
  // installers and packages
  'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'msu', 'cab', 'vsix',
  'pkg', 'mpkg', 'dmg', 'deb', 'rpm', 'apk', 'snap', 'flatpakref', 'appimage', 'run', 'bin',
  // shortcuts and things that point somewhere else
  'lnk', 'url', 'website', 'webloc', 'scf', 'desktop', 'inetloc', 'fileloc', 'shb', 'shs',
  'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms',
  // ClickOnce, gadgets, consoles, registry, setup information
  'application', 'appref-ms', 'xbap', 'gadget', 'msc', 'reg', 'inf', 'ins', 'isp', 'its', 'job', 'jnlp', 'diagcab',
  // Java and other runtimes
  'jar', 'class', 'py', 'pyw', 'pyc', 'pyz', 'pl', 'rb', 'php', 'lua', 'tcl', 'ahk', 'au3',
  // POSIX shells and macOS launchers
  'sh', 'bash', 'zsh', 'ksh', 'csh', 'fish', 'command', 'tool', 'workflow', 'action', 'terminal', 'scpt', 'scptd', 'applescript', 'osascript',
  // macOS bundles (folders, but they launch)
  'app', 'prefpane', 'kext', 'plugin',
  // disk images that mount (and can then auto-run) on a double-click
  'iso', 'img', 'vhd', 'vhdx',
  // compiled help and Office add-ins, which run code by design
  'chm', 'hlp', 'xll', 'xlam', 'ppam', 'wll',
  // Access databases, which run macros on open
  'ade', 'adp', 'mda', 'mdb', 'mde', 'accde', 'accdb', 'accda', 'accdr',
  // misc Windows handlers
  'grp', 'crt', 'cer', 'der', 'mof',
]);

/**
 * The extension of the LAST segment of `p`, lower-cased and without the dot,
 * or '' when it has none.
 *
 * Trailing dots and spaces are dropped first, because Windows drops them: it
 * opens `setup.exe.` and `setup.exe ` as `setup.exe`, so their type is `exe`.
 */
export function extensionOf(p: string): string {
  const name = p.split(/[\\/]/).pop() ?? '';
  const trimmed = name.replace(/[. ]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return '';
  return trimmed.slice(dot + 1).toLowerCase();
}

/** Is `p` a type a click must never run? By name alone; main adds the rest. */
export function isRunnableFile(p: string): boolean {
  return RUNNABLE_EXTENSIONS.has(extensionOf(p));
}

/** Is `p` a Markdown file by name: the ones the in-app viewer opens. */
export function isMarkdownFile(p: string): boolean {
  const ext = extensionOf(p);
  return ext === 'md' || ext === 'markdown';
}
