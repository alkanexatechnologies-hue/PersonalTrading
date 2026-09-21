import { getProvider } from "./index";
import { scrubGrowwToken } from "./sessionFeed";

// ============================ Dhan authentication (legacy function names kept) ============================
// Validates the Dhan access token by making a real read-only request.

export type GrowwFailureCode =
  | "NO_TOKEN"
  | "INVALID_TOKEN"
  | "AUTH_FAILED"
  | "RATE_LIMIT"
  | "API_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "UNEXPECTED_RESPONSE";

const FAILURE_TEXT: Record<GrowwFailureCode, string> = {
  NO_TOKEN: "No access token saved. Paste a Dhan access token and save it.",
  INVALID_TOKEN: "Invalid or expired access token. Dhan tokens expire daily — generate a fresh one on web.dhan.co → Access DhanHQ APIs.",
  AUTH_FAILED: "Authentication failed. The token was rejected — check the DhanHQ API subscription is active.",
  RATE_LIMIT: "Dhan is rate-limiting requests right now. Wait a minute and test again.",
  API_UNAVAILABLE: "Dhan API is unavailable (server error). Try again shortly.",
  NETWORK_ERROR: "Network error reaching Dhan. Check this machine's internet connection.",
  UNEXPECTED_RESPONSE: "Unexpected response from the Dhan API.",
};

export function classifyGrowwError(e: unknown): { code: GrowwFailureCode; message: string; detail: string } {
  const raw = scrubGrowwToken((e as any)?.message || String(e || "") || "");
  let code: GrowwFailureCode = "UNEXPECTED_RESPONSE";

  if (/\b401\b|unauthor/i.test(raw)) code = "INVALID_TOKEN";
  else if (/\b403\b|forbidden/i.test(raw)) code = "AUTH_FAILED";
  else if (/\b429\b|rate.?limit|too many/i.test(raw)) code = "RATE_LIMIT";
  else if (/\b5\d\d\b|unavailable|bad gateway/i.test(raw)) code = "API_UNAVAILABLE";
  else if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timeout|timed out|abort/i.test(raw)) code = "NETWORK_ERROR";

  return { code, message: FAILURE_TEXT[code], detail: raw.slice(0, 200) };
}

export interface GrowwValidation {
  ok: boolean;
  code?: GrowwFailureCode;
  message: string;
  latencyMs: number;
  price?: number;
}

export async function validateGrowwToken(timeoutMs = 12_000): Promise<GrowwValidation> {
  const t0 = Date.now();
  try {
    const quote = await Promise.race([
      getProvider().getQuote("RELIANCE.NS"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Dhan request timed out")), timeoutMs)),
    ]);
    const latencyMs = Date.now() - t0;
    const price = Number((quote as any)?.price);
    if (!quote || !Number.isFinite(price) || price <= 0) {
      return { ok: false, code: "UNEXPECTED_RESPONSE", message: "Authenticated, but Dhan returned no usable price.", latencyMs };
    }
    return { ok: true, message: `Authenticated — live data received (Reliance ₹${price}).`, latencyMs, price };
  } catch (e) {
    const { code, message } = classifyGrowwError(e);
    return { ok: false, code, message, latencyMs: Date.now() - t0 };
  }
}
