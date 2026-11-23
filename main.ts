// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Run as `node main.ts [options] [PATCH]` with the working directory as the
// root of a tree of text files. It reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every
// change or none, printing what it changed or why it failed.
//
// Node 22, standard library only. When MAKEFUN_ENV_URL is set this file
// hands the run over to runner.ts, which drives the trial's checks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; `line` is the stdout line. */
class ParseErr {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; `code` and `path` go on its stdout line. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or .. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface Doc {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBr ? d.br : '');
}

/** The tree as the edits leave it: pending changes over the files on disk. */
class Work {
  private readonly seen = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  disk(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  at(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.disk(p);
  }

  /** Remember a move, chaining one that already ends where this one starts. */
  noteMove(from: string, to: string): void {
    for (const m of this.moves) {
      if (m.to === from) {
        m.to = to;
        return;
      }
    }
    this.moves.push({ from, to });
  }
}

type Job = (w: Work) => void;

/** One line the way a format's normaliser sees it at a tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The first tier at which `want` occurs in `lines`, with every position there. */
function locate(lines: string[], want: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (normLine(lines[i + j]!, t) !== normLine(want[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of the replacement: a context line (index into the old lines) or an added line. */
interface NewItem {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines: a context line is written as the file's own
 * matched line; at tier 2 an added line that starts with the old lines'
 * leading whitespace has that prefix swapped for the file's.
 */
function buildNew(items: NewItem[], docLines: string[], pos: number, oldLines: string[], tier: number): string[] {
  const out: string[] = [];
  const fLead = leadingWs(docLines[pos] ?? '');
  const pLead = leadingWs(oldLines[0] ?? '');
  for (const it of items) {
    if (it.ctx !== null) {
      out.push(docLines[pos + it.ctx]!);
      continue;
    }
    let s = it.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(pLead)) s = fLead + s.slice(pLead.length);
    out.push(s);
  }
  return out;
}

/** One body line of a hunk or chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

function toBody(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  if (line[0] === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (line[0] === '-') return { kind: 'old', text: line.slice(1) };
  if (line[0] === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'mark', text: line.slice(1) };
}

/** Split a hunk or chunk body into its old lines and its replacement items. */
function oldNew(body: BodyLine[]): { oldLines: string[]; items: NewItem[] } {
  const oldLines: string[] = [];
  const items: NewItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      items.push({ text: b.text, ctx: oldLines.length });
      oldLines.push(b.text);
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      items.push({ text: b.text, ctx: null });
    }
  }
  return { oldLines, items };
}

/** True when a `\` line immediately follows the body's last context or added line. */
function noNewline(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'mark';
}

/** One unified hunk: the old start line and its body lines. */
interface Hunk {
  start: number;
  body: BodyLine[];
}

/** Apply a section's hunks in order to a file's text. */
function runHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const doc = readDoc(text);
  let drift = 0;
  for (const h of hunks) {
    const { oldLines, items } = oldNew(h.body);
    if (oldLines.length === 0) {
      const at = Math.min(Math.max(h.start + drift, 0), doc.lines.length);
      const added = items.map((it) => it.text);
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...added);
      if (atEnd) doc.finalBr = !noNewline(h.body);
      drift += added.length;
      continue;
    }
    const found = locate(doc.lines, oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    const want = h.start - 1 + drift;
    let best = found.at[0]!;
    let bd = Math.abs(best - want);
    for (const p of found.at) {
      const d = Math.abs(p - want);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    const made = buildNew(items, doc.lines, best, oldLines, found.tier);
    const runsToEnd = best + oldLines.length === doc.lines.length;
    doc.lines.splice(best, oldLines.length, ...made);
    if (runsToEnd) doc.finalBr = !noNewline(h.body);
    drift += made.length - oldLines.length;
  }
  return writeDoc(doc);
}

/** One V4A chunk: an optional anchor, an end-of-file flag, and its body lines. */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** Apply a V4A section's chunks in order, following the cursor. */
function runChunks(text: string, chunks: Chunk[], strict: boolean, path: string): string {
  const doc = readDoc(text);
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  const singleAt = (line: string, from: number, tier: number): number | null => {
    for (let i = from; i < doc.lines.length; i++) {
      if (normLine(doc.lines[i]!, tier) === normLine(line, tier)) return i;
    }
    return null;
  };
  const blockAt = (want: string[], from: number, tier: number): number | null => {
    for (let i = from; i + want.length <= doc.lines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (normLine(doc.lines[i + j]!, tier) !== normLine(want[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return null;
  };
  for (const c of chunks) {
    if (c.anchor !== null) {
      let anchorAt: number | null = null;
      for (const t of tiers) {
        anchorAt = singleAt(c.anchor, cursor, t);
        if (anchorAt !== null) break;
      }
      if (anchorAt === null) throw new EditFail('no-match', path);
      cursor = anchorAt + 1;
    }
    const { oldLines, items } = oldNew(c.body);
    if (oldLines.length === 0) {
      const at = c.eof ? doc.lines.length : cursor;
      const added = items.map((it) => it.text);
      doc.lines.splice(at, 0, ...added);
      cursor = at + added.length;
      continue;
    }
    if (c.eof) {
      const at = doc.lines.length - oldLines.length;
      if (at < cursor) throw new EditFail('no-match', path);
      let tier = -1;
      for (const t of tiers) {
        if (blockAt(oldLines, at, t) === at) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new EditFail('no-match', path);
      const made = buildNew(items, doc.lines, at, oldLines, tier);
      doc.lines.splice(at, oldLines.length, ...made);
      cursor = at + made.length;
      continue;
    }
    let hit: { tier: number; pos: number } | null = null;
    for (const t of tiers) {
      const pos = blockAt(oldLines, cursor, t);
      if (pos !== null) {
        hit = { tier: t, pos };
        break;
      }
    }
    if (hit === null) throw new EditFail('no-match', path);
    const made = buildNew(items, doc.lines, hit.pos, oldLines, hit.tier);
    doc.lines.splice(hit.pos, oldLines.length, ...made);
    cursor = hit.pos + made.length;
  }
  return writeDoc(doc);
}

/** Detect the format of patch lines, or null when none of them holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- JSON edits

/** One JSON edit object, or null when the value is not one. */
function jsonJob(v: unknown): Job | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (w) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (w.at(p) !== null) throw new EditFail('exists', p);
      w.pending.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (w) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const cur = w.at(p);
      if (cur === null) throw new EditFail('missing', p);
      const nl = cur.indexOf('\n');
      const crlf = nl > 0 && cur[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(cur);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      w.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (w) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const cur = w.at(p);
      if (cur === null) throw new EditFail('missing', p);
      const doc = readDoc(cur);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFail('no-match', p);
      doc.lines.splice(lineNo, 0, ...add);
      w.pending.set(p, writeDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Job[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  const jobs: Job[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseErr(`error: parse ${first + 1}`);
    for (const x of v) {
      const j = jsonJob(x);
      if (j === null) throw new ParseErr(`error: parse ${first + 1}`);
      jobs.push(j);
    }
    return jobs;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let j: Job | null = null;
    try {
      j = jsonJob(JSON.parse(l));
    } catch {
      j = null;
    }
    if (j === null) throw new ParseErr(`error: parse ${i + 1}`);
    jobs.push(j);
  });
  return jobs;
}

// ------------------------------------------------------- SEARCH/REPLACE blocks

function srJob(path: string, oldLines: string[], newLines: string[], strict: boolean): Job {
  const items: NewItem[] = newLines.map((t) => ({ text: t, ctx: null }));
  return (w) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (w.at(path) !== null) throw new EditFail('exists', path);
      w.pending.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = w.at(path);
    if (cur === null) throw new EditFail('missing', path);
    const doc = readDoc(cur);
    const found = locate(doc.lines, oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.at[0]!;
    const made = buildNew(items, doc.lines, pos, oldLines, found.tier);
    doc.lines.splice(pos, oldLines.length, ...made);
    w.pending.set(path, writeDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Job[] {
  const jobs: Job[] = [];
  let prevPath: string | null = null;
  let windowStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = i - 1; j >= windowStart; j--) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseErr(`error: parse ${searchAt + 1}`);
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new ParseErr(`error: parse ${searchAt + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new ParseErr(`error: parse ${searchAt + 1}`);
    jobs.push(srJob(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    windowStart = end + 1;
    i = end + 1;
  }
  if (jobs.length === 0) throw new ParseErr('error: parse 1');
  return jobs;
}

// ------------------------------------------------------------ Unified diffs

/** The path a `---` or `+++` line names, or null for /dev/null. */
function headerPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!;
  const p = cut.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface UniSection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function sectionJob(s: UniSection, strict: boolean): Job {
  let oldP: string | null | undefined = s.pairOld;
  if (oldP === undefined) oldP = s.renOld;
  if (oldP === undefined) oldP = s.gitOld;
  let newP: string | null | undefined = s.pairNew;
  if (newP === undefined) newP = s.renNew;
  if (newP === undefined) newP = s.gitNew;
  if (oldP === undefined) oldP = newP;
  if (newP === undefined) newP = oldP;
  const oldPath = oldP ?? '';
  const newPath = newP ?? '';
  if (oldP === null || s.newFile) {
    const plus: string[] = [];
    let noNl = false;
    let seenPlus = false;
    for (const h of s.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        if (h.body[k]!.kind === 'new') {
          plus.push(h.body[k]!.text);
          seenPlus = true;
          noNl = h.body[k + 1]?.kind === 'mark';
        }
      }
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (seenPlus && noNl ? '' : '\n');
    return (w) => {
      if (!isSafe(newPath)) throw new EditFail('unsafe', newPath);
      if (w.at(newPath) !== null) throw new EditFail('exists', newPath);
      w.pending.set(newPath, text);
    };
  }
  if (newP === null || s.delFile) {
    return (w) => {
      if (!isSafe(oldPath)) throw new EditFail('unsafe', oldPath);
      if (w.at(oldPath) === null) throw new EditFail('missing', oldPath);
      w.pending.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (w) => {
      if (!isSafe(oldPath)) throw new EditFail('unsafe', oldPath);
      if (!isSafe(newPath)) throw new EditFail('unsafe', newPath);
      const cur = w.at(oldPath);
      if (cur === null) throw new EditFail('missing', oldPath);
      if (w.at(newPath) !== null) throw new EditFail('exists', newPath);
      const made = runHunks(cur, s.hunks, strict, oldPath);
      w.pending.set(oldPath, null);
      w.pending.set(newPath, made);
      w.noteMove(oldPath, newPath);
    };
  }
  return (w) => {
    if (!isSafe(oldPath)) throw new EditFail('unsafe', oldPath);
    const cur = w.at(oldPath);
    if (cur === null) throw new EditFail('missing', oldPath);
    w.pending.set(oldPath, runHunks(cur, s.hunks, strict, oldPath));
  };
}

function parseUnified(lines: string[], strict: boolean): Job[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
      else break;
    }
    sec!.hunks.push(hunk);
    hunk = null;
  };
  const isBody = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      closeHunk();
      if (sec !== null) sections.push(sec);
      sec = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      inHeader = true;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeHunk();
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (sec !== null && inHeader) {
        sec.pairOld = oldP;
        sec.pairNew = newP;
      } else {
        if (sec !== null) sections.push(sec);
        sec = { pairOld: oldP, pairNew: newP, newFile: false, delFile: false, hunks: [] };
        inHeader = true;
      }
      i += 1;
      continue;
    }
    if (hunk !== null) {
      if (isBody(line)) {
        hunk.body.push(toBody(line));
        continue;
      }
      closeHunk();
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseErr(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      hunk = { start: parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseErr(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      continue;
    }
  }
  closeHunk();
  if (sec !== null) sections.push(sec);
  return sections.map((s) => sectionJob(s, strict));
}

// ---------------------------------------------------------------- V4A patches

function v4aAddJob(path: string, body: string[], bodyStart: number): Job {
  const made: string[] = [];
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') made.push('');
    else if (l.startsWith('+')) made.push(l.slice(1));
    else throw new ParseErr(`error: parse ${bodyStart + k + 1}`);
  }
  const text = made.length === 0 ? '' : made.join('\n') + '\n';
  return (w) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (w.at(path) !== null) throw new EditFail('exists', path);
    w.pending.set(path, text);
  };
}

function v4aDeleteJob(path: string): Job {
  return (w) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (w.at(path) === null) throw new EditFail('missing', path);
    w.pending.set(path, null);
  };
}

function v4aUpdateJob(path: string, body: string[], bodyStart: number, headLine: number, strict: boolean): Job {
  let moveTo: string | null = null;
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const push = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    const num = bodyStart + k + 1;
    if (l.startsWith('*** Move to: ')) {
      if (k !== 0 || moveTo !== null) throw new ParseErr(`error: parse ${num}`);
      moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l === '*** End of File') {
      // Ends the open chunk and anchors it to the end of the file; with no
      // chunk open there is nothing to end, so the section may still end up
      // with no chunk at all (an error, unless it only moves the file).
      if (cur !== null) {
        cur.eof = true;
        push();
      }
      continue;
    }
    if (l.startsWith('@@')) {
      push();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseErr(`error: parse ${num}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(toBody(l));
      continue;
    }
    throw new ParseErr(`error: parse ${num}`);
  }
  push();
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(`error: parse ${headLine}`);
  return (w) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
    const curText = w.at(path);
    if (curText === null) throw new EditFail('missing', path);
    if (moveTo !== null && w.at(moveTo) !== null) throw new EditFail('exists', moveTo);
    const made = runChunks(curText, chunks, strict, path);
    if (moveTo !== null) {
      w.pending.set(path, null);
      w.pending.set(moveTo, made);
      w.noteMove(path, moveTo);
    } else {
      w.pending.set(path, made);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Job[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(`error: parse ${lines.length + 1}`);
  const headKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const headPath = (l: string): string => l.slice(l.indexOf(': ') + 2).trim();
  const jobs: Job[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = headKind(line);
    if (kind === null) throw new ParseErr(`error: parse ${i + 1}`);
    const path = headPath(line);
    let j = i + 1;
    while (j < last && headKind(lines[j]!) === null) j += 1;
    let end = j;
    while (end > i + 1 && isBlank(lines[end - 1]!)) end -= 1;
    const body = lines.slice(i + 1, end);
    if (kind === 'add') jobs.push(v4aAddJob(path, body, i + 1));
    else if (kind === 'delete') {
      if (body.length > 0) throw new ParseErr(`error: parse ${i + 2}`);
      jobs.push(v4aDeleteJob(path));
    } else {
      jobs.push(v4aUpdateJob(path, body, i + 1, i + 1, strict));
    }
    i = j;
  }
  if (jobs.length === 0) throw new ParseErr('error: parse 1');
  return jobs;
}

// ------------------------------------------------------------- Run the CLI

/** The stdout rows for a successful run, moves shown as R lines. */
function resultRows(w: Work): string[] {
  const pairs: Array<{ from: string; to: string }> = [];
  for (const m of w.moves) {
    if (w.disk(m.from) !== null && w.at(m.from) === null && w.disk(m.to) === null && w.at(m.to) !== null) pairs.push(m);
  }
  const hidden = new Set<string>();
  for (const p of pairs) {
    hidden.add(p.from);
    hidden.add(p.to);
  }
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...w.pending.keys()]) {
    if (hidden.has(p)) continue;
    const was = w.disk(p);
    const now = w.at(p);
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const p of pairs) rows.push({ key: p.to, text: `R ${p.from} -> ${p.to}` });
  rows.sort((a, b) => byteLess(a.key, b.key));
  return rows.map((r) => r.text);
}

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
        continue;
      }
      if (a === '--check' && !check) {
        check = true;
        continue;
      }
      if (a === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, out: ['error: usage'] };
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let jobs: Job[];
  try {
    if (kind === 'json') jobs = parseJson(text, lines);
    else if (kind === 'unified') jobs = parseUnified(lines, strict);
    else if (kind === 'search-replace') jobs = parseSearchReplace(lines, strict);
    else jobs = parseV4a(lines, strict);
    if (jobs.length === 0) throw new ParseErr('error: parse 1');
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [e.line] };
    throw e;
  }
  const work = new Work();
  const fails: EditFail[] = [];
  for (const job of jobs) {
    const snap = new Map(work.pending);
    try {
      job(work);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      work.pending.clear();
      for (const [k, v] of snap) work.pending.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${jobs.length} edits`] };
  }
  const rows = resultRows(work);
  if (!check) {
    for (const p of [...work.pending.keys()]) {
      const now = work.pending.get(p)!;
      const was = work.disk(p);
      if (now === was) continue;
      if (now === null) {
        if (was !== null) rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
