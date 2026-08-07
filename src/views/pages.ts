import { html } from "hono/html";
import type { Bucket, LinkRow } from "../db.ts";
import {
  barChart,
  countryFlag,
  flash,
  fmtDate,
  fmtNum,
  fmtRelative,
  type Html,
  layout,
  statCard,
  topList,
  truncate,
} from "./ui.ts";

export interface PageCtx {
  cssHref: string;
  baseUrl: string;
}

// --- Login --------------------------------------------------------------------

export function loginPage(ctx: PageCtx, opts: { error?: string; notice?: string } = {}): Html {
  return layout({
    title: "Sign in · shorturl",
    cssHref: ctx.cssHref,
    body: html`
      <div class="center-page">
        <div class="card">
            <h1>Sign in</h1>
            <p class="subtitle">Dashboard access</p>
            ${opts.error ? flash("err", opts.error) : ""}
            ${opts.notice ? flash("ok", opts.notice) : ""}
            <form method="post" action="/login" class="stack">
              <div>
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required autofocus
                      autocomplete="current-password">
              </div>
              <button class="btn" type="submit">Sign in</button>
            </form>
          </div>
      </div>
    `,
  });
}

// --- Public landing -----------------------------------------------------------

export function homePage(
  ctx: PageCtx,
  opts: { publicShortening: boolean; created?: string; error?: string },
): Html {
  return layout({
    title: "shorturl",
    cssHref: ctx.cssHref,
    body: html`
      <div class="center-page">
        <div class="card">
            <h1>🔗 shorturl</h1>
            <p class="subtitle">A small, self-hosted URL shortener with privacy-preserving analytics.</p>
            ${opts.error ? flash("err", opts.error) : ""}
            ${opts.created
              ? html`
                <div class="copybox">
                  <span class="link mono">${opts.created}</span>
                  <a class="btn small" href="${opts.created}">Open</a>
                </div>
              `
              : ""}
            ${opts.publicShortening
              ? html`
                <form method="post" action="/shorten" class="stack">
                  <div>
                    <label for="target">Destination URL</label>
                    <input type="url" id="target" name="target" required
                      placeholder="https://example.com/a/very/long/path">
                  </div>
                  <button class="btn" type="submit">Shorten</button>
                </form>
              `
              : html`<p class="muted">Shortening is restricted to signed-in users.</p>`}
            <p class="muted"><a href="/dashboard">Dashboard →</a></p>
          </div>
      </div>
    `,
  });
}

// --- Overview -----------------------------------------------------------------

export interface OverviewData {
  totals: { links: number; clicks: number; visitors: number; active: number };
  day: { clicks: number; visitors: number };
  week: { clicks: number; visitors: number };
  series: Bucket[];
  topLinks: Array<LinkRow & { recent: number }>;
  referrers: Bucket[];
  countries: Bucket[];
  browsers: Bucket[];
  devices: Bucket[];
  discord: { enabled: boolean; published: boolean; intervalSeconds: number };
}

export function overviewPage(ctx: PageCtx, d: OverviewData): Html {
  return layout({
    title: "Overview · shorturl",
    cssHref: ctx.cssHref,
    nav: { active: "overview" },
    body: html`
      <div class="wrap">
        <h1>Overview</h1>
        <p class="subtitle">
              ${d.discord.enabled
                ? d.discord.published
                  ? html`Discord stats message is live, refreshing every ${
                    String(Math.round(d.discord.intervalSeconds / 60))
                  } min.`
                  : html`Discord reporter is enabled — the stats message will appear shortly.`
                : html`Discord reporter is off. Set <code>DISCORD_WEBHOOK_URL</code> to enable it.`}
            </p>

        <div class="grid stats">
              ${statCard(
                "Total clicks",
                d.totals.clicks,
                `${fmtNum(d.day.clicks)} in the last 24 h`,
              )}
              ${statCard(
                "Unique visitors",
                d.totals.visitors,
                `${fmtNum(d.day.visitors)} in the last 24 h`,
              )}
              ${statCard("Links", d.totals.links, `${fmtNum(d.totals.active)} active`)}
              ${statCard("Clicks · 7 days", d.week.clicks, `${fmtNum(d.week.visitors)} visitors`)}
            </div>

        <h2>Clicks · last 30 days</h2>
        <div class="card">${barChart(d.series, { label: "clicks per day over 30 days" })}</div>

        <h2>Top links · last 7 days</h2>
        <div class="card table-wrap">
              ${d.topLinks.length === 0
                ? html`<div class="empty">No clicks recorded yet.</div>`
                : html`
                  <table>
                    <thead>
                      <tr>
                        <th>Slug</th>
                        <th>Destination</th>
                        <th class="num">7 d</th>
                        <th class="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>${d.topLinks.map((l) =>
                      html`
                        <tr>
                          <td><a class="mono" href="/dashboard/links/${l.slug}">${l.slug}</a></td>
                          <td class="truncate muted">${truncate(l.target, 60)}</td>
                          <td class="num">${fmtNum(l.recent)}</td>
                          <td class="num">${fmtNum(l.click_count)}</td>
                        </tr>
                      `
                    )}</tbody>
                  </table>
                `}
            </div>

        <div class="grid halves">
          <div>
            <h2>Referrers · 7 d</h2>
            <div class="card">
                ${topList(d.referrers, { empty: "No referrers recorded (direct traffic only)." })}
              </div>
          </div>
          <div>
            <h2>Countries · 7 d</h2>
            <div class="card">
                ${topList(d.countries, { empty: "No country data.", icon: countryFlag })}
              </div>
          </div>
          <div>
            <h2>Browsers · 7 d</h2>
            <div class="card">
                ${topList(d.browsers, { empty: "No data." })}
              </div>
          </div>
          <div>
            <h2>Devices · 7 d</h2>
            <div class="card">
                ${topList(d.devices, { empty: "No data." })}
              </div>
          </div>
        </div>
      </div>
    `,
  });
}

// --- Links list ---------------------------------------------------------------

export interface LinksData {
  links: LinkRow[];
  total: number;
  page: number;
  pages: number;
  search: string;
  sort: string;
  notice?: string;
  error?: string;
}

export function linksPage(ctx: PageCtx, d: LinksData): Html {
  const qs = (page: number) =>
    `/dashboard/links?page=${page}` +
    (d.search ? `&q=${encodeURIComponent(d.search)}` : "") +
    (d.sort ? `&sort=${encodeURIComponent(d.sort)}` : "");

  return layout({
    title: "Links · shorturl",
    cssHref: ctx.cssHref,
    nav: { active: "links" },
    body: html`<div class="wrap">
      <h1>Links</h1>
      <p class="subtitle">${fmtNum(d.total)} link${d.total === 1 ? "" : "s"}</p>
      ${d.notice ? flash("ok", d.notice) : ""}
      ${d.error ? flash("err", d.error) : ""}

      <div class="card">
        <form method="get" action="/dashboard/links" class="row">
          <div>
            <label for="q">Search <span class="opt">slug, destination or note</span></label>
            <input type="search" id="q" name="q" value="${d.search}">
          </div>
          <div>
            <label for="sort">Sort</label>
            <select id="sort" name="sort">
              <option value="newest" ${d.sort === "newest" ? "selected" : ""}>Newest first</option>
              <option value="clicks" ${d.sort === "clicks" ? "selected" : ""}>Most clicked</option>
              <option value="oldest" ${d.sort === "oldest" ? "selected" : ""}>Oldest first</option>
            </select>
          </div>
          <div class="actions">
            <button class="btn secondary" type="submit">Apply</button>
            <a class="btn" href="/dashboard/new">New link</a>
          </div>
        </form>
      </div>

      <div class="card table-wrap">
        ${
      d.links.length === 0 ? html`<div class="empty">No links match.</div>` : html`
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Destination</th>
              <th>Status</th>
              <th class="num">Clicks</th>
              <th>Last click</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>${d.links.map((l) => linkRow(l))}</tbody>
        </table>
      `
    }
      </div>

      ${
      d.pages > 1
        ? html`<div class="actions">
            ${
          d.page > 1
            ? html`<a class="btn secondary small" href="${qs(d.page - 1)}">← Previous</a>`
            : ""
        }
            <span class="muted">Page ${String(d.page)} of ${String(d.pages)}</span>
            ${
          d.page < d.pages
            ? html`<a class="btn secondary small" href="${qs(d.page + 1)}">Next →</a>`
            : ""
        }
          </div>`
        : ""
    }
    </div>`,
  });
}

function linkRow(l: LinkRow): Html {
  return html`
    <tr>
      <td><a class="mono" href="/dashboard/links/${l.slug}">${l.slug}</a></td>
      <td class="truncate muted">${truncate(l.target, 64)}</td>
      <td>${statusPill(l)}</td>
      <td class="num">${fmtNum(l.click_count)}</td>
      <td class="muted">${fmtRelative(l.last_click_at)}</td>
      <td class="muted">${fmtRelative(l.created_at)}</td>
    </tr>
  `;
}

function statusPill(l: LinkRow): Html {
  const now = Math.floor(Date.now() / 1000);
  if (l.disabled) return html`<span class="pill off">disabled</span>`;
  if (l.expires_at && l.expires_at <= now) return html`<span class="pill exp">expired</span>`;
  if (l.expires_at) return html`<span class="pill exp">expires ${fmtRelative(l.expires_at)}</span>`;
  return html`<span class="pill on">active</span>`;
}

// --- New link -----------------------------------------------------------------

export function newLinkPage(
  ctx: PageCtx,
  opts: { error?: string; values?: Record<string, string> } = {},
): Html {
  const v = opts.values ?? {};
  return layout({
    title: "New link · shorturl",
    cssHref: ctx.cssHref,
    nav: { active: "new" },
    body: html`<div class="wrap">
      <h1>New link</h1>
      <p class="subtitle">Leave the slug blank to generate a random one.</p>
      ${opts.error ? flash("err", opts.error) : ""}
      <div class="card">
        <form method="post" action="/dashboard/links" class="stack">
          <div>
            <label for="target">Destination URL</label>
            <input type="url" id="target" name="target" required autofocus
                   value="${v.target ?? ""}" placeholder="https://example.com/page">
          </div>
          <div class="row">
            <div>
              <label for="slug">Custom slug <span class="opt">optional</span></label>
              <input type="text" id="slug" name="slug" value="${v.slug ?? ""}"
                     pattern="[A-Za-z0-9_-]{3,64}" placeholder="launch-2026">
            </div>
            <div>
              <label for="expires">Expires on <span class="opt">optional, UTC</span></label>
              <input type="date" id="expires" name="expires" value="${v.expires ?? ""}">
            </div>
          </div>
          <div>
            <label for="note">Note <span class="opt">optional, private</span></label>
            <input type="text" id="note" name="note" maxlength="280" value="${v.note ?? ""}"
                   placeholder="Newsletter #42 — header button">
          </div>
          <div class="actions">
            <button class="btn" type="submit">Create link</button>
            <a class="btn secondary" href="/dashboard/links">Cancel</a>
          </div>
        </form>
      </div>
    </div>`,
  });
}

// --- Link detail --------------------------------------------------------------

export interface LinkDetailData {
  link: LinkRow;
  shortUrl: string;
  day: { clicks: number; visitors: number };
  week: { clicks: number; visitors: number };
  uniqueTotal: number;
  series: Bucket[];
  hourly: Bucket[];
  referrers: Bucket[];
  countries: Bucket[];
  browsers: Bucket[];
  devices: Bucket[];
  notice?: string;
  error?: string;
}

export function linkDetailPage(ctx: PageCtx, d: LinkDetailData): Html {
  const l = d.link;
  const expiresValue = l.expires_at ? new Date(l.expires_at * 1000).toISOString().slice(0, 10) : "";

  return layout({
    title: `${l.slug} · shorturl`,
    cssHref: ctx.cssHref,
    nav: { active: "links" },
    body: html`<div class="wrap">
      <h1><span class="mono">/${l.slug}</span> ${statusPill(l)}</h1>
      <p class="subtitle">Created ${fmtDate(l.created_at)} · last click ${
      fmtRelative(l.last_click_at)
    }</p>
      ${d.notice ? flash("ok", d.notice) : ""}
      ${d.error ? flash("err", d.error) : ""}

      <div class="copybox">
        <span class="link mono">${d.shortUrl}</span>
        <a class="btn small" href="${d.shortUrl}">Open</a>
        <a class="btn small secondary" href="/dashboard/links/${l.slug}/qr.svg" download>
          Download QR
        </a>
        <a class="btn small secondary" href="/dashboard/links/${l.slug}/export.csv">Export CSV</a>
      </div>

      <div class="grid stats">
        ${statCard("Total clicks", l.click_count)}
        ${statCard("Unique visitors", d.uniqueTotal)}
        ${statCard("Last 24 h", d.day.clicks, `${fmtNum(d.day.visitors)} visitors`)}
        ${statCard("Last 7 days", d.week.clicks, `${fmtNum(d.week.visitors)} visitors`)}
      </div>

      <h2>Clicks · last 30 days</h2>
      <div class="card">${barChart(d.series, { label: "clicks per day" })}</div>

      <h2>Clicks · last 48 hours</h2>
      <div class="card">${barChart(d.hourly, { height: 110, label: "clicks per hour" })}</div>

      <div class="grid halves">
        <div><h2>Referrers</h2><div class="card">
          ${topList(d.referrers, { empty: "Direct traffic only." })}
        </div></div>
        <div><h2>Countries</h2><div class="card">
          ${topList(d.countries, { empty: "No country data.", icon: countryFlag })}
        </div></div>
        <div><h2>Browsers</h2><div class="card">${
      topList(d.browsers, { empty: "No data." })
    }</div></div>
        <div><h2>Devices</h2><div class="card">${
      topList(d.devices, { empty: "No data." })
    }</div></div>
      </div>

      <h2>QR code</h2>
      <div class="card">
        <img class="qr" src="/dashboard/links/${l.slug}/qr.svg" alt="QR code for ${d.shortUrl}"
             width="200" height="200">
      </div>

      <h2>Settings</h2>
      <div class="card">
        <form method="post" action="/dashboard/links/${l.slug}" class="stack">
          <div>
            <label for="target">Destination URL</label>
            <input type="url" id="target" name="target" required value="${l.target}">
          </div>
          <div class="row">
            <div>
              <label for="expires">Expires on <span class="opt">blank = never</span></label>
              <input type="date" id="expires" name="expires" value="${expiresValue}">
            </div>
            <div>
              <label for="note">Note</label>
              <input type="text" id="note" name="note" maxlength="280" value="${l.note ?? ""}">
            </div>
          </div>
          <div class="actions">
            <button class="btn" type="submit">Save changes</button>
          </div>
        </form>
      </div>

      <h2>Danger zone</h2>
      <div class="card actions">
        <form method="post" action="/dashboard/links/${l.slug}/toggle" class="inline-form">
          <button class="btn secondary" type="submit">
            ${l.disabled ? "Re-enable link" : "Disable link"}
          </button>
        </form>
        <form method="post" action="/dashboard/links/${l.slug}/delete" class="inline-form">
          <button class="btn danger" type="submit">Delete link and its analytics</button>
        </form>
        <span class="muted">Deleting is permanent and removes every recorded click.</span>
      </div>
    </div>`,
  });
}

// --- Settings -----------------------------------------------------------------

export interface SettingsData {
  keys: Array<
    { id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }
  >;
  newKey?: string;
  notice?: string;
  error?: string;
  config: {
    baseUrl: string;
    publicShortening: boolean;
    trustProxy: boolean;
    retentionDays: number;
    redirectStatus: number;
    discordEnabled: boolean;
    discordInterval: number;
  };
}

export function settingsPage(ctx: PageCtx, d: SettingsData): Html {
  return layout({
    title: "Settings · shorturl",
    cssHref: ctx.cssHref,
    nav: { active: "settings" },
    body: html`<div class="wrap">
      <h1>Settings</h1>
      <p class="subtitle">Runtime configuration comes from the environment; this page is read-only
        except for API keys.</p>
      ${d.notice ? flash("ok", d.notice) : ""}
      ${d.error ? flash("err", d.error) : ""}

      ${
      d.newKey
        ? html`<div class="flash ok">
            <strong>Copy this key now — it is not stored and cannot be shown again:</strong><br>
            <code>${d.newKey}</code>
          </div>`
        : ""
    }

      <h2>API keys</h2>
      <div class="card">
        <form method="post" action="/dashboard/api-keys" class="row">
          <div>
            <label for="name">Key name</label>
            <input type="text" id="name" name="name" required maxlength="60"
                   placeholder="ci-pipeline">
          </div>
          <div class="actions"><button class="btn" type="submit">Create key</button></div>
        </form>
      </div>
      <div class="card table-wrap">
        ${
      d.keys.length === 0 ? html`<div class="empty">No API keys yet.</div>` : html`
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${d.keys.map((k) =>
            html`
              <tr>
                <td>${k.name}</td>
                <td class="mono muted">${k.prefix}…</td>
                <td class="muted">${fmtDate(k.created_at)}</td>
                <td class="muted">${fmtRelative(k.last_used_at)}</td>
                <td>
                  <form method="post" action="/dashboard/api-keys/${String(k.id)}/delete"
                    class="inline-form">
                    <button class="btn danger small" type="submit">Revoke</button>
                  </form>
                </td>
              </tr>
            `
          )}</tbody>
        </table>
      `
    }
      </div>

      <h2>Current configuration</h2>
      <div class="card table-wrap">
        <table>
          <tbody>
            <tr><td>Base URL</td><td class="mono">${d.config.baseUrl}</td></tr>
            <tr><td>Public shortening</td><td>${d.config.publicShortening ? "on" : "off"}</td></tr>
            <tr><td>Trust proxy headers</td><td>${d.config.trustProxy ? "on" : "off"}</td></tr>
            <tr><td>Redirect status</td><td>${String(d.config.redirectStatus)}</td></tr>
            <tr><td>Analytics retention</td><td>${
      d.config.retentionDays === 0 ? "forever" : `${String(d.config.retentionDays)} days`
    }</td></tr>
            <tr><td>Discord reporter</td><td>${
      d.config.discordEnabled
        ? `on, every ${String(Math.round(d.config.discordInterval / 60))} min`
        : "off"
    }</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Sessions</h2>
      <div class="card actions">
        <form method="post" action="/dashboard/sessions/revoke" class="inline-form">
          <button class="btn danger" type="submit">Sign out everywhere</button>
        </form>
        <span class="muted">Invalidates every dashboard session, including this one.</span>
      </div>
    </div>`,
  });
}

// --- Errors -------------------------------------------------------------------

export function errorPage(ctx: PageCtx, status: number, message: string): Html {
  return layout({
    title: `${status} · shorturl`,
    cssHref: ctx.cssHref,
    body: html`
      <div class="center-page">
        <div class="card">
          <h1>${String(status)}</h1>
          <p class="subtitle">${message}</p>
          <a class="btn secondary" href="/">Back to start</a>
        </div>
      </div>
    `,
  });
}
