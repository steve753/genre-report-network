// Worker Conversions API check (Steve, 2026-10-03): Lead on signup and CompleteRegistration on confirm go to the
// configured pixel server-side, with a page-supplied fbc, and never carry a query string or the DOI token in
// event_source_url. Run by run-tests.mjs against a copy of src/index.js; no network (fetch is stubbed).
import assert from "node:assert";
const mod = await import(process.argv[2]);
const worker = mod.default;
const TOKEN = "11111111-2222-3333-4444-555555555555";
const metaCalls = [];
let subStatus = "pending";
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://graph.facebook.com/")) { metaCalls.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }
  if (url.includes("api.postmarkapp.com")) return new Response(JSON.stringify({ MessageID: "m1" }), { status: 200 });
  if (url.includes("/rest/v1/genres?")) return new Response(JSON.stringify([{ id: "g1" }]), { status: 200 });
  if (url.includes("/rest/v1/subscribers?on_conflict")) return new Response(JSON.stringify([{ id: "s1", status: "pending", doi_token: TOKEN }]), { status: 201 });
  if (url.includes("/rest/v1/subscribers?doi_token=eq.")) return new Response(JSON.stringify([{ id: "s1", status: subStatus, email: "a@b.co", consent_source: "thriller-subscribe-page", genre_id: "g1", genres: { slug: "thriller", display_name: "Thriller" } }]), { status: 200 });
  if (url.includes("/rest/v1/")) return new Response(init.method === "PATCH" ? "" : "[]", { status: 200 });
  throw new Error("unexpected fetch " + url);
};
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_KEY: "k", POSTMARK_TOKEN: "p", META_PIXEL_ID: "139094011531252", META_CAPI_TOKEN: "t", ASSETS: { fetch: () => new Response("") } };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const fbc = "fb.1.1791000000000.IwAR3abcdefghijklmnop";
let r = await worker.fetch(new Request("https://reports.stevepieper.com/api/subscribe", { method: "POST",
  headers: { "Content-Type": "application/json", Referer: "https://reports.stevepieper.com/thriller/subscribe/?utm_source=fb&fbclid=IwAR3abc&email=a@b.co", "CF-Connecting-IP": "1.2.3.4", "User-Agent": "UA" },
  body: JSON.stringify({ genre: "thriller", email: "A@B.co", first_name: "Al", consent_source: "x", fbc }) }), env, ctx);
await Promise.all(waits);
assert.deepEqual(await r.json(), { ok: true, state: "confirmation-sent" });
const lead = metaCalls.find(c => c.body.data[0].event_name === "Lead");
assert.ok(lead && lead.url.includes("/139094011531252/events"), "Lead sent to the configured pixel");
const ld = lead.body.data[0];
assert.equal(ld.event_source_url, "https://reports.stevepieper.com/thriller/subscribe/", "Lead source URL is the page with no query string");
assert.equal(ld.user_data.fbc, fbc, "page-supplied fbc forwarded");
assert.match(ld.event_id, /^[0-9a-f]{64}$/, "Lead event_id is a hash"); assert.equal(ld.action_source, "website");
assert.equal(ld.user_data.em[0].length, 64, "email hashed");
assert.ok(!JSON.stringify(lead.body).includes("a@b.co"), "no plain email in the Meta payload");
assert.ok(!JSON.stringify(lead.body).includes(TOKEN), "the DOI token appears nowhere in the Lead payload");
// bad fbc dropped; off-site referer falls back to the desk home
metaCalls.length = 0; waits.length = 0;
await worker.fetch(new Request("https://reports.stevepieper.com/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json", Referer: "https://evil.example/x?y" },
  body: JSON.stringify({ genre: "thriller", email: "a@b.co", fbc: "javascript:alert(1)" }) }), env, ctx);
await Promise.all(waits);
const l2 = metaCalls[0].body.data[0];
assert.equal(l2.user_data.fbc, undefined, "malformed fbc dropped"); assert.equal(l2.event_source_url, "https://reports.stevepieper.com/thriller/", "off-site referer -> desk home");
// confirm POST -> CompleteRegistration with the desk URL, never the token
metaCalls.length = 0; waits.length = 0;
r = await worker.fetch(new Request(`https://reports.stevepieper.com/api/confirm?token=${TOKEN}`, { method: "POST", headers: { Referer: `https://reports.stevepieper.com/api/confirm?token=${TOKEN}` } }), env, ctx);
await Promise.all(waits);
const cr = metaCalls.find(c => c.body.data[0].event_name === "CompleteRegistration");
assert.ok(cr, "CompleteRegistration sent"); assert.equal(cr.body.data[0].event_source_url, "https://reports.stevepieper.com/thriller/");
assert.ok(!JSON.stringify(cr.body).includes(TOKEN), "the DOI token appears nowhere in the CompleteRegistration payload");
assert.ok(!cr.body.data[0].event_source_url.includes(TOKEN), "token never in source URL");
// already confirmed: no second CompleteRegistration
subStatus = "confirmed"; metaCalls.length = 0; waits.length = 0;
await worker.fetch(new Request(`https://reports.stevepieper.com/api/confirm?token=${TOKEN}`, { method: "POST" }), env, ctx);
await Promise.all(waits);
assert.equal(metaCalls.length, 0, "re-click sends nothing");
// no secrets: no call
subStatus = "pending"; metaCalls.length = 0; waits.length = 0;
await worker.fetch(new Request("https://reports.stevepieper.com/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ genre: "thriller", email: "a@b.co" }) }), { ...env, META_CAPI_TOKEN: "" }, ctx);
await Promise.all(waits);
assert.equal(metaCalls.length, 0, "no token -> no Meta call");
console.log("CAPI harness PASS");
