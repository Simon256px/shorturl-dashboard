/**
 * Discord reporter — keeps ONE webhook message permanently up to date.
 *
 * Why edit rather than post: a channel that gets a new stats message every five
 * minutes is a channel people mute. Editing keeps a single live dashboard
 * pinned in the channel.
 *
 * Why a webhook rather than a bot: no bot token to leak, no gateway connection
 * to keep alive, no privileged intents to justify. If the process dies, nothing
 * needs reconnecting — the next tick simply edits the message again.
 *
 * Every failure path here is non-fatal. Discord being down must never affect
 * the redirect service.
 */

import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { sha256Hex } from "./util/crypto.ts";

const KV_MESSAGE_ID = "discord_message_id";
const KV_WEBHOOK_FINGERPRINT = "discord_webhook_fingerprint";

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const EMBED_COLOR = 0x5865f2; // Discord blurple

export class DiscordReporter {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #consecutiveFailures = 0;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.discordWebhook);
  }

  start(): void {
    if (!this.enabled || this.#timer !== undefined) return;

    // A webhook change means the old message id belongs to another channel.
    const fingerprint = sha256Hex(this.config.discordWebhook!).slice(0, 16);
    if (this.store.kvGet(KV_WEBHOOK_FINGERPRINT) !== fingerprint) {
      this.store.kvDelete(KV_MESSAGE_ID);
      this.store.kvSet(KV_WEBHOOK_FINGERPRINT, fingerprint);
    }

    const intervalMs = this.config.discordIntervalSeconds * 1000;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    // First publish shortly after boot, once the server is actually listening.
    setTimeout(() => void this.tick(), 3_000);

    console.log(
      `[discord] reporter enabled, updating every ${this.config.discordIntervalSeconds}s`,
    );
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Runs one publish cycle. Never throws. */
  async tick(): Promise<void> {
    if (!this.enabled || this.#running) return; // a slow request must not stack ticks
    this.#running = true;
    try {
      const embed = this.buildEmbed();
      await this.publish(embed);
      this.#consecutiveFailures = 0;
    } catch (err) {
      this.#consecutiveFailures++;
      console.error(
        `[discord] update failed (${this.#consecutiveFailures} in a row):`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.#running = false;
    }
  }

  // --- Message construction -------------------------------------------------

  buildEmbed(): Record<string, unknown> {
    const totals = this.store.globalTotals();
    const d1 = this.store.clicksSince(86400);
    const d7 = this.store.clicksSince(7 * 86400);
    const hourly = this.store.hourlySeries(24);

    const top = this.store.topLinks(5, 7 * 86400);
    const referrers = this.store.topDimension("referrer_host", {
      limit: 5,
      sinceSeconds: 7 * 86400,
    });
    const countries = this.store.topDimension("country", { limit: 5, sinceSeconds: 7 * 86400 });

    const nextUpdate = Math.floor(Date.now() / 1000) + this.config.discordIntervalSeconds;

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      {
        name: "Clicks",
        value: [
          `**${fmt(totals.clicks)}** all-time`,
          `**${fmt(d1.clicks)}** last 24 h`,
          `**${fmt(d7.clicks)}** last 7 d`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Visitors",
        value: [
          `**${fmt(totals.visitors)}** all-time`,
          `**${fmt(d1.visitors)}** last 24 h`,
          `**${fmt(d7.visitors)}** last 7 d`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Links",
        value: [
          `**${fmt(totals.links)}** total`,
          `**${fmt(totals.active)}** active`,
          `**${fmt(totals.links - totals.active)}** off/expired`,
        ].join("\n"),
        inline: true,
      },
    ];

    if (top.length > 0) {
      fields.push({
        name: "Top links (7 d)",
        value: clamp(
          top
            .map((l, i) =>
              `\`${String(i + 1)}.\` [${escapeMd(l.slug)}](${this.config.baseUrl}/${
                encodeURIComponent(l.slug)
              }) — **${fmt(l.recent)}** · ${escapeMd(truncate(hostOf(l.target), 34))}`
            )
            .join("\n"),
          1024,
        ),
      });
    }

    if (referrers.length > 0) {
      fields.push({
        name: "Referrers (7 d)",
        value: clamp(
          referrers.map((r) => `${escapeMd(truncate(r.label, 28))} — **${fmt(r.value)}**`).join(
            "\n",
          ),
          1024,
        ),
        inline: true,
      });
    }

    if (countries.length > 0) {
      fields.push({
        name: "Countries (7 d)",
        value: clamp(
          countries.map((r) => `${flag(r.label)} ${r.label} — **${fmt(r.value)}**`).join("\n"),
          1024,
        ),
        inline: true,
      });
    }

    const peak = Math.max(...hourly.map((h) => h.value), 0);
    const description = [
      "```",
      sparkline(hourly.map((h) => h.value)),
      "```",
      `Last 24 h · peak **${fmt(peak)}** clicks/h · next update <t:${nextUpdate}:R>`,
    ].join("\n");

    return {
      title: "🔗 Link statistics",
      url: this.config.baseUrl,
      color: EMBED_COLOR,
      description: clamp(description, 4096),
      fields: fields.slice(0, 25),
      footer: { text: "shorturl-dashboard" },
      timestamp: new Date().toISOString(),
    };
  }

  // --- Transport ------------------------------------------------------------

  private async publish(embed: Record<string, unknown>): Promise<void> {
    const messageId = this.store.kvGet(KV_MESSAGE_ID);

    if (messageId) {
      const res = await this.send(
        `${this.config.discordWebhook}/messages/${messageId}`,
        "PATCH",
        embed,
      );
      if (res.ok) return;
      // 404: someone deleted the message. 10008 = Unknown Message.
      if (res.status === 404 || res.status === 10008) {
        console.warn("[discord] stats message is gone, posting a new one");
        this.store.kvDelete(KV_MESSAGE_ID);
      } else {
        throw new Error(`PATCH failed: ${res.status} ${res.body}`);
      }
    }

    const created = await this.send(`${this.config.discordWebhook}?wait=true`, "POST", embed);
    if (!created.ok) throw new Error(`POST failed: ${created.status} ${created.body}`);

    const id = safeJson(created.body)?.id;
    if (typeof id === "string") {
      this.store.kvSet(KV_MESSAGE_ID, id);
      console.log(`[discord] stats message created (id ${id}) — it will be edited from now on`);
    } else {
      console.warn("[discord] webhook did not return a message id; will repost next tick");
    }
  }

  /** One HTTP call with a timeout and a single 429-aware retry. */
  private async send(
    url: string,
    method: "POST" | "PATCH",
    embed: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const payload = JSON.stringify({
      embeds: [embed],
      // Defence in depth: even if a link note contained "@everyone", Discord
      // must not ping anyone from a stats message.
      allowed_mentions: { parse: [] },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        const body = await res.text();

        if (res.status === 429 && attempt === 0) {
          const retryAfter =
            Number(safeJson(body)?.retry_after ?? res.headers.get("retry-after")) ||
            2;
          const waitMs = Math.min(retryAfter * 1000 + 250, 30_000);
          console.warn(`[discord] rate limited, retrying in ${Math.round(waitMs / 1000)}s`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        return { ok: res.ok, status: res.status, body };
      } catch (err) {
        if (attempt === 1) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    return { ok: false, status: 0, body: "unreachable" };
  }
}

// --- Formatting helpers -------------------------------------------------------

/** Unicode bar chart. Empty series render as a flat baseline, not as noise. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "—";
  const max = Math.max(...values);
  if (max === 0) return BLOCKS[0]!.repeat(values.length);
  return values
    .map((v) => {
      if (v === 0) return " ";
      const idx = Math.min(BLOCKS.length - 1, Math.ceil((v / max) * BLOCKS.length) - 1);
      return BLOCKS[Math.max(0, idx)]!;
    })
    .join("");
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Regional-indicator pair, so "FR" renders as the French flag. */
function flag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Stop stored text from breaking out into Discord markdown. */
function escapeMd(s: string): string {
  return s.replace(/([*_~`|\\[\]()>])/g, "\\$1");
}

// deno-lint-ignore no-explicit-any
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
