// ---- Sentiment / Liquidity / Risk extension — barrel export ----
// Additive layer on the paper engine's DIRECTIONAL option entries. The ordered
// call sequence (Step 11) lives in engine.ts (runExtPipeline); these are the pure,
// independently-testable modules it composes.

export * from "./types";
export * from "./marketRegime";
export * from "./liquidityGuard";
export * from "./sentiment4L";
export * from "./openingBias";
export * from "./premiumSentiment";
export * from "./wallReaction";
export * from "./tradeScore";
export * from "./riskComment";
export * from "./tradeDedup";
export * from "./pipeline";
export * from "./decisionLog";
export * from "./tradeArbiter";
