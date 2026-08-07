/**
 * End-to-end HTTP tests against the real Hono app, driven through `app.fetch`.
 * No socket is opened, so these stay fast enough to run on every save.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";

const ADMIN_PASSWORD = "test-password-1234";
const ORIGIN = "http://localhost:8000";

// Configuration is read from the environment at first use — set it before the
// config module is ever imported.
Deno.env.set("BASE_URL", ORIGIN);
Deno.env.set("HOST", "127.0.0.1");
Deno.env.set("PORT", "8000");
Deno.env.set("ADMIN_PASSWORD", ADMIN_PASSWORD);
Deno.env.set("DATA_DIR", "./data-test");
Deno.env.delete("DISCORD_WEBHOOK_URL");

const { getConfig } = await import("../src/config.ts");
const { Store } = await import("../src/db.ts");
const { DiscordReporter } = await import("../src/discord.ts");
const { resolveAdminHash } = await import("../src/auth.ts");
const { buildContext, createApp } = await import("../src/app.ts");

function harness() {
  const config = getConfig();
  const store = new Store(":memory:");
  const discord = new DiscordReporter(store, config);
  const ctx = buildContext(store, config, resolveAdminHash(config), discord);
  const app = createApp(ctx);

  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, init));

  return { app, store, ctx, config, call };
}

/** Signs in and returns the Cookie header to reuse. */
async function signIn(call: ReturnType<typeof harness>["call"]): Promise<string> {
  const res = await call("/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
    },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assertEquals(res.status, 303);
  const setCookie = res.headers.get("set-cookie");
  assert(setCookie, "no session cookie issued");
  return setCookie!.split(";")[0]!;
}

// --- Basics -------------------------------------------------------------------

Deno.test("health endpoint responds", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/health");
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "ok");
  } finally {
    store.close();
  }
});

Deno.test("robots.txt tells crawlers to stay out", async () => {
  const { call, store } = harness();
  try {
    const body = await (await call("/robots.txt")).text();
    assertStringIncludes(body, "Disallow: /");
  } finally {
    store.close();
  }
});

Deno.test("security headers are present on every response", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    assertEquals(res.headers.get("x-frame-options"), "DENY");

    const csp = res.headers.get("content-security-policy") ?? "";
    assertStringIncludes(csp, "default-src 'none'");
    assertStringIncludes(csp, "frame-ancestors 'none'");
    // Scripts are never allowed: the dashboard ships none.
    assertFalse(csp.includes("script-src"));
    assertFalse(csp.includes("unsafe-inline"));
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("stylesheet is served only at its content-hashed path", async () => {
  const { call, store, ctx } = harness();
  try {
    const ok = await call(ctx.cssHref);
    assertEquals(ok.status, 200);
    assertStringIncludes(ok.headers.get("content-type") ?? "", "text/css");
    assertStringIncludes(ok.headers.get("cache-control") ?? "", "immutable");
    await ok.body?.cancel();

    const wrong = await call("/assets/app.css");
    assertEquals(wrong.status, 404);
    await wrong.body?.cancel();
  } finally {
    store.close();
  }
});

// --- Authentication -----------------------------------------------------------

Deno.test("dashboard redirects anonymous visitors to the login page", async () => {
  const { call, store } = harness();
  try {
    for (const path of ["/dashboard", "/dashboard/links", "/dashboard/settings"]) {
      const res = await call(path);
      assertEquals(res.status, 302, path);
      assertEquals(res.headers.get("location"), "/login");
      await res.body?.cancel();
    }
  } finally {
    store.close();
  }
});

Deno.test("wrong password is rejected and issues no cookie", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({ password: "wrong-password-here" }),
    });
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("set-cookie"), null);
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("correct password signs in and the session cookie is hardened", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Lax");
    assertStringIncludes(cookie, "Path=/");
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("login is rate limited after repeated failures", async () => {
  const { call, store } = harness();
  try {
    let sawLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await call("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({ password: `guess-${i}` }),
      });
      if (res.status === 429) {
        sawLimit = true;
        assert(Number(res.headers.get("retry-after")) > 0);
      }
      await res.body?.cancel();
    }
    assert(sawLimit, "brute force was never throttled");
  } finally {
    store.close();
  }
});

Deno.test("a cross-origin login POST is refused", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    });
    assertEquals(res.status, 403);
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("signed-in dashboard renders", async () => {
  const { call, store } = harness();
  try {
    const cookie = await signIn(call);
    const res = await call("/dashboard", { headers: { cookie } });
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "Overview");
  } finally {
    store.close();
  }
});

// --- Link lifecycle -----------------------------------------------------------

Deno.test("create, redirect, count, then delete a link", async () => {
  const { call, store, config } = harness();
  try {
    const cookie = await signIn(call);

    const created = await call("/dashboard/links", {
      method: "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        target: "https://example.com/destination",
        slug: "my-link",
        note: "integration test",
      }),
    });
    assertEquals(created.status, 303);
    assertStringIncludes(created.headers.get("location") ?? "", "/dashboard/links/my-link");
    await created.body?.cancel();

    // The redirect itself.
    const hop = await call("/my-link", {
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:121.0) Firefox/121.0",
        referer: "https://news.example.com/story?secret=1",
        "accept-language": "fr-FR,fr;q=0.9",
      },
    });
    assertEquals(hop.status, config.redirectStatus);
    assertEquals(hop.headers.get("location"), "https://example.com/destination");
    assertStringIncludes(hop.headers.get("cache-control") ?? "", "no-store");
    assertEquals(hop.headers.get("referrer-policy"), "no-referrer");
    await hop.body?.cancel();

    // Analytics land after the batch flush.
    assertEquals(store.flushClicks(), 1);
    assertEquals(store.getLinkBySlug("my-link")?.click_count, 1);

    // Only the referring host is kept — never the query string.
    const refs = store.topDimension("referrer_host");
    assertEquals(refs[0]?.label, "news.example.com");
    assertEquals(store.topDimension("country")[0]?.label, "FR");
    assertEquals(store.topDimension("browser")[0]?.label, "Firefox");

    const deleted = await call("/dashboard/links/my-link/delete", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    assertEquals(deleted.status, 303);
    await deleted.body?.cancel();
    assertEquals(store.getLinkBySlug("my-link"), undefined);
  } finally {
    store.close();
  }
});

Deno.test("unknown, disabled and expired slugs all return 404", async () => {
  const { call, store } = harness();
  try {
    const missing = await call("/does-not-exist");
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const off = store.createLink({
      slug: "offlnk",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    store.updateLink(off.id, { disabled: true });
    const disabled = await call("/offlnk");
    assertEquals(disabled.status, 404);
    assertStringIncludes(await disabled.text(), "disabled");

    store.createLink({
      slug: "explnk",
      target: "https://example.com",
      note: null,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const expired = await call("/explnk");
    assertEquals(expired.status, 404);
    assertStringIncludes(await expired.text(), "expired");
  } finally {
    store.close();
  }
});

Deno.test("a disabled link records no click", async () => {
  const { call, store } = harness();
  try {
    const link = store.createLink({
      slug: "silent",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    store.updateLink(link.id, { disabled: true });

    const res = await call("/silent");
    await res.body?.cancel();
    store.flushClicks();
    assertEquals(store.globalTotals().clicks, 0);
  } finally {
    store.close();
  }
});

Deno.test("dangerous destinations are refused by the dashboard form", async () => {
  const { call, store } = harness();
  try {
    const cookie = await signIn(call);
    for (const target of ["javascript:alert(1)", "http://169.254.169.254/", "http://127.0.0.1/"]) {
      const res = await call("/dashboard/links", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ target }),
      });
      assertEquals(res.status, 400, target);
      await res.body?.cancel();
    }
    assertEquals(store.globalTotals().links, 0);
  } finally {
    store.close();
  }
});

Deno.test("reserved slugs cannot be claimed", async () => {
  const { call, store } = harness();
  try {
    const cookie = await signIn(call);
    const res = await call("/dashboard/links", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ target: "https://example.com", slug: "dashboard" }),
    });
    assertEquals(res.status, 409);
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("mutating dashboard routes reject a cross-origin POST", async () => {
  const { call, store } = harness();
  try {
    const cookie = await signIn(call);
    const res = await call("/dashboard/links", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ target: "https://example.com" }),
    });
    assertEquals(res.status, 403);
    await res.body?.cancel();
    assertEquals(store.globalTotals().links, 0);
  } finally {
    store.close();
  }
});

Deno.test("public shortening is off by default", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/shorten", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ target: "https://example.com" }),
    });
    assertEquals(res.status, 303);
    assertStringIncludes(res.headers.get("location") ?? "", "error=");
    await res.body?.cancel();
    assertEquals(store.globalTotals().links, 0);
  } finally {
    store.close();
  }
});

// --- API ----------------------------------------------------------------------

Deno.test("API requires authentication", async () => {
  const { call, store } = harness();
  try {
    const res = await call("/api/stats");
    assertEquals(res.status, 401);
    assertStringIncludes(res.headers.get("www-authenticate") ?? "", "Bearer");
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("API key creates and reads links", async () => {
  const { call, store } = harness();
  try {
    const { issueApiKey } = await import("../src/auth.ts");
    const key = issueApiKey(store, "test-key");

    const created = await call("/api/links", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "https://example.com/api", slug: "api-made" }),
    });
    assertEquals(created.status, 201);
    const link = await created.json();
    assertEquals(link.slug, "api-made");
    assertEquals(link.short_url, `${ORIGIN}/api-made`);
    assertEquals(link.state, "ok");

    const stats = await call("/api/stats", { headers: { authorization: `Bearer ${key}` } });
    assertEquals(stats.status, 200);
    assertEquals((await stats.json()).totals.links, 1);

    const bad = await call("/api/links", {
      method: "POST",
      headers: { authorization: "Bearer sud_wrong", "content-type": "application/json" },
      body: JSON.stringify({ target: "https://example.com" }),
    });
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("API rejects a dangerous target and a malformed body", async () => {
  const { call, store } = harness();
  try {
    const { issueApiKey } = await import("../src/auth.ts");
    const key = issueApiKey(store, "k2");
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

    const evil = await call("/api/links", {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "javascript:alert(1)" }),
    });
    assertEquals(evil.status, 400);
    await evil.body?.cancel();

    const junk = await call("/api/links", { method: "POST", headers, body: "not json" });
    assertEquals(junk.status, 400);
    await junk.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("API patch and delete work through to storage", async () => {
  const { call, store } = harness();
  try {
    const { issueApiKey } = await import("../src/auth.ts");
    const key = issueApiKey(store, "k3");
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    store.createLink({
      slug: "patchme",
      target: "https://old.example",
      note: null,
      expiresAt: null,
    });

    const patched = await call("/api/links/patchme", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ target: "https://new.example/", disabled: true }),
    });
    assertEquals(patched.status, 200);
    const body = await patched.json();
    assertEquals(body.target, "https://new.example/");
    assertEquals(body.disabled, true);
    assertEquals(body.state, "disabled");

    const gone = await call("/api/links/patchme", { method: "DELETE", headers });
    assertEquals(gone.status, 204);
    assertEquals(store.getLinkBySlug("patchme"), undefined);
  } finally {
    store.close();
  }
});

// --- QR & export --------------------------------------------------------------

Deno.test("QR endpoint returns SVG for a real slug and 404 otherwise", async () => {
  const { call, store } = harness();
  try {
    const cookie = await signIn(call);
    store.createLink({
      slug: "qrlink",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });

    const res = await call("/dashboard/links/qrlink/qr.svg", { headers: { cookie } });
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "image/svg+xml");
    assertStringIncludes(await res.text(), "<svg");

    const missing = await call("/dashboard/links/nosuch/qr.svg", { headers: { cookie } });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    store.close();
  }
});

Deno.test("CSV export returns an attachment with a header row", async () => {
  const { call, store } = harness();
  try {
    const cookie = await signIn(call);
    const link = store.createLink({
      slug: "csvlnk",
      target: "https://example.com",
      note: null,
      expiresAt: null,
    });
    store.recordClick({
      link_id: link.id,
      ts: Math.floor(Date.now() / 1000),
      visitor: "v1",
      referrer_host: "ref.example",
      country: "FR",
      browser: "Firefox",
      os: "Fedora",
      device: "desktop",
      lang: "fr",
    });
    store.flushClicks();

    const res = await call("/dashboard/links/csvlnk/export.csv", { headers: { cookie } });
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-disposition") ?? "", "attachment");
    const csv = await res.text();
    assertStringIncludes(csv, '"timestamp","slug"');
    assertStringIncludes(csv, "csvlnk");
    assertStringIncludes(csv, "ref.example");
  } finally {
    store.close();
  }
});

// --- Discord embed ------------------------------------------------------------

Deno.test("Discord embed stays within the documented field limits", async () => {
  const { store, config } = harness();
  try {
    const { DiscordReporter: Reporter } = await import("../src/discord.ts");
    const reporter = new Reporter(store, config);

    // A note and slug full of markdown must not break out of the embed.
    const link = store.createLink({
      slug: "md-test",
      target: "https://example.com/*bold*_x_",
      note: "@everyone **ping**",
      expiresAt: null,
    });
    for (let i = 0; i < 20; i++) {
      store.recordClick({
        link_id: link.id,
        ts: Math.floor(Date.now() / 1000) - i * 600,
        visitor: `v${i}`,
        referrer_host: "very-long-referrer-hostname.example.com",
        country: "FR",
        browser: "Firefox",
        os: "Fedora",
        device: "desktop",
        lang: "fr",
      });
    }
    store.flushClicks();

    const embed = reporter.buildEmbed() as {
      description: string;
      fields: Array<{ name: string; value: string }>;
      title: string;
    };

    assert(embed.title.length <= 256);
    assert(embed.description.length <= 4096);
    assert(embed.fields.length <= 25);
    for (const f of embed.fields) {
      assert(f.name.length <= 256, `field name too long: ${f.name}`);
      assert(f.value.length <= 1024, `field value too long: ${f.value}`);
    }
    const total = embed.title.length + embed.description.length +
      embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert(total <= 6000, `embed total ${total} exceeds Discord's 6000 limit`);
  } finally {
    store.close();
  }
});
