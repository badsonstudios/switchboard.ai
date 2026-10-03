// The one tool name plan mode turns on (#948, #588).
//
// `ExitPlanMode` is the request a plan-mode session makes when it wants its
// plan APPROVED — measured to be the only thing such a session asks permission
// for, and an Allow is what takes it out of plan mode
// (`spike/findings/588-plan-mode-permission-bar.md`). Shared because the
// permission router refuses it for a dispatched session and the fake provider
// has to be able to raise it.
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';
