// Text is never dimmed by fading its box (#1211).
//
// #685 moved every piece of text meant to be read off the disabled grey, and
// pinned that by counting uses of `--faint`. The count cannot see text dimmed
// a different way: by `opacity` on the element or an ancestor. `tokens.css`
// already says why that is not the same thing ("GROUP OPACITY IS NOT A
// DE-EMPHASIS, IT IS A CONTRAST CUT"): it fades the words AND the fill behind
// them toward whatever is underneath. A 9.5px label on an enabled pill at 0.72
// measured about 3.8:1; a status letter at 0.55, far less.
//
// The right way to make something step back is a step down the neutral ladder
// (`--text` to `--muted`, the readable grey). So this counts every component
// that sets a fractional `opacity`, the way the `--faint` table counts that
// ink: each one is here by name, with the reason it is allowed to. They are
// all the same reason but one: THE CONTROL IS DISABLED, which is the state
// WCAG exempts and the one place a fade says something true.
//
// A new fractional opacity fails this until it is added here, which is the
// moment somebody has to say whether it is on something meant to be read.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const NL = String.fromCharCode(10);

/** `opacity:` followed, somewhere on the line, by a number below 1 */
const FRACTIONAL = /opacity:[^,}]*?(?:^|[^0-9.])(0?[.][0-9]+)/;

const ALLOWED: Record<string, [number, string]> = {
  'components/ComposeDialog.tsx': [1, 'the Send button while it cannot be pressed'],
  'components/FeedView.tsx': [
    2,
    'the "drop files here" veil over the prompt box (a surface, shown only mid-drag), and Stop while it is disabled because the AI has no interrupt (#1287)',
  ],
  'components/FindBar.tsx': [1, 'the search box while this surface cannot be searched'],
  'components/LayoutPresets.tsx': [1, 'a layout preset that cannot be applied right now'],
  'components/McpAddForm.tsx': [1, 'a button in the add-server form while it is disabled'],
  'components/RailGroupMenu.tsx': [1, 'a menu item that cannot be used right now'],
  'components/SessionGrid.tsx': [1, 'a card-header button while it is disabled'],
  'components/SessionsRail.tsx': [1, 'a menu item that cannot be used right now'],
  'components/settings/controls.tsx': [1, 'a settings button while it is disabled'],
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/** every fractional opacity that is CODE, by file: comments are prose about it */
function usesByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sources(SRC)) {
    const count = fs
      .readFileSync(file, 'utf8')
      .split(NL)
      .filter((line) => !/^\s*(?:[/][/]|[*]|[/][*])/.test(line) && FRACTIONAL.test(line)).length;
    if (count > 0) out[path.relative(SRC, file).split(path.sep).join('/')] = count;
  }
  return out;
}

describe('text is never dimmed by fading its box (#1211)', () => {
  it('a fractional opacity appears only where the table says, and only that many times', () => {
    const found = usesByFile();
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, [count]]) => [file, count]));
    expect(
      found,
      'A fade is a CONTRAST CUT, not a de-emphasis: words meant to be read step back by going to ' +
        '`--muted`. If this new use is a disabled control or a surface with no text on it, add it to ' +
        'ALLOWED with its reason.'
    ).toEqual(allowed);
  });

  it('every entry says why', () => {
    for (const [file, [count, why]] of Object.entries(ALLOWED)) {
      expect(count, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(15);
    }
  });

  it('the five places the ticket named are in the readable grey instead', () => {
    const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');
    // a folded calm pill's name
    expect(read('components/StripPill.tsx')).toContain(
      "color: props.folded && !paint.lit ? 'var(--muted)' : 'var(--text)'"
    );
    // a find hit that cannot be jumped to
    expect(read('components/FindBar.tsx')).toContain("color: hit.jumpable ? 'var(--text)' : 'var(--muted)'");
    // a status letter rolled up from inside a folder
    expect(read('components/FileTree.tsx')).toMatch(/rolledUp\s*[?]\s*'var\(--muted\)'/);
    // a group's policy button with no override
    expect(read('components/SessionsRail.tsx')).toContain(
      "color: groupOverride(props.policies, g.id) ? 'var(--text)' : 'var(--muted)'"
    );
  });
});
