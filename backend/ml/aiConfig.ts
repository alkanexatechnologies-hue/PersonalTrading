// ============================ AI safety configuration ============================
// This module is imported (and its guard executed) before anything else in
// backend/ml/ runs. There is no order-execution code anywhere in this
// codebase to safely enable — LIVE_ORDER_EXECUTION is asserted false at
// import time, not just defaulted, so a misconfigured env var fails loudly
// instead of silently doing something this app was never built to do safely.

export const AI_MODE: "ADVISORY_ONLY" = "ADVISORY_ONLY";
export const MODEL_TRAINING_ENABLED: boolean = process.env.MODEL_TRAINING_ENABLED === "true"; // default false
export const LIVE_ORDER_EXECUTION: boolean = process.env.LIVE_ORDER_EXECUTION === "true"; // default false

if (LIVE_ORDER_EXECUTION) {
  throw new Error(
    "LIVE_ORDER_EXECUTION=true is not permitted — this codebase has no order-execution path built or reviewed for safe live use. Data collection and backtesting only."
  );
}
