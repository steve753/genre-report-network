// Agent seats, per genre_reports.network.model_assignments (DR-0152):
// research on Opus, writing on Fable, adversary on a model different from the
// writer, mechanical checks on Haiku. Model IDs arrive as environment
// variables (GitHub repo variables) so a model rename never needs a code push.

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { requireEnv, log } from "./util.mjs";

const PROMPTS = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "prompts");

export function models() {
  const m = {
    research: requireEnv("MODEL_RESEARCH"),
    writer: requireEnv("MODEL_WRITER"),
    adversary: requireEnv("MODEL_ADVERSARY"),
    mechanical: requireEnv("MODEL_MECHANICAL"),
  };
  if (m.adversary === m.writer) {
    throw new Error(
      `MODEL_ADVERSARY (${m.adversary}) must differ from MODEL_WRITER (${m.writer}) — genre_reports.network.model_assignments`
    );
  }
  return m;
}

export function prompt(name, vars = {}) {
  let text = fs.readFileSync(path.join(PROMPTS, `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, String(v));
  }
  const leftover = text.match(/\{\{[a-z_]+\}\}/i);
  if (leftover) throw new Error(`prompt ${name}: unfilled variable ${leftover[0]}`);
  return text;
}

// The environment a seat's process tree may see. Seats fetch untrusted web
// content by design, so every credential they do not strictly need is
// withheld here — the workflow additionally scopes which secrets each STEP
// receives, and the checkout carries no persisted git credential, so a
// prompt-injected seat holds no token that could push, deploy, or write the
// database. ANTHROPIC_API_KEY necessarily remains (it is what runs the seat);
// its blast radius is API spend, bounded by Console limits.
function seatEnv() {
  const keep = ["PATH", "HOME", "NODE_ENV", "ANTHROPIC_API_KEY", "TMPDIR", "SHELL", "USER", "LANG", "LC_ALL"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// Run one agent seat to completion inside the workspace. permissionMode
// bypasses interactive prompts because there is no human in an unattended
// run — the human gates are the GitHub environment approval and Steve's send
// click, both outside this process (DR-0158, DR-0165). `tools` narrows the
// seat's tool set (the writer gets no shell and no web).
// NOTE: the CONTROL for credential exposure is the workflow's per-step env
// scoping plus persist-credentials:false — the env option below is a belt
// whose honoring by the installed SDK is a shakedown verification item.
function denied(tools) {
  return ["Bash", "WebFetch", "WebSearch"].filter((t) => !(tools || []).includes(t));
}

export async function runSeat({ seat, model, promptText, cwd, maxTurns = 120, tools }) {
  const denyList = denied(tools);
  log(`seat ${seat} starting on ${model}`);
  let usage = { input_tokens: 0, output_tokens: 0 };
  let resultText = "";
  const it = query({
    prompt: promptText,
    options: {
      model,
      cwd,
      maxTurns,
      permissionMode: "bypassPermissions",
      allowedTools: tools || ["Read", "Write", "Edit", "Glob", "Grep"],
      // Deny rules are the stronger primitive; whether allowedTools narrows
      // the set under bypassPermissions is a shakedown verification item.
      // The key is omitted entirely when nothing is denied, so full seats
      // are configured exactly as before.
      ...(denyList.length ? { disallowedTools: denyList } : {}),
      env: seatEnv(),
    },
  });
  for await (const message of it) {
    if (message.type === "result") {
      resultText = message.result ?? "";
      if (message.usage) usage = message.usage;
      if (message.is_error) throw new Error(`seat ${seat} ended in error: ${resultText.slice(0, 500)}`);
    }
  }
  log(`seat ${seat} done (in ${usage.input_tokens ?? "?"} / out ${usage.output_tokens ?? "?"} tokens)`);
  return { resultText, usage };
}
