# Contributing

Thanks for taking the time. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/Simon256px/shorturl-dashboard/issues) with:

- what you did, what you expected, and what happened instead
- your Deno version (`deno --version`), your OS, and how you run it (Fedora installer,
  `deno task start`, something else)
- relevant log lines, with secrets, webhook URLs and API keys removed

## Reporting a security issue

**Please do not open a public issue.** Use
[private vulnerability reporting](https://github.com/Simon256px/shorturl-dashboard/security/advisories/new)
instead, so the problem can be fixed before it is public.

## Suggesting a feature

Open an issue describing the problem you want solved before writing a large change — it saves you
from building something that does not fit. The project stays deliberately small, so a feature that
needs a new dependency, a second service or client-side JavaScript will be a hard sell. See
[Design rules](#design-rules).

## Development setup

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

Set `ADMIN_PASSWORD` in `.env` to any password of 12 characters or more (or use
`deno task hash-password`), then:

```bash
deno task dev
```

The dashboard is at <http://localhost:8000/dashboard>, and the data in `./data` is safe to delete.

## Before opening a pull request

Run the same checks as CI:

```bash
deno task check
```

```bash
deno task test
```

`deno task fmt` fixes formatting (100-column lines, double quotes, semicolons). CI also compiles the
binary, since that is what the Fedora installer ships.

Then:

- **Add tests** for any behaviour change. Tests live in `tests/`; `app.test.ts` drives the app over
  HTTP, the others are unit and storage tests.
- **Update the README** if you change configuration, the API, or anything a user would notice.
- **Keep the pull request focused** — one change per PR is much easier to review.
- **Write commit messages** as a short imperative sentence, e.g. `Add per-link expiry to the API`,
  with a body explaining _why_ when it is not obvious.

## Design rules

These are the constraints the codebase is built around. Changes that break one need a strong reason,
stated in the pull request.

- **No client-side JavaScript.** The CSP has no `script-src`, which rules out XSS as a category.
  Interactions are plain forms and links; charts are server-rendered SVG.
- **Two runtime dependencies.** `hono` and `qrcode-generator`. Small, auditable code in `src/util/`
  is preferred over a new package.
- **Private by default.** Never store IP addresses, full referrer URLs, or set cookies on visitors.
- **Redirects come first.** Nothing on the redirect path may block on Discord, the network, or slow
  queries; click writes are batched.
- **Fail at boot, not under traffic.** New settings are parsed and validated in `src/config.ts`.
- **Least privilege.** The app runs with Deno permissions limited to its data directory; do not
  widen them without discussion.
- **Cross-platform development.** The app must keep running on Windows, macOS and Linux. Line
  endings are normalised to LF by `.gitattributes`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
