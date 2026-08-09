/**
 * Application logic shared by the HTML dashboard and the JSON API.
 *
 * Both entry points must apply exactly the same validation — duplicating these
 * rules per route is how a shortener ends up with an unvalidated back door.
 */

import type { Context } from "hono";
import type { Config } from "./config.ts";
import type { ClickInsert, LinkRow, Store } from "./db.ts";
import { channelById, isChannelId } from "./util/channel.ts";
import { generateSlug, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, visitorId } from "./util/crypto.ts";
import { referrerHost, validateTarget } from "./util/target-url.ts";
import { detectCountry, detectLanguage, parseUserAgent } from "./util/user-agent.ts";

/** Paths the router owns. A link on one of these would be unreachable. */
export const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "assets",
  "dashboard",
  "favicon.ico",
  "health",
  "login",
  "logout",
  "robots.txt",
  "shorten",
  "static",
  "sitemap.xml",
  ".well-known",
]);

const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

export function validateSlug(slug: string): Result<string> {
  const s = slug.trim();
  if (s.length < SLUG_MIN_LENGTH || s.length > SLUG_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `The slug must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters.`,
    };
  }
  if (!SLUG_PATTERN.test(s)) {
    return {
      ok: false,
      status: 400,
      error: "The slug may only contain letters, digits, hyphens and underscores.",
    };
  }
  if (RESERVED_SLUGS.has(s.toLowerCase())) {
    return { ok: false, status: 409, error: `"${s}" is reserved by the application.` };
  }
  return { ok: true, value: s };
}

/** Parses a `YYYY-MM-DD` form value into an end-of-day UTC timestamp. */
export function parseExpiry(raw: string | undefined | null): Result<number | null> {
  const v = (raw ?? "").trim();
  if (v === "") return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return { ok: false, status: 400, error: "Expiry must be a date in YYYY-MM-DD form." };
  }
  const ts = Date.parse(`${v}T23:59:59Z`);
  if (Number.isNaN(ts)) {
    return { ok: false, status: 400, error: "Expiry is not a real date." };
  }
  if (ts < Date.now()) {
    return { ok: false, status: 400, error: "Expiry is in the past." };
  }
  return { ok: true, value: Math.floor(ts / 1000) };
}

export interface CreateInput {
  target: string;
  slug?: string | null;
  note?: string | null;
  expiresAt?: number | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  channel?: string | null;
}

/**
 * Validates a declared channel against the known list.
 *
 * An unknown id is rejected rather than stored as-is: the value drives grouping
 * in the dashboard, and a typo would quietly split one network's numbers across
 * two rows. Blank means "unattributed", which is a legitimate answer.
 */
export function normaliseChannel(raw: string | null | undefined): Result<string | null> {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { ok: true, value: null };
  if (!isChannelId(v)) {
    return { ok: false, status: 400, error: `"${v}" is not a known channel.` };
  }
  return { ok: true, value: v };
}

export function createLink(store: Store, config: Config, input: CreateInput): Result<LinkRow> {
  const check = validateTarget(input.target, {
    allowPrivate: config.allowPrivateTargets,
    selfOrigin: config.baseOrigin,
  });
  if (!check.ok) return { ok: false, status: 400, error: check.error };

  const og = normaliseOpenGraph(input, config);
  if (!og.ok) return og;

  const channel = normaliseChannel(input.channel);
  if (!channel.ok) return channel;

  const note = (input.note ?? "").trim().slice(0, 280) || null;
  const common = {
    target: check.url,
    note,
    expiresAt: input.expiresAt ?? null,
    channel: channel.value,
    ...og.value,
  };

  if (input.slug) {
    const slugCheck = validateSlug(input.slug);
    if (!slugCheck.ok) return slugCheck;
    if (store.slugExists(slugCheck.value)) {
      return { ok: false, status: 409, error: `The slug "${slugCheck.value}" is already taken.` };
    }
    return { ok: true, value: store.createLink({ slug: slugCheck.value, ...common }) };
  }

  // A declared channel marks the generated slug, so `/twA8f3k` is recognisable
  // at a glance in a tweet. A custom slug above is left exactly as typed — the
  // prefix is a convenience for the generator, not a naming rule to enforce.
  const prefix = channelById(channel.value)?.prefix ?? "";

  // Random slug: retry on collision, widening the alphabet space as we go.
  for (let attempt = 0; attempt < 8; attempt++) {
    const length = 7 + Math.floor(attempt / 3); // 7, 7, 7, 8, 8, 8, 9, 9
    const slug = generateSlug(length, prefix);
    if (RESERVED_SLUGS.has(slug.toLowerCase()) || store.slugExists(slug)) continue;
    return { ok: true, value: store.createLink({ slug, ...common }) };
  }
  return { ok: false, status: 503, error: "Could not allocate a free slug. Try again." };
}

// --- Open Graph ---------------------------------------------------------------

/** Platforms truncate well before these; the caps just bound what we store. */
export const OG_TITLE_MAX = 120;
export const OG_DESCRIPTION_MAX = 300;

export interface OpenGraphFields {
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
}

/**
 * Trims the card fields and validates the image URL.
 *
 * The image is fetched by the crawler, not by us, so this is not an SSRF
 * boundary — but the same scheme allowlist applies, because a `javascript:`
 * value emitted into a meta tag is something we should never produce.
 */
export function normaliseOpenGraph(
  input: { ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null },
  config: Config,
): Result<OpenGraphFields> {
  const title = (input.ogTitle ?? "").trim().slice(0, OG_TITLE_MAX) || null;
  const description = (input.ogDescription ?? "").trim().slice(0, OG_DESCRIPTION_MAX) || null;

  const rawImage = (input.ogImage ?? "").trim();
  let image: string | null = null;
  if (rawImage !== "") {
    const check = validateTarget(rawImage, { allowPrivate: config.allowPrivateTargets });
    if (!check.ok) return { ok: false, status: 400, error: `Card image: ${check.error}` };
    image = check.url;
  }

  return { ok: true, value: { ogTitle: title, ogDescription: description, ogImage: image } };
}

export type LinkState = "ok" | "missing" | "disabled" | "expired";

export function linkState(link: LinkRow | undefined): LinkState {
  if (!link) return "missing";
  if (link.disabled) return "disabled";
  if (link.expires_at && link.expires_at <= Math.floor(Date.now() / 1000)) return "expired";
  return "ok";
}

// --- Analytics ----------------------------------------------------------------

/**
 * Client IP.
 *
 * X-Forwarded-For is only consulted when TRUST_PROXY is on. Reading it
 * unconditionally would let anyone spoof their address by sending the header,
 * which defeats both rate limiting and unique-visitor counting.
 */
export function clientIp(c: Context, config: Config): string {
  if (config.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = c.req.header("x-real-ip");
    if (real) return real.trim();
  }
  // Hono passes Deno's ServeHandlerInfo through as `env`.
  const info = c.env as { remote?: { hostname?: string } } | undefined;
  return info?.remote?.hostname ?? "0.0.0.0";
}

export function buildClick(c: Context, config: Config, store: Store, linkId: number): ClickInsert {
  const ua = c.req.header("user-agent") ?? "";
  const parsed = parseUserAgent(ua);
  const headers = c.req.raw.headers;

  return {
    link_id: linkId,
    ts: Math.floor(Date.now() / 1000),
    visitor: visitorId(store.dailySalt(), clientIp(c, config), ua),
    referrer_host: referrerHost(headers.get("referer")),
    country: detectCountry(headers),
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    lang: detectLanguage(headers),
  };
}

// --- CSV ----------------------------------------------------------------------

/**
 * RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would
 * treat as a formula — a referrer of `=cmd|'/c calc'!A1` should not execute
 * when the export is opened in Excel.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const cell = (v: unknown): string => {
    // Every field is quoted, including empty ones, so the output parses the
    // same way in every tool and stays easy to eyeball.
    if (v === null || v === undefined) return '""';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [columns.map(cell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => cell(row[col])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
