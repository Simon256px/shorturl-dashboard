# shorturl-dashboard

> Short links, honest analytics, nothing else to run.

A self-hosted URL shortener with a privacy-respecting analytics dashboard, per-link social cards,
and a Discord message that keeps itself up to date.

One process, one SQLite file, two dependencies. No build step, no client-side JavaScript, no Redis,
no Postgres.

```
┌──────────┐   302    ┌──────────────┐   batched writes   ┌────────────┐
│ visitor  │ ───────▶ │   Deno app   │ ─────────────────▶ │ SQLite/WAL │
└──────────┘          │  Hono router │                    └────────────┘
                      └──────┬───────┘                           │
                             │ edits the same message            │ read
                             ▼  on a timer                       ▼
                      ┌──────────────┐                    ┌────────────┐
                      │   Discord    │                    │  dashboard │
                      └──────────────┘                    └────────────┘
```

**Contents** — [Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration)
· [Deploying](#deploying-on-fedora) · [Social cards](#social-cards) · [Channels](#channels) ·
[Discord](#discord) · [API](#api) · [Security & privacy](#security--privacy) ·
[Development](#development) · [Contributing](#contributing) · [Support](#support) ·
[License](#license)

## Features

- **Short links** — random slugs from a CSPRNG, or a custom slug of your choosing
- **Analytics** — clicks, unique visitors, referrers, countries, browsers, OS, device type, daily
  and hourly charts
- **Channels** — tag a link with where you posted it and compare what you declared with what the
  referrers say; the network list is yours to edit
- **Social cards** — a per-link Open Graph title, description and image, so the short link shows
  _your_ preview on Discord, X, Slack and the rest
- **Discord** — one embed message edited in place, never a stream of posts
- **QR codes** — SVG, generated server-side, sharp at any print size
- **Expiry and disable** — per link, enforced at redirect time
- **CSV export** — per link, or everything at once
- **JSON API** — authenticated with revocable API keys
- **Private by default** — no cookies for visitors, no IP addresses on disk

## Quick start

You need [Deno 2](https://docs.deno.com/runtime/getting_started/installation/).

```bash
git clone https://github.com/Simon256px/shorturl-dashboard.git
```

```bash
cd shorturl-dashboard
```

```bash
cp .env.example .env
```

```bash
deno task hash-password
```

Paste the printed `ADMIN_PASSWORD_HASH=...` line into `.env`, then:

```bash
deno task start
```

Open <http://localhost:8000/dashboard> and sign in. Data lives in `./data`.

## Configuration

Everything comes from the environment or `.env`. [`.env.example`](.env.example) is the annotated
reference; these are the settings that matter:

| Variable                          | Default                 | Notes                                                                            |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `BASE_URL`                        | `http://localhost:8000` | Public origin. Used for short links, QR codes and the CSRF origin check.         |
| `HOST` / `PORT`                   | `127.0.0.1` / `8000`    | Keep on loopback behind a reverse proxy.                                         |
| `ADMIN_PASSWORD_HASH`             | —                       | From `deno task hash-password`. Preferred over `ADMIN_PASSWORD` (min. 12 chars). |
| `SESSION_TTL_HOURS`               | `168`                   | How long a dashboard login lasts.                                                |
| `TRUST_PROXY`                     | `false`                 | Read `X-Forwarded-For`. Turn on **only** behind a proxy you control — see below. |
| `PUBLIC_SHORTENING`               | `false`                 | Let anonymous visitors create links from the home page.                          |
| `ALLOW_PRIVATE_TARGETS`           | `false`                 | Allow destinations on loopback, RFC1918 and link-local addresses.                |
| `REDIRECT_STATUS`                 | `302`                   | `301`/`308` are cached by browsers forever, which silently stops your analytics. |
| `ANALYTICS_RETENTION_DAYS`        | `400`                   | Click rows older than this are purged nightly. `0` keeps them forever.           |
| `DISCORD_WEBHOOK_URL`             | —                       | Empty disables the Discord reporter.                                             |
| `DISCORD_UPDATE_INTERVAL_SECONDS` | `300`                   | Seconds between edits, 60 minimum. `.env.example` suggests `3600`.               |

The configuration is validated at boot: a bad value stops the server with a message naming the
variable, rather than misbehaving under traffic.

**About `TRUST_PROXY`.** `X-Forwarded-For` is just a header, and anyone can send one. Trusting it
unconditionally would let a visitor pick their own IP and slip past both rate limiting and
unique-visitor counting. Set it to `true` when, and only when, a proxy in front of the app
overwrites that header.

## Deploying on Fedora

The installer targets Fedora, RHEL and CentOS Stream. From a clone of the repository:

```bash
sudo ./deploy/install-fedora.sh
```

It compiles a self-contained binary to `/usr/local/bin/shorturl`, writes
`/etc/shorturl/shorturl.env`, installs a hardened systemd unit, sets the SELinux boolean the reverse
proxy needs and opens ports 80/443 in firewalld. It is idempotent, so re-running it upgrades an
existing install. Then:

```bash
sudo systemctl enable --now shorturl
```

Put Caddy in front for automatic TLS — see [`deploy/Caddyfile`](deploy/Caddyfile).

The unit runs under `DynamicUser=yes` and `ProtectSystem=strict`, with no capabilities,
`SystemCallFilter=@system-service`, and write access to nothing but `/var/lib/shorturl`. On top of
that, Deno's permissions are compiled into the binary: the process cannot read outside its data
directory even if the unit file is later edited. `MemoryDenyWriteExecute` is deliberately left off,
because V8's JIT needs W+X pages and the process will not start with it.

**Backups** use SQLite's online backup API, so they are consistent without stopping the service:

```bash
sudo ./deploy/backup.sh /var/backups/shorturl
```

Run it from a systemd timer or cron.

## Social cards

Fill **Card title**, **Card description** and **Card image URL** on a link, and sharing the short
link shows your preview instead of the destination's.

A `302` has no body, so a preview crawler that follows a short link normally reads the
_destination's_ Open Graph tags. To show a card of our own, the crawler has to receive HTML. When a
link has card data **and** the request comes from a known preview crawler (listed in
[`src/util/user-agent.ts`](src/util/user-agent.ts)), the app answers with a small HTML page instead
of a redirect. Everyone else — people, scripts, uptime monitors — still gets the plain `302`.

"Serve crawlers something different" deserves scrutiny, so here is what keeps it honest:

- The HTML page points at the **same destination** as the redirect, with a meta refresh and a plain
  link. Sending crawlers somewhere else would be cloaking, and would get the domain flagged.
- It carries `noindex, nofollow` addressed to Googlebot, Bingbot and Applebot by name. A blanket
  `robots` meta tag would also be read by preview crawlers, and X drops the card when it sees one.
- With all three fields empty, nothing changes: the link redirects exactly as before.

`robots.txt` disallows the whole host **except** for the preview crawlers, which get their own
`Allow: /` group. X and LinkedIn obey `robots.txt` and would otherwise never fetch the card, while
Discord and Facebook ignore it and would hide the problem. Allowing them exposes nothing: a crawler
only visits a slug it was handed, and no page links to another.

**Tips**

- Use an **https** image (many platforms drop `http` ones), ideally **1200×630**. X crops to 1.91:1.
  Prefer PNG or JPEG; WebP support is patchy in practice.
- X shows the image, the title and the shortener's domain — not the description, which Discord and
  Slack do show.
- Platforms cache cards aggressively, X for days. To force a fresh fetch, share a URL they have not
  seen yet: appending `?v=2` changes nothing about the routing. A fresh Discord channel is the
  quickest way to preview the current card.
- A platform whose crawler is not on the list yet shows the destination's card. That is a missing
  card, never a broken link.

## Channels

Pick a channel when you create a link and the dashboard reports per-network numbers. The slug gets a
prefix so the URL says where it went — X/Twitter gives `/twA8f3k`, YouTube `/ytQ7bnx`. The random
part keeps its full 7 characters, so a prefixed slug is exactly as hard to guess as a plain one. A
custom slug is never rewritten.

The dashboard shows two figures side by side, and they measure different things:

|              | Comes from                         | Reliability                      |
| ------------ | ---------------------------------- | -------------------------------- |
| **Declared** | the channel you picked on the link | exact — it is your own statement |
| **Detected** | the `Referer` header on each click | partial, and unevenly so         |

Detected always reads low: X routes links through `t.co`, and most native apps send no `Referer` at
all. That is why declaring the channel exists — it is the figure you can plan against.

The comparison pays off in one case: a network showing up under _detected_ that you never declared
means the link is being shared somewhere you did not post it. The link's page says so, e.g. _20 % of
referred clicks came from another network — probably reshared._

### Editing the list

Twelve networks ship by default: X/Twitter, YouTube, Discord, Instagram, GitHub, TikTok, Pinterest,
LinkedIn, Reddit, Facebook, Newsletter and Website/blog. They are ordinary rows, seeded on first
run: rename, re-prefix, re-icon or delete any of them under **Settings → Channels**, and add your
own.

A channel needs a name, a 2–3 letter prefix and an icon. Referrer hosts are optional — without them
you just lose the declared-vs-detected comparison. Paste whatever you have:
`https://www.twitch.tv/videos/1` is stored as `twitch.tv`, and subdomains match automatically.
Prefixes must be unique, and may not contain `l` (`/bl1abc` is unreadable aloud).

| Edit              | Effect                                                                           |
| ----------------- | -------------------------------------------------------------------------------- |
| Rename or re-icon | Relabels every statistic, history included                                       |
| Change prefix     | Applies to new slugs only; existing short links are never rewritten              |
| Delete            | Its links become unattributed; links, slugs and clicks are kept and reassignable |

Channels are a dashboard feature: the JSON API neither accepts nor returns them.

## Discord

Create a webhook under **Server Settings → Integrations → Webhooks**, put its URL in
`DISCORD_WEBHOOK_URL`, and restart.

On first run the app posts one embed and remembers its id; from then on it edits that same message.
Delete it in Discord and a fresh one is posted on the next tick; change the webhook URL and it
starts over in the new channel. The embed shows total, 24 h and 7 d clicks and visitors, link
counts, top links, referrers and countries, and a 24-hour sparkline.

Failures are logged and retried on the next tick. Discord being down never affects redirects.

A webhook rather than a bot means no bot token to leak, no gateway connection to keep alive and no
privileged intents.

## API

Create a key under **Settings** in the dashboard — it is shown once — and send it as a bearer token.

```bash
curl -X POST https://s.example.com/api/links -H "Authorization: Bearer sud_..." -H "Content-Type: application/json" -d '{"target":"https://example.com/page","slug":"launch","note":"newsletter","expires":"2027-01-31"}'
```

Request body fields: `target` (required), `slug`, `note`, `expires` (`YYYY-MM-DD`, or `expires_at`
as a Unix timestamp), and the card fields `og_title`, `og_description`, `og_image`. `PATCH` also
accepts `disabled`. On `PATCH`, an absent key is left alone and an explicit `null` clears it, so
`{"og_image":null}` drops only the image.

| Method   | Path                          | Purpose                                                |
| -------- | ----------------------------- | ------------------------------------------------------ |
| `GET`    | `/api/links`                  | List (`?q=`, `?limit=`, `?offset=`, `?sort=`)          |
| `POST`   | `/api/links`                  | Create                                                 |
| `GET`    | `/api/links/:slug`            | One link with its stats                                |
| `PATCH`  | `/api/links/:slug`            | Update target, note, expiry, disabled flag or card     |
| `DELETE` | `/api/links/:slug`            | Delete a link and its clicks                           |
| `GET`    | `/api/links/:slug/clicks.csv` | Raw click export                                       |
| `GET`    | `/api/stats`                  | Global stats                                           |
| `POST`   | `/api/discord/refresh`        | Publish the Discord embed now (e.g. from a deploy job) |
| `GET`    | `/health`                     | Liveness check, no auth                                |

## Security & privacy

**Authentication**

- **Passwords** — scrypt (N=2¹⁵, r=8) with a 16-byte salt and a constant-time compare. A tampered
  hash with an absurd work factor is rejected, so it cannot be turned into a memory bomb.
- **Sessions** — 32 random bytes, of which only the SHA-256 is stored: a leaked backup contains no
  live sessions. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` whenever `BASE_URL` is https.
- **CSRF** — every cookie-authenticated write checks `Origin` (falling back to `Referer`). API-key
  requests are exempt, since browsers never attach `Authorization` cross-origin without a preflight.
- **Rate limits** per IP — login 8 per 15 min, link creation 60/h, API 240/min, redirects 600/min.

**Abuse resistance**

- **Destinations** must be `http`/`https`, may not embed credentials, and by default may not point
  at loopback, RFC1918, link-local (including `169.254.169.254`), CGNAT or multicast addresses — so
  the shortener cannot be used to attack someone's router.
- **Slugs** are rejection-sampled from a CSPRNG over a 58-character alphabet (no `0`/`O`/`I`/`l`):
  neither guessable nor enumerable.
- **CSV exports** prefix cells starting with `=`, `+`, `-` or `@`, so a hostile referrer cannot run
  a formula when the file is opened in a spreadsheet.

**Browser hardening**

- **No client JavaScript**, so the CSP has no `script-src` at all and XSS is ruled out as a
  category. Charts are inline SVG. The one CSP relaxation: when a link has a card image, its detail
  page allows `img-src https:` so the image can be previewed.
- **Card fields** are HTML-escaped (a test checks that a `"><script>` payload cannot break out), and
  the image URL goes through the same scheme check as destinations, ruling out `javascript:` and
  `data:`.
- **Headers** — `nosniff`, `X-Frame-Options: DENY`, HSTS on https, and
  `Referrer-Policy: no-referrer` on redirects so the destination never learns which short link sent
  the visitor.

**Privacy**

- No cookie is ever set on a visitor, and no IP address is written to disk.
- Unique visitors are `sha256(daily_salt || ip || user_agent)`, truncated. The salt is regenerated
  every UTC day and the old one deleted, after which yesterday's visitors cannot be linked to
  today's or to anyone.
- Referrers are stored as a bare hostname: full URLs often carry tokens and personal data.
- Country comes from a CDN header (`CF-IPCountry` and similar) when present, otherwise from the
  `Accept-Language` region. No GeoIP database ships with the app.
- A link's **total clicks** is a lifetime counter that survives the retention purge, while **unique
  visitors** only covers the retention window — counting lifetime uniques would mean keeping every
  click row forever, which is what retention exists to avoid.

## Development

| Task                | Does                                       |
| ------------------- | ------------------------------------------ |
| `deno task dev`     | Run with file watching                     |
| `deno task test`    | Run the tests (unit, storage, HTTP)        |
| `deno task check`   | Type check, lint and format check, like CI |
| `deno task fmt`     | Format the code                            |
| `deno task compile` | Build a standalone binary into `dist/`     |

Windows works for development as-is; the shutdown handler listens for `SIGINT`/`SIGBREAK` there,
since `SIGTERM` does not exist.

<details>
<summary><strong>Why this stack</strong></summary>

| Choice           | Reason                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Deno 2**       | Permissions are enforced by the runtime. Launched with `--allow-read=/var/lib/shorturl`, the process cannot read your SSH keys whatever a dependency tries. TypeScript without a build step, and one binary. |
| **SQLite (WAL)** | A shortener is read-heavy with tiny rows. SQLite handles that on one core, has no daemon to patch, and backs up with one command. Postgres would be a second service to keep alive for no gain.              |
| **Hono**         | A ~14 kB router, portable across Deno, Node and Bun — if Deno stops suiting you, the app moves without a rewrite.                                                                                            |

The only third-party code is `hono` and `qrcode-generator`. Password hashing, rate limiting,
User-Agent parsing, QR rendering and CSV are all in `src/`, where you can read them.

</details>

<details>
<summary><strong>Project layout</strong></summary>

```
src/
  main.ts       bootstrap, graceful shutdown, maintenance loop
  app.ts        middleware, routing, security headers
  config.ts     environment parsing, validated at boot
  db.ts         SQLite schema, migrations, queries, batched click writes
  service.ts    link creation and validation shared by dashboard and API
  auth.ts       sessions, API keys, CSRF
  discord.ts    the self-editing webhook message
  routes/       dashboard.ts (HTML), api.ts (JSON)
  views/        server-rendered pages, SVG charts, Open Graph wrapper, stylesheet
  util/         crypto, URL validation, UA parsing, channels, rate limiting, QR
tests/          unit, storage and end-to-end HTTP tests
scripts/        hash-password.ts
deploy/         systemd unit, Caddyfile, Fedora installer, backup script
```

</details>

## Contributing

Bug reports, ideas and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please
report security issues privately rather than in a public issue.

## Support

shorturl-dashboard is free and stays that way. If it saves you a SaaS subscription, you can support
its development at [ko-fi.com/simon256px](https://ko-fi.com/simon256px).

## License

[MIT](LICENSE) © Simon256px
