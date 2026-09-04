// K-lytics containment scan core — extracted so the control has a repeatable
// test (DR-0113). Given the extract text and a list of files, returns the
// files containing any substantial extract line. Quarantine mechanics live in
// produce-issue.mjs; this is the detection the RUNBOOK calls "enforced
// MECHANICALLY, not just by prompt".
import fs from "node:fs";

export function extractLines(extractText) {
  return extractText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 25);
}

export function containmentHits(extractText, files) {
  const lines = extractLines(extractText);
  if (lines.length === 0) return [];
  const hits = [];
  for (const f of files) {
    let content = "";
    try {
      content = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (lines.some((line) => content.includes(line))) hits.push(f);
  }
  return hits;
}

import path from "node:path";

// Quarantine: move EVERY file out of publicDir into quarantineDir (the whole
// artifact set goes — .png renders of contaminated content included), remove
// hit files outside publicDir (built preview pages) after copying them in,
// and leave only a marker naming the hits and any prior recorded error.
// Returns the marker path. Pure mechanics, no policy — testable in a temp dir.
export function quarantine({ hits, publicDir, quarantineDir, repoRoot, priorError = "" }) {
  fs.mkdirSync(quarantineDir, { recursive: true });
  for (const e of fs.readdirSync(publicDir)) {
    fs.renameSync(path.join(publicDir, e), path.join(quarantineDir, e));
  }
  for (const f of hits) {
    if (!f.startsWith(publicDir + path.sep) && fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(quarantineDir, path.relative(repoRoot, f).replace(/[\\/]/g, "__")));
      fs.rmSync(f);
    }
  }
  const marker = path.join(publicDir, "CONTAINMENT_FAILURE.md");
  fs.writeFileSync(
    marker,
    `K-lytics containment failed: ${hits.length} file(s) contained extract lines:\n` +
      hits.map((f) => `- ${path.relative(repoRoot, f) || f}`).join("\n") +
      `\nThe entire artifact set was quarantined into the private workspace. This run must not ship.\n` +
      (priorError ? `\nOriginal run error before containment: ${priorError}\n` : "")
  );
  return marker;
}
