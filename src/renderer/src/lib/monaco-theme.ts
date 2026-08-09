// AA contrast for the diff pane's syntax colours (#191).
//
// Before #191 every character in the Changes tab rendered in the editor's
// default foreground — black on white, #D4D4D4 on #1E1E1E — because the models
// had no language and nothing was tokenized. Turning tokenization on means the
// text takes monaco's built-in `vs` / `vs-dark` palette instead, and MEASURED
// against those themes' own editor background, some of that palette does not
// clear WCAG AA (4.5:1) for normal text:
//
//   vs        7 of 43 scopes, worst `operator.sql` at 3.64:1
//   vs-dark   9 of 42 scopes, worst `variable.predefined` at 2.92:1
//
// Those are VS Code's defaults and they are below AA in VS Code too, but that
// is not a reason to import the problem: turning highlighting on must not make
// any text in this app harder to read than it was yesterday.
//
// So this defines two themes that inherit `vs` / `vs-dark` wholesale and
// override ONLY the scopes that miss, each nudged the minimum distance along
// its own hue until it clears 4.5:1 — `comment` moves #608B4E -> #659252, the
// grey delimiters #808080 -> #858585. The palette stays the one every
// developer already reads all day; it just stops falling short. Any scope not
// listed here either already clears AA or is not styled by the base theme at
// all, in which case it renders in the default foreground, which clears it by
// a mile. `monaco-theme.test.ts` re-derives that claim from monaco's own theme
// source, so a monaco upgrade that repaints a token cannot slip past.
//
// SCOPE, stated plainly. AA is asserted against the editor BACKGROUND. Monaco
// also tints changed lines (`rgba(155,185,85,.2)` inserted,
// `rgba(255,0,0,.2)` removed) and tints changed CHARACTERS again on top, and
// against those tints much of the palette drops back under 4.5:1. Fixing that
// too was tried and rejected: it forces 34 of 42 dark scopes into pale
// pastels and destroys the distinction between them, which costs more
// legibility than it buys. The tints are monaco's, they are unchanged by this
// item, and the honest answer for someone who needs more is a high-contrast
// editor theme — see the follow-up note below.
//
// FOLLOW-UP, deliberately not done here: the app ships four themes (nordic,
// daylight, high-contrast, soft-contrast) and collapses them to `light` or
// `dark` for monaco, so a high-contrast user gets ordinary `vs-dark` in this
// pane. Monaco has `hc-black` / `hc-light` built in and DESIGN §5.20 already
// argues that a high-contrast theme which cannot reach a colour is decoration.
// Wiring that up means the pane needs the theme ID, not just the resolved
// colour scheme, which is a change to the panel params, the popout params and
// the contribution context — its own item, not a rider on this one.

import type * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';

/** The theme ids this module registers, by resolved colour scheme. */
export const DIFF_THEME = {
  light: 'switchboard-diff-light',
  dark: 'switchboard-diff-dark',
} as const;

/**
 * Monaco's OWN editor background for each base theme — the surface every ratio
 * above is measured against. Not a switchboard token: the pane does not paint
 * this, monaco does, and the test needs the same number monaco uses.
 *
 * Written without a leading `#`, like every other colour in this file, because
 * that is the form monaco's token rules take.
 */
export const EDITOR_BACKGROUND = { light: 'fffffe', dark: '1e1e1e' } as const;

/**
 * The overrides, by base theme. Token scope -> replacement foreground.
 *
 * §5.20 says renderer components take colours from `tokens.css`, and these are
 * the documented exception: they are not switchboard's colours, they are
 * minimum corrections to MONACO's built-in palette, handed to a JS theme API
 * that takes hex strings and cannot read a CSS custom property. (The §5.20
 * lint rule looks for `#rrggbb`, which monaco's token rules do not use, so it
 * does not fire here — the exception is declared in this comment, not smuggled
 * past a disable directive.) Routing the editor's palette through the theme
 * system properly is the follow-up in the header — it would replace this
 * table, not extend it.
 */
export const CONTRAST_FIXES: Readonly<
  Record<'light' | 'dark', readonly monaco.editor.ITokenThemeRule[]>
> = {
  light: [
    { token: 'annotation', foreground: '767676' },
    { token: 'metatag.content.html', foreground: 'eb0000' },
    { token: 'metatag.html', foreground: '767676' },
    { token: 'metatag.xml', foreground: '767676' },
    { token: 'attribute.name', foreground: 'eb0000' },
    { token: 'string.sql', foreground: 'eb0000' },
    { token: 'operator.sql', foreground: '657687' },
  ],
  dark: [
    { token: 'variable.predefined', foreground: '6e86c1' },
    { token: 'comment', foreground: '659252' },
    { token: 'regexp', foreground: 'b9709c' },
    { token: 'annotation', foreground: 'cd6a6a' },
    { token: 'delimiter.html', foreground: '858585' },
    { token: 'delimiter.xml', foreground: '858585' },
    // unreachable today — pug is not one of the registered languages. They are
    // here because the test audits monaco's WHOLE palette rather than the part
    // this app can currently reach, which is the version of that rule that
    // survives someone adding pug later.
    { token: 'tag.id.pug', foreground: '6689b9' },
    { token: 'tag.class.pug', foreground: '6689b9' },
    { token: 'string.sql', foreground: 'ff2e2e' },
  ],
};

/**
 * Register both themes. Idempotent — `defineTheme` overwrites by id — so it is
 * safe to call at module load and safe to call again.
 */
export function defineDiffThemes(editor: typeof monaco.editor): void {
  editor.defineTheme(DIFF_THEME.light, {
    base: 'vs',
    inherit: true,
    rules: [...CONTRAST_FIXES.light],
    colors: {},
  });
  editor.defineTheme(DIFF_THEME.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: [...CONTRAST_FIXES.dark],
    colors: {},
  });
}
