// Probe whether NSE's public option-chain API is reachable from this environment.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};

function cookieHeader(res: Response): string {
  const anyHeaders = res.headers as any;
  const list: string[] = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  try {
    // 1) Prime cookies by hitting the homepage root, then the option-chain page.
    const home = await fetch("https://www.nseindia.com/", { headers: HEADERS });
    let cookie = cookieHeader(home);
    const oc = await fetch("https://www.nseindia.com/option-chain", {
      headers: { ...HEADERS, Cookie: cookie },
    });
    const more = cookieHeader(oc);
    if (more) cookie = cookie ? cookie + "; " + more : more;
    console.log("home status:", home.status, "| oc status:", oc.status, "| cookie parts:", cookie.split("; ").length);

    // 2) Call the option-chain API with the cookie.
    const res = await fetch("https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY", {
      headers: { ...HEADERS, Cookie: cookie },
    });
    console.log("api status:", res.status);
    const text = await res.text();
    console.log("body length:", text.length);
    try {
      const json = JSON.parse(text);
      const records = json?.records;
      console.log("underlyingValue:", records?.underlyingValue);
      console.log("strikePrices count:", records?.strikePrices?.length);
      console.log("data rows:", records?.data?.length);
      const sample = records?.data?.find((d: any) => d.CE && d.PE);
      if (sample) {
        console.log("sample strike:", sample.strikePrice, "CE OI:", sample.CE?.openInterest, "PE OI:", sample.PE?.openInterest);
      }
    } catch {
      console.log("body (first 200):", text.slice(0, 200));
    }
  } catch (e: any) {
    console.log("FETCH ERROR:", e?.message || e);
  }
}

main();
