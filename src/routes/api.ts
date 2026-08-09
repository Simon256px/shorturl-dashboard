/**
 * JSON API.
 *
 * Authentication is a bearer API key (or a dashboard session, which makes the
 * API usable straight from the browser while signed in). Everything is scoped
 * to the single admin identity — there are no per-user permissions to get
 * wrong.
 */

import type { Context } from "hono";
import type { AppCtx, AppEnv, AppHono } from "../app.ts";
import { authenticate, csrfOk } from "../auth.ts";
import { hasOpenGraph, type LinkRow } from "../db.ts";
import {
  clientIp,
  createLink,
  linkState,
  normaliseOpenGraph,
  parseExpiry,
  toCsv,
} from "../service.ts";
import { validateTarget } from "../util/target-url.ts";

const WEEK = 7 * 86400;

export function registerApi(app: AppHono, ctx: AppCtx): void {
  const { store, config } = ctx;

  /** Auth + rate limit for the whole /api surface. */
  app.use("/api/*", async (c, next) => {
    const auth = authenticate(c, store);
    if (!auth) {
      c.header("www-authenticate", 'Bearer realm="shorturl"');
      return c.json({ error: "Authentication required" }, 401);
    }
    const rl = ctx.limiters.api.check(`${auth.kind}:${auth.label}:${clientIp(c, config)}`);
    if (!rl.allowed) {
      c.header("retry-after", String(rl.retryAfter));
      return c.json({ error: "Rate limit exceeded", retry_after: rl.retryAfter }, 429);
    }
    c.header("x-ratelimit-remaining", String(rl.remaining));
    c.set("auth", auth);
    await next();
  });

  const requireCsrf = (c: Context<AppEnv>): boolean => csrfOk(c, config, c.get("auth") ?? null);

  // --- Links -----------------------------------------------------------------

  app.get("/api/links", (c) => {
    const limit = clampInt(c.req.query("limit"), 50, 1, 500);
    const offset = clampInt(c.req.query("offset"), 0, 0, 1_000_000);
    const search = (c.req.query("q") ?? "").trim().slice(0, 120) || undefined;

    return c.json({
      total: store.countLinks(search),
      limit,
      offset,
      links: store.listLinks({ limit, offset, search, sort: c.req.query("sort") ?? "newest" })
        .map((l) => serialize(l, config.baseUrl)),
    });
  });

  app.post("/api/links", async (c) => {
    if (!requireCsrf(c)) return c.json({ error: "Cross-origin request rejected" }, 403);

    const body = await readJson(c);
    if (!body) return c.json({ error: "Expected a JSON object body" }, 400);

    const expiry = typeof body.expires_at === "number"
      ? { ok: true as const, value: body.expires_at }
      : parseExpiry(typeof body.expires === "string" ? body.expires : null);
    if (!expiry.ok) return c.json({ error: expiry.error }, 400);

    const result = createLink(store, config, {
      target: String(body.target ?? body.url ?? ""),
      slug: typeof body.slug === "string" ? body.slug : null,
      note: typeof body.note === "string" ? body.note : null,
      expiresAt: expiry.value,
      ogTitle: typeof body.og_title === "string" ? body.og_title : null,
      ogDescription: typeof body.og_description === "string" ? body.og_description : null,
      ogImage: typeof body.og_image === "string" ? body.og_image : null,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400);

    c.header("location", `${config.baseUrl}/${encodeURIComponent(result.value.slug)}`);
    return c.json(serialize(result.value, config.baseUrl), 201);
  });

  app.get("/api/links/:slug", (c) => {
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.json({ error: "Not found" }, 404);

    return c.json({
      ...serialize(link, config.baseUrl),
      stats: {
        total_clicks: link.click_count,
        unique_visitors: store.clicksSince(100 * 365 * 86400, link.id).visitors,
        last_24h: store.clicksSince(86400, link.id),
        last_7d: store.clicksSince(WEEK, link.id),
        daily: store.dailySeries(30, link.id),
        referrers: store.topDimension("referrer_host", { limit: 10, linkId: link.id }),
        countries: store.topDimension("country", { limit: 10, linkId: link.id }),
        browsers: store.topDimension("browser", { limit: 10, linkId: link.id }),
        devices: store.topDimension("device", { limit: 10, linkId: link.id }),
      },
    });
  });

  app.patch("/api/links/:slug", async (c) => {
    if (!requireCsrf(c)) return c.json({ error: "Cross-origin request rejected" }, 403);

    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.json({ error: "Not found" }, 404);

    const body = await readJson(c);
    if (!body) return c.json({ error: "Expected a JSON object body" }, 400);

    const patch: Parameters<typeof store.updateLink>[1] = {};

    if (body.target !== undefined || body.url !== undefined) {
      const check = validateTarget(String(body.target ?? body.url), {
        allowPrivate: config.allowPrivateTargets,
        selfOrigin: config.baseOrigin,
      });
      if (!check.ok) return c.json({ error: check.error }, 400);
      patch.target = check.url;
    }
    if (body.note !== undefined) {
      patch.note = body.note === null ? null : String(body.note).trim().slice(0, 280) || null;
    }
    if (body.disabled !== undefined) patch.disabled = Boolean(body.disabled);

    // Card fields are individually patchable, and `null` clears one. Absent
    // keys are left alone, so updating only the target keeps the card intact.
    if (
      body.og_title !== undefined || body.og_description !== undefined ||
      body.og_image !== undefined
    ) {
      const og = normaliseOpenGraph({
        ogTitle: body.og_title === undefined ? link.og_title : asNullableString(body.og_title),
        ogDescription: body.og_description === undefined
          ? link.og_description
          : asNullableString(body.og_description),
        ogImage: body.og_image === undefined ? link.og_image : asNullableString(body.og_image),
      }, config);
      if (!og.ok) return c.json({ error: og.error }, 400);
      Object.assign(patch, og.value);
    }
    if (body.expires !== undefined || body.expires_at !== undefined) {
      if (body.expires_at === null || body.expires === null) {
        patch.expiresAt = null;
      } else if (typeof body.expires_at === "number") {
        patch.expiresAt = body.expires_at;
      } else {
        const expiry = parseExpiry(String(body.expires));
        if (!expiry.ok) return c.json({ error: expiry.error }, 400);
        patch.expiresAt = expiry.value;
      }
    }

    store.updateLink(link.id, patch);
    return c.json(serialize(store.getLinkById(link.id)!, config.baseUrl));
  });

  app.delete("/api/links/:slug", (c) => {
    if (!requireCsrf(c)) return c.json({ error: "Cross-origin request rejected" }, 403);
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.json({ error: "Not found" }, 404);

    store.deleteLink(link.id);
    return c.body(null, 204);
  });

  app.get("/api/links/:slug/clicks.csv", (c) => {
    const link = store.getLinkBySlug(c.req.param("slug"));
    if (!link) return c.json({ error: "Not found" }, 404);

    const rows = store.exportClicks(link.id).map((r) => ({
      ...r,
      timestamp: new Date(Number(r.ts) * 1000).toISOString(),
    }));
    return c.body(
      toCsv(rows, [
        "timestamp",
        "slug",
        "referrer_host",
        "country",
        "browser",
        "os",
        "device",
        "lang",
      ]),
      200,
      {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${link.slug}-clicks.csv"`,
      },
    );
  });

  // --- Aggregate stats -------------------------------------------------------

  app.get("/api/stats", (c) => {
    return c.json({
      totals: store.globalTotals(),
      last_24h: store.clicksSince(86400),
      last_7d: store.clicksSince(WEEK),
      daily: store.dailySeries(30),
      hourly: store.hourlySeries(24),
      top_links: store.topLinks(10, WEEK).map((l) => ({
        ...serialize(l, config.baseUrl),
        recent_clicks: l.recent,
      })),
      referrers: store.topDimension("referrer_host", { limit: 10, sinceSeconds: WEEK }),
      countries: store.topDimension("country", { limit: 10, sinceSeconds: WEEK }),
      browsers: store.topDimension("browser", { limit: 10, sinceSeconds: WEEK }),
      devices: store.topDimension("device", { limit: 10, sinceSeconds: WEEK }),
    });
  });

  /** Force an immediate Discord refresh — handy from CI after a deploy. */
  app.post("/api/discord/refresh", async (c) => {
    if (!requireCsrf(c)) return c.json({ error: "Cross-origin request rejected" }, 403);
    if (!ctx.discord.enabled) return c.json({ error: "Discord reporter is disabled" }, 409);
    await ctx.discord.tick();
    return c.json({ status: "ok" });
  });
}

// --- Helpers ------------------------------------------------------------------

function serialize(link: LinkRow, baseUrl: string) {
  return {
    slug: link.slug,
    short_url: `${baseUrl}/${encodeURIComponent(link.slug)}`,
    target: link.target,
    note: link.note,
    state: linkState(link),
    disabled: Boolean(link.disabled),
    clicks: link.click_count,
    created_at: link.created_at,
    expires_at: link.expires_at,
    last_click_at: link.last_click_at,
    card: {
      // `active: false` means preview crawlers get the plain redirect and the
      // destination's own card shows.
      active: hasOpenGraph(link),
      title: link.og_title,
      description: link.og_description,
      image: link.og_image,
    },
  };
}

/** `null` clears a field; anything else is coerced to a trimmed string. */
function asNullableString(v: unknown): string | null {
  return v === null ? null : String(v);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Returns null for anything that isn't a JSON object, so callers can 400. */
async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
