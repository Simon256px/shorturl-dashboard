/**
 * Validation of the URL a short link points at.
 *
 * A URL shortener is an open redirector by definition, which makes it an
 * attractive laundering tool. The rules below are the minimum that keeps the
 * service from being weaponised:
 *
 *  - scheme allowlist  → blocks `javascript:`, `data:`, `file:`, `vbscript:`
 *  - no embedded creds → blocks `https://user:pass@evil.tld` phishing bait
 *  - no private ranges → blocks CSRF against routers/printers on the visitor's
 *                        LAN and against cloud metadata endpoints (169.254.169.254)
 */

export const MAX_TARGET_LENGTH = 2048;

export type UrlCheck =
  | { ok: true; url: string; hostname: string }
  | { ok: false; error: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that resolve inside the machine or the local network. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
];
const BLOCKED_HOSTS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** True if the string holds any C0 control char, DEL, or a raw space. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function validateTarget(
  raw: string,
  opts: { allowPrivate?: boolean; selfOrigin?: string } = {},
): UrlCheck {
  const input = raw.trim();
  if (input === "") return { ok: false, error: "The destination URL is required." };
  if (input.length > MAX_TARGET_LENGTH) {
    return { ok: false, error: `The destination URL exceeds ${MAX_TARGET_LENGTH} characters.` };
  }
  // Control characters can smuggle a second header/line past naive consumers.
  if (hasControlChars(input)) {
    return { ok: false, error: "The destination URL contains control characters." };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "The destination is not a valid absolute URL (include https://)." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, error: `Only http:// and https:// are allowed (got ${url.protocol}).` };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "The destination URL must not embed credentials." };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "") return { ok: false, error: "The destination URL has no host." };

  // Refuse to shorten our own short links: trivially builds a redirect loop.
  if (opts.selfOrigin && url.origin === opts.selfOrigin) {
    return { ok: false, error: "The destination cannot be this shortener itself." };
  }

  if (!opts.allowPrivate) {
    if (BLOCKED_HOSTS.has(hostname)) {
      return { ok: false, error: "The destination points at the local machine." };
    }
    if (BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
      return { ok: false, error: "The destination points at a private network name." };
    }
    const ip = parseIpLiteral(hostname);
    if (ip && isPrivateAddress(ip)) {
      return { ok: false, error: "The destination points at a private or reserved IP address." };
    }
  }

  return { ok: true, url: url.toString(), hostname };
}

type ParsedIp =
  | { family: 4; bytes: number[] }
  | { family: 6; text: string };

/** Recognises the IP forms a URL hostname can legally take. */
export function parseIpLiteral(hostname: string): ParsedIp | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return { family: 6, text: hostname.slice(1, -1).toLowerCase() };
  }
  // The URL parser normalises IPv6 hosts without brackets in `hostname`.
  if (hostname.includes(":")) return { family: 6, text: hostname.toLowerCase() };

  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return { family: 4, bytes };
}

export function isPrivateAddress(ip: ParsedIp): boolean {
  if (ip.family === 4) {
    const [a, b] = ip.bytes as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8  "this network"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + TEST-NET-1
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  const t = ip.text;
  if (t === "::" || t === "::1") return true;
  if (t.startsWith("fe80") || t.startsWith("fec0")) return true; // link/site-local
  if (/^f[cd]/.test(t)) return true; // fc00::/7 unique-local
  if (t.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:10.0.0.1) — re-check the embedded v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (mapped) {
    const inner = parseIpLiteral(mapped[1]!);
    return inner ? isPrivateAddress(inner) : true;
  }
  return false;
}

/**
 * Referrers are stored as a bare host, never the full URL: query strings on the
 * referring page routinely carry session tokens and personal data we have no
 * business keeping.
 */
export function referrerHost(referer: string | undefined | null): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
