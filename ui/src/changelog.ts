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

/** Entries longer than this read as a wall of text in the dialog. */
const MAX_ITEM_CHARS = 150;

/**
 * The in-game view of one entry (issue #181): its lead sentence, without the
 * markdown emphasis or the issue refs. The changelog's house style puts the
 * summary first and the detail after it, so the lead sentence alone is the
 * release note a player wants — and where that sentence is itself long, it is
 * cut at the clause where its detail starts.
 */
export function briefItem(text: string): string {
  const plain = text
    .replace(/\s*\(#[^)]*\)/g, '')
    .replace(/\*/g, '');
  // A sentence ends at .!? followed by a space — a decimal ("×1.5") has none.
  const stop = /[.!?](?=\s)/.exec(plain);
  const lead = stop ? plain.slice(0, stop.index + 1) : plain;
  if (lead.length <= MAX_ITEM_CHARS) return lead;
  const clause = /[:;](?=\s)|\s—\s/.exec(lead);
  if (clause) return `${lead.slice(0, clause.index)}.`;
  const word = lead.lastIndexOf(' ', MAX_ITEM_CHARS);
  return `${lead.slice(0, word)}…`;
}

/** What the in-game dialog renders: release headings and entries, never the
 *  file's own prose header. */
export type BriefBlock = ChangelogBlock & { readonly kind: 'heading' | 'item' };

/** The blocks the in-game dialog renders: every release, one short line per
 *  entry. The file's own prose header is dropped — it describes the file. */
export function briefChangelog(md: string): BriefBlock[] {
  return parseChangelog(md)
    .filter((b): b is BriefBlock => b.kind !== 'text')
    .map((b) => (b.kind === 'item' ? { kind: b.kind, text: briefItem(b.text) } : b));
}
