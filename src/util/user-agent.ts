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

/**
 * Agents that fetch a URL purely to build a link preview.
 *
 * Deliberately a named list rather than the broader `device === "bot"` bucket:
 * serving an HTML wrapper instead of a redirect changes what the caller gets,
 * so it should happen only for callers we can name. A `curl` script or an
 * uptime monitor keeps getting the plain 302 it asked for.
 *
 * The cost of the allowlist is that a brand-new platform shows the
 * destination's card until its agent is added here — a missing card, never a
 * broken link.
 */
const SOCIAL_CRAWLER_PATTERNS = [
  "discordbot",
  "twitterbot",
  "facebookexternalhit",
  "facebookcatalog",
  "slackbot",
  "slack-imgproxy",
  "linkedinbot",
  "telegrambot",
  "whatsapp",
  "skypeuripreview",
  "redditbot",
  "pinterest",
  "tumblr",
  "mastodon",
  "akkoma",
  "pleroma",
  "misskey",
  "bluesky",
  "embedly",
  "iframely",
  "quora link preview",
  "nuzzel",
  "vkshare",
  "flipboard",
  "outbrain",
  "applebot", // powers iMessage rich links
  "signal-desktop",
  "snapchat",
  "viber",
  "line-podcast",
  "developers.google.com/+/web/snippet", // Google+ era, still sent by some tools
  "google-inspectiontool",
];

/**
 * The subset of the crawlers above that reads /robots.txt before the page.
 *
 * `Disallow: /` for everyone is the right default for a shortener, but X and
 * LinkedIn honour it: they never fetch the wrapper, so a posted short link
 * shows no preview at all. Discord and Facebook ignore robots.txt, which is
 * why their embeds worked while X's did not.
 *
 * Naming them costs nothing in exposure. A preview crawler only ever visits a
 * slug someone already handed it, and there is no page here linking to others,
 * so the slug space stays unwalkable either way.
 *
 * Values are robots.txt product tokens; matching is case-insensitive.
 */
const ROBOTS_ALLOWED_CRAWLERS = [
  "Twitterbot",
  "facebookexternalhit",
  "LinkedInBot",
  "Slackbot",
  "Slackbot-LinkExpanding",
  "Applebot",
  "Discordbot",
  "TelegramBot",
  "WhatsApp",
  "redditbot",
  "Pinterestbot",
  "Mastodon",
];

/**
 * A crawler obeys the most specific group that names it and ignores the rest,
 * so the preview agents get `Allow: /` and everything else still gets the
 * blanket `Disallow: /`.
 */
export function robotsTxt(): string {
  const named = ROBOTS_ALLOWED_CRAWLERS.map((ua) => `User-agent: ${ua}`).join("\n");
  return `${named}\nAllow: /\n\nUser-agent: *\nDisallow: /\n`;
}

/**
 * True when the request is a link-preview crawler, i.e. something that will
 * read Open Graph tags rather than navigate a human.
 */
export function isSocialCrawler(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const lower = raw.slice(0, 512).toLowerCase();
  return SOCIAL_CRAWLER_PATTERNS.some((p) => lower.includes(p));
}

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
