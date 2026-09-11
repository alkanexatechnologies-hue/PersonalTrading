import crypto from "crypto";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const TOKEN_URL = "https://api.groww.in/v1/token/api/access";

function checksum(secret: string, timestamp: string): string {
  return crypto.createHash("sha256").update(secret + timestamp, "utf8").digest("hex");
}

function extractToken(data: any): string | null {
  if (!data) return null;
  const t = data.token || data.payload?.token || data.data?.token || data.access_token;
  return t && String(t).trim() ? String(t).trim() : null;
}

function growwError(data: any, text: string, status: number): string {
  const msg =
    data?.error?.message ||
    data?.message ||
    data?.error ||
    (typeof data?.payload === "string" ? data.payload : null);
  if (msg) return String(msg);
  if (text) return text.slice(0, 280);
  return `Groww token API HTTP ${status}`;
}

/**
 * Mint a Groww access token from API key + secret (approval checksum flow).
 * Official docs: POST /v1/token/api/access with SHA256(secret + epochSeconds).
 * Does not require Python. Token expires ~6:00 AM IST.
 */
export async function mintGrowwToken(apiKey: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-VERSION": "1.0",
    },
    body: JSON.stringify({
      key_type: "approval",
      checksum: checksum(secret, timestamp),
      timestamp,
    }),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  const token = extractToken(data);
  if (res.ok && token) return token;
  if (data?.status === "SUCCESS" && token) return token;

  const hint = growwError(data, text, res.status);
  throw new Error(
    hint +
      " Approve the API key for today on Groww → Settings → Trading APIs, check IP whitelist, and confirm the Trading API subscription is active."
  );
}

function pythonPath(): string {
  const local = process.env.LOCALAPPDATA || "";
  const candidate = path.join(local, "Programs", "Python", "Python312", "python.exe");
  if (local && fs.existsSync(candidate)) return candidate;
  return process.platform === "win32" ? "python" : "python3";
}

/** Legacy fallback if the HTTP mint fails on an old Python-only environment. */
export function mintGrowwTokenPython(apiKey: string, secret: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const py = pythonPath();
    const script = path.join(process.cwd(), "scripts", "mint_token.py");
    if (!fs.existsSync(script)) return reject(new Error("mint_token.py not found"));
    const child = spawn(py, [script], {
      env: { ...process.env, GROWW_API_KEY: apiKey, GROWW_API_SECRET: secret },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      const token = out.trim();
      if (code === 0 && token) resolve(token);
      else if (code === 3) reject(new Error("Python growwapi package is not installed."));
      else reject(new Error(err.trim() || `Token generation failed (exit ${code}).`));
    });
  });
}
