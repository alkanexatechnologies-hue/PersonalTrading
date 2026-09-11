import fs from "fs";
import path from "path";

// Personal WhatsApp sender. Tries (in order): CallMeBot, Green-API, Meta Cloud, webhook.
// Secrets live in data/whatsapp-config.json and/or env — never required for the rest of the app.

export interface WhatsappConfig {
  enabled: boolean;
  phone: string;               // digits with country code, e.g. 91XXXXXXXXXX
  callmebotKey?: string;
  greenId?: string;
  greenToken?: string;
  metaToken?: string;
  metaPhoneId?: string;
  webhookUrl?: string;
}

const FILE = path.join(process.cwd(), "data", "whatsapp-config.json");

function digits(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

export function loadWhatsappConfig(): WhatsappConfig {
  let file: Partial<WhatsappConfig> = {};
  try { file = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { /* none */ }
  return {
    enabled: file.enabled === true,
    phone: digits(process.env.WHATSAPP_PHONE || file.phone || ""),
    callmebotKey: process.env.WHATSAPP_CALLMEBOT_KEY || file.callmebotKey || "",
    greenId: process.env.WHATSAPP_GREEN_ID || file.greenId || "",
    greenToken: process.env.WHATSAPP_GREEN_TOKEN || file.greenToken || "",
    metaToken: process.env.WHATSAPP_TOKEN || file.metaToken || "",
    metaPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || file.metaPhoneId || "",
    webhookUrl: process.env.WHATSAPP_WEBHOOK_URL || file.webhookUrl || "",
  };
}

export function saveWhatsappConfig(patch: Partial<WhatsappConfig>): WhatsappConfig {
  const cur = loadWhatsappConfig();
  const phoneIn = patch.phone != null ? digits(patch.phone) : "";
  const keyIn = patch.callmebotKey != null ? String(patch.callmebotKey).trim() : "";
  const next: WhatsappConfig = {
    ...cur,
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    phone: phoneIn.length >= 10 ? phoneIn : cur.phone,
    callmebotKey: keyIn || cur.callmebotKey,
    greenId: patch.greenId != null && String(patch.greenId).trim() ? String(patch.greenId).trim() : cur.greenId,
    greenToken: patch.greenToken != null && String(patch.greenToken).trim() ? String(patch.greenToken).trim() : cur.greenToken,
    metaToken: patch.metaToken != null && String(patch.metaToken).trim() ? String(patch.metaToken).trim() : cur.metaToken,
    metaPhoneId: patch.metaPhoneId != null && String(patch.metaPhoneId).trim() ? String(patch.metaPhoneId).trim() : cur.metaPhoneId,
    webhookUrl: patch.webhookUrl != null && String(patch.webhookUrl).trim() ? String(patch.webhookUrl).trim() : cur.webhookUrl,
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch { /* best-effort */ }
  return next;
}

export function whatsappReady(cfg = loadWhatsappConfig()): { ok: boolean; via: string; reason: string } {
  if (!cfg.enabled) return { ok: false, via: "off", reason: "WhatsApp alerts बंद हैं" };
  if (!cfg.phone || cfg.phone.length < 10) return { ok: false, via: "none", reason: "phone number नहीं है (91XXXXXXXXXX)" };
  if (cfg.callmebotKey) return { ok: true, via: "callmebot", reason: "CallMeBot" };
  if (cfg.greenId && cfg.greenToken) return { ok: true, via: "green-api", reason: "Green-API" };
  if (cfg.metaToken && cfg.metaPhoneId) return { ok: true, via: "meta", reason: "WhatsApp Cloud API" };
  if (cfg.webhookUrl) return { ok: true, via: "webhook", reason: "custom webhook" };
  return { ok: false, via: "none", reason: "CallMeBot API key (या Green-API / Meta token) नहीं है" };
}

export async function sendWhatsapp(text: string, cfg = loadWhatsappConfig()): Promise<{ ok: boolean; via: string; error?: string }> {
  const ready = whatsappReady(cfg);
  if (!ready.ok) return { ok: false, via: ready.via, error: ready.reason };
  const body = text.slice(0, 3900);
  try {
    if (cfg.callmebotKey) {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cfg.phone)}&text=${encodeURIComponent(body)}&apikey=${encodeURIComponent(cfg.callmebotKey)}`;
      const res = await fetch(url);
      const t = await res.text();
      if (!res.ok) return { ok: false, via: "callmebot", error: t.slice(0, 200) };
      return { ok: true, via: "callmebot" };
    }
    if (cfg.greenId && cfg.greenToken) {
      const url = `https://api.green-api.com/waInstance${cfg.greenId}/sendMessage/${cfg.greenToken}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: `${cfg.phone}@c.us`, message: body }),
      });
      if (!res.ok) return { ok: false, via: "green-api", error: (await res.text()).slice(0, 200) };
      return { ok: true, via: "green-api" };
    }
    if (cfg.metaToken && cfg.metaPhoneId) {
      const url = `https://graph.facebook.com/v21.0/${cfg.metaPhoneId}/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.metaToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: cfg.phone,
          type: "text",
          text: { body, preview_url: false },
        }),
      });
      if (!res.ok) return { ok: false, via: "meta", error: (await res.text()).slice(0, 200) };
      return { ok: true, via: "meta" };
    }
    if (cfg.webhookUrl) {
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: cfg.phone, text: body, source: "nsa-oi-command" }),
      });
      if (!res.ok) return { ok: false, via: "webhook", error: (await res.text()).slice(0, 200) };
      return { ok: true, via: "webhook" };
    }
  } catch (e: any) {
    return { ok: false, via: ready.via, error: e?.message || String(e) };
  }
  return { ok: false, via: "none", error: "no transport" };
}
