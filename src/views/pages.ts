import { html } from "hono/html";
import type { Bucket, ChannelStat, LinkRow } from "../db.ts";
import type { ChannelRow, ChannelSet, DetectedChannel } from "../util/channel.ts";
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
  /** Declared channels — what you said when you created each link. */
  channels: ChannelStat[];
  /** Channels inferred from referrers — where the clicks actually came from. */
  detected: DetectedChannel[];
  /** The channel table, for labels and icons. */
  channelSet: ChannelSet;
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

        <h2>Channels</h2>
        <p class="subtitle chanhelp">
              <strong>Declared</strong> is where you said you published each link.
              <strong>Detected</strong> is what the referrers claim. The two rarely
              match exactly: Twitter and most mobile apps send no referrer, so
              detected always reads low. A network showing up in detected that you
              never declared means someone reshared the link there.
            </p>

        <div class="grid halves">
          <div>
            <h2>Declared channels</h2>
            <div class="card table-wrap">
              ${d.channels.length === 0 ? html`<div class="empty">No links yet.</div>` : html`
                <table>
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th class="num">Links</th>
                      <th class="num">7 d</th>
                      <th class="num">Visitors</th>
                      <th class="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>${d.channels.map((row) =>
                    html`
                      <tr>
                        <td>${row.channel
                          ? html`<a href="/dashboard/links?channel=${row.channel}">${
                            d.channelSet.display(row.channel)
                          }</a>`
                          : html`<a class="muted" href="/dashboard/links?channel=none">${
                            d.channelSet.display(null)
                          }</a>`}</td>
                        <td class="num">${fmtNum(row.links)}</td>
                        <td class="num">${fmtNum(row.recent)}</td>
                        <td class="num">${fmtNum(row.visitors)}</td>
                        <td class="num">${fmtNum(row.clicks)}</td>
                      </tr>
                    `
                  )}</tbody>
                </table>
              `}
            </div>
          </div>
          <div>
            <h2>Detected channels · 7 d</h2>
            <div class="card">
                ${topList(detectedBuckets(d.detected, d.channelSet), {
                  empty: "No referrers recorded — every click arrived without one.",
                })}
              </div>
          </div>
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
  /** `""` = every channel, `"none"` = unattributed only, otherwise a channel id. */
  channel: string;
  channelSet: ChannelSet;
  notice?: string;
  error?: string;
}

export function linksPage(ctx: PageCtx, d: LinksData): Html {
  const qs = (page: number) =>
    `/dashboard/links?page=${page}` +
    (d.search ? `&q=${encodeURIComponent(d.search)}` : "") +
    (d.sort ? `&sort=${encodeURIComponent(d.sort)}` : "") +
    (d.channel ? `&channel=${encodeURIComponent(d.channel)}` : "");

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
            <label for="channel">Channel</label>
            <select id="channel" name="channel">
              <option value="" ${d.channel === "" ? "selected" : ""}>All channels</option>
              <option value="none" ${d.channel === "none" ? "selected" : ""}>Unattributed</option>
              ${
      d.channelSet.all.map((ch) =>
        html`<option value="${ch.id}" ${
          d.channel === ch.id ? "selected" : ""
        }>${ch.icon} ${ch.label}</option>`
      )
    }
            </select>
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
              <th>Channel</th>
              <th>Status</th>
              <th class="num">Clicks</th>
              <th>Last click</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>${d.links.map((l) => linkRow(l, d.channelSet))}</tbody>
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

function linkRow(l: LinkRow, channels: ChannelSet): Html {
  return html`
    <tr>
      <td><a class="mono" href="/dashboard/links/${l.slug}">${l.slug}</a></td>
      <td class="truncate muted">${truncate(l.target, 64)}</td>
      <td>${channelCell(l.channel, channels)}</td>
      <td>${statusPill(l)}</td>
      <td class="num">${fmtNum(l.click_count)}</td>
      <td class="muted">${fmtRelative(l.last_click_at)}</td>
      <td class="muted">${fmtRelative(l.created_at)}</td>
    </tr>
  `;
}

/**
 * One sentence comparing what was declared against what the referrers show.
 *
 * Hedged on purpose. Referrer coverage is partial by construction, so a low
 * detected count is the expected case and never evidence of anything. Only
 * traffic from a *different* known network is worth flagging.
 */
function channelVerdict(
  declared: string | null,
  detected: DetectedChannel[],
  channels: ChannelSet,
): Html {
  const known = detected.filter((d) => d.channel !== null);
  const referred = detected.reduce((n, d) => n + d.clicks, 0);

  if (!declared) {
    const top = known[0];
    return top
      ? html`<span class="muted">Nothing declared — referrers suggest ${
        channels.label(top.channel)
      }.</span>`
      : html`<span class="muted">No channel declared.</span>`;
  }

  if (referred === 0) {
    return html`<span class="muted">
      No referrer data yet, which proves nothing — most apps send none.
    </span>`;
  }

  const elsewhere = known
    .filter((d) => d.channel !== declared)
    .reduce((n, d) => n + d.clicks, 0);

  if (elsewhere === 0) {
    return html`<span class="muted">Referrers agree, as far as they reach.</span>`;
  }
  return html`
    <span
      class="flag">${String(
        Math.round((elsewhere / referred) * 100),
      )} % of referred clicks came from another network — probably reshared.</span>
  `;
}

/** Unrecognised hosts are named rather than dropped: they are real traffic. */
function detectedBuckets(detected: DetectedChannel[], channels: ChannelSet): Bucket[] {
  return detected.map((d) => ({
    label: d.channel ? channels.display(d.channel) : "🔗 Other referrers",
    value: d.clicks,
  }));
}

function channelCell(channel: string | null, channels: ChannelSet): Html {
  if (!channel) return html`<span class="muted">—</span>`;
  return html`<a class="pill ch" href="/dashboard/links?channel=${channel}">${
    channels.icon(channel)
  } ${channels.label(channel)}</a>`;
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
  channels: ChannelSet,
  opts: { error?: string; values?: Record<string, string> } = {},
): Html {
  const v = opts.values ?? {};
  return layout({
    title: "New link · shorturl",
    cssHref: ctx.cssHref,
    nav: { active: "new" },
    body: html`<div class="wrap">
      <h1>New link</h1>
      <p class="subtitle">
        Leave the slug blank to generate a random one — picking a channel prefixes
        it, so a Twitter link comes out as <span class="mono">/twA8f3k</span>.
      </p>
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
            ${channelField(v.channel ?? null, channels)}
          </div>
          <div>
            <label for="note">Note <span class="opt">optional, private</span></label>
            <input type="text" id="note" name="note" maxlength="280" value="${v.note ?? ""}"
                   placeholder="Newsletter #42 — header button">
          </div>

          ${socialCardFields(v)}

          <div class="actions">
            <button class="btn" type="submit">Create link</button>
            <a class="btn secondary" href="/dashboard/links">Cancel</a>
          </div>
        </form>
      </div>
    </div>`,
  });
}

/**
 * Channel picker, shared by the create and edit forms.
 *
 * A `<select>` rather than a free-text field on purpose: the value is what the
 * per-channel stats group by, so "Twitter" and "twiter" as two rows would be
 * worse than useless. The prefix is shown next to each name because it changes
 * the slug you are about to get. Manage the list under Settings.
 */
function channelField(selected: string | null, channels: ChannelSet): Html {
  return html`
    <div>
      <label for="channel">Channel <span class="opt">optional</span></label>
      <select id="channel" name="channel">
        <option value="" ${selected ? "" : "selected"}>— unattributed —</option>
        ${channels.all.map((ch) =>
          html`<option value="${ch.id}" ${
            selected === ch.id ? "selected" : ""
          }>${ch.icon} ${ch.label} · /${ch.prefix}…</option>`
        )}
      </select>
    </div>
  `;
}

/**
 * The Open Graph card editor, shared by the create and edit forms so the two
 * cannot drift apart.
 */
function socialCardFields(v: Record<string, string>): Html {
  return html`
    <fieldset class="cardfields">
      <legend>Social card <span class="opt">optional</span></legend>
      <p class="muted fieldhelp">
          Fill any field and this short link shows your own preview on Discord, X,
          Slack and the rest. Leave all three empty and the destination's own card
          is used, exactly as before.
        </p>
      <div>
        <label for="og_title">Card title</label>
        <input type="text" id="og_title" name="og_title" maxlength="120"
          value="${v.og_title ?? ""}" placeholder="Support my work on Ko-fi">
      </div>
      <div>
        <label for="og_description">Card description</label>
        <input type="text" id="og_description" name="og_description" maxlength="300"
          value="${v.og_description ?? ""}"
          placeholder="Every coffee helps me keep building open source tools.">
      </div>
      <div>
        <label for="og_image">Card image URL
            <span class="opt">https, 1200×630 recommended</span></label>
        <input type="url" id="og_image" name="og_image" value="${v.og_image ?? ""}"
          placeholder="https://example.com/card.png">
      </div>
    </fieldset>
  `;
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
  /** Referrer-derived channels for this link, for the declared/actual comparison. */
  detected: DetectedChannel[];
  channelSet: ChannelSet;
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

      <h2>Channel</h2>
      <div class="card">
        <p class="chanverdict">${channelCell(l.channel, d.channelSet)} ${
      channelVerdict(l.channel, d.detected, d.channelSet)
    }</p>
        ${
      d.detected.length > 0
        ? topList(detectedBuckets(d.detected, d.channelSet), { empty: "" })
        : html`<div class="empty">No referrers recorded for this link yet.</div>`
    }
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
            ${channelField(l.channel, d.channelSet)}
          </div>
          <p class="muted fieldhelp">
            Changing the channel re-labels the stats from here on. It does not
            rename the slug — <span class="mono">/${l.slug}</span> keeps working
            wherever you already posted it.
          </p>

          ${
      socialCardFields({
        og_title: l.og_title ?? "",
        og_description: l.og_description ?? "",
        og_image: l.og_image ?? "",
      })
    }

          <div class="actions">
            <button class="btn" type="submit">Save changes</button>
          </div>
        </form>
      </div>

      ${cardPreview(l, d.shortUrl)}

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

/**
 * Approximation of how the card lands in a chat client. Deliberately labelled
 * as an approximation — every platform crops and truncates differently, so the
 * only authoritative check is posting the link somewhere.
 */
function cardPreview(l: LinkRow, shortUrl: string): Html {
  if (!l.og_title && !l.og_description && !l.og_image) {
    return html`
      <h2>Social card</h2>
      <div class="card">
        <p class="muted">
                No card set — sharing this link shows the destination's own preview.
                Fill the card fields above to override it.
              </p>
      </div>
    `;
  }

  return html`
    <h2>Social card</h2>
    <div class="card">
      <div class="ogcard">
            <div class="ogcard-host">${hostOfUrl(shortUrl)}</div>
            <div class="ogcard-title">${l.og_title ?? hostOfUrl(l.target)}</div>
            ${l.og_description ? html`<div class="ogcard-desc">${l.og_description}</div>` : ""}
            ${l.og_image
              ? html`
                <img class="ogcard-img" src="${l.og_image}" alt="Card image preview"
                  loading="lazy" width="600" height="315">
              `
              : ""}
          </div>
      <p class="muted fieldhelp">
            Approximate. Crawlers cache aggressively, so an edit can take a few
            minutes to appear — and a platform that already cached the old card may
            keep showing it until its own cache expires.
          </p>
    </div>
  `;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// --- Settings -----------------------------------------------------------------

export interface SettingsData {
  keys: Array<
    { id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }
  >;
  channels: readonly ChannelRow[];
  /** Links per channel id, so the table can warn before a delete detaches them. */
  channelUse: Map<string, number>;
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
        except for API keys and channels.</p>
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

      <h2>Channels</h2>
      <p class="subtitle chanhelp">
        The networks offered when you create a link. The twelve shipped by default are
        ordinary rows — rename, re-prefix or delete any of them. Editing a prefix never
        rewrites slugs that already exist.
      </p>
      <div class="card table-wrap">
        ${
      d.channels.length === 0 ? html`<div class="empty">No channels — add one below.</div>` : html`
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Prefix</th>
              <th>Referrer hosts</th>
              <th class="num">Links</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${d.channels.map((ch) =>
            html`
              <tr>
                <td>${ch.icon}</td>
                <td>${ch.label}</td>
                <td class="mono muted">/${ch.prefix}…</td>
                <td class="muted truncate">${ch.hosts.length === 0
                  ? html`<span class="muted">— none, so it is never auto-detected</span>`
                  : truncate(ch.hosts.join(", "), 52)}</td>
                <td class="num">${fmtNum(d.channelUse.get(ch.id) ?? 0)}</td>
                <td>
                  <a class="btn secondary small" href="/dashboard/channels/${ch.id}">Edit</a>
                </td>
              </tr>
            `
          )}</tbody>
        </table>
      `
    }
      </div>
      <div class="card">
        <form method="post" action="/dashboard/channels" class="stack">
          <div class="row">
            <div>
              <label for="ch_label">Name</label>
              <input type="text" id="ch_label" name="label" required maxlength="40"
                     placeholder="Pinterest">
            </div>
            <div>
              <label for="ch_prefix">Slug prefix <span class="opt">2–3 letters, no l</span></label>
              <input type="text" id="ch_prefix" name="prefix" required pattern="[A-Za-z]{2,3}"
                     placeholder="pn">
            </div>
            <div>
              <label for="ch_icon">Icon <span class="opt">emoji</span></label>
              <input type="text" id="ch_icon" name="icon" required placeholder="📌">
            </div>
          </div>
          <div>
            <label for="ch_hosts">Referrer hosts <span class="opt">optional, comma or
              newline separated</span></label>
            <input type="text" id="ch_hosts" name="hosts"
                   placeholder="pinterest.com, pin.it">
          </div>
          <p class="muted fieldhelp">
            Hosts are only used to detect traffic arriving from that network. Leave blank and
            the channel still works — you just won't get the declared/detected comparison for
            it. Pasting a full URL is fine, it gets reduced to the hostname.
          </p>
          <div class="actions"><button class="btn" type="submit">Add channel</button></div>
        </form>
      </div>

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

// --- Channel editor -----------------------------------------------------------

export interface ChannelEditData {
  channel: ChannelRow;
  /** How many links point at it, which decides how loud the delete button is. */
  inUse: number;
  notice?: string;
  error?: string;
}

export function channelEditPage(ctx: PageCtx, d: ChannelEditData): Html {
  const ch = d.channel;
  return layout({
    title: `${ch.label} · channels · shorturl`,
    cssHref: ctx.cssHref,
    nav: { active: "settings" },
    body: html`<div class="wrap">
      <h1>${ch.icon} ${ch.label}</h1>
      <p class="subtitle">
        Channel <span class="mono">${ch.id}</span> · ${fmtNum(d.inUse)} link${
      d.inUse === 1 ? "" : "s"
    } attached
      </p>
      ${d.notice ? flash("ok", d.notice) : ""}
      ${d.error ? flash("err", d.error) : ""}

      <div class="card">
        <form method="post" action="/dashboard/channels/${ch.id}" class="stack">
          <div class="row">
            <div>
              <label for="label">Name</label>
              <input type="text" id="label" name="label" required maxlength="40"
                     value="${ch.label}">
            </div>
            <div>
              <label for="prefix">Slug prefix <span class="opt">2–3 letters, no l</span></label>
              <input type="text" id="prefix" name="prefix" required pattern="[A-Za-z]{2,3}"
                     value="${ch.prefix}">
            </div>
            <div>
              <label for="icon">Icon <span class="opt">emoji</span></label>
              <input type="text" id="icon" name="icon" required value="${ch.icon}">
            </div>
          </div>
          <div>
            <label for="hosts">Referrer hosts <span class="opt">comma or newline
              separated</span></label>
            <input type="text" id="hosts" name="hosts" value="${ch.hosts.join(", ")}">
          </div>
          <p class="muted fieldhelp">
            The name and icon are labels only — changing them relabels every statistic for this
            channel, past clicks included, because the rows are grouped by the id
            <span class="mono">${ch.id}</span>, which never changes. Changing the prefix only
            affects slugs generated from now on.
          </p>
          <div class="actions">
            <button class="btn" type="submit">Save changes</button>
            <a class="btn secondary" href="/dashboard/settings">Back to settings</a>
          </div>
        </form>
      </div>

      <h2>Danger zone</h2>
      <div class="card actions">
        <form method="post" action="/dashboard/channels/${ch.id}/delete" class="inline-form">
          <button class="btn danger" type="submit">Delete this channel</button>
        </form>
        <span class="muted">
          ${
      d.inUse === 0 ? html`No link uses it, so this removes a menu entry and nothing else.` : html`
        <strong>${fmtNum(d.inUse)} link${d.inUse === 1 ? "" : "s"}</strong> will become
        unattributed. The links, their slugs and every recorded click are kept — only the
        channel label goes away, and you can reassign them afterwards.
      `
    }
        </span>
      </div>
    </div>`,
  });
}

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
