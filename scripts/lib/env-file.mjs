// Reads and updates the local .env (never committed). Only touches the keys it is given.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../.env");

export function ensureEnv() {
  if (!existsSync(ENV_PATH)) copyFileSync(join(dirname(ENV_PATH), ".env.example"), ENV_PATH);
}

/** Sets KEY=value, keeping the line's trailing comment; appends the key if it is not there. */
export function setEnv(values) {
  ensureEnv();
  let text = readFileSync(ENV_PATH, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=[^\\n#]*?(\\s+#.*)?$`, "m");
    text = re.test(text) ? text.replace(re, (_, comment = "") => `${k}=${v}${comment}`) : `${text.trimEnd()}\n${k}=${v}\n`;
    process.env[k] = v;
  }
  writeFileSync(ENV_PATH, text);
}
