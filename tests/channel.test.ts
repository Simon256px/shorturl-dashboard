/**
 * Publication channels: the host→channel mapping, the declared/detected split,
 * slug prefixing, the per-channel aggregation, and managing the table itself.
 */

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { Store } from "../src/db.ts";
import { createLink, normaliseChannel } from "../src/service.ts";
import {
  CHANNEL_SEEDS,
  ChannelSet,
  deriveChannelId,
  normaliseHosts,
  packHosts,
  unpackHosts,
  validateIcon,
  validateLabel,
  validatePrefix,
} from "../src/util/channel.ts";
import { generateSlug } from "../src/util/crypto.ts";
import type { Config } from "../src/config.ts";

const cfg = {
  allowPrivateTargets: false,
  baseOrigin: "https://s.example.com",
} as Config;

function freshStore(): Store {
  return new Store(":memory:");
}

/** The seeded table, which is what a fresh install actually serves. */
function seededSet(store: Store): ChannelSet {
  return new ChannelSet(store.listChannels());
}

function seedClick(store: Store, linkId: number, referrer: string | null, visitor = "v0000001") {
  store.recordClick({
    link_id: linkId,
    ts: Math.floor(Date.now() / 1000),
    visitor,
    referrer_host: referrer,
    country: "FR",
    browser: "Firefox",
    os: "Fedora",
    device: "desktop",
    lang: "fr",
  });
}

// --- The seeded table ---------------------------------------------------------

Deno.test("seeded channels are internally consistent", () => {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  const hosts = new Set<string>();

  for (const ch of CHANNEL_SEEDS) {
    assertFalse(ids.has(ch.id), `duplicate channel id ${ch.id}`);
    ids.add(ch.id);

    // A shared prefix would make two networks indistinguishable in a URL, which
    // is the one thing the prefix exists to prevent. The column is UNIQUE, so a
    // clash here would fail the migration outright.
    assertFalse(prefixes.has(ch.prefix), `duplicate prefix ${ch.prefix}`);
    prefixes.add(ch.prefix);

    assert(validatePrefix(ch.prefix).ok, `seed prefix ${ch.prefix} fails its own validator`);
    assert(validateLabel(ch.label).ok, `seed label ${ch.label} fails its own validator`);
    assert(validateIcon(ch.icon).ok, `seed icon ${ch.icon} fails its own validator`);

    // The id is an opaque, frozen key — deliberately *not* re-derived from the
    // label, so renaming a channel relabels its history instead of orphaning it.
    // `twitter` keeping its id under the name "X / Twitter" is the point. What it
    // does have to be is URL-safe, since it appears in ?channel= and in a path.
    assert(/^[a-z0-9-]+$/.test(ch.id), `id ${ch.id} is not URL-safe`);
    assertEquals(ch.id, encodeURIComponent(ch.id));

    for (const host of ch.hosts) {
      assertFalse(hosts.has(host), `host ${host} claimed twice`);
      hosts.add(host);
      assertEquals(host, host.toLowerCase(), "hosts must be stored lowercase");
    }
  }
});

Deno.test("a fresh database is seeded with every default channel", () => {
  const store = freshStore();
  try {
    const set = seededSet(store);
    assertEquals(set.all.length, CHANNEL_SEEDS.length);
    assert(set.has("pinterest"), "Pinterest should ship by default");
    assertEquals(set.get("pinterest")!.prefix, "pn");

    // Seed order is preserved, because it is the order of the create menu.
    assertEquals(set.all.map((c) => c.id), CHANNEL_SEEDS.map((c) => c.id));
  } finally {
    store.close();
  }
});

// --- Referrer mapping ---------------------------------------------------------

Deno.test("fromReferrer matches exact hosts and subdomains only", () => {
  const store = freshStore();
  try {
    const set = seededSet(store);
    assertEquals(set.fromReferrer("t.co"), "twitter");
    assertEquals(set.fromReferrer("x.com"), "twitter");
    assertEquals(set.fromReferrer("www.youtube.com"), "youtube");
    assertEquals(set.fromReferrer("youtu.be"), "youtube");
    assertEquals(set.fromReferrer("pin.it"), "pinterest");
    assertEquals(set.fromReferrer("fr.pinterest.com"), "pinterest");

    // Instagram and Facebook route outbound links through a shim subdomain.
    assertEquals(set.fromReferrer("l.instagram.com"), "instagram");
    assertEquals(set.fromReferrer("lm.facebook.com"), "facebook");

    assertEquals(set.fromReferrer("Discord.COM"), "discord", "matching must be case-insensitive");

    // Not a subdomain — a lookalike domain must not inherit the mapping.
    assertEquals(set.fromReferrer("notx.com"), null);
    assertEquals(set.fromReferrer("x.com.evil.net"), null);
    assertEquals(set.fromReferrer("news.example.com"), null);
    assertEquals(set.fromReferrer(null), null);
    assertEquals(set.fromReferrer(""), null);
  } finally {
    store.close();
  }
});

Deno.test("foldReferrers sums hosts into channels and keeps the unknown bucket", () => {
  const store = freshStore();
  try {
    const folded = seededSet(store).foldReferrers([
      { label: "t.co", value: 10 },
      { label: "x.com", value: 5 },
      { label: "blog.example.com", value: 4 },
      { label: "news.example.org", value: 3 },
      { label: "youtu.be", value: 2 },
    ]);

    // Twitter's two hosts collapse into one row of 15, which is the whole point.
    assertEquals(folded[0], { channel: "twitter", clicks: 15 });
    // Unrecognised hosts are pooled under null rather than dropped.
    assertEquals(folded[1], { channel: null, clicks: 7 });
    assertEquals(folded[2], { channel: "youtube", clicks: 2 });
    assertEquals(folded.length, 3);

    assertEquals(seededSet(store).foldReferrers([]), []);
  } finally {
    store.close();
  }
});

Deno.test("a set reflects edits, so detection follows the table", () => {
  const store = freshStore();
  try {
    // Nothing knows about Bluesky until it is added.
    assertEquals(seededSet(store).fromReferrer("bsky.app"), null);

    store.createChannel({
      id: "bluesky",
      label: "Bluesky",
      prefix: "bs",
      icon: "🦋",
      hosts: ["bsky.app"],
    });
    assertEquals(seededSet(store).fromReferrer("bsky.app"), "bluesky");

    store.deleteChannel("bluesky");
    assertEquals(seededSet(store).fromReferrer("bsky.app"), null);
  } finally {
    store.close();
  }
});

Deno.test("label falls back to Unattributed rather than an empty string", () => {
  const store = freshStore();
  try {
    const set = seededSet(store);
    assertEquals(set.label("twitter"), "X / Twitter");
    assertEquals(set.label(null), "Unattributed");
    assertEquals(set.label("nope"), "Unattributed");
    assert(set.has("twitter"));
    assertFalse(set.has("Twitter"), "ids are lowercase; lookup must not be lenient");
  } finally {
    store.close();
  }
});

// --- Field validation ---------------------------------------------------------

Deno.test("deriveChannelId folds accents and punctuation into a stable key", () => {
  const id = (s: string) => {
    const r = deriveChannelId(s);
    return r.ok ? r.value : `ERR:${r.error}`;
  };
  assertEquals(id("Pinterest"), "pinterest");
  assertEquals(id("Website / blog"), "website-blog");
  assertEquals(id("  X / Twitter  "), "x-twitter");
  // Folded, not stripped: "Café" must not become "caf".
  assertEquals(id("Café"), "cafe");
  assertEquals(id("Ma Chaîne"), "ma-chaine");
  assertEquals(id("A—B"), "a-b");
  assertFalse(deriveChannelId("!!!").ok, "a name with no letters has no usable id");
  assertFalse(deriveChannelId("").ok);
});

Deno.test("validatePrefix enforces length and rejects the ambiguous letter", () => {
  assertEquals(validatePrefix("pn"), { ok: true, value: "pn" });
  assertEquals(validatePrefix(" PN "), { ok: true, value: "pn" });
  assertEquals(validatePrefix("abc"), { ok: true, value: "abc" });

  assertFalse(validatePrefix("a").ok, "one letter is too short");
  assertFalse(validatePrefix("abcd").ok, "four letters is too long");
  assertFalse(validatePrefix("p1").ok, "digits would blur into the random tail");
  assertFalse(validatePrefix("p-").ok);
  assertFalse(validatePrefix("").ok);
  // `l` next to `1` in a slug is exactly what SLUG_ALPHABET avoids.
  assertFalse(validatePrefix("li").ok);
  assertFalse(validatePrefix("bl").ok);
});

Deno.test("validateIcon counts graphemes, not code units", () => {
  assert(validateIcon("📌").ok);
  assert(validateIcon("𝕏").ok);
  // A flag is several code points but one glyph; .length would wrongly reject it.
  assert(validateIcon("🇫🇷").ok, "a flag emoji is one grapheme");
  assert(validateIcon("👍🏽").ok, "a skin-toned emoji is one grapheme");
  assert(validateIcon("ab").ok, "two characters is the documented maximum");

  assertFalse(validateIcon("abc").ok);
  assertFalse(validateIcon("").ok);
  assertFalse(validateIcon("   ").ok);
});

Deno.test("normaliseHosts is forgiving on input and strict on output", () => {
  const hosts = (s: string) => {
    const r = normaliseHosts(s);
    return r.ok ? r.value : `ERR:${r.error}`;
  };

  assertEquals(hosts("pinterest.com, pin.it"), ["pinterest.com", "pin.it"]);
  assertEquals(hosts("pinterest.com\npin.it"), ["pinterest.com", "pin.it"]);
  // A pasted URL, a port, a path and a www. prefix all reduce to the hostname.
  assertEquals(hosts("https://www.pinterest.com/pin/123?x=1"), ["pinterest.com"]);
  assertEquals(hosts("example.com:8443"), ["example.com"]);
  assertEquals(hosts("  MiXeD.Example.COM  "), ["mixed.example.com"]);
  // Duplicates collapse, including once normalisation makes them equal.
  assertEquals(hosts("pin.it, pin.it, www.pin.it"), ["pin.it"]);
  assertEquals(hosts(""), []);
  assertEquals(hosts("   "), []);

  assertFalse(normaliseHosts("not a host").ok);
  assertFalse(normaliseHosts("localhost").ok, "a single label has no dot and cannot be a referrer");
  assertFalse(normaliseHosts("-bad.com").ok);
  assertFalse(
    normaliseHosts(Array.from({ length: 13 }, (_, i) => `h${i}.example.com`).join(",")).ok,
    "too many hosts",
  );
});

Deno.test("hosts survive the round-trip through the packed column", () => {
  assertEquals(unpackHosts(packHosts(["a.com", "b.net"])), ["a.com", "b.net"]);
  assertEquals(unpackHosts(packHosts([])), []);
  assertEquals(unpackHosts(""), []);
});

// --- Declaring a channel on a link -------------------------------------------

Deno.test("normaliseChannel accepts known ids, blank, and rejects the rest", () => {
  const store = freshStore();
  try {
    const set = seededSet(store);
    assertEquals(normaliseChannel(set, "twitter"), { ok: true, value: "twitter" });
    assertEquals(normaliseChannel(set, "  TWITTER "), { ok: true, value: "twitter" });
    assertEquals(normaliseChannel(set, ""), { ok: true, value: null });
    assertEquals(normaliseChannel(set, null), { ok: true, value: null });
    assertEquals(normaliseChannel(set, undefined), { ok: true, value: null });

    const bad = normaliseChannel(set, "twiter");
    assertFalse(bad.ok);
    if (!bad.ok) assertEquals(bad.status, 400);
  } finally {
    store.close();
  }
});

Deno.test("generateSlug prepends the prefix without shortening the random part", () => {
  const plain = generateSlug(7);
  const prefixed = generateSlug(7, "tw");

  assertEquals(plain.length, 7);
  assertEquals(prefixed.length, 9, "the prefix must not eat into the random tail");
  assert(prefixed.startsWith("tw"));

  // The tail still spans the full alphabet, so entropy is unchanged.
  const tails = new Set(Array.from({ length: 40 }, () => generateSlug(7, "tw").slice(2)));
  assert(tails.size > 35, `random tails collided too often: ${tails.size}/40 unique`);
});

Deno.test("a declared channel prefixes the generated slug", () => {
  const store = freshStore();
  try {
    const made = createLink(store, cfg, {
      target: "https://example.com/launch",
      channel: "twitter",
    });
    assert(made.ok);
    if (!made.ok) return;

    assert(made.value.slug.startsWith("tw"), `expected a tw prefix, got ${made.value.slug}`);
    assertEquals(made.value.slug.length, 9);
    assertEquals(made.value.channel, "twitter");
  } finally {
    store.close();
  }
});

Deno.test("a channel added at runtime prefixes slugs like any other", () => {
  const store = freshStore();
  try {
    store.createChannel({
      id: "bluesky",
      label: "Bluesky",
      prefix: "bs",
      icon: "🦋",
      hosts: ["bsky.app"],
    });
    const made = createLink(store, cfg, { target: "https://example.com/x", channel: "bluesky" });
    assert(made.ok);
    if (!made.ok) return;
    assert(made.value.slug.startsWith("bs"), `got ${made.value.slug}`);
  } finally {
    store.close();
  }
});

Deno.test("a custom slug is stored verbatim even when a channel is declared", () => {
  const store = freshStore();
  try {
    const made = createLink(store, cfg, {
      target: "https://example.com/launch",
      slug: "launch-2026",
      channel: "twitter",
    });
    assert(made.ok);
    if (!made.ok) return;

    // The prefix helps the generator; it is not a naming rule imposed on you.
    assertEquals(made.value.slug, "launch-2026");
    assertEquals(made.value.channel, "twitter");
  } finally {
    store.close();
  }
});

Deno.test("no channel leaves both the slug and the column untouched", () => {
  const store = freshStore();
  try {
    const made = createLink(store, cfg, { target: "https://example.com/x" });
    assert(made.ok);
    if (!made.ok) return;

    assertEquals(made.value.slug.length, 7);
    assertEquals(made.value.channel, null);
  } finally {
    store.close();
  }
});

Deno.test("an unknown channel is refused before the link is created", () => {
  const store = freshStore();
  try {
    const made = createLink(store, cfg, {
      target: "https://example.com/x",
      channel: "myspace",
    });
    assertFalse(made.ok);
    if (!made.ok) assertEquals(made.status, 400);
    assertEquals(store.countLinks(), 0, "a rejected create must not leave a row behind");
  } finally {
    store.close();
  }
});

// --- Managing the table -------------------------------------------------------

Deno.test("createChannel appends in order and updateChannel edits in place", () => {
  const store = freshStore();
  try {
    const before = store.listChannels().length;
    const made = store.createChannel({
      id: "bluesky",
      label: "Bluesky",
      prefix: "bs",
      icon: "🦋",
      hosts: ["bsky.app"],
    });
    assertEquals(made.sort_order, before, "a new channel lands at the end of the menu");
    assertEquals(store.listChannels().at(-1)!.id, "bluesky");

    store.updateChannel("bluesky", { label: "Bluesky Social", icon: "☁" });
    const edited = store.getChannel("bluesky")!;
    assertEquals(edited.label, "Bluesky Social");
    assertEquals(edited.icon, "☁");
    assertEquals(edited.prefix, "bs", "an untouched field must not change");
    assertEquals(edited.hosts, ["bsky.app"]);

    store.updateChannel("bluesky", { hosts: [] });
    assertEquals(store.getChannel("bluesky")!.hosts, []);
  } finally {
    store.close();
  }
});

Deno.test("the prefix column is unique, and its owner can be identified", () => {
  const store = freshStore();
  try {
    assertEquals(store.channelPrefixOwner("tw"), "twitter");
    assertEquals(store.channelPrefixOwner("zz"), undefined);
    // An edit keeping its own prefix must not collide with itself.
    assertEquals(store.channelPrefixOwner("tw", "twitter"), undefined);

    assertThrows(
      () =>
        store.createChannel({
          id: "twitter-clone",
          label: "Twitter clone",
          prefix: "tw",
          icon: "🐦",
          hosts: [],
        }),
      Error,
      undefined,
      "a duplicate prefix must be refused by the database, not just the form",
    );
  } finally {
    store.close();
  }
});

Deno.test("deleting a channel detaches its links and keeps their clicks", () => {
  const store = freshStore();
  try {
    const base = { target: "https://example.com", note: null, expiresAt: null };
    const a = store.createLink({ ...base, slug: "tw00001", channel: "twitter" });
    store.createLink({ ...base, slug: "tw00002", channel: "twitter" });
    store.createLink({ ...base, slug: "yt00001", channel: "youtube" });

    seedClick(store, a.id, "t.co", "visitor00000001");
    store.flushClicks();

    const detached = store.deleteChannel("twitter");
    assertEquals(detached, 2, "the count of affected links is reported back");

    assertEquals(store.getChannel("twitter"), undefined);
    assertEquals(store.getLinkBySlug("tw00001")!.channel, null);
    assertEquals(store.getLinkBySlug("tw00002")!.channel, null);
    assertEquals(store.getLinkBySlug("yt00001")!.channel, "youtube", "other channels untouched");

    // The link, its slug and its history all survive — only the label went away.
    assertEquals(store.getLinkBySlug("tw00001")!.click_count, 1);
    assertEquals(store.clicksSince(7 * 86400, a.id).clicks, 1);

    // And the freed prefix becomes available again.
    assertEquals(store.channelPrefixOwner("tw"), undefined);
  } finally {
    store.close();
  }
});

Deno.test("deleting an unused channel reports zero detached links", () => {
  const store = freshStore();
  try {
    assertEquals(store.deleteChannel("tiktok"), 0);
    assertEquals(store.getChannel("tiktok"), undefined);
  } finally {
    store.close();
  }
});

Deno.test("countLinksByChannel omits unattributed links", () => {
  const store = freshStore();
  try {
    const base = { target: "https://example.com", note: null, expiresAt: null };
    store.createLink({ ...base, slug: "tw00001", channel: "twitter" });
    store.createLink({ ...base, slug: "tw00002", channel: "twitter" });
    store.createLink({ ...base, slug: "plain01" });

    const use = store.countLinksByChannel();
    assertEquals(use.get("twitter"), 2);
    assertEquals(use.get("youtube"), undefined);
    assertFalse(use.has(""), "a null channel must not become an empty-string key");
  } finally {
    store.close();
  }
});

// --- Storage ------------------------------------------------------------------

Deno.test("channel round-trips through create and update, and can be cleared", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "twabc12",
      target: "https://example.com",
      note: null,
      expiresAt: null,
      channel: "twitter",
    });
    assertEquals(link.channel, "twitter");

    store.updateLink(link.id, { channel: "youtube" });
    assertEquals(store.getLinkBySlug("twabc12")!.channel, "youtube");

    store.updateLink(link.id, { channel: null });
    assertEquals(store.getLinkBySlug("twabc12")!.channel, null);

    // An absent key must leave the column alone, not blank it.
    store.updateLink(link.id, { channel: "reddit" });
    store.updateLink(link.id, { note: "unrelated" });
    assertEquals(store.getLinkBySlug("twabc12")!.channel, "reddit");
  } finally {
    store.close();
  }
});

Deno.test("listLinks and countLinks filter by channel, including unattributed", () => {
  const store = freshStore();
  try {
    const base = { target: "https://example.com", note: null, expiresAt: null };
    store.createLink({ ...base, slug: "tw00001", channel: "twitter" });
    store.createLink({ ...base, slug: "tw00002", channel: "twitter" });
    store.createLink({ ...base, slug: "yt00001", channel: "youtube" });
    store.createLink({ ...base, slug: "plain01" });

    const list = (channel?: string) => store.listLinks({ limit: 50, offset: 0, channel });

    assertEquals(list().length, 4);
    assertEquals(list("twitter").length, 2);
    assertEquals(list("youtube").length, 1);
    assertEquals(list("none").length, 1, `"none" must select the unattributed links`);
    assertEquals(list("none")[0]!.slug, "plain01");

    // The count has to agree with the list, or the pager runs off the end.
    assertEquals(store.countLinks(undefined, "twitter"), 2);
    assertEquals(store.countLinks(undefined, "none"), 1);
    assertEquals(store.countLinks(), 4);

    // Search and channel compose rather than override each other.
    assertEquals(store.countLinks("tw00001", "twitter"), 1);
    assertEquals(store.countLinks("tw00001", "youtube"), 0);
  } finally {
    store.close();
  }
});

Deno.test("channelStats separates lifetime clicks from the window", () => {
  const store = freshStore();
  try {
    const base = { target: "https://example.com", note: null, expiresAt: null };
    const tw = store.createLink({ ...base, slug: "tw00001", channel: "twitter" });
    store.createLink({ ...base, slug: "tw00002", channel: "twitter" });
    const plain = store.createLink({ ...base, slug: "plain01" });

    seedClick(store, tw.id, "t.co", "visitor00000001");
    seedClick(store, tw.id, "t.co", "visitor00000002");
    seedClick(store, plain.id, null, "visitor00000003");
    store.flushClicks();

    const stats = store.channelStats(7 * 86400);
    const twitter = stats.find((s) => s.channel === "twitter")!;
    const none = stats.find((s) => s.channel === null)!;

    assertEquals(twitter.links, 2, "a channel with no clicks still counts as a link");
    assertEquals(twitter.recent, 2);
    assertEquals(twitter.visitors, 2);
    assertEquals(twitter.clicks, 2, "lifetime clicks come from the denormalised counter");

    assertEquals(none.links, 1);
    assertEquals(none.recent, 1);

    // Ordered by recent activity, so the busiest channel leads.
    assertEquals(stats[0]!.channel, "twitter");

    // Channels with no links at all are absent rather than listed as zeroes.
    assertFalse(stats.some((s) => s.channel === "tiktok"));
  } finally {
    store.close();
  }
});

Deno.test("channelStats counts lifetime clicks that fell outside the window", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "tw00003",
      target: "https://example.com",
      note: null,
      expiresAt: null,
      channel: "twitter",
    });
    // A click old enough to have been purged from `clicks` but still counted in
    // `links.click_count` — the asymmetry the dashboard has to report honestly.
    store.recordClick({
      link_id: link.id,
      ts: Math.floor(Date.now() / 1000) - 30 * 86400,
      visitor: "visitor00000009",
      referrer_host: "t.co",
      country: null,
      browser: "Firefox",
      os: "Fedora",
      device: "desktop",
      lang: null,
    });
    store.flushClicks();

    const twitter = store.channelStats(7 * 86400).find((s) => s.channel === "twitter")!;
    assertEquals(twitter.clicks, 1, "lifetime total keeps the old click");
    assertEquals(twitter.recent, 0, "the 7-day window does not");
    assertEquals(twitter.visitors, 0);
  } finally {
    store.close();
  }
});
