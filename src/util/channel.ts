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
 *
 * The channel list lives in the `channels` table, editable from the dashboard.
 * The seeds below are only what a fresh database starts with — nothing in the
 * code special-cases them afterwards, so a seeded row can be renamed or deleted
 * exactly like one you added.
 */

export interface ChannelRow {
  /** Derived from the label at creation. Stored in `links.channel`. */
  id: string;
  label: string;
  /**
   * Prepended to generated slugs, so the network is legible in the URL itself.
   *
   * Lowercase letters only, and `l` is excluded for the same reason
   * `SLUG_ALPHABET` drops `0`/`O`/`I`/`l`: slugs get read aloud and typed by hand.
   */
  prefix: string;
  icon: string;
  /**
   * Referrer hosts that mean this channel. Matched on the exact host or on any
   * subdomain of it, which is what catches `www.youtube.com` and Instagram's
   * `l.instagram.com` link shim without listing every variant.
   */
  hosts: string[];
  sort_order: number;
}

export const PREFIX_MIN = 2;
export const PREFIX_MAX = 3;
export const LABEL_MAX = 40;
export const ICON_MAX_GRAPHEMES = 2;
export const HOSTS_MAX = 12;

/** What a fresh database starts with. Not privileged: editable and deletable. */
export const CHANNEL_SEEDS: ReadonlyArray<Omit<ChannelRow, "sort_order">> = [
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
    id: "pinterest",
    label: "Pinterest",
    prefix: "pn",
    icon: "📌",
    hosts: ["pinterest.com", "pinterest.fr", "pin.it"],
  },
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
];

/** A channel inferred from referrers. `channel: null` = hosts we don't recognise. */
export interface DetectedChannel {
  channel: string | null;
  clicks: number;
}

/**
 * An immutable view over the channel table, built once per request.
 *
 * Lookups need the whole list, and the list is now user data rather than a
 * constant — bundling them here keeps every caller honest about the fact that
 * it has to be loaded, instead of importing a global that could be stale.
 */
export class ChannelSet {
  readonly all: readonly ChannelRow[];
  readonly #byId: Map<string, ChannelRow>;
  /** Longest host first, so a longer entry cannot be shadowed by its own suffix. */
  readonly #byHost: ReadonlyArray<{ host: string; id: string }>;

  constructor(rows: readonly ChannelRow[]) {
    this.all = [...rows].sort((a, b) => a.sort_order - b.sort_order);
    this.#byId = new Map(this.all.map((c) => [c.id, c]));
    this.#byHost = this.all
      .flatMap((c) => c.hosts.map((host) => ({ host, id: c.id })))
      .sort((a, b) => b.host.length - a.host.length);
  }

  get(id: string | null | undefined): ChannelRow | undefined {
    return id ? this.#byId.get(id) : undefined;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** `null` is a real, expected state: a link need not declare anything. */
  label(id: string | null | undefined): string {
    return this.get(id)?.label ?? "Unattributed";
  }

  icon(id: string | null | undefined): string {
    return this.get(id)?.icon ?? "•";
  }

  /** `𝕏 X / Twitter`, ready to drop into a chart label. */
  display(id: string | null | undefined): string {
    return `${this.icon(id)} ${this.label(id)}`;
  }

  /**
   * Which channel a referrer host belongs to, or `null` when it is not a network
   * in the table — a blog, a search engine, or traffic we cannot place.
   *
   * `null` here means "unrecognised", which is not the same as the `null` stored
   * in `links.channel` ("not declared"). The dashboard labels them differently.
   */
  fromReferrer(host: string | null | undefined): string | null {
    if (!host) return null;
    const h = host.toLowerCase();
    for (const entry of this.#byHost) {
      if (h === entry.host || h.endsWith(`.${entry.host}`)) return entry.id;
    }
    return null;
  }

  /**
   * Folds referrer-host counts into channels.
   *
   * Done here rather than in SQL because the host-to-channel mapping is user
   * data that changes without a migration; teaching the query about it would
   * mean rewriting the query every time a row is edited.
   */
  foldReferrers(hosts: Array<{ label: string; value: number }>): DetectedChannel[] {
    const totals = new Map<string | null, number>();
    for (const { label, value } of hosts) {
      const id = this.fromReferrer(label);
      totals.set(id, (totals.get(id) ?? 0) + value);
    }
    return [...totals]
      .map(([channel, clicks]) => ({ channel, clicks }))
      .sort((a, b) => b.clicks - a.clicks);
  }
}

// --- Validation ---------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Turns a label into a stable id: `"Website / blog"` → `"website-blog"`.
 *
 * Diacritics are folded rather than stripped, so `"Café"` becomes `"cafe"` and
 * not `"caf"`. The id is a database key and never shown, which is why it can be
 * this aggressive about what it keeps.
 */
export function deriveChannelId(label: string): Validated<string> {
  const id = label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (id === "") {
    return { ok: false, error: "The name needs at least one letter or digit." };
  }
  return { ok: true, value: id };
}

export function validateLabel(raw: string): Validated<string> {
  const label = raw.trim().replace(/\s+/g, " ");
  if (label === "") return { ok: false, error: "A name is required." };
  if (label.length > LABEL_MAX) {
    return { ok: false, error: `The name must be at most ${LABEL_MAX} characters.` };
  }
  return { ok: true, value: label };
}

export function validatePrefix(raw: string): Validated<string> {
  const prefix = raw.trim().toLowerCase();
  if (!new RegExp(`^[a-z]{${PREFIX_MIN},${PREFIX_MAX}}$`).test(prefix)) {
    return {
      ok: false,
      error: `The prefix must be ${PREFIX_MIN} to ${PREFIX_MAX} lowercase letters.`,
    };
  }
  if (prefix.includes("l")) {
    return {
      ok: false,
      error: "The prefix cannot contain the letter l — it is unreadable next to 1 in a slug.",
    };
  }
  return { ok: true, value: prefix };
}

/**
 * One or two graphemes, counted properly.
 *
 * A flag or a skin-toned emoji is several code points; `.length` would reject
 * 🇫🇷 as four characters and let a whole word through as five.
 */
export function validateIcon(raw: string): Validated<string> {
  const icon = raw.trim();
  if (icon === "") return { ok: false, error: "An icon is required (an emoji works well)." };
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(icon)].length;
  if (graphemes > ICON_MAX_GRAPHEMES) {
    return { ok: false, error: `The icon must be at most ${ICON_MAX_GRAPHEMES} characters.` };
  }
  return { ok: true, value: icon };
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Parses the hosts textarea.
 *
 * Forgiving on input because people paste what they have: a full URL, a leading
 * `www.`, a trailing slash, comma- or newline-separated. Strict on output —
 * whatever is stored is a bare lowercase hostname, since that is what
 * `clicks.referrer_host` holds and the two have to be comparable.
 */
export function normaliseHosts(raw: string): Validated<string[]> {
  const out: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    let host = piece.trim().toLowerCase();
    if (host === "") continue;

    // Accept a pasted URL, and anything with a path or port glued on.
    host = host.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
    // A leading `www.` would only ever be redundant: subdomains already match.
    host = host.replace(/^www\./, "");
    if (host === "") continue;

    if (!HOSTNAME.test(host)) {
      return { ok: false, error: `"${piece.trim()}" is not a valid hostname.` };
    }
    if (!out.includes(host)) out.push(host);
  }
  if (out.length > HOSTS_MAX) {
    return { ok: false, error: `At most ${HOSTS_MAX} hosts per channel.` };
  }
  return { ok: true, value: out };
}

/** Round-trips through the `channels.hosts` column, which is newline-delimited. */
export function packHosts(hosts: string[]): string {
  return hosts.join("\n");
}

export function unpackHosts(packed: string): string[] {
  return packed.split("\n").map((h) => h.trim()).filter((h) => h !== "");
}
