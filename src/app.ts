/**
 * HTTP wiring: middleware, routing, and the composition of every module.
 *
 * Route order is deliberate — the `/:slug` redirect is a catch-all and must be
 * registered last, after every reserved prefix.
 */

import { Hono } from "hono";
import type { Config } from "./config.ts";
import { hasOpenGraph, type Store } from "./db.ts";
import type { DiscordReporter } from "./discord.ts";
import {
  type Auth,
  authenticate,
  checkPassword,
  csrfOk,
  endSession,
  startSession,
} from "./auth.ts";
import { RateLimiter } from "./util/rate-limit.ts";
import { sha256Hex } from "./util/crypto.ts";
import { CSS } from "./views/assets.ts";
import { errorPage, homePage, loginPage, type PageCtx } from "./views/pages.ts";
import { openGraphPage } from "./views/opengraph.ts";
import { isSocialCrawler } from "./util/user-agent.ts";
import { buildClick, clientIp, createLink, linkState } from "./service.ts";
import { registerDashboard } from "./routes/dashboard.ts";
import { registerApi } from "./routes/api.ts";

/** Per-request state Hono carries for us. */
export interface AppEnv {
  Variables: { auth: Auth };
}

export type AppHono = Hono<AppEnv>;

export interface AppCtx {
  store: Store;
  config: Config;
  adminHash: string;
  discord: DiscordReporter;
  cssHref: string;
  page: PageCtx;
  limiters: {
    login: RateLimiter;
    create: RateLimiter;
    api: RateLimiter;
    redirect: RateLimiter;
  };
}

/** Requests larger than this are rejected before any parsing happens. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The site policy. `script-src` is absent entirely, which under
 * `default-src 'none'` means no script can run anywhere — that is the whole
 * reason the dashboard ships no client JavaScript.
 *
 * `imgSrc` is the one dial: the card editor widens it so it can preview an
 * image hosted elsewhere. Even then nothing becomes executable — the worst a
 * remote image can do is tell its host that the admin opened the page.
 */
export function contentSecurityPolicy(imgSrc = "'self' data:"): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    `img-src ${imgSrc}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function buildContext(
  store: Store,
  config: Config,
  adminHash: string,
  discord: DiscordReporter,
): AppCtx {
  const cssHref = `/assets/app.${sha256Hex(CSS).slice(0, 10)}.css`;
  const limiters = {
    // Login: slow enough that online guessing is hopeless, loose enough that a
    // fat-fingered password three times running isn't a lockout.
    login: new RateLimiter(8, 900),
    create: new RateLimiter(60, 3600),
    api: new RateLimiter(240, 60),
    redirect: new RateLimiter(600, 60),
  };
  for (const l of Object.values(limiters)) l.startSweeping();

  return {
    store,
    config,
    adminHash,
    discord,
    cssHref,
    page: { cssHref, baseUrl: config.baseUrl },
    limiters,
  };
}

export function createApp(ctx: AppCtx): AppHono {
  const { store, config } = ctx;
  const app = new Hono<AppEnv>();

  // --- Security headers ------------------------------------------------------
  app.use("*", async (c, next) => {
    await next();

    const h = c.res.headers;
    h.set("x-content-type-options", "nosniff");
    h.set("x-frame-options", "DENY");
    // Don't clobber a per-route choice: the redirect handler sets
    // `no-referrer` so the destination never learns the short URL.
    if (!h.has("referrer-policy")) h.set("referrer-policy", "same-origin");
    h.set("permissions-policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
    // Set only if the route hasn't chosen its own — the card editor needs a
    // wider img-src to preview a remote image.
    if (!h.has("content-security-policy")) {
      h.set("content-security-policy", contentSecurityPolicy());
    }
    if (config.secureCookies) {
      h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  });

  // --- Body size guard -------------------------------------------------------
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_BODY_BYTES) return c.text("Payload too large", 413);
    }
    await next();
  });

  // --- Health & crawlers -----------------------------------------------------
  app.get("/health", (c) => c.json({ status: "ok", uptime: Math.floor(performance.now() / 1000) }));

  // A shortener has nothing to index, and letting crawlers walk the slug space
  // both pollutes analytics and leaks which links exist.
  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

  // --- Stylesheet ------------------------------------------------------------
  app.get("/assets/:file", (c) => {
    if (`/assets/${c.req.param("file")}` !== ctx.cssHref) return c.notFound();
    return c.body(CSS, 200, {
      "content-type": "text/css; charset=utf-8",
      // Safe to cache forever: the filename carries the content hash.
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  // --- Public landing --------------------------------------------------------
  app.get("/", (c) => {
    const created = c.req.query("created");
    return c.html(
      homePage(ctx.page, {
        publicShortening: config.publicShortening,
        created: created ? `${config.baseUrl}/${encodeURIComponent(created)}` : undefined,
        error: c.req.query("error") ?? undefined,
      }),
    );
  });

  app.post("/shorten", async (c) => {
    const auth = authenticate(c, store);
    if (!config.publicShortening && !auth) {
      return c.redirect("/?error=Shortening+requires+sign-in", 303);
    }
    if (!csrfOk(c, config, auth)) return c.text("Cross-origin request rejected", 403);

    const rl = ctx.limiters.create.check(clientIp(c, config));
    if (!rl.allowed) {
      return c.redirect(`/?error=Too+many+links+created.+Retry+in+${rl.retryAfter}s`, 303);
    }

    const body = await c.req.parseBody();
    const result = createLink(store, config, { target: String(body.target ?? "") });
    if (!result.ok) {
      return c.redirect(`/?error=${encodeURIComponent(result.error)}`, 303);
    }
    return c.redirect(`/?created=${encodeURIComponent(result.value.slug)}`, 303);
  });

  // --- Session -------------------------------------------------------------
  app.get("/login", (c) => {
    if (authenticate(c, store)?.kind === "session") return c.redirect("/dashboard", 302);
    return c.html(loginPage(ctx.page, { error: c.req.query("error") ?? undefined }));
  });

  app.post("/login", async (c) => {
    if (!csrfOk(c, config, null)) return c.text("Cross-origin request rejected", 403);

    const ip = clientIp(c, config);
    const rl = ctx.limiters.login.check(ip);
    if (!rl.allowed) {
      c.header("retry-after", String(rl.retryAfter));
      return c.html(
        loginPage(ctx.page, {
          error: `Too many attempts. Try again in ${rl.retryAfter} seconds.`,
        }),
        429,
      );
    }

    const body = await c.req.parseBody();
    const password = String(body.password ?? "");

    if (!checkPassword(password, ctx.adminHash)) {
      console.warn(`[auth] failed sign-in from ${ip}`);
      return c.html(loginPage(ctx.page, { error: "Incorrect password." }), 401);
    }

    ctx.limiters.login.reset(ip);
    startSession(c, store, config, null);
    return c.redirect("/dashboard", 303);
  });

  app.post("/logout", (c) => {
    endSession(c, store, config);
    return c.redirect("/login", 303);
  });

  // --- Sub-applications ------------------------------------------------------
  registerDashboard(app, ctx);
  registerApi(app, ctx);

  // --- The redirect (catch-all — must stay last) -----------------------------
  app.get("/:slug", (c) => {
    const slug = c.req.param("slug");

    const rl = ctx.limiters.redirect.check(clientIp(c, config));
    if (!rl.allowed) {
      c.header("retry-after", String(rl.retryAfter));
      return c.text("Too many requests", 429);
    }

    const link = store.getLinkBySlug(slug);
    const state = linkState(link);

    if (state !== "ok") {
      const message = state === "disabled"
        ? "This link has been disabled."
        : state === "expired"
        ? "This link has expired."
        : "This link does not exist.";
      return c.html(errorPage(ctx.page, 404, message), 404);
    }

    // Recorded either way, so a preview still shows up in the analytics —
    // bucketed as `device: bot`, which is how you tell the two apart.
    store.recordClick(buildClick(c, config, store, link!.id));

    // A preview crawler asking for a link that has its own card gets the card.
    // Everything else — every human, every script — gets the plain redirect.
    if (hasOpenGraph(link!) && isSocialCrawler(c.req.header("user-agent"))) {
      return c.html(
        openGraphPage({
          link: link!,
          shortUrl: `${config.baseUrl}/${encodeURIComponent(link!.slug)}`,
          siteName: new URL(config.baseUrl).hostname,
          themeColor: "#3b5bdb",
        }),
        200,
        {
          // Crawlers cache hard. Five minutes keeps an edit from taking hours
          // to show up without inviting a re-fetch on every share.
          "cache-control": "public, max-age=300",
          "referrer-policy": "no-referrer",
        },
      );
    }

    return c.body(null, config.redirectStatus, {
      location: link!.target,
      // 301/308 get cached by the browser forever, which silently stops the
      // analytics; whatever the status, tell caches not to keep this.
      "cache-control": "no-store, max-age=0",
      // Don't leak the short URL (and therefore the campaign) to the target.
      "referrer-policy": "no-referrer",
    });
  });

  // --- Fallbacks -------------------------------------------------------------
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
    return c.html(errorPage(ctx.page, 404, "Nothing here."), 404);
  });

  app.onError((err, c) => {
    console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "Internal server error" }, 500);
    }
    // Never surface the exception text: stack traces and SQL fragments are a
    // gift to an attacker.
    return c.html(errorPage(ctx.page, 500, "Something went wrong on our side."), 500);
  });

  return app;
}
