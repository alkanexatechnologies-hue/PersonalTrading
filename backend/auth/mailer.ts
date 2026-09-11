import nodemailer from "nodemailer";

// ============================ Credential-rotation email ============================
// Sends the dashboard's rotated login (see credentials.ts) to a user-configured
// address instead of making them go dig it out of the server console. Configure
// via env vars:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM (optional)
// Any standard SMTP provider works (Gmail with an app password, SendGrid,
// Mailgun, etc.). If unconfigured, sendCredentialsEmail logs and no-ops instead
// of throwing, so the app keeps working without email set up - the console
// announcement (credentials.ts) remains the fallback either way.

let transporter: ReturnType<typeof nodemailer.createTransport> | null | undefined; // undefined = not built yet

function getTransporter() {
  if (transporter !== undefined) return transporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    transporter = null;
    return transporter;
  }
  const port = Number(process.env.SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return transporter;
}

export function emailConfigured(): boolean {
  return getTransporter() !== null;
}

export async function sendCredentialsEmail(to: string, username: string, password: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log(`[auth] SMTP not configured (set SMTP_HOST / SMTP_USER / SMTP_PASS env vars) - cannot email rotated credentials to ${to}. Check the server console instead.`);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
  await t.sendMail({
    from,
    to,
    subject: "NSA Intraday Assistant — your dashboard login",
    text:
      `Your dashboard login was just rotated.\n\n` +
      `Username: ${username}\nPassword: ${password}\n\n` +
      `This rotates automatically every day at 08:00 IST - a new email like this one arrives each time.`,
    html:
      `<p>Your dashboard login was just rotated.</p>` +
      `<p><b>Username:</b> ${username}<br><b>Password:</b> ${password}</p>` +
      `<p>This rotates automatically every day at 08:00 IST - a new email like this one arrives each time.</p>`,
  });
}
