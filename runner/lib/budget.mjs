// Time budget for the seats phase.
//
// Why this exists (thriller shakedown, run 37050723376, 2026-10-02): GitHub
// killed the produce job at its time limit in the middle of adversary round 5.
// A killed process writes no summary.json and never reaches the failure
// policy, so the run ended with nothing that said why. The budget makes the
// runner stop FIRST, at a seat boundary, and fail through the normal path
// (summary.json with a reason, the containment guard, exit 2).
//
// The budget is derived from the seats step's own GitHub time limit
// (SEATS_STEP_TIMEOUT_MINUTES, the single number the workflow also uses for
// that step's timeout-minutes), less a margin for writing the summary and
// running the containment scan. The step limit stays as the backstop for a
// seat that hangs.
//
// Seat time estimates are the LONGER of a floor and the longest seat of that
// kind already observed in this run. Reviews in the shakedown ran 18.5, 19.5,
// 27.6 and 20.1 minutes, so early observations understate later ones; the
// adversary floor is set above the longest of them. A review that still runs
// past its estimate is absorbed by the 8-minute margin, and past that by the
// seats step's own time limit.

export const BUDGET_MARGIN_MINUTES = 8;
export const DEFAULT_FLOORS_MINUTES = Object.freeze({
  adversary: 30, // shakedown reviews: 18.5, 19.5, 27.6, 20.1 min
  fixes: 8, //      shakedown fix passes: 6.8, 4.4, 4.0, 5.9 min (a fix pass's time includes any writer-repair seat it triggers)
  tail: 12, //      pages build + screenshots + layout-check seat (not yet measured)
});

export function budgetMinutesFromEnv(env = process.env) {
  const raw = env.SEATS_STEP_TIMEOUT_MINUTES;
  const step = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(step) || step <= BUDGET_MARGIN_MINUTES) {
    throw new Error(
      `SEATS_STEP_TIMEOUT_MINUTES must be a number of minutes greater than ${BUDGET_MARGIN_MINUTES} (got ${JSON.stringify(raw)}) — the seats phase refuses to run without a time budget`
    );
  }
  return step - BUDGET_MARGIN_MINUTES;
}

export function makeBudget({ budgetMinutes, startedAtMs, nowMs = () => Date.now(), floors = DEFAULT_FLOORS_MINUTES }) {
  if (!(budgetMinutes > 0)) throw new Error(`budgetMinutes must be positive (got ${budgetMinutes})`);
  const start = startedAtMs ?? nowMs();
  const deadline = start + budgetMinutes * 60000;
  const longest = {}; // kind -> longest observed minutes

  const estimate = (kind) => Math.max(floors[kind] ?? 0, longest[kind] ?? 0);
  const remaining = () => (deadline - nowMs()) / 60000;

  return {
    record(kind, ms) {
      longest[kind] = Math.max(longest[kind] ?? 0, ms / 60000);
    },
    estimate,
    remaining,
    // Before an adversary round: the review, then (if it releases) the tail.
    canStartReview() {
      const need = estimate("adversary") + estimate("tail");
      return { ok: remaining() >= need, need, remaining: remaining() };
    },
    // Before a fix pass: a fix is only worth running if the review that
    // judges it, and the tail after a release, also fit.
    canStartFixes() {
      const need = estimate("fixes") + estimate("adversary") + estimate("tail");
      return { ok: remaining() >= need, need, remaining: remaining() };
    },
    snapshot() {
      return {
        budget_minutes: budgetMinutes,
        remaining_minutes: Number(remaining().toFixed(1)),
        longest_observed_minutes: Object.fromEntries(Object.entries(longest).map(([k, v]) => [k, Number(v.toFixed(1))])),
      };
    },
  };
}
