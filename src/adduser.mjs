// Creates or resets a dashboard login. The password is typed in, never passed on the command line or saved anywhere.
// Usage: node src/adduser.mjs <username>
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { db, ensureSchema } = await import("../lib/db.mjs");
const { hashPassword } = await import("../lib/auth.mjs");

const username = (process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(username)) { console.error("Usage: node src/adduser.mjs <username>  (letters, digits, . _ -)"); process.exit(1); }

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => rl.output.write(s.includes(q) ? s : "*");
  rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
});
const pw = await ask(`Password for ${username}: `);
if (pw.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
if ((await ask("Repeat password: ")) !== pw) { console.error("Passwords do not match."); process.exit(1); }

await ensureSchema();
await db().query("insert into users (username, pass_hash) values ($1, $2) on conflict (username) do update set pass_hash = excluded.pass_hash", [username, hashPassword(pw)]);
console.log(`Login ready: ${username}`);
await db().end();
