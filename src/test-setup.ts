// jsdom gaps that xterm probes while loading. Any test that (transitively)
// imports the view components needs these; they were copy-pasted into two
// files before, and a third was inevitable.
const d = globalThis.document as unknown as Record<string, unknown> | undefined;
if (d) {
  if (typeof d.queryCommandSupported !== 'function') d.queryCommandSupported = () => false;
  if (typeof d.execCommand !== 'function') d.execCommand = () => false;
}
