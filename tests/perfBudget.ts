/**
 * SPEC performance budgets (200 ms full-score solve / 20 ms local re-solve) are
 * wall-clock measurements calibrated on a local workstation. GitHub-hosted
 * runners are slower and share CPU with other test files running in parallel,
 * so allow a multiplier only when CI is set. Local runs keep the SPEC budgets.
 *
 * Override explicitly with PERF_BUDGET_SCALE=<number>.
 */
const DEFAULT_CI_SCALE = 3;

function resolveScale(): number {
  const raw = process.env.PERF_BUDGET_SCALE;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return process.env.CI ? DEFAULT_CI_SCALE : 1;
}

export const PERF_BUDGET_SCALE = resolveScale();

export function perfBudget(ms: number): number {
  return Math.ceil(ms * PERF_BUDGET_SCALE);
}
