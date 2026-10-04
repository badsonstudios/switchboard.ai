// `npm run manual:shots` — regenerate the user manual's pictures (#1082).
//
// The pictures are taken by `e2e/manual-shots.spec.ts`, which is skipped unless
// `SWITCHBOARD_MANUAL_SHOTS` is set so that `npm run e2e` and CI never rewrite
// one. This sets it and runs that one spec. A script rather than an inline
// `VAR=1 playwright …` in package.json because that spelling is POSIX-only and
// the project is developed on Windows.
const { spawnSync } = require('child_process');

const result = spawnSync('npx', ['playwright', 'test', 'e2e/manual-shots.spec.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, SWITCHBOARD_MANUAL_SHOTS: '1' },
});
process.exit(result.status ?? 1);
