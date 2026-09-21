// ============================ Compliance / Disclosure constants ============================
// Single source of truth for disclosure/rule versions used by the audit trail and by the
// /api/compliance/meta endpoint (the frontend reads these to decide when to re-prompt the
// user for acknowledgement). Bump DISCLOSURE_VERSION whenever the disclosure TEXT changes
// materially — users will then be asked to acknowledge the updated disclosure.
//
// IMPORTANT: none of this makes the application "SEBI compliant". These are software
// controls only. See docs/compliance/ for the full picture and the items that require
// independent legal/broker/exchange confirmation.

import fs from "fs";
import path from "path";

function readAppVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    return JSON.parse(raw).version || "0.0.0";
  } catch { return "0.0.0"; }
}

export const APP_VERSION: string = readAppVersion();

// Disclosure text version. Change this string when disclosure wording changes.
export const DISCLOSURE_VERSION = "2026-09-11.1";

// Strategy/rule version stamped onto every signal audit record.
export const RULE_VERSION = "oi-command/v1";

// The standard SEBI market-risk warning — used verbatim, never reworded.
export const SEBI_STANDARD_WARNING =
  "Investment in securities market are subject to market risks. Read all the related documents carefully before investing.";

export function complianceMeta() {
  return {
    appVersion: APP_VERSION,
    disclosureVersion: DISCLOSURE_VERSION,
    ruleVersion: RULE_VERSION,
    sebiStandardWarning: SEBI_STANDARD_WARNING,
    // Honest capability flags for the UI.
    liveOrderExecution: false, // no broker order path; simulated paper only
    marketDataSource: "DHAN",
  };
}
