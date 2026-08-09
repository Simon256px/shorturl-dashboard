# shorturl-dashboard

A self-hosted URL shortener with an analytics dashboard and a Discord message that keeps itself up
to date.

Built on Deno 2 + Hono + SQLite. One process, one database file, two dependencies. No build step, no
client-side JavaScript, no Redis, no Postgres.

```
┌──────────┐   302    ┌──────────────┐   batched writes   ┌────────────┐
│ visitor  │ ───────▶ │   Deno app   │ ─────────────────▶ │ SQLite/WAL │
└──────────┘          │  Hono router │                    └────────────┘
                      └──────┬───────┘                           │
                             │ PATCH the same message            │ read
                             ▼  every 5 min                      ▼
                      ┌──────────────┐                    ┌────────────┐
                      │   Discord    │                    │  dashboard │
                      └──────────────┘                    └────────────┘
```

## Features

- **Shortening** — random slugs from a CSPRNG, or your own custom slug
- **Analytics** — clicks, unique visitors, referrers, countries, browsers, OS, device type, daily
  and hourly time series
- **Dashboard** — server-rendered, dark/light, works without JavaScript
- **Social cards** — per-link Open Graph title, description and image, so a short link shows _your_
  preview on Discord, X, Slack and the rest
- **Discord** — a single embed message edited in place, never spammed
- **QR codes** — SVG, generated server-side, scale to print
- **Expiry & disable** — per-link, enforced on redirect
- **CSV export** — per link or everything
- **JSON API** — with revocable API keys
- **Privacy by default** — no cookies for visitors, no IP addresses stored

## Why this stack

| Choice                         | Reason                                                                                                                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deno 2**                     | Permissions are enforced by the runtime, not by convention. The process is launched with `--allow-read=/var/lib/shorturl` and physically cannot read your SSH keys, whatever a dependency tries. Also: TypeScript with no build step, and `deno compile` yields one static binary. |
| **SQLite (WAL)**               | A shortener is read-heavy with tiny rows. SQLite does hundreds of thousands of redirects per second on one core, has no daemon to patch, and backs up with one command. Postgres here would be a second thing to keep alive for no gain.                                           |
| **Hono**                       | ~14 kB router, and portable across Deno/Node/Bun — if Deno ever stops suiting you, the app moves without a rewrite.                                                                                                                                                                |
| **Discord webhook, not a bot** | No bot token to leak, no gateway socket to keep alive, no privileged intents. If the process dies, the next tick simply edits the message again.                                                                                                                                   |
| **No client JavaScript**       | Lets the app ship `script-src 'none'` in its CSP, which removes XSS as a _category_ rather than as a bug to hunt. Charts are inline SVG.                                                                                                                                           |

Total third-party code: `hono` and `qrcode-generator`. Everything else — password hashing, rate
limiting, User-Agent parsing, QR rendering, CSV — is in `src/` where you can read it.

## Quick start

```bash
deno task hash-password
```

```bash
cp .env.example .env
```

Put the printed `ADMIN_PASSWORD_HASH` into `.env`, then:

```bash
deno task start
```

Open <http://localhost:8000/dashboard>.

Other tasks:

```bash
deno task dev
```

```bash
deno task test
```

```bash
deno task check
```

## Configuration

Everything comes from the environment (or `.env`). See [`.env.example`](.env.example) for the
annotated list. The ones that matter:

| Variable                          | Default                 | Notes                                                                            |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `BASE_URL`                        | `http://localhost:8000` | Public origin. Used for short links, QR payloads and the CSRF origin check.      |
| `HOST` / `PORT`                   | `127.0.0.1` / `8000`    | Keep on loopback behind a reverse proxy.                                         |
| `ADMIN_PASSWORD_HASH`             | —                       | From `deno task hash-password`. Preferred over `ADMIN_PASSWORD`.                 |
| `TRUST_PROXY`                     | `false`                 | Turn on **only** behind a proxy you control. See below.                          |
| `PUBLIC_SHORTENING`               | `false`                 | Let anonymous visitors create links.                                             |
| `ALLOW_PRIVATE_TARGETS`           | `false`                 | Permit shortening to RFC1918 / loopback addresses.                               |
| `REDIRECT_STATUS`                 | `302`                   | `301`/`308` are cached by browsers forever, which silently stops your analytics. |
| `ANALYTICS_RETENTION_DAYS`        | `400`                   | `0` keeps click rows forever.                                                    |
| `DISCORD_WEBHOOK_URL`             | —                       | Empty disables the reporter.                                                     |
| `DISCORD_UPDATE_INTERVAL_SECONDS` | `300`                   | Minimum 60.                                                                      |

### About `TRUST_PROXY`

`X-Forwarded-For` is a header — anyone can send one. It is read **only** when `TRUST_PROXY=true`,
because trusting it unconditionally would let a visitor spoof their address and thereby defeat both
rate limiting and unique-visitor counting. Set it to `true` when, and only when, a proxy in front of
the app overwrites that header.

## Social cards

Fill **Card title**, **Card description** and **Card image URL** on a link, and sharing that short
link shows your own preview instead of the destination's.

How it works: a `302` carries no body, so a preview crawler following a short link reads the
_destination's_ Open Graph tags. To show a card of our own the crawler has to receive HTML — so when
a link has card data **and** the caller matches the named crawler list in
[`src/util/user-agent.ts`](src/util/user-agent.ts), it gets an HTML wrapper instead of a redirect.
Everyone else — every human, every script, every uptime monitor — keeps getting the plain `302`.

Three properties worth stating plainly, because "serve crawlers something different" deserves
scrutiny:

- The wrapper points at the **same destination** as the redirect, via a meta refresh and a real
  anchor. Sending crawlers elsewhere would be cloaking and would get the domain flagged; this
  doesn't.
- It ships `noindex, nofollow`, so it never competes with the destination in search results.
- Leave all three fields empty and nothing changes: the link redirects exactly as it did before.
  Existing links are untouched by the upgrade.

Practical notes: use **https** for the image (many platforms silently drop `http` ones) and aim for
**1200×630**. Crawlers cache hard — an edit can take minutes to appear, and a platform that already
cached the old card may keep showing it until its own cache expires. Posting the link in a fresh
Discord channel is the quickest way to see the current version.

The trade-off of the named-crawler list: a brand-new platform shows the destination's card until its
agent is added. That is a missing card, never a broken link.

## Discord

Create a webhook in **Server Settings → Integrations → Webhooks**, copy the URL into
`DISCORD_WEBHOOK_URL`, restart.

On first run the app posts one embed and remembers its message id; from then on it edits that same
message. Delete the message in Discord and it posts a fresh one on the next tick. Change the webhook
URL and it starts over in the new channel.

The embed carries total/24 h/7 d clicks and visitors, link counts, top links, top referrers, top
countries, and a 24-hour Unicode sparkline. Failures are logged and retried on the next tick —
Discord being down never affects redirects.

Force a refresh (e.g. from CI after a deploy):

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" https://s.example.com/api/discord/refresh
```

## API

Create a key under **Settings** in the dashboard. It is shown once.

```bash
curl -X POST https://s.example.com/api/links -H "Authorization: Bearer sud_..." -H "Content-Type: application/json" -d '{"target":"https://example.com/page","slug":"launch","note":"newsletter"}'
```

Card fields go in the same body — `og_title`, `og_description`, `og_image`:

```bash
curl -X POST https://s.example.com/api/links -H "Authorization: Bearer sud_..." -H "Content-Type: application/json" -d '{"target":"https://ko-fi.com/you","slug":"kofi","og_title":"Support my work","og_description":"Every coffee helps.","og_image":"https://example.com/card.png"}'
```

On `PATCH`, an absent card key is left alone and an explicit `null` clears it — so updating the
target never disturbs the card, and `{"og_image":null}` drops just the image.

| Method   | Path                          | Purpose                                       |
| -------- | ----------------------------- | --------------------------------------------- |
| `GET`    | `/api/links`                  | List (`?q=`, `?limit=`, `?offset=`, `?sort=`) |
| `POST`   | `/api/links`                  | Create                                        |
| `GET`    | `/api/links/:slug`            | One link plus its stats                       |
| `PATCH`  | `/api/links/:slug`            | Update target, note, expiry, disabled         |
| `DELETE` | `/api/links/:slug`            | Delete link and its clicks                    |
| `GET`    | `/api/links/:slug/clicks.csv` | Raw click export                              |
| `GET`    | `/api/stats`                  | Global stats                                  |
| `POST`   | `/api/discord/refresh`        | Publish the Discord embed now                 |
| `GET`    | `/health`                     | Liveness, no auth                             |

## Deploying on Fedora

```bash
sudo ./deploy/install-fedora.sh
```

That compiles a static binary to `/usr/local/bin/shorturl`, writes `/etc/shorturl/shorturl.env`,
installs a hardened systemd unit, sets the SELinux boolean the reverse proxy needs, and opens 80/443
in firewalld.

Then:

```bash
sudo systemctl enable --now shorturl
```

Put Caddy in front for automatic TLS — see [`deploy/Caddyfile`](deploy/Caddyfile).

The unit runs under `DynamicUser=yes` with `ProtectSystem=strict`, an empty capability set,
`SystemCallFilter=@system-service` and write access to nothing but `/var/lib/shorturl`.
`MemoryDenyWriteExecute` is deliberately left off: V8's JIT needs W+X pages and the process will not
start with it enabled.

Backups:

```bash
sudo ./deploy/backup.sh /var/backups/shorturl
```

Uses SQLite's online backup API, so it is consistent without stopping the service. Wire it to a
systemd timer or cron.

## Security notes

What the app does, and why:

- **Passwords** — scrypt (N=2¹⁵, r=8), 16-byte random salt, constant-time compare. A tampered hash
  string with an absurd work factor is rejected rather than honoured, so it can't be turned into a
  memory bomb.
- **Sessions** — 32 random bytes; only the SHA-256 is stored, so a leaked database backup hands over
  no live sessions. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` whenever `BASE_URL` is
  https.
- **CSRF** — every cookie-authenticated write checks the `Origin` header (falling back to
  `Referer`). API-key requests are exempt: browsers never attach an `Authorization` header
  cross-origin without a preflight.
- **Open-redirect abuse** — targets are restricted to `http`/`https`, may not embed credentials, and
  by default may not point at loopback, RFC1918, link-local (including `169.254.169.254`), CGNAT or
  multicast addresses. That last rule is what stops your shortener being used to CSRF someone's
  router.
- **Slugs** — rejection-sampled from a CSPRNG over a 58-character alphabet, so they are neither
  guessable nor enumerable.
- **Rate limits** — login 8/15 min, link creation 60/h, API 240/min, redirects 600/min, all per IP.
- **CSP** — `default-src 'none'; script-src` absent entirely; no inline styles. The one exception is
  the link detail page when a card image is set: `img-src` widens to `https:` so the image can be
  previewed. `script-src` stays absent, so the image still cannot execute anything — the residual
  cost is that the image host learns the admin opened that page.
- **Social cards** — the title and description are user-controlled text emitted into `content="…"`
  attributes, so they are HTML-escaped; a test asserts a `"><script>` payload cannot break out. The
  image URL goes through the same scheme allowlist as a destination, which rules out `javascript:`
  and `data:` in a meta tag.
- **Headers** — `nosniff`, `X-Frame-Options: DENY`, HSTS on https, and
  `Referrer-Policy: no-referrer` on the redirect so the destination never learns which short link
  (or campaign) sent the visitor.
- **CSV export** — cells beginning `=`, `+`, `-` or `@` are prefixed with an apostrophe, so a
  hostile referrer string cannot execute when the export is opened in Excel.

### Privacy

No cookie is ever set on a visitor. No IP address is written to disk.

Unique visitors are counted as `sha256(daily_salt || ip || user_agent)` truncated to 16 hex
characters. The salt is 32 random bytes, regenerated every UTC day, and old salts are deleted by the
nightly maintenance pass. Once yesterday's salt is gone, yesterday's visitor ids cannot be linked to
today's or back to any person — which is the point.

Referrers are stored as a bare hostname, never the full URL: referring pages routinely carry session
tokens and personal data in their query strings.

Country is taken from a GeoIP header set by your CDN/proxy (`CF-IPCountry` and friends) if present,
otherwise guessed from the `Accept-Language` region subtag. No GeoIP database ships with the app.

One asymmetry worth knowing: a link's **total clicks** comes from a lifetime counter and survives
the retention purge, while **unique visitors** is computed over the retained click rows and
therefore only covers the retention window. Counting lifetime uniques would require keeping every
click row forever, which is exactly what retention exists to avoid.

## Project layout

```
src/
  main.ts           bootstrap, graceful shutdown, maintenance loop
  app.ts            middleware, routing, security headers
  config.ts         environment parsing, validated at boot
  db.ts             SQLite schema, migrations, queries, batched click writes
  service.ts        link creation/validation shared by dashboard and API
  auth.ts           sessions, API keys, CSRF
  discord.ts        the self-editing webhook message
  routes/           dashboard.ts (HTML), api.ts (JSON)
  views/            server-rendered pages, SVG charts, the stylesheet
  util/             crypto, URL validation, UA parsing, rate limiting, QR
tests/              92 tests: unit, storage, and end-to-end HTTP
deploy/             systemd unit, Caddyfile, Fedora installer, backup script
```

## Running on Windows

Works as-is for development:

```bash
deno task start
```

`SIGTERM` doesn't exist on Windows, so the shutdown handler listens for `SIGINT`/`SIGBREAK` there
and `SIGINT`/`SIGTERM` elsewhere.

## License

MIT — see [LICENSE](LICENSE).
