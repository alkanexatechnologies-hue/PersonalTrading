// Minimal reader for legacy Excel .xls (BIFF8 inside an OLE2/CFB container) — just enough
// to read cell values from NSE's small daily report files. Returns the first worksheet as a
// grid of strings ("" for empty). Throws on anything it does not understand; callers treat
// that as "data unavailable" (never guessed).

const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe;

function cfbStream(buf: Buffer, wanted: string): Buffer {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) throw new Error("not an OLE2 file");
  const ssz = 1 << buf.readUInt16LE(0x1e), mssz = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2c), dirStart = buf.readUInt32LE(0x30), cutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c), difatStart = buf.readUInt32LE(0x44);
  const sector = (n: number) => { const o = (n + 1) * ssz; if (o + ssz > buf.length) throw new Error("sector out of range"); return buf.subarray(o, o + ssz); };
  // FAT sector list: 109 in the header, then the DIFAT chain
  const fatSecs: number[] = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = buf.readUInt32LE(0x4c + i * 4); if (s !== FREESECT) fatSecs.push(s); }
  for (let d = difatStart, guard = 0; d !== ENDOFCHAIN && d !== FREESECT && fatSecs.length < nFat && guard < 1000; guard++) {
    const sec = sector(d);
    for (let i = 0; i < ssz / 4 - 1 && fatSecs.length < nFat; i++) { const s = sec.readUInt32LE(i * 4); if (s !== FREESECT) fatSecs.push(s); }
    d = sec.readUInt32LE(ssz - 4);
  }
  const fat: number[] = [];
  for (const s of fatSecs) { const sec = sector(s); for (let i = 0; i < ssz / 4; i++) fat.push(sec.readUInt32LE(i * 4)); }
  const chain = (start: number, next: number[]) => { const out: number[] = []; for (let s = start; s !== ENDOFCHAIN && s !== FREESECT; s = next[s]) { if (out.length > next.length || s >= next.length) throw new Error("bad chain"); out.push(s); } return out; };
  const read = (start: number) => Buffer.concat(chain(start, fat).map(sector));
  // directory
  const dir = read(dirStart);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nlen = dir.readUInt16LE(o + 64);
    entries.push({ name: dir.subarray(o, o + Math.max(0, nlen - 2)).toString("utf16le"), type: dir[o + 66], start: dir.readUInt32LE(o + 116), size: dir.readUInt32LE(o + 120) });
  }
  const ent = entries.find((e) => e.type === 2 && e.name.toLowerCase() === wanted.toLowerCase());
  if (!ent) throw new Error(`stream ${wanted} not found`);
  if (ent.size >= cutoff) return read(ent.start).subarray(0, ent.size);
  // small stream: lives in the mini stream (root entry's chain), addressed by the mini FAT
  const root = entries[0];
  const ministream = read(root.start);
  const minifatBuf = miniFatStart === ENDOFCHAIN ? Buffer.alloc(0) : read(miniFatStart);
  const minifat: number[] = []; for (let i = 0; i + 4 <= minifatBuf.length; i += 4) minifat.push(minifatBuf.readUInt32LE(i));
  return Buffer.concat(chain(ent.start, minifat).map((m) => ministream.subarray(m * mssz, m * mssz + mssz))).subarray(0, ent.size);
}

/** Cursor over SST + CONTINUE record bodies; strings may continue across record boundaries. */
class SegReader {
  private i = 0; private o = 0;
  constructor(private segs: Buffer[]) {}
  private ensure() { while (this.i < this.segs.length && this.o >= this.segs[this.i].length) { this.i++; this.o = 0; } if (this.i >= this.segs.length) throw new Error("SST overrun"); }
  u8(): number { this.ensure(); return this.segs[this.i][this.o++]; }
  u16(): number { return this.u8() | (this.u8() << 8); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n: number) { while (n-- > 0) this.u8(); }
  chars(n: number, high: boolean): string {
    let s = "";
    while (n > 0) {
      this.ensure();
      const seg = this.segs[this.i];
      const avail = Math.floor((seg.length - this.o) / (high ? 2 : 1));
      const take = Math.min(n, avail);
      s += high ? seg.subarray(this.o, this.o + take * 2).toString("utf16le") : seg.subarray(this.o, this.o + take).toString("latin1");
      this.o += take * (high ? 2 : 1); n -= take;
      if (n > 0) { this.i++; this.o = 0; this.ensure(); high = (this.segs[this.i][this.o++] & 1) === 1; }   // new grbit at a CONTINUE
    }
    return s;
  }
}

function rkValue(rk: number): number {
  let v: number;
  if (rk & 2) v = rk >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE(0, 0); b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4); v = b.readDoubleLE(0); }
  return rk & 1 ? v / 100 : v;
}
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

/** First worksheet of a BIFF8 .xls as rows of strings. */
export function readXlsFirstSheet(buf: Buffer): string[][] {
  let wb: Buffer;
  try { wb = cfbStream(buf, "Workbook"); } catch { wb = cfbStream(buf, "Book"); }
  const sst: string[] = [];
  const cells = new Map<string, string>();
  let sheet = -1, maxR = -1, maxC = -1;
  const put = (r: number, c: number, v: string) => { if (sheet !== 0) return; cells.set(`${r},${c}`, v); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); };
  let o = 0;
  while (o + 4 <= wb.length) {
    const type = wb.readUInt16LE(o), len = wb.readUInt16LE(o + 2);
    const d = wb.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    if (type === 0x0809) { if (d.readUInt16LE(2) === 0x0010) sheet++; continue; }            // BOF (worksheet)
    if (type === 0x00fc) {                                                                    // SST (+ CONTINUE)
      const segs = [d];
      while (o + 4 <= wb.length && wb.readUInt16LE(o) === 0x003c) { const l = wb.readUInt16LE(o + 2); segs.push(wb.subarray(o + 4, o + 4 + l)); o += 4 + l; }
      const r = new SegReader(segs);
      r.u32(); const n = r.u32();
      for (let k = 0; k < n; k++) {
        const cch = r.u16(), fl = r.u8();
        const runs = fl & 8 ? r.u16() : 0, ext = fl & 4 ? r.u32() : 0;
        sst.push(r.chars(cch, (fl & 1) === 1));
        r.skip(runs * 4); r.skip(ext);
      }
      continue;
    }
    if (sheet !== 0) { if (sheet > 0) break; continue; }
    if (type === 0x00fd) put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? "");     // LABELSST
    else if (type === 0x0203) put(d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(d.readDoubleLE(6)));    // NUMBER
    else if (type === 0x027e) put(d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(rkValue(d.readUInt32LE(6)))); // RK
    else if (type === 0x00bd) {                                                                       // MULRK
      const r = d.readUInt16LE(0), c0 = d.readUInt16LE(2), cN = d.readUInt16LE(d.length - 2);
      for (let c = c0; c <= cN; c++) put(r, c, fmtNum(rkValue(d.readUInt32LE(4 + (c - c0) * 6 + 2))));
    } else if (type === 0x0204) {                                                                     // LABEL (old style)
      const cch = d.readUInt16LE(6), hi = d[8] & 1;
      put(d.readUInt16LE(0), d.readUInt16LE(2), hi ? d.subarray(9, 9 + cch * 2).toString("utf16le") : d.subarray(9, 9 + cch).toString("latin1"));
    }
  }
  const grid: string[][] = [];
  for (let r = 0; r <= maxR; r++) { const row: string[] = []; for (let c = 0; c <= maxC; c++) row.push((cells.get(`${r},${c}`) ?? "").trim()); grid.push(row); }
  return grid;
}
