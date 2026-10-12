import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "zlib";
import { unzipFirst, parseFoBhav, compareWithOfficial } from "./oiReconcile";

// minimal single-file zip (deflate) built by hand
function zip(name: string, content: string): Buffer {
  const data = zlib.deflateRawSync(Buffer.from(content)), nm = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(content.length, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(content.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nm.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, nm, data, cd, nm, eocd]);
}

const CSV = "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst\n"
  + "2026-10-12,2026-10-12,FO,NSE,IDO,1,,NIFTY,,2026-10-13,2026-10-13,22350.00,CE,x,0,0,0,72.00,72.45,0,0,0,1000000\n"
  + "2026-10-12,2026-10-12,FO,NSE,IDO,2,,NIFTY,,2026-10-13,2026-10-13,22350.00,PE,x,0,0,0,81.00,81.50,0,0,0,2000000\n"
  + "2026-10-12,2026-10-12,FO,NSE,IDO,3,,NIFTY,,2026-10-20,2026-10-20,22350.00,CE,x,0,0,0,1,1,0,0,0,5\n"
  + "2026-10-12,2026-10-12,FO,NSE,IDO,4,,BANKNIFTY,,2026-10-13,2026-10-13,22350.00,CE,x,0,0,0,1,1,0,0,0,5\n";

test("unzip: first file of a deflated zip", () => {
  assert.equal(unzipFirst(zip("a.csv", CSV)).toString(), CSV);
  assert.throws(() => unzipFirst(Buffer.from("not a zip at all, definitely not")));
});

test("bhavcopy parse: one index, one expiry, options only", () => {
  const m = parseFoBhav(CSV, "NIFTY", "2026-10-13");
  assert.equal(m.size, 2); assert.deepEqual(m.get("22350CE"), { oi: 1000000, last: 72.45, close: 72 });
});

test("comparison: OI difference %, exact premium match, status", () => {
  const off = parseFoBhav(CSV, "NIFTY", "2026-10-13");
  const r: any = compareWithOfficial([{ strike: 22350, ceOi: 1010000, peOi: 2000000, ceLtp: 72.45, peLtp: 81.5 }], off, 22360);
  assert.equal(r.n, 2); assert.equal(r.ltpOk, 2); assert.equal(r.worst[0].oiDiffPct, 1);
  assert.equal(r.status, "GOOD");
  const bad: any = compareWithOfficial([{ strike: 22350, ceOi: 1500000, peOi: 1000000, ceLtp: 70, peLtp: 81.5 }], off, 22360);
  assert.equal(bad.ltpOk, 1); assert.equal(bad.status, "CHECK");   // premiums must match exactly
  assert.equal((compareWithOfficial([], off, 1) as any).n, 0);
});
