// The one tool name plan mode turns on (#948, #588).
//
// `ExitPlanMode` is the request a plan-mode session makes when it wants its
// plan APPROVED. Measured (`spike/findings/588-plan-mode-permission-bar.md`):
// ordered to run a command or write a file, a plan session asked for this
// instead of for either, and an Allow is what takes it out of plan mode.
//
// Shared because the permission router refuses it for a dispatched session and
// the fake provider has to be able to raise it.
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';
