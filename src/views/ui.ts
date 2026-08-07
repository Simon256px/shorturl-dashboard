/**
 * Server-rendered UI, built from `hono/html` tagged templates.
 *
 * There is no client-side JavaScript in this dashboard — not as an aesthetic
 * choice but a security one: it lets the app ship `script-src 'none'` in its
 * CSP, which removes XSS as a class of bug rather than a bug to find. Charts
 * are inline SVG, sorting and filtering are query parameters.
 */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Bucket } from "../db.ts";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface LayoutOptions {
  title: string;
  cssHref: string;
  nav?: { active: "overview" | "links" | "new" | "settings" };
  body: Html;
}

export function layout(o: LayoutOptions): Html {
  return html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="noindex, nofollow">
        <title>${o.title}</title>
        <link rel="stylesheet" href="${o.cssHref}">
        <link rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>🔗</text></svg>">
      </head>
      <body>
      ${o.nav
        ? html`
          <header class="top">
            <div class="wrap">
              <div class="brand">short<span>url</span></div>
              <nav class="top-nav">
                <a href="/dashboard" class="${o.nav.active === "overview"
                  ? "active"
                  : ""}">Overview</a>
                <a href="/dashboard/links" class="${o.nav.active === "links"
                  ? "active"
                  : ""}">Links</a>
                <a href="/dashboard/new" class="${o.nav.active === "new"
                  ? "active"
                  : ""}">New link</a>
                <a href="/dashboard/settings" class="${o.nav.active === "settings"
                  ? "active"
                  : ""}">Settings</a>
                <form method="post" action="/logout" class="inline-form">
                  <button class="btn secondary small" type="submit">Sign out</button>
                </form>
              </nav>
            </div>
          </header>
        `
        : ""}
      ${o.body}
      <footer class="foot">
        shorturl-dashboard ·
    <a href="https://github.com/Simon256px/shorturl-dashboard">source</a> ·
    privacy-preserving analytics
      </footer>
        </body>
    </html>
  `;
}

// --- Small pieces -------------------------------------------------------------

export function statCard(label: string, value: string | number, hint?: string): Html {
  return html`<div class="card stat">
    <div class="label">${label}</div>
    <div class="value">${typeof value === "number" ? fmtNum(value) : value}</div>
    ${hint ? html`<div class="hint">${hint}</div>` : ""}
  </div>`;
}

export function flash(kind: "ok" | "err", message: string): Html {
  return html`<div class="flash ${kind}">${message}</div>`;
}

/**
 * Vertical bar chart as inline SVG.
 *
 * Uses a viewBox and no fixed width so it scales to the container, and no
 * inline `style` attributes so the strict CSP holds.
 */
export function barChart(series: Bucket[], opts: { height?: number; label?: string } = {}): Html {
  const height = opts.height ?? 160;
  const n = Math.max(series.length, 1);
  const width = 720;
  const padTop = 14;
  const padBottom = 22;
  const plot = height - padTop - padBottom;
  const slot = width / n;
  const barW = Math.max(1.5, slot * 0.68);
  const max = Math.max(...series.map((s) => s.value), 1);

  const bars = series.map((s, i) => {
    const h = s.value === 0 ? 0 : Math.max(2, (s.value / max) * plot);
    const x = i * slot + (slot - barW) / 2;
    const y = padTop + (plot - h);
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(barW)}" height="${round(h)}" ` +
      `rx="2" fill="currentColor"><title>${escapeAttr(s.label)}: ${s.value}</title></rect>`;
  }).join("");

  // Only the first, middle and last labels — more becomes unreadable on mobile.
  const idxs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const ticks = idxs
    .filter((i) => series[i])
    .map((i) => {
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      const x = i === 0 ? 0 : i === n - 1 ? width : i * slot + slot / 2;
      return `<text x="${round(x)}" y="${height - 6}" font-size="11" fill="currentColor" ` +
        `opacity="0.55" text-anchor="${anchor}">${escapeAttr(series[i]!.label)}</text>`;
    })
    .join("");

  const baseline =
    `<line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" ` +
    `stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>`;

  // No preserveAspectRatio="none": stretching the viewBox would squash the
  // tick labels along with the bars.
  return raw(
    `<svg class="chart" viewBox="0 0 ${width} ${height}" ` +
      `role="img" aria-label="${escapeAttr(opts.label ?? "clicks over time")}" ` +
      `xmlns="http://www.w3.org/2000/svg" color="var(--accent)">` +
      baseline + bars + ticks + `</svg>`,
  );
}

/**
 * Ranked list with a proportional bar behind each row. Drawn as SVG so no
 * inline width style is needed.
 */
export function topList(
  items: Bucket[],
  opts: { empty?: string; icon?: (l: string) => string } = {},
): Html {
  if (items.length === 0) {
    return html`<div class="empty">${opts.empty ?? "No data yet."}</div>`;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  const rowH = 30;
  const width = 480;
  const height = items.length * rowH;

  const rows = items.map((item, i) => {
    const y = i * rowH;
    const w = Math.max(2, (item.value / max) * width);
    const label = opts.icon ? `${opts.icon(item.label)} ${item.label}` : item.label;
    return `<rect x="0" y="${y + 3}" width="${round(w)}" height="${rowH - 8}" rx="4" ` +
      `fill="currentColor" opacity="0.13"/>` +
      `<text x="9" y="${y + rowH / 2 + 4}" font-size="13" fill="currentColor">${
        escapeAttr(truncate(label, 38))
      }</text>` +
      `<text x="${width - 8}" y="${
        y + rowH / 2 + 4
      }" font-size="13" font-weight="600" text-anchor="end" fill="currentColor">${
        fmtNum(item.value)
      }</text>`;
  }).join("");

  return raw(
    `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" ` +
      `xmlns="http://www.w3.org/2000/svg" color="var(--accent)">${rows}</svg>`,
  );
}

// --- Formatting ---------------------------------------------------------------

export function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function fmtDate(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function fmtRelative(unixSeconds: number | null): string {
  if (!unixSeconds) return "never";
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return fmtDate(unixSeconds).slice(0, 10);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function countryFlag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)));
}

/** SVG is built by string concatenation, so attribute values need escaping. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
