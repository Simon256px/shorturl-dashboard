/**
 * Configuration is read once at boot and validated eagerly: a misconfigured
 * server should refuse to start rather than misbehave under traffic.
 */

function env(key: string): string | undefined {
  const v = Deno.env.get(key);
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function bool(key: string, fallback: boolean): boolean {
  const v = env(key)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${key} must be a boolean (got ${JSON.stringify(v)})`);
}

function int(key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer in [${min}, ${max}] (got ${JSON.stringify(v)})`);
  }
  return n;
}

const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

function buildConfig() {
  const port = int("PORT", 8000, 1, 65535);
  const baseUrlRaw = env("BASE_URL") ?? `http://localhost:${port}`;

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new Error(`BASE_URL is not a valid URL: ${JSON.stringify(baseUrlRaw)}`);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("BASE_URL must be http:// or https://");
  }
  // Normalise: no trailing slash, so `${baseUrl}/${slug}` is always well formed.
  const baseOrigin = baseUrl.origin;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");

  const redirectStatus = int("REDIRECT_STATUS", 302, 300, 399);
  if (!REDIRECT_STATUSES.includes(redirectStatus as RedirectStatus)) {
    throw new Error(`REDIRECT_STATUS must be one of ${REDIRECT_STATUSES.join(", ")}`);
  }

  const discordWebhook = env("DISCORD_WEBHOOK_URL");
  if (discordWebhook !== undefined) {
    let u: URL;
    try {
      u = new URL(discordWebhook);
    } catch {
      throw new Error("DISCORD_WEBHOOK_URL is not a valid URL");
    }
    const okHost = u.protocol === "https:" &&
      (u.hostname === "discord.com" || u.hostname === "discordapp.com" ||
        u.hostname.endsWith(".discord.com"));
    if (!okHost) {
      throw new Error("DISCORD_WEBHOOK_URL must be an https://discord.com/api/webhooks/... URL");
    }
  }

  const adminHash = env("ADMIN_PASSWORD_HASH");
  const adminPlain = env("ADMIN_PASSWORD");
  if (!adminHash && !adminPlain) {
    throw new Error(
      "No admin credentials. Set ADMIN_PASSWORD_HASH (run `deno task hash-password`) " +
        "or ADMIN_PASSWORD in your .env.",
    );
  }
  if (adminPlain && adminPlain.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  }

  return {
    host: env("HOST") ?? "127.0.0.1",
    port,

    /** Public origin, no trailing slash. e.g. `https://s.example.com` */
    baseUrl: baseOrigin + basePath,
    baseOrigin,

    dataDir: env("DATA_DIR") ?? "./data",

    adminPasswordHash: adminHash,
    adminPassword: adminPlain,
    sessionTtlSeconds: int("SESSION_TTL_HOURS", 168, 1, 24 * 365) * 3600,

    trustProxy: bool("TRUST_PROXY", false),
    publicShortening: bool("PUBLIC_SHORTENING", false),
    allowPrivateTargets: bool("ALLOW_PRIVATE_TARGETS", false),

    redirectStatus: redirectStatus as RedirectStatus,
    retentionDays: int("ANALYTICS_RETENTION_DAYS", 400, 0, 36500),

    discordWebhook,
    discordIntervalSeconds: int("DISCORD_UPDATE_INTERVAL_SECONDS", 300, 60, 86400),

    /** Cookies get the Secure attribute only when the public origin is https. */
    secureCookies: baseUrl.protocol === "https:",
  };
}

export type Config = ReturnType<typeof buildConfig>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) cached = buildConfig();
  return cached;
}
