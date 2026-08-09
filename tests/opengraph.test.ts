/**
 * Open Graph cards: crawler detection, the served wrapper, escaping, and the
 * v1 → v2 upgrade path.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { isSocialCrawler } from "../src/util/user-agent.ts";
import { hasOpenGraph, Store } from "../src/db.ts";
import { normaliseOpenGraph } from "../src/service.ts";
import { openGraphPage } from "../src/views/opengraph.ts";
import type { Config } from "../src/config.ts";

const cfg = { allowPrivateTargets: false } as Config;

// --- Crawler detection --------------------------------------------------------

Deno.test("isSocialCrawler recognises the platforms that build previews", () => {
  for (
    const ua of [
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "Twitterbot/1.0",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0)",
      "TelegramBot (like TwitterBot)",
      "WhatsApp/2.19.81 A",
      "Mozilla/5.0 (compatible; Mastodon/4.2; +https://mastodon.social/)",
      "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Applebot/0.1",
    ]
  ) {
    assert(isSocialCrawler(ua), `missed crawler: ${ua}`);
  }
});

Deno.test("isSocialCrawler leaves humans and plain tooling alone", () => {
  for (
    const ua of [
      "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1",
      "curl/8.4.0",
      "wget/1.21",
      "python-requests/2.31.0",
      "Googlebot/2.1 (+http://www.google.com/bot.html)", // indexes, doesn't preview
      "",
    ]
  ) {
    assertFalse(isSocialCrawler(ua), `wrongly treated as crawler: ${ua}`);
  }
  assertFalse(isSocialCrawler(undefined));
  assertFalse(isSocialCrawler(null));
});

// --- Field validation ---------------------------------------------------------

Deno.test("normaliseOpenGraph trims, caps and nulls out empty fields", () => {
  const r = normaliseOpenGraph({ ogTitle: "  Hello  ", ogDescription: "", ogImage: "  " }, cfg);
  assert(r.ok);
  assertEquals(r.value.ogTitle, "Hello");
  assertEquals(r.value.ogDescription, null);
  assertEquals(r.value.ogImage, null);

  const long = normaliseOpenGraph({ ogTitle: "x".repeat(500) }, cfg);
  assert(long.ok);
  assertEquals(long.value.ogTitle!.length, 120);
});

Deno.test("normaliseOpenGraph rejects dangerous image URLs", () => {
  for (
    const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data/",
      "not a url",
    ]
  ) {
    const r = normaliseOpenGraph({ ogImage: bad }, cfg);
    assertFalse(r.ok, `accepted image ${bad}`);
    if (!r.ok) assertStringIncludes(r.error, "Card image");
  }

  assert(normaliseOpenGraph({ ogImage: "https://cdn.example.com/card.png" }, cfg).ok);
});

// --- hasOpenGraph -------------------------------------------------------------

Deno.test("hasOpenGraph is true as soon as one field is set", () => {
  const store = new Store(":memory:");
  try {
    const bare = store.createLink({
      slug: "bare01",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    assertFalse(hasOpenGraph(bare));

    const carded = store.createLink({
      slug: "card01",
      target: "https://example.com",
      note: null,
      expiresAt: null,
      ogTitle: "Only a title",
    });
    assert(hasOpenGraph(carded));
  } finally {
    store.close();
  }
});

// --- The rendered wrapper -----------------------------------------------------

function renderCard(over: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  try {
    const link = store.createLink({
      slug: "kofi",
      target: "https://ko-fi.com/simon256px",
      note: null,
      expiresAt: null,
      ogTitle: "Support my work",
      ogDescription: "Every coffee helps.",
      ogImage: "https://cdn.example.com/card.png",
      ...over,
    });
    return String(
      openGraphPage({
        link,
        shortUrl: "https://s.example.com/kofi",
        siteName: "s.example.com",
        themeColor: "#3b5bdb",
      }),
    );
  } finally {
    store.close();
  }
}

Deno.test("the wrapper emits the tags every platform actually reads", () => {
  const out = renderCard();
  for (
    const tag of [
      '<meta property="og:type" content="website">',
      '<meta property="og:url" content="https://s.example.com/kofi">',
      '<meta property="og:title" content="Support my work">',
      '<meta property="og:description" content="Every coffee helps.">',
      '<meta property="og:image" content="https://cdn.example.com/card.png">',
      '<meta property="og:site_name" content="s.example.com">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:image" content="https://cdn.example.com/card.png">',
      '<meta name="theme-color" content="#3b5bdb">',
    ]
  ) {
    assertStringIncludes(out, tag);
  }
});

Deno.test("the wrapper still sends a human to the destination", () => {
  const out = renderCard();
  // Both routes out: no-JS meta refresh, and a real anchor.
  assertStringIncludes(
    out,
    '<meta http-equiv="refresh" content="0; url=https://ko-fi.com/simon256px">',
  );
  assertStringIncludes(out, 'href="https://ko-fi.com/simon256px"');
  // It must never become indexable — that is what would look like doorway spam.
  assertStringIncludes(out, '<meta name="robots" content="noindex, nofollow">');
});

Deno.test("a card with no image falls back to the small twitter card", () => {
  const out = renderCard({ ogImage: null });
  assertStringIncludes(out, '<meta name="twitter:card" content="summary">');
  assertFalse(out.includes("og:image"));
});

Deno.test("a card with no title falls back to the destination host", () => {
  const out = renderCard({ ogTitle: null });
  assertStringIncludes(out, '<meta property="og:title" content="ko-fi.com">');
});

Deno.test("hostile card text cannot break out of the meta attribute", () => {
  const out = renderCard({
    ogTitle: `"><script>alert(1)</script><meta x="`,
    ogDescription: `bad " onload="alert(2)`,
  });

  // The payload must survive only as escaped text.
  assertFalse(out.includes("<script>"), "script tag was emitted verbatim");
  assertFalse(out.includes('onload="alert(2)"'));
  assertStringIncludes(out, "&lt;script&gt;");
  assertStringIncludes(out, "&quot;");
});

// --- Upgrade path -------------------------------------------------------------

Deno.test("a v1 database upgrades to v2 without losing rows", async () => {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  try {
    // Build a v1 database by hand: the columns and user_version as they shipped.
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE links (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, target TEXT NOT NULL,
        note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0, click_count INTEGER NOT NULL DEFAULT 0,
        last_click_at INTEGER);
      CREATE TABLE clicks (
        id INTEGER PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL, visitor TEXT NOT NULL, referrer_host TEXT, country TEXT,
        browser TEXT, os TEXT, device TEXT, lang TEXT);
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, label TEXT);
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
      CREATE TABLE salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);
    raw.prepare(
      "INSERT INTO links (slug, target, note, created_at, click_count) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy", "https://example.com/old", "kept", 1700000000, 42);
    raw.close();

    // Opening with the current code must migrate in place.
    const store = new Store(path);
    try {
      const version = store.raw.prepare("PRAGMA user_version").get() as { user_version: number };
      assertEquals(Number(version.user_version), 2);

      const link = store.getLinkBySlug("legacy")!;
      assertEquals(link.target, "https://example.com/old");
      assertEquals(link.note, "kept");
      assertEquals(link.click_count, 42);

      // New columns exist and default to null, so the link behaves as before.
      assertEquals(link.og_title, null);
      assertEquals(link.og_image, null);
      assertFalse(hasOpenGraph(link));
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(path).catch(() => {});
    for (const suffix of ["-wal", "-shm"]) {
      await Deno.remove(path + suffix).catch(() => {});
    }
  }
});

Deno.test("card fields round-trip through create and update, and can be cleared", () => {
  const store = new Store(":memory:");
  try {
    const link = store.createLink({
      slug: "rt0001",
      target: "https://example.com",
      note: null,
      expiresAt: null,
      ogTitle: "Title",
      ogDescription: "Desc",
      ogImage: "https://cdn.example.com/a.png",
    });
    assertEquals(link.og_title, "Title");
    assertEquals(link.og_image, "https://cdn.example.com/a.png");

    store.updateLink(link.id, { ogTitle: "New title" });
    assertEquals(store.getLinkBySlug("rt0001")!.og_title, "New title");
    assertEquals(store.getLinkBySlug("rt0001")!.og_description, "Desc", "untouched field changed");

    store.updateLink(link.id, { ogTitle: null, ogDescription: null, ogImage: null });
    const cleared = store.getLinkBySlug("rt0001")!;
    assertFalse(hasOpenGraph(cleared));
  } finally {
    store.close();
  }
});
