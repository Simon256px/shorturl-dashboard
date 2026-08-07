import { assert, assertEquals, assertFalse } from "@std/assert";
import { Store } from "../src/db.ts";

/** Each test gets its own in-memory database. */
function freshStore(): Store {
  return new Store(":memory:");
}

function seedClick(
  store: Store,
  linkId: number,
  overrides: Partial<Parameters<Store["recordClick"]>[0]> = {},
) {
  store.recordClick({
    link_id: linkId,
    ts: Math.floor(Date.now() / 1000),
    visitor: "visitor00000001",
    referrer_host: "news.example.com",
    country: "FR",
    browser: "Firefox",
    os: "Fedora",
    device: "desktop",
    lang: "fr",
    ...overrides,
  });
}

Deno.test("migrations create a usable schema and are idempotent per instance", () => {
  const store = freshStore();
  try {
    const version = store.raw.prepare("PRAGMA user_version").get() as { user_version: number };
    assertEquals(Number(version.user_version), 1);
    assertEquals(store.globalTotals().links, 0);
  } finally {
    store.close();
  }
});

Deno.test("createLink stores the link and slugExists sees it", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "abc123",
      target: "https://example.com/a",
      note: "test",
      expiresAt: null,
    });
    assertEquals(link.slug, "abc123");
    assertEquals(link.click_count, 0);
    assert(store.slugExists("abc123"));
    assertFalse(store.slugExists("nope42"));
    assertEquals(store.getLinkBySlug("abc123")?.target, "https://example.com/a");
  } finally {
    store.close();
  }
});

Deno.test("queued clicks are flushed and bump the denormalised counter", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "count1",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });

    for (let i = 0; i < 5; i++) seedClick(store, link.id);
    // Not yet written — the flush is deferred so redirects never block on I/O.
    assertEquals(store.getLinkBySlug("count1")?.click_count, 0);

    assertEquals(store.flushClicks(), 5);
    assertEquals(store.getLinkBySlug("count1")?.click_count, 5);
    assert((store.getLinkBySlug("count1")?.last_click_at ?? 0) > 0);
  } finally {
    store.close();
  }
});

Deno.test("unique visitors are counted by visitor id, not by click", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "uniq01",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    seedClick(store, link.id, { visitor: "aaaa" });
    seedClick(store, link.id, { visitor: "aaaa" });
    seedClick(store, link.id, { visitor: "bbbb" });
    store.flushClicks();

    const totals = store.globalTotals();
    assertEquals(totals.clicks, 3);
    assertEquals(totals.visitors, 2);
  } finally {
    store.close();
  }
});

Deno.test("deleting a link removes its clicks and drops queued ones", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "gone01",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    seedClick(store, link.id);
    store.flushClicks();
    assertEquals(store.globalTotals().clicks, 1);

    // Queue a click, then delete before it is flushed: the pending row must be
    // discarded rather than fail the whole batch on the foreign key.
    seedClick(store, link.id);
    store.deleteLink(link.id);
    assertEquals(store.flushClicks(), 0);

    assertEquals(store.globalTotals().links, 0);
    assertEquals(store.globalTotals().clicks, 0);
  } finally {
    store.close();
  }
});

Deno.test("globalTotals counts expired and disabled links as inactive", () => {
  const store = freshStore();
  try {
    const past = Math.floor(Date.now() / 1000) - 3600;
    store.createLink({ slug: "live01", target: "https://a.example", note: null, expiresAt: null });
    store.createLink({ slug: "dead01", target: "https://b.example", note: null, expiresAt: past });
    const off = store.createLink({
      slug: "off001",
      target: "https://c.example",
      note: null,
      expiresAt: null,
    });
    store.updateLink(off.id, { disabled: true });

    const totals = store.globalTotals();
    assertEquals(totals.links, 3);
    assertEquals(totals.active, 1);
  } finally {
    store.close();
  }
});

Deno.test("dailySeries fills gaps and covers the requested window", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "chart1",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    const now = Math.floor(Date.now() / 1000);
    seedClick(store, link.id, { ts: now });
    seedClick(store, link.id, { ts: now - 3 * 86400 });
    store.flushClicks();

    const series = store.dailySeries(7);
    assertEquals(series.length, 7);
    assertEquals(series.at(-1)?.value, 1); // today
    assertEquals(series.reduce((a, b) => a + b.value, 0), 2);
    // Days with no clicks are present with a zero, not missing.
    assert(series.some((s) => s.value === 0));
  } finally {
    store.close();
  }
});

Deno.test("topDimension ranks values and skips nulls", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "dims01",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    seedClick(store, link.id, { country: "FR" });
    seedClick(store, link.id, { country: "FR" });
    seedClick(store, link.id, { country: "DE" });
    seedClick(store, link.id, { country: null });
    store.flushClicks();

    const top = store.topDimension("country");
    assertEquals(top.length, 2);
    assertEquals(top[0], { label: "FR", value: 2 });
    assertEquals(top[1], { label: "DE", value: 1 });
  } finally {
    store.close();
  }
});

Deno.test("listLinks search matches slug, target and note without LIKE injection", () => {
  const store = freshStore();
  try {
    store.createLink({
      slug: "alpha1",
      target: "https://a.example",
      note: "newsletter",
      expiresAt: null,
    });
    store.createLink({
      slug: "beta02",
      target: "https://b.example/promo",
      note: null,
      expiresAt: null,
    });

    assertEquals(store.listLinks({ limit: 10, offset: 0, search: "alpha" }).length, 1);
    assertEquals(store.listLinks({ limit: 10, offset: 0, search: "promo" }).length, 1);
    assertEquals(store.listLinks({ limit: 10, offset: 0, search: "newsletter" }).length, 1);
    // A bare "%" would match everything if the wildcard were not escaped.
    assertEquals(store.listLinks({ limit: 10, offset: 0, search: "%" }).length, 0);
    assertEquals(store.countLinks("%"), 0);
  } finally {
    store.close();
  }
});

Deno.test("sessions expire and can be revoked wholesale", () => {
  const store = freshStore();
  try {
    store.createSession("hash-a", 3600, null);
    store.createSession("hash-b", -10, null); // already expired

    assert(store.getSession("hash-a"));
    assertEquals(store.getSession("hash-b"), undefined);

    store.deleteAllSessions();
    assertEquals(store.getSession("hash-a"), undefined);
  } finally {
    store.close();
  }
});

Deno.test("daily salt is stable within a day and differs across days", () => {
  const store = freshStore();
  try {
    const today = store.dailySalt("2026-08-07");
    assertEquals(store.dailySalt("2026-08-07"), today);
    assert(store.dailySalt("2026-08-08") !== today);
    assert(today.length >= 40); // 32 random bytes, base64
  } finally {
    store.close();
  }
});

Deno.test("maintenance purges old clicks, dead sessions and stale salts", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "purge1",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    const now = Math.floor(Date.now() / 1000);
    seedClick(store, link.id, { ts: now });
    seedClick(store, link.id, { ts: now - 500 * 86400 });
    store.flushClicks();

    store.createSession("expired-session", -10, null);
    store.dailySalt("2020-01-01");

    const purged = store.maintenance(400);
    assertEquals(purged.clicks, 1);
    assertEquals(purged.sessions, 1);
    assert(purged.salts >= 1);

    // Only the detailed row is gone. The lifetime counter is intentionally
    // left alone: "this link got 2 clicks ever" must not shrink just because
    // the per-click analytics aged out of the retention window.
    assertEquals(store.globalTotals().clicks, 2);
    assertEquals(
      Number(
        (store.raw.prepare("SELECT COUNT(*) AS n FROM clicks").get() as { n: number }).n,
      ),
      1,
    );
  } finally {
    store.close();
  }
});

Deno.test("maintenance with retention 0 keeps every click", () => {
  const store = freshStore();
  try {
    const link = store.createLink({
      slug: "keep01",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    seedClick(store, link.id, { ts: Math.floor(Date.now() / 1000) - 9999 * 86400 });
    store.flushClicks();

    assertEquals(store.maintenance(0).clicks, 0);
    assertEquals(store.globalTotals().clicks, 1);
  } finally {
    store.close();
  }
});

Deno.test("kv round-trips and deletes", () => {
  const store = freshStore();
  try {
    assertEquals(store.kvGet("missing"), undefined);
    store.kvSet("discord_message_id", "12345");
    assertEquals(store.kvGet("discord_message_id"), "12345");
    store.kvSet("discord_message_id", "67890"); // upsert
    assertEquals(store.kvGet("discord_message_id"), "67890");
    store.kvDelete("discord_message_id");
    assertEquals(store.kvGet("discord_message_id"), undefined);
  } finally {
    store.close();
  }
});

Deno.test("api keys are looked up by hash and revocable", () => {
  const store = freshStore();
  try {
    store.createApiKey("ci", "hash-of-key", "sud_abcdefg");
    const found = store.findApiKey("hash-of-key");
    assert(found);
    assertEquals(found!.name, "ci");
    assertEquals(store.findApiKey("wrong-hash"), undefined);

    store.deleteApiKey(found!.id);
    assertEquals(store.findApiKey("hash-of-key"), undefined);
  } finally {
    store.close();
  }
});
