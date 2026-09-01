// Version label + changelog rendering model (issue #81).
//
// CHANGELOG.md is the source of truth, maintained by hand per release and
// bundled into the build as a raw string (Vite `?raw`). The in-game view
// renders it from the tiny line grammar the file actually uses — release
// headings, bullet items (with two-space continuations), and prose — rather
// than a markdown engine the rest of the file format would never exercise.

export interface ChangelogBlock {
  readonly kind: 'heading' | 'item' | 'text';
  readonly text: string;
}

/** Parse the changelog's line grammar. The `# ` title is dropped — the view
 *  has its own heading — and blank lines just close the current block. */
export function parseChangelog(md: string): ChangelogBlock[] {
  const blocks: ChangelogBlock[] = [];
  let open: { kind: 'item' | 'text'; lines: string[] } | null = null;
  const close = () => {
    if (open) blocks.push({ kind: open.kind, text: open.lines.join(' ') });
    open = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      close();
    } else if (line.startsWith('# ')) {
      close();
    } else if (line.startsWith('## ')) {
      close();
      blocks.push({ kind: 'heading', text: line.slice(3).trim() });
    } else if (line.startsWith('- ')) {
      close();
      open = { kind: 'item', lines: [line.slice(2).trim()] };
    } else if (open) {
      open.lines.push(line.trim());
    } else {
      open = { kind: 'text', lines: [line.trim()] };
    }
  }
  close();
  return blocks;
}

/**
 * The version line shown in Settings: semver, commit, and build date —
 * `v0.1.0+ab12cd3 · 2026-09-01`. The commit is the load-bearing part
 * (issue #81: the packages sit at 0.1.0 across releases).
 */
export function versionLabel(version: string, commit: string, buildTimeIso: string): string {
  const day = buildTimeIso.slice(0, 10);
  return `v${version}+${commit}${day ? ` · ${day}` : ''}`;
}
