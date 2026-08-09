/**
 * The HTML wrapper served to link-preview crawlers.
 *
 * A 302 carries no body, so a crawler following a short link reads the
 * destination's Open Graph tags and shows the destination's card. To show a
 * card of our own, the crawler has to receive HTML — so when a link has card
 * data and the caller is a known preview crawler, we answer with this page
 * instead of redirecting.
 *
 * The page still points at the same destination, via both a meta refresh and a
 * real anchor. Nothing here shows a crawler one place and a human another; it
 * only decides whether the hop is expressed as a header or as markup. That
 * matters — a wrapper that sent crawlers somewhere else would be cloaking, and
 * would get the domain flagged.
 */

import { html } from "hono/html";
import type { LinkRow } from "../db.ts";
import type { Html } from "./ui.ts";

export interface OgPageInput {
  link: LinkRow;
  shortUrl: string;
  siteName: string;
  /** Colours the left stripe of a Discord embed. */
  themeColor?: string;
}

export function openGraphPage(o: OgPageInput): Html {
  const { link, shortUrl } = o;

  // Fall back to something meaningful rather than emitting an empty tag: a
  // crawler shown `<meta content="">` renders a blank card.
  const title = link.og_title ?? hostOf(link.target);
  const description = link.og_description;
  const image = link.og_image;

  // `summary_large_image` is what makes X/Twitter render the wide card people
  // expect; the small `summary` card is the default and looks like an error.
  const twitterCard = image ? "summary_large_image" : "summary";

  return html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <title>${title}</title>
    ${description ? html`<meta name="description" content="${description}">` : ""}

    <meta property="og:type" content="website">
    <meta property="og:url" content="${shortUrl}">
    <meta property="og:title" content="${title}">
    ${description ? html`<meta property="og:description" content="${description}">` : ""}
    ${image ? html`<meta property="og:image" content="${image}">` : ""}
    ${image ? html`<meta property="og:image:secure_url" content="${image}">` : ""}
    ${image ? html`<meta property="og:image:alt" content="${title}">` : ""}
    <meta property="og:site_name" content="${o.siteName}">

    <meta name="twitter:card" content="${twitterCard}">
    <meta name="twitter:title" content="${title}">
    ${description ? html`<meta name="twitter:description" content="${description}">` : ""}
    ${image ? html`<meta name="twitter:image" content="${image}">` : ""}

    ${o.themeColor ? html`<meta name="theme-color" content="${o.themeColor}">` : ""}
    <link rel="canonical" href="${shortUrl}">
    <meta name="robots" content="noindex, nofollow">

    <!-- A human who lands here (a spoofed agent, a crawler that renders) must
        still reach the destination without needing JavaScript. -->
    <meta http-equiv="refresh" content="0; url=${link.target}">
      </head>
      <body>
        <p>Redirecting to <a href="${link.target}" rel="noreferrer">${link.target}</a>…</p>
      </body>
    </html>
  `;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
