import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // native/runtime deps (node-pty) must stay external — bundling a native
    // module breaks it
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          // standalone done-when checks, run via `electron --run-as-node`
          'pty-check': 'src/main/pty/lifecycle-check.ts',
          'adapter-check': 'src/main/providers/adapter-check.ts',
          'hook-check': 'src/main/hooks/hook-check.ts',
          'transcript-check': 'src/main/transcripts/transcript-check.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
