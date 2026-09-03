/**
 * Genre Report Network — write lane (MCP server Worker).
 *
 * Pattern of record: The Dangle write lane. Sessions hold no database write
 * access; this Worker is the ONLY write path, and it exposes exactly two
 * tools, both backed by SECURITY DEFINER functions whose gates live in
 * Postgres (sql/2026-09-03-write-lane.sql). The approval fields
 * (approved_at, approved_by, approval_token_hash) have NO tool here by
 * design — the one-click console is their only writer, and send-arming
 * (SEND_AUTH_TOKEN) is a different Worker's secret entirely. Blast radius
 * of a compromised lane token, stated exactly: it can mark an issue
 * published and author the payload a later broadcast would carry — it
 * cannot approve, arm, or dispatch. The payload is rendered in full on the
 * approval console and hash-bound to the click, so nothing it writes
 * reaches subscribers without the approver reading it first.
 *
 * Transport: MCP streamable HTTP (JSON-RPC 2.0 over POST). The connector UI
 * reserves the Authorization header, so the shared token rides in the URL
 * path — /mcp/<WRITE_LANE_TOKEN> — same as the Dangle lane. GETs answer 405
 * (no SSE stream is offered; every client we use POSTs).
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY, WRITE_LANE_TOKEN.
 * Deploy: own Worker "genre-write" on workers.dev (no route on the
 * publication domain — the lane is not a public surface).
 */

const TOOLS = [
  {
    name: "genre_write_probe",
    description:
      "Verify the write lane end to end: inserts one row into " +
      "genre_reports.write_probe_log and returns its id. Run this first in " +
      "any session before trusting the lane.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Optional note stored with the probe row (200 chars max)." },
      },
    },
  },
  {
    name: "genre_record_issue_published",
    description:
      "Record an issue's publication: flips status draft→published, stamps " +
      "published_at, stores the send payload (genre, subject, teaser_bullets, " +
      "permalink_url) and optional telemetry. Gates enforced in Postgres: " +
      "draft-only (idempotent on identical re-call), payload genre must match " +
      "the issue, 3–6 non-empty teasers, canonical permalink. This tool " +
      "cannot approve, arm, or send anything.",
    inputSchema: {
      type: "object",
      required: ["issue_id", "send_payload"],
      properties: {
        issue_id: { type: "string", description: "UUID of the genre_reports.issues row." },
        send_payload: {
          type: "object",
          required: ["genre", "subject", "teaser_bullets", "permalink_url"],
          properties: {
            genre: { type: "string" },
            subject: { type: "string" },
            teaser_bullets: { type: "array", items: { type: "string" } },
            permalink_url: { type: "string" },
          },
        },
        adversary_rounds: { type: "integer" },
        adversary_verdict: { type: "string" },
        story_count: { type: "integer" },
        production_notes: { type: "string" },
      },
    },
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!m || !env.WRITE_LANE_TOKEN || !timingSafeEqual(m[1], env.WRITE_LANE_TOKEN)) {
      return new Response("not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    let msg;
    try { msg = await request.json(); } catch {
      return rpcError(null, -32700, "parse error");
    }
    try {
      return await handle(msg, env);
    } catch (err) {
      console.error("write_lane_error", err.stack || String(err));
      return rpcError(msg && msg.id, -32603, "internal error");
    }
  },
};

async function handle(msg, env) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: (params && params.protocolVersion) || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "genre-write-lane", version: "1.0.0" },
    });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    // A notification carrying an id is malformed-but-benign: answer it so a
    // strict client never blocks on the id.
    return id === undefined || id === null
      ? new Response(null, { status: 202 })
      : rpcResult(id, {});
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "genre_write_probe") {
      const out = await rpc(env, "write_probe", { p_note: args.note ? String(args.note) : null });
      return toolResult(id, out, out && out.ok === false);
    }
    if (name === "genre_record_issue_published") {
      const issueId = String(args.issue_id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(issueId.toLowerCase())) {
        return toolResult(id, { ok: false, error: "invalid issue_id" }, true);
      }
      if (!args.send_payload || typeof args.send_payload !== "object") {
        return toolResult(id, { ok: false, error: "send_payload object is required" }, true);
      }
      if (JSON.stringify(args.send_payload).length > 16384) {
        return toolResult(id, { ok: false, error: "send_payload too large (16KB cap)" }, true);
      }
      const out = await rpc(env, "record_issue_published", {
        p_issue_id: issueId.toLowerCase(),
        p_send_payload: args.send_payload,
        p_adversary_rounds: intOrNull(args.adversary_rounds),
        p_adversary_verdict: args.adversary_verdict ? String(args.adversary_verdict).slice(0, 2000) : null,
        p_story_count: intOrNull(args.story_count),
        p_production_notes: args.production_notes ? String(args.production_notes).slice(0, 4000) : null,
      });
      return toolResult(id, out, out && out.ok === false);
    }
    return rpcError(id, -32602, `unknown tool: ${name}`);
  }
  return rpcError(id, -32601, `unknown method: ${method}`);
}

function intOrNull(v) {
  // Explicit null/absent/boolean/empty mean "not provided" — never 0
  // (adversary finding 3: Number(null) === 0 would falsify the adversary-
  // rounds audit trail). Clamp to smallint range so an optional telemetry
  // field can never fail the whole publication call.
  if (v === null || v === undefined || typeof v === "boolean" || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return Math.min(Math.max(n, 0), 32767);
}

// PostgREST RPC against the genre_reports schema.
async function rpc(env, fn, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "genre_reports",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("write_lane_rpc_error", fn, res.status, text.slice(0, 500));
    return { ok: false, error: `database refused (${res.status})` };
  }
  try { return JSON.parse(text); } catch { return { ok: false, error: "unparseable database reply" }; }
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function toolResult(id, payload, isError = false) {
  return rpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: Boolean(isError),
  });
}
function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
