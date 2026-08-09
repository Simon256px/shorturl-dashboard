/**
 * Publication channels — where *you* posted a link, as opposed to where a
 * visitor came from.
 *
 * Those are two different facts, and keeping them apart is the whole point of
 * this module:
 *
 *  - `links.channel` is declared by you at creation time. It is exact.
 *  - `clicks.referrer_host` is whatever the browser chose to send. On Twitter it
 *    arrives as `t.co` when it arrives at all — the mobile apps send no Referer,
 *    and neither do most desktop clients for a link opened from a DM. Attributing
 *    by referrer alone therefore under-counts, silently and unevenly per network.
 *
 * So the declared channel is the number you plan with, and the referrer is a
 * cross-check: it tells you when a link is getting traffic from somewhere you
 * never published it, which usually means someone reshared it.
 */

export interface Channel {
  /** Stored verbatim in `links.channel`. Renaming one would orphan old rows. */
  id: string;
  label: string;
  /**
   * Prepended to generated slugs, so the network is legible in the URL itself.
   *
   * Two characters, and deliberately drawn from the readable subset of the slug
   * alphabet — no `0`/`O`/`I`/`l`, same reasoning as `SLUG_ALPHABET`: these get
   * read aloud and typed by hand.
   */
  prefix: string;
  /**
   * Referrer hosts that mean this channel. Matched on the exact host or on any
   * subdomain of it, which is what catches `www.youtube.com` and Instagram's
   * `l.instagram.com` link shim without listing every variant.
   */
  hosts: string[];
  icon: string;
}

/** Ordered as shown in the dashboard: most-used first. */
export const CHANNELS: readonly Channel[] = [
  {
    id: "twitter",
    label: "X / Twitter",
    prefix: "tw",
    icon: "𝕏",
    hosts: ["x.com", "twitter.com", "t.co"],
  },
  { id: "youtube", label: "YouTube", prefix: "yt", icon: "▶", hosts: ["youtube.com", "youtu.be"] },
  {
    id: "discord",
    label: "Discord",
    prefix: "dc",
    icon: "💬",
    hosts: ["discord.com", "discord.gg", "discordapp.com"],
  },
  { id: "instagram", label: "Instagram", prefix: "ig", icon: "📷", hosts: ["instagram.com"] },
  { id: "github", label: "GitHub", prefix: "gh", icon: "🐙", hosts: ["github.com", "github.io"] },
  { id: "tiktok", label: "TikTok", prefix: "tt", icon: "🎵", hosts: ["tiktok.com"] },
  {
    id: "linkedin",
    label: "LinkedIn",
    prefix: "in",
    icon: "💼",
    hosts: ["linkedin.com", "lnkd.in"],
  },
  { id: "reddit", label: "Reddit", prefix: "rd", icon: "👽", hosts: ["reddit.com", "redd.it"] },
  { id: "facebook", label: "Facebook", prefix: "fb", icon: "📘", hosts: ["facebook.com", "fb.me"] },
  { id: "newsletter", label: "Newsletter", prefix: "ne", icon: "✉", hosts: [] },
  { id: "website", label: "Website / blog", prefix: "ws", icon: "🌐", hosts: [] },
] as const;

const BY_ID = new Map(CHANNELS.map((ch) => [ch.id, ch]));

/**
 * Longest host first, so `github.io` cannot be shadowed by a shorter entry that
 * happens to be a suffix of it. With the current table no pair overlaps, but the
 * ordering makes adding one safe.
 */
const BY_HOST: ReadonlyArray<{ host: string; id: string }> = CHANNELS
  .flatMap((ch) => ch.hosts.map((host) => ({ host, id: ch.id })))
  .sort((a, b) => b.host.length - a.host.length);

export function channelById(id: string | null | undefined): Channel | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function isChannelId(v: string): boolean {
  return BY_ID.has(v);
}

/** Label for display. `null` is a real, expected state: most links have none. */
export function channelLabel(id: string | null | undefined): string {
  return channelById(id)?.label ?? "Unattributed";
}

export function channelIcon(id: string | null | undefined): string {
  return channelById(id)?.icon ?? "•";
}

/** `𝕏 X / Twitter`, ready to drop into a chart label. */
export function channelDisplay(id: string | null | undefined): string {
  return `${channelIcon(id)} ${channelLabel(id)}`;
}

/**
 * Which channel a referrer host belongs to, or `null` when it is not a network
 * we know — a blog, a search engine, or traffic we simply cannot place.
 *
 * `null` here means "unrecognised", which is not the same as the `null` stored
 * in `links.channel` ("not declared"). The dashboard labels them differently.
 */
export function channelFromReferrer(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.toLowerCase();
  for (const entry of BY_HOST) {
    if (h === entry.host || h.endsWith(`.${entry.host}`)) return entry.id;
  }
  return null;
}

/** A channel inferred from referrers. `channel: null` = hosts we don't recognise. */
export interface DetectedChannel {
  channel: string | null;
  clicks: number;
}

/**
 * Folds referrer-host counts into channels.
 *
 * Done here rather than in SQL because the host-to-channel mapping is this
 * table, not something the database should learn: adding a network then means
 * editing one array instead of writing a migration.
 */
export function foldReferrers(hosts: Array<{ label: string; value: number }>): DetectedChannel[] {
  const totals = new Map<string | null, number>();
  for (const { label, value } of hosts) {
    const id = channelFromReferrer(label);
    totals.set(id, (totals.get(id) ?? 0) + value);
  }
  return [...totals]
    .map(([channel, clicks]) => ({ channel, clicks }))
    .sort((a, b) => b.clicks - a.clicks);
}
