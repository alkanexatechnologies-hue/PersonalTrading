// Dhan access-token auto-renewal (Dhan v2 POST /RenewToken).
// Dhan Web tokens last 24 h. RenewToken expires the CURRENT token and returns a new one valid for
// another 24 h; it only works while the current token is still active (docs:
// dhanhq.co/docs/v2/authentication). A renewal always lasts exactly 24 h, so renewing at one fixed
// time each day would race the expiry. Rule instead: outside market hours, renew whenever fewer
// than 13 h remain. Market hours can delay a renewal by at most ~6.5 h, so at least ~6.5 h of
// validity is always left when it happens, and the token is never swapped while trading.

export const RENEW_BELOW_SEC = 13 * 3600;      // renew when less than this remains
export const MIN_LEFT_SEC = 120;               // never try on a token that is (about to be) expired

export function jwtPayload(token: string | null | undefined): any | null {
  try {
    const p = String(token || "").split(".")[1]; if (!p) return null;
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}
export function jwtExp(token: string | null | undefined): number | null {
  const e = Number(jwtPayload(token)?.exp); return isFinite(e) && e > 0 ? e : null;
}

// Mon–Fri 09:00–15:31 IST: no token swaps while the market is open (incl. pre-open).
export function inMarketWindow(nowSec: number): boolean {
  const d = new Date((nowSec + 19800) * 1000), dow = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 9 * 60 && m < 15 * 60 + 31;
}

export function renewDecision(nowSec: number, expSec: number | null): { renew: boolean; why: string } {
  if (expSec == null) return { renew: false, why: "token has no readable expiry" };
  const left = expSec - nowSec;
  if (left <= MIN_LEFT_SEC) return { renew: false, why: "token already expired — paste a fresh one (Dhan only renews an active token)" };
  if (left >= RENEW_BELOW_SEC) return { renew: false, why: `${Math.round(left / 3600)} h left` };
  if (inMarketWindow(nowSec)) return { renew: false, why: "market hours — renewal waits until 15:31" };
  return { renew: true, why: `${(left / 3600).toFixed(1)} h left` };
}

// RenewToken's response body is not documented field-by-field: take the first JWT-looking string
// that belongs to the same Dhan client and expires later than the current token.
export function pickRenewedToken(body: any, oldToken: string, clientId: string | null | undefined): string | null {
  const oldExp = jwtExp(oldToken) || 0;
  const seen: string[] = [];
  const walk = (v: any, depth: number) => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") { if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v.trim())) seen.push(v.trim()); return; }
    if (typeof v === "object") for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(body, 0);
  for (const t of seen) {
    if (t === oldToken) continue;
    const p = jwtPayload(t); if (!p) continue;
    if (clientId && p.dhanClientId && String(p.dhanClientId) !== String(clientId)) continue;
    if ((Number(p.exp) || 0) <= oldExp) continue;
    return t;
  }
  return null;
}
