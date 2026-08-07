/**
 * The Discord reporter, driven against a local stand-in for the webhook API.
 *
 * The behaviour worth pinning down is the message lifecycle: post once, then
 * edit that same message forever, and recover on its own if someone deletes it.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { DiscordReporter } from "../src/discord.ts";

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/**
 * Minimal fake of the two endpoints we use. `patchStatus` lets a test simulate
 * the message having been deleted in Discord.
 */
function fakeDiscord(opts: { patchStatus?: number } = {}) {
  const calls: Recorded[] = [];
  const ac = new AbortController();
  let messageId = "1000000000000000001";

  const server = Deno.serve({
    port: 0,
    signal: ac.signal,
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    calls.push({ method: req.method, path: url.pathname, body });

    if (req.method === "POST") {
      return Response.json({ id: messageId }, { status: 200 });
    }
    if (req.method === "PATCH") {
      const status = opts.patchStatus ?? 200;
      if (status !== 200) return Response.json({ code: 10008 }, { status });
      return Response.json({ id: messageId }, { status: 200 });
    }
    return new Response("nope", { status: 405 });
  });

  const port = (server.addr as Deno.NetAddr).port;
  return {
    calls,
    url: `http://127.0.0.1:${port}/api/webhooks/123/token`,
    setMessageId: (id: string) => (messageId = id),
    async close() {
      ac.abort();
      await server.finished;
    },
  };
}

function fakeConfig(webhook: string): Config {
  return {
    baseUrl: "https://s.example.com",
    baseOrigin: "https://s.example.com",
    discordWebhook: webhook,
    discordIntervalSeconds: 300,
  } as Config;
}

function seed(store: Store) {
  const link = store.createLink({
    slug: "seeded",
    target: "https://example.com/page",
    note: null,
    expiresAt: null,
  });
  store.recordClick({
    link_id: link.id,
    ts: Math.floor(Date.now() / 1000),
    visitor: "v1",
    referrer_host: "news.example.com",
    country: "FR",
    browser: "Firefox",
    os: "Fedora",
    device: "desktop",
    lang: "fr",
  });
  store.flushClicks();
}

Deno.test("first tick posts a message, later ticks edit that same message", async () => {
  const discord = fakeDiscord();
  const store = new Store(":memory:");
  try {
    seed(store);
    const reporter = new DiscordReporter(store, fakeConfig(discord.url));

    await reporter.tick();
    assertEquals(discord.calls.length, 1);
    assertEquals(discord.calls[0]!.method, "POST");
    // ?wait=true is what makes Discord return the message id.
    assert(store.kvGet("discord_message_id"));

    await reporter.tick();
    await reporter.tick();
    assertEquals(discord.calls.length, 3);
    assertEquals(discord.calls[1]!.method, "PATCH");
    assertEquals(discord.calls[2]!.method, "PATCH");
    assertStringIncludes(discord.calls[1]!.path, "/messages/1000000000000000001");
  } finally {
    store.close();
    await discord.close();
  }
});

Deno.test("a deleted message is detected and re-posted", async () => {
  const discord = fakeDiscord({ patchStatus: 404 });
  const store = new Store(":memory:");
  try {
    seed(store);
    const reporter = new DiscordReporter(store, fakeConfig(discord.url));

    await reporter.tick(); // POST — creates it
    discord.setMessageId("2000000000000000002");
    await reporter.tick(); // PATCH 404 → POST again

    const methods = discord.calls.map((c) => c.method);
    assertEquals(methods, ["POST", "PATCH", "POST"]);
    assertEquals(store.kvGet("discord_message_id"), "2000000000000000002");
  } finally {
    store.close();
    await discord.close();
  }
});

Deno.test("changing the webhook forgets the old message id", async () => {
  const store = new Store(":memory:");
  const a = fakeDiscord();
  const b = fakeDiscord();
  try {
    seed(store);

    const first = new DiscordReporter(store, fakeConfig(a.url));
    first.start();
    first.stop();
    await first.tick();
    const idA = store.kvGet("discord_message_id");
    assert(idA);

    // A different webhook means a different channel: reusing the stored id
    // would try to edit a message that lives somewhere else.
    const second = new DiscordReporter(store, fakeConfig(b.url));
    second.start();
    second.stop();
    assertEquals(store.kvGet("discord_message_id"), undefined);

    await second.tick();
    assertEquals(b.calls[0]!.method, "POST");
  } finally {
    store.close();
    await a.close();
    await b.close();
  }
});

Deno.test("the payload suppresses mentions and carries one embed", async () => {
  const discord = fakeDiscord();
  const store = new Store(":memory:");
  try {
    const link = store.createLink({
      slug: "pingme",
      target: "https://example.com",
      note: "@everyone @here",
      expiresAt: null,
    });
    store.recordClick({
      link_id: link.id,
      ts: Math.floor(Date.now() / 1000),
      visitor: "v1",
      referrer_host: null,
      country: null,
      browser: "Firefox",
      os: "Fedora",
      device: "desktop",
      lang: null,
    });
    store.flushClicks();

    const reporter = new DiscordReporter(store, fakeConfig(discord.url));
    await reporter.tick();

    const body = discord.calls[0]!.body as {
      embeds: unknown[];
      allowed_mentions: { parse: string[] };
    };
    assertEquals(body.embeds.length, 1);
    // Even a link note full of @everyone must never ping a channel.
    assertEquals(body.allowed_mentions.parse, []);
  } finally {
    store.close();
    await discord.close();
  }
});

Deno.test("a failing webhook does not throw out of tick()", async () => {
  const store = new Store(":memory:");
  try {
    seed(store);
    // Nothing is listening on this port.
    const reporter = new DiscordReporter(
      store,
      fakeConfig("http://127.0.0.1:1/api/webhooks/1/x"),
    );
    await reporter.tick(); // must resolve, not reject
    assertEquals(store.kvGet("discord_message_id"), undefined);
  } finally {
    store.close();
  }
});

Deno.test("the reporter is disabled when no webhook is configured", async () => {
  const store = new Store(":memory:");
  try {
    const reporter = new DiscordReporter(store, fakeConfig("") as Config);
    assertEquals(reporter.enabled, false);
    await reporter.tick(); // no-op
  } finally {
    store.close();
  }
});
