// Hold the site's files (public/) in memory when the seats phase starts, and
// put them back exactly before the preview is built (2026-10-03).
//
// Why restore rather than refuse: the adversary seat is told to render the
// page to check charts, it has Bash, and the natural way to do that writes
// under public/. Refusing would throw away a run that had already paid for
// every round. Restoring means the preview is always built and rendered from
// the files the run started with, whatever a seat did -- including tricks that
// hide a change from git (a commit, skip-worktree), which a git status check
// would miss.
import fs from "node:fs";
import path from "node:path";

// returns Map<relativePath, Buffer> of every regular file under root
export function snapshotTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.set(path.relative(root, p), fs.readFileSync(p));
      else throw new Error(`snapshot: ${path.relative(root, p)} is neither a file nor a folder -- refusing to snapshot a tree holding links or devices`);
    }
  };
  walk(root);
  return files;
}

// Makes root hold exactly the snapshot again. Returns the relative paths it
// had to change: { rewritten: [...], removed: [...] } (empty when untouched).
export function restoreTree(root, snapshot) {
  const rewritten = [];
  const removed = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        walk(p);
        const keep = [...snapshot.keys()].some((k) => k === rel || k.startsWith(rel + path.sep));
        if (!keep) { fs.rmSync(p, { recursive: true, force: true }); removed.push(rel + path.sep); }
      } else if (!e.isFile() || !snapshot.has(rel)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(rel);
      }
    }
  };
  walk(root);
  for (const [rel, buf] of snapshot) {
    const p = path.join(root, rel);
    let same = false;
    try { same = fs.lstatSync(p).isFile() && fs.readFileSync(p).equals(buf); } catch { same = false; }
    if (!same) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch { /* absent */ }
      fs.writeFileSync(p, buf);
      rewritten.push(rel);
    }
  }
  return { rewritten, removed };
}
