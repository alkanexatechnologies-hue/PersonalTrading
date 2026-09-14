import path from "path";

// ============================ Persistent data directory ============================
// PRODUCTION PERSISTENCE ROOT CAUSE FIX.
//
// Every auth/user store in this app writes JSON under `<cwd>/data`. On Render's
// free tier (and any container without a mounted disk) that path is EPHEMERAL:
// a restart, redeploy, or the free-tier idle spin-down starts a fresh container
// with an empty `data/`, so the persisted admin credentials and every
// admin-created user silently vanish and the app regenerates a new random admin
// password on next boot. The storage CODE was already non-destructive (it
// reuses whatever it finds and never resets on startup) - the loss was purely
// the filesystem underneath it disappearing.
//
// The fix is to let the data live on a persistent location chosen by the
// deployment, via the DATA_DIR environment variable, WITHOUT changing any
// storage logic. In production, point DATA_DIR at a mounted Render Persistent
// Disk (e.g. /var/data) so the files survive restarts, redeploys and GitHub
// deploys. When DATA_DIR is unset (local dev, tests), behaviour is exactly as
// before: `<cwd>/data`.
//
// Deliberately scoped to the auth/login stores (credentials, users, login
// audit) - the accounts and passwords that MUST survive - so nothing about how
// trading data is stored or computed changes.
export const DATA_DIR: string = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

/** Absolute path to a file inside the persistent data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}
