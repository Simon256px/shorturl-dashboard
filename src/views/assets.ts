/**
 * The whole stylesheet, as a string.
 *
 * Served from a single route with a content-hashed URL so it caches forever and
 * busts on change. Keeping it in TypeScript means `deno compile` produces one
 * self-contained binary with no asset directory to deploy alongside it.
 */

export const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --border: #e2e5ea;
  --text: #14181f;
  --muted: #666f7d;
  --accent: #3b5bdb;
  --accent-soft: #e7ecfd;
  --good: #2f9e57;
  --warn: #b8860b;
  --bad: #c0392b;
  --radius: 10px;
  --shadow: 0 1px 2px rgb(16 24 40 / 6%), 0 1px 3px rgb(16 24 40 / 8%);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --surface: #171b21;
    --surface-2: #1e242c;
    --border: #2a313b;
    --text: #e6e9ee;
    --muted: #98a2b3;
    --accent: #7c93f5;
    --accent-soft: #21283a;
    --good: #4ec27e;
    --warn: #e0b341;
    --bad: #f0736a;
    --shadow: 0 1px 2px rgb(0 0 0 / 30%);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

code, .mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
               "Liberation Mono", monospace;
  font-size: 0.92em;
}

.wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px 64px; }

/* --- header --------------------------------------------------------------- */
header.top {
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  margin-bottom: 28px;
}
header.top .wrap {
  display: flex; align-items: center; gap: 20px;
  padding-top: 14px; padding-bottom: 14px;
}
.brand { font-weight: 700; font-size: 17px; color: var(--text); letter-spacing: -0.01em; }
.brand span { color: var(--accent); }
nav.top-nav { display: flex; gap: 18px; margin-left: auto; align-items: center; }
nav.top-nav a { color: var(--muted); font-weight: 500; }
nav.top-nav a.active, nav.top-nav a:hover { color: var(--text); }

h1 { font-size: 24px; letter-spacing: -0.02em; margin: 0 0 4px; }
h2 { font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase;
     color: var(--muted); margin: 32px 0 12px; font-weight: 600; }
.subtitle { color: var(--muted); margin: 0 0 24px; }

/* --- cards ---------------------------------------------------------------- */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 20px;
}

.grid { display: grid; gap: 16px; }
.grid.stats { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.grid.halves { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }

.stat .label { color: var(--muted); font-size: 13px; font-weight: 500; }
.stat .value { font-size: 30px; font-weight: 700; letter-spacing: -0.03em; margin-top: 2px; }
.stat .hint { color: var(--muted); font-size: 12.5px; margin-top: 2px; }

/* --- tables --------------------------------------------------------------- */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; font-size: 12.5px;
     text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--surface-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.truncate { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --- forms ---------------------------------------------------------------- */
form.stack { display: grid; gap: 14px; }
.row { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; }
label .opt { font-weight: 400; color: var(--muted); }
input[type=text], input[type=url], input[type=password], input[type=date],
input[type=search], input[type=number], select, textarea {
  width: 100%; padding: 9px 11px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text);
  font: inherit; font-size: 14px;
}
input:focus, select:focus, textarea:focus {
  outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent;
}
.btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 15px; border-radius: 8px; border: 1px solid transparent;
  background: var(--accent); color: #fff; font: inherit; font-weight: 600; font-size: 14px;
  cursor: pointer; text-decoration: none;
}
.btn:hover { filter: brightness(1.08); text-decoration: none; }
.btn.secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
.btn.danger { background: var(--bad); }
.btn.small { padding: 5px 10px; font-size: 13px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
/* Lets a <form> wrapper disappear from layout, so its button sits in the flex
   row like a plain link. Avoids an inline style attribute, which the strict
   CSP (no 'unsafe-inline') would block. */
.inline-form { display: contents; }

/* --- misc ----------------------------------------------------------------- */
.flash { padding: 11px 14px; border-radius: 8px; margin-bottom: 18px; font-size: 14px; }
.flash.ok { background: color-mix(in srgb, var(--good) 14%, transparent); color: var(--good);
            border: 1px solid color-mix(in srgb, var(--good) 32%, transparent); }
.flash.err { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad);
             border: 1px solid color-mix(in srgb, var(--bad) 32%, transparent); }

.pill { display: inline-block; padding: 2px 8px; border-radius: 999px;
        font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--muted); }
.pill.on  { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
.pill.off { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
.pill.exp { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
/* Channel pill doubles as a filter link, so it needs the anchor reset. */
.pill.ch { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);
           text-decoration: none; white-space: nowrap; }

.chanhelp { max-width: 80ch; }
.chanverdict { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline;
               margin: 0 0 12px; font-size: 14px; }
.chanverdict .flag { color: var(--warn); font-weight: 600; }

.muted { color: var(--muted); }
.empty { color: var(--muted); text-align: center; padding: 28px 12px; font-size: 14px; }
.chart { width: 100%; height: auto; display: block; }
.qr { max-width: 200px; width: 100%; height: auto; border-radius: 8px; }

/* --- social card editor --------------------------------------------------- */
fieldset.cardfields {
  display: grid; gap: 14px;
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 4px 16px 16px; margin: 4px 0 0;
}
fieldset.cardfields legend {
  font-size: 13px; font-weight: 700; padding: 0 7px;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
}
.fieldhelp { font-size: 13px; margin: 4px 0 0; }

/* Rough stand-in for a chat client's embed: accent bar, stacked text, image
   below. Not pixel-accurate to any one platform, on purpose. */
.ogcard {
  border-left: 4px solid var(--accent);
  background: var(--surface-2);
  border-radius: 6px; padding: 12px 14px; max-width: 460px;
}
.ogcard-host  { font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.ogcard-title { font-weight: 600; color: var(--accent); line-height: 1.3; }
.ogcard-desc  { font-size: 14px; margin-top: 5px; white-space: pre-wrap; }
.ogcard-img {
  display: block; margin-top: 10px; width: 100%; height: auto;
  border-radius: 5px; background: var(--border);
}

.copybox {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: var(--accent-soft); border: 1px solid var(--border);
  border-radius: 8px; padding: 11px 14px; margin-bottom: 18px;
}
.copybox .link { font-weight: 600; word-break: break-all; }

.center-page { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
.center-page .card { width: 100%; max-width: 380px; }

footer.foot { color: var(--muted); font-size: 13px; text-align: center;
              padding: 28px 20px; border-top: 1px solid var(--border); margin-top: 48px; }

@media (max-width: 640px) {
  .wrap { padding: 0 14px 48px; }
  header.top .wrap { flex-wrap: wrap; gap: 10px; }
  nav.top-nav { margin-left: 0; width: 100%; }
  .truncate { max-width: 180px; }
}
`.trim();
