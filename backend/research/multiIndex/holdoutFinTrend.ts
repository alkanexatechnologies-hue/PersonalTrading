import fs from "fs";
import path from "path";
import { assembleIndex, INDICES } from "./data";
import { analyse } from "../earlyBreakout/trendday";
import { stats } from "../earlyBreakout/root";
import { DATA_DIR } from "../../config/dataDir";
// Pre-registered HOLDOUT (opened once): FINNIFTY trend-day s4_T1000_TRAIL — DEV-best (48 trades), positive in DEV and VALIDATION.
const days = assembleIndex("FINNIFTY", "2024-10-14", "2026-10-12"), c = INDICES.FINNIFTY;
const { trades } = analyse(days, [{ s: 4, T: 600, exit: "TRAIL" }], { step: c.step, lot: c.lot });
const by = (p: string) => stats(trades.filter((t: any) => t.period === p) as any);
const out = { variant: "s4_T1000_TRAIL", index: "FINNIFTY", DEV: by("DEV"), VALIDATION: by("VALIDATION"), HOLDOUT: by("HOLDOUT"), openedAt: new Date().toISOString() };
fs.writeFileSync(path.join(DATA_DIR, "research-multi", "results", "FINNIFTY_trendday_HOLDOUT.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
