import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

// ============================ ORB activation state (Test Zone) ============================
// Whether the ORB strategy is "activated" to log its confirmed TAKE signals into
// the Trade Execution daily log. This is ADVISORY/paper: it records the signal
// (like the existing auto-log), it never places a live order. Persisted under
// DATA_DIR so it survives restarts. Off by default.

const FILE = path.join(DATA_DIR, "strategies", "orb-active.json");

export interface OrbActiveState { active: boolean; at: number | null; }

export function getOrbActive(): OrbActiveState {
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf-8")); return { active: !!j.active, at: j.at ?? null }; }
  catch { return { active: false, at: null }; }
}

export function setOrbActive(active: boolean): OrbActiveState {
  const next: OrbActiveState = { active: !!active, at: Math.floor(Date.now() / 1000) };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(next), "utf-8"); } catch { /* best-effort */ }
  return next;
}
