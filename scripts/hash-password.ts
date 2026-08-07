/**
 * Prints an ADMIN_PASSWORD_HASH line for your .env.
 *
 *   deno task hash-password
 *
 * Reads from stdin so the password never lands in your shell history or in the
 * process list. Echo is disabled where the terminal supports it.
 */

import { hashPassword } from "../src/util/crypto.ts";

const MIN_LENGTH = 12;

const CTRL_C = 3;
const BACKSPACE = 8;
const LF = 10;
const CR = 13;
const DEL = 127;

async function readPassword(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));

  let raw = false;
  try {
    Deno.stdin.setRaw(true, { cbreak: false });
    raw = true;
  } catch {
    // Not a TTY (piped input) — fall through and read the line as-is.
  }
  const restore = () => {
    if (!raw) return;
    try {
      Deno.stdin.setRaw(false);
    } catch { /* ignore */ }
  };

  const bytes: number[] = [];
  const buf = new Uint8Array(1);

  try {
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const b = buf[0]!;

      if (b === CR || b === LF) break;
      if (b === CTRL_C) {
        restore();
        await Deno.stdout.write(new TextEncoder().encode("\n"));
        Deno.exit(130);
      }
      if (b === DEL || b === BACKSPACE) {
        bytes.pop();
        continue;
      }
      bytes.push(b);
    }
  } finally {
    restore();
  }

  await Deno.stdout.write(new TextEncoder().encode("\n"));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const password = await readPassword("New admin password: ");
if (password.length < MIN_LENGTH) {
  console.error(`Too short — use at least ${MIN_LENGTH} characters.`);
  Deno.exit(1);
}

const confirm = await readPassword("Confirm password:   ");
if (confirm !== password) {
  console.error("Passwords do not match.");
  Deno.exit(1);
}

console.log("\nAdd this line to your .env (and remove ADMIN_PASSWORD if present):\n");
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}\n`);
