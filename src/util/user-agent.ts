/**
 * A deliberately small User-Agent classifier.
 *
 * Full UA databases are large, need updating, and encourage storing a
 * high-entropy fingerprint. We only want coarse buckets for the dashboard, so
 * a few ordered patterns beat a dependency here. Order matters: Edge claims to
 * be Chrome, Chrome claims to be Safari, and nearly everything claims Mozilla.
 */

export type DeviceKind = "desktop" | "mobile" | "tablet" | "bot";

export interface UaInfo {
  browser: string;
  os: string;
  device: DeviceKind;
}

const BOT_PATTERNS = [
  "bot",
  "crawler",
  "spider",
  "slurp",
  "curl/",
  "wget/",
  "python-requests",
  "httpx",
  "axios/",
  "go-http-client",
  "java/",
  "okhttp",
  "headlesschrome",
  "facebookexternalhit",
  "discordbot",
  "slackbot",
  "telegrambot",
  "whatsapp",
  "twitterbot",
  "linkedinbot",
  "embedly",
  "preview",
  "monitoring",
  "uptime",
  "pingdom",
  "lighthouse",
];

// Ordered: the first match wins, so impersonators must come before the
// browser they impersonate.
const BROWSERS: Array<[RegExp, string]> = [
  [/edg(?:e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/vivaldi/i, "Vivaldi"],
  [/brave/i, "Brave"],
  [/samsungbrowser/i, "Samsung Internet"],
  [/ucbrowser/i, "UC Browser"],
  [/yabrowser/i, "Yandex"],
  [/firefox\/|fxios\//i, "Firefox"],
  [/chrome\/|crios\//i, "Chrome"],
  [/safari\//i, "Safari"],
];

const OSES: Array<[RegExp, string]> = [
  [/windows nt 10|windows nt 11/i, "Windows"],
  [/windows/i, "Windows"],
  [/android/i, "Android"],
  [/(iphone|ipad|ipod)/i, "iOS"],
  [/mac os x|macintosh/i, "macOS"],
  [/cros/i, "ChromeOS"],
  [/fedora/i, "Fedora"],
  [/ubuntu/i, "Ubuntu"],
  [/linux/i, "Linux"],
  [/freebsd|openbsd|netbsd/i, "BSD"],
];

export function parseUserAgent(raw: string | undefined | null): UaInfo {
  const ua = (raw ?? "").slice(0, 512); // bound the work; UAs this long are junk
  if (ua.trim() === "") {
    return { browser: "Unknown", os: "Unknown", device: "bot" };
  }

  const lower = ua.toLowerCase();

  if (BOT_PATTERNS.some((p) => lower.includes(p))) {
    return { browser: botName(lower), os: "—", device: "bot" };
  }

  let browser = "Other";
  for (const [re, name] of BROWSERS) {
    if (re.test(ua)) {
      browser = name;
      break;
    }
  }

  let os = "Other";
  for (const [re, name] of OSES) {
    if (re.test(ua)) {
      os = name;
      break;
    }
  }

  const device: DeviceKind = /ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)
    ? "tablet"
    : /mobi|iphone|ipod|android|phone|iemobile/i.test(ua)
    ? "mobile"
    : "desktop";

  return { browser, os, device };
}

/** Name the well-known crawlers so the dashboard shows something useful. */
function botName(lower: string): string {
  const known: Array<[string, string]> = [
    ["googlebot", "Googlebot"],
    ["bingbot", "Bingbot"],
    ["duckduckbot", "DuckDuckBot"],
    ["yandexbot", "YandexBot"],
    ["baiduspider", "Baiduspider"],
    ["applebot", "Applebot"],
    ["discordbot", "Discord"],
    ["slackbot", "Slack"],
    ["telegrambot", "Telegram"],
    ["whatsapp", "WhatsApp"],
    ["twitterbot", "Twitter"],
    ["facebookexternalhit", "Facebook"],
    ["linkedinbot", "LinkedIn"],
    ["curl/", "curl"],
    ["wget/", "wget"],
    ["python-requests", "python-requests"],
    ["go-http-client", "Go client"],
  ];
  for (const [needle, name] of known) if (lower.includes(needle)) return name;
  return "Bot";
}

/**
 * Best-effort country, in order of trust:
 *  1. a header set by the reverse proxy / CDN (authoritative, GeoIP-backed)
 *  2. the region subtag of Accept-Language (a hint, not a location)
 *
 * We deliberately ship no GeoIP database: it would be a large binary blob to
 * keep updated, and turning an IP into a location is exactly the processing
 * the daily-salt design is trying to avoid.
 */
export function detectCountry(headers: Headers): string | null {
  const fromProxy = headers.get("cf-ipcountry") ??
    headers.get("x-vercel-ip-country") ??
    headers.get("x-country-code") ??
    headers.get("x-geo-country");
  if (fromProxy && /^[A-Za-z]{2}$/.test(fromProxy) && fromProxy.toUpperCase() !== "XX") {
    return fromProxy.toUpperCase();
  }

  const lang = headers.get("accept-language");
  if (lang) {
    const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(lang.trim());
    if (m) return m[1]!.toUpperCase();
  }
  return null;
}

/** Primary language tag, e.g. `fr` from `fr-FR,fr;q=0.9,en;q=0.8`. */
export function detectLanguage(headers: Headers): string | null {
  const lang = headers.get("accept-language");
  if (!lang) return null;
  const m = /^([a-zA-Z]{2,3})\b/.exec(lang.trim());
  return m ? m[1]!.toLowerCase() : null;
}
