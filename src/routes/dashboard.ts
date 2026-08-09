/**
 * The HTML dashboard. Session-authenticated, no client-side JavaScript.
 *
 * Every mutating route re-checks the session and the request Origin: a single
 * middleware would be neater, but this way a new route cannot silently inherit
 * "no auth" by being registered in the wrong place.
 */

import type { Context } from "hono";
import { type AppCtx, type AppHono, contentSecurityPolicy } from "../app.ts";
import { csrfOk, currentSession, issueApiKey } from "../auth.ts";
import {
  createLink,
  normaliseChannel,
  normaliseOpenGraph,
  parseExpiry,
  toCsv,
  validateSlug,
} from "../service.ts";
import { foldReferrers, isChannelId } from "../util/channel.ts";
import { validateTarget } from "../util/target-url.ts";
import { qrSvg } from "../util/qr.ts";
import {
  errorPage,
  linkDetailPage,
  linksPage,
  newLinkPage,
  overviewPage,
  settingsPage,
} from "../views/pages.ts";

const PAGE_SIZE = 50;
const WEEK = 7 * 86400;

export function registerDashboard(app: AppHono, ctx: AppCtx): void {
  const { store, config } = ctx;

  /** Session gate for every /dashboard route. */
  app.use("/dashboard/*", async (c, next) => {
    if (!currentSession(c, store)) return c.redirect("/login", 302);
    await next();
  });
  app.use("/dashboard", async (c, next) => {
    if (!currentSession(c, store)) return c.redirect("/login", 302);
    await next();
  });

  /** Origin gate for every mutating dashboard request. */
  const guard = (c: Context) => csrfOk(c, config, { kind: "session", label: "admin" });

  const configSummary = () => ({
    baseUrl: config.baseUrl,
    publicShortening: config.publicShortening,
    trustProxy: config.trustProxy,
    retentionDays: config.retentionDays,
    redirectStatus: config.redirectStatus,
    discordEnabled: ctx.discord.enabled,
    discordInterval: config.discordIntervalSeconds,
  });

  // --- Overview --------------------------------------------------------------

  app.get("/dashboard", (c) => {
    return c.html(
      overviewPage(ctx.page, {
        totals: store.globalTotals(),
        day: store.clicksSince(86400),
        week: store.clicksSince(WEEK),
        series: store.dailySeries(30),
        topLinks: store.topLinks(10, WEEK),
        referrers: store.topDimension("referrer_host", { limit: 8, sinceSeconds: WEEK }),
        countries: store.topDimension("country", { limit: 8, sinceSeconds: WEEK }),
        browsers: store.topDimension("browser", { limit: 8, sinceSeconds: WEEK }),
        devices: store.topDimension("device", { limit: 8, sinceSeconds: WEEK }),
        channels: store.channelStats(WEEK),
        // A high limit here, unlike the display lists above: this feeds an
        // aggregation, and truncating it would drop hosts out of their channel's
        // total rather than merely hiding a row.
        detected: foldReferrers(
          store.topDimension("referrer_host", { limit: 500, sinceSeconds: WEEK }),
        ),
        discord: {
          enabled: ctx.discord.enabled,
          published: store.kvGet("discord_message_id") !== undefined,
          intervalSeconds: config.discordIntervalSeconds,
        },
      }),
    );
  });

  // --- Link list -------------------------------------------------------------

  app.get("/dashboard/links", (c) => {
    const search = (c.req.query("q") ?? "").trim().slice(0, 120);
    const sortRaw = c.req.query("sort") ?? "newest";
    const sort = ["newest", "clicks", "oldest"].includes(sortRaw) ? sortRaw : "newest";
    const page = Math.max(1, Math.min(10_000, Number(c.req.query("page") ?? 1) || 1));

    // An unrecognised value falls back to "all" rather than erroring: this is a
    // URL people edit and share, and a 400 on a stale bookmark is unhelpful.
    const channelRaw = (c.req.query("channel") ?? "").trim().toLowerCase();
    const channel = channelRaw === "none" || isChannelId(channelRaw) ? channelRaw : "";

    const total = store.countLinks(search || undefined, channel || undefined);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return c.html(
      linksPage(ctx.page, {
        links: store.listLinks({
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          search: search || undefined,
          sort,
          channel: channel || undefined,
        }),
        total,
        page,
        pages,
        search,
        sort,
        channel,
        notice: c.req.query("ok") ?? undefined,
        error: c.req.query("error") ?? undefined,
      }),
    );
  });

  // --- Create ----------------------------------------------------------------

  app.get("/dashboard/new", (c) => c.html(newLinkPage(ctx.page)));

  app.post("/dashboard/links", async (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);

    const body = await c.req.parseBody();
    const values = {
      target: String(body.target ?? ""),
      slug: String(body.slug ?? ""),
      note: String(body.note ?? ""),
      expires: String(body.expires ?? ""),
      og_title: String(body.og_title ?? ""),
      og_description: String(body.og_description ?? ""),
      og_image: String(body.og_image ?? ""),
      channel: String(body.channel ?? ""),
    };

    const expiry = parseExpiry(values.expires);
    if (!expiry.ok) return c.html(newLinkPage(ctx.page, { error: expiry.error, values }), 400);

    const result = createLink(store, config, {
      target: values.target,
      slug: values.slug || null,
      note: values.note,
      expiresAt: expiry.value,
      ogTitle: values.og_title,
      ogDescription: values.og_description,
      ogImage: values.og_image,
      channel: values.channel,
    });
    if (!result.ok) {
      return c.html(
        newLinkPage(ctx.page, { error: result.error, values }),
        result.status as 400,
      );
    }
    return c.redirect(
      `/dashboard/links/${encodeURIComponent(result.value.slug)}?ok=Link+created`,
      303,
    );
  });

  // --- Detail ----------------------------------------------------------------

  app.get("/dashboard/links/:slug", (c) => {
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.html(errorPage(ctx.page, 404, "No such link."), 404);

    // This page previews the card image, which lives on someone else's host.
    // Widening img-src to https: is the whole concession — script-src stays
    // absent, so the image still cannot execute anything. The residual cost is
    // that the image host learns the admin opened this page.
    if (link.og_image) {
      c.header("content-security-policy", contentSecurityPolicy("'self' data: https:"));
    }

    return c.html(
      linkDetailPage(ctx.page, {
        link,
        shortUrl: `${config.baseUrl}/${encodeURIComponent(link.slug)}`,
        day: store.clicksSince(86400, link.id),
        week: store.clicksSince(WEEK, link.id),
        uniqueTotal: store.clicksSince(100 * 365 * 86400, link.id).visitors,
        series: store.dailySeries(30, link.id),
        hourly: store.hourlySeries(48, link.id),
        referrers: store.topDimension("referrer_host", { limit: 8, linkId: link.id }),
        countries: store.topDimension("country", { limit: 8, linkId: link.id }),
        browsers: store.topDimension("browser", { limit: 8, linkId: link.id }),
        devices: store.topDimension("device", { limit: 8, linkId: link.id }),
        detected: foldReferrers(
          store.topDimension("referrer_host", { limit: 500, linkId: link.id }),
        ),
        notice: c.req.query("ok") ?? undefined,
        error: c.req.query("error") ?? undefined,
      }),
    );
  });

  app.post("/dashboard/links/:slug", async (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);

    const slug = c.req.param("slug");
    const link = store.getLinkBySlug(slug);
    if (!link) return c.html(errorPage(ctx.page, 404, "No such link."), 404);

    const body = await c.req.parseBody();
    const back = (msg: string, key: "ok" | "error") =>
      c.redirect(
        `/dashboard/links/${encodeURIComponent(slug)}?${key}=${encodeURIComponent(msg)}`,
        303,
      );

    const check = validateTarget(String(body.target ?? ""), {
      allowPrivate: config.allowPrivateTargets,
      selfOrigin: config.baseOrigin,
    });
    if (!check.ok) return back(check.error, "error");

    const expiry = parseExpiry(String(body.expires ?? ""));
    if (!expiry.ok) return back(expiry.error, "error");

    // Same normalisation as on create. Submitting the fields empty really
    // clears them — that is how you take a card back off a link.
    const og = normaliseOpenGraph({
      ogTitle: String(body.og_title ?? ""),
      ogDescription: String(body.og_description ?? ""),
      ogImage: String(body.og_image ?? ""),
    }, config);
    if (!og.ok) return back(og.error, "error");

    const channel = normaliseChannel(String(body.channel ?? ""));
    if (!channel.ok) return back(channel.error, "error");

    store.updateLink(link.id, {
      target: check.url,
      note: String(body.note ?? "").trim().slice(0, 280) || null,
      expiresAt: expiry.value,
      channel: channel.value,
      ...og.value,
    });
    return back("Changes saved", "ok");
  });

  app.post("/dashboard/links/:slug/toggle", (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.html(errorPage(ctx.page, 404, "No such link."), 404);

    store.updateLink(link.id, { disabled: !link.disabled });
    const msg = link.disabled ? "Link re-enabled" : "Link disabled";
    return c.redirect(
      `/dashboard/links/${encodeURIComponent(link.slug)}?ok=${encodeURIComponent(msg)}`,
      303,
    );
  });

  app.post("/dashboard/links/:slug/delete", (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.html(errorPage(ctx.page, 404, "No such link."), 404);

    store.deleteLink(link.id);
    return c.redirect(`/dashboard/links?ok=${encodeURIComponent(`Deleted /${link.slug}`)}`, 303);
  });

  // --- QR & export -----------------------------------------------------------

  app.get("/dashboard/links/:slug/qr.svg", (c) => {
    const slug = c.req.param("slug");
    // Validate rather than trust: the slug lands inside the QR payload.
    if (!validateSlug(slug).ok || !store.slugExists(slug)) return c.notFound();

    const svg = qrSvg(`${config.baseUrl}/${encodeURIComponent(slug)}`, { scale: 0 });
    return c.body(svg, 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "content-disposition": `inline; filename="${slug}-qr.svg"`,
      "cache-control": "private, max-age=3600",
    });
  });

  app.get("/dashboard/links/:slug/export.csv", (c) => {
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.notFound();
    return csvResponse(c, store.exportClicks(link.id), `${link.slug}-clicks.csv`);
  });

  app.get("/dashboard/export.csv", (c) => {
    return csvResponse(c, store.exportClicks(undefined), "all-clicks.csv");
  });

  // --- Settings --------------------------------------------------------------

  app.get("/dashboard/settings", (c) => {
    return c.html(
      settingsPage(ctx.page, {
        keys: store.listApiKeys(),
        notice: c.req.query("ok") ?? undefined,
        error: c.req.query("error") ?? undefined,
        config: configSummary(),
      }),
    );
  });

  app.post("/dashboard/api-keys", async (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim().slice(0, 60);
    if (name === "") return c.redirect("/dashboard/settings?error=Name+is+required", 303);

    const secret = issueApiKey(store, name);
    // Rendered inline rather than passed through the URL: a query string ends
    // up in proxy logs and browser history.
    return c.html(
      settingsPage(ctx.page, {
        keys: store.listApiKeys(),
        newKey: secret,
        notice: `API key "${name}" created.`,
        config: configSummary(),
      }),
    );
  });

  app.post("/dashboard/api-keys/:id/delete", (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);
    const id = Number(c.req.param("id"));
    if (Number.isInteger(id)) store.deleteApiKey(id);
    return c.redirect("/dashboard/settings?ok=API+key+revoked", 303);
  });

  app.post("/dashboard/sessions/revoke", (c) => {
    if (!guard(c)) return c.text("Cross-origin request rejected", 403);
    store.deleteAllSessions();
    return c.redirect("/login", 303);
  });

  function csvResponse(c: Context, rows: Array<Record<string, unknown>>, filename: string) {
    const withIso = rows.map((r) => ({
      ...r,
      timestamp: new Date(Number(r.ts) * 1000).toISOString(),
    }));
    const csv = toCsv(withIso, [
      "timestamp",
      "slug",
      "referrer_host",
      "country",
      "browser",
      "os",
      "device",
      "lang",
    ]);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    });
  }
}
