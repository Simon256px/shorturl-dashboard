/**
 * Publication channels: the host→channel mapping, the declared/detected split,
 * slug prefixing, and the per-channel aggregation.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { Store } from "../src/db.ts";
import { createLink, normaliseChannel } from "../src/service.ts";
import {
  channelFromReferrer,
  channelLabel,
  CHANNELS,
  foldReferrers,
  isChannelId,
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

// --- The channel table --------------------------------------------------------

Deno.test("channel ids, prefixes and hosts are internally consistent", () => {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  const hosts = new Set<string>();

  for (const ch of CHANNELS) {
    assertFalse(ids.has(ch.id), `duplicate channel id ${ch.id}`);
    ids.add(ch.id);

    // A shared prefix would make two networks indistinguishable in a URL, which
    // is the one thing the prefix exists to prevent.
    assertFalse(prefixes.has(ch.prefix), `duplicate prefix ${ch.prefix}`);
    prefixes.add(ch.prefix);

    // Same rule as SLUG_ALPHABET, which drops 0/O/I/l because slugs get read
    // aloud. Of those, only lowercase `l` can occur in a lowercase prefix.
    assert(/^[a-z]{2}$/.test(ch.prefix), `prefix ${ch.prefix} is not two lowercase letters`);
    assertFalse(ch.prefix.includes("l"), `prefix ${ch.prefix} contains an ambiguous glyph`);

    for (const host of ch.hosts) {
      assertFalse(hosts.has(host), `host ${host} claimed twice`);
      hosts.add(host);
      assertEquals(host, host.toLowerCase(), "hosts must be stored lowercase");
    }
  }
});

Deno.test("channelFromReferrer matches exact hosts and subdomains only", () => {
  assertEquals(channelFromReferrer("t.co"), "twitter");
  assertEquals(channelFromReferrer("x.com"), "twitter");
  assertEquals(channelFromReferrer("twitter.com"), "twitter");
  assertEquals(channelFromReferrer("www.youtube.com"), "youtube");
  assertEquals(channelFromReferrer("youtu.be"), "youtube");

  // Instagram and Facebook route outbound links through a shim subdomain.
  assertEquals(channelFromReferrer("l.instagram.com"), "instagram");
  assertEquals(channelFromReferrer("lm.facebook.com"), "facebook");

  assertEquals(channelFromReferrer("Discord.COM"), "discord", "matching must be case-insensitive");

  // Not a subdomain — a lookalike domain must not inherit the mapping.
  assertEquals(channelFromReferrer("notx.com"), null);
  assertEquals(channelFromReferrer("x.com.evil.net"), null);
  assertEquals(channelFromReferrer("news.example.com"), null);
  assertEquals(channelFromReferrer(null), null);
  assertEquals(channelFromReferrer(""), null);
});

Deno.test("foldReferrers sums hosts into channels and keeps the unknown bucket", () => {
  const folded = foldReferrers([
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

  assertEquals(foldReferrers([]), []);
});

Deno.test("channelLabel names the unattributed case instead of returning empty", () => {
  assertEquals(channelLabel("twitter"), "X / Twitter");
  assertEquals(channelLabel(null), "Unattributed");
  assertEquals(channelLabel("nope"), "Unattributed");
  assert(isChannelId("twitter"));
  assertFalse(isChannelId("Twitter"), "ids are lowercase; validation must not be lenient");
});

// --- Validation ---------------------------------------------------------------

Deno.test("normaliseChannel accepts known ids, blank, and rejects the rest", () => {
  assertEquals(normaliseChannel("twitter"), { ok: true, value: "twitter" });
  assertEquals(normaliseChannel("  TWITTER "), { ok: true, value: "twitter" });
  assertEquals(normaliseChannel(""), { ok: true, value: null });
  assertEquals(normaliseChannel("   "), { ok: true, value: null });
  assertEquals(normaliseChannel(null), { ok: true, value: null });
  assertEquals(normaliseChannel(undefined), { ok: true, value: null });

  // A typo must not become a new grouping key.
  const bad = normaliseChannel("twiter");
  assertFalse(bad.ok);
  if (!bad.ok) assertEquals(bad.status, 400);
});

// --- Slug prefixing -----------------------------------------------------------

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
