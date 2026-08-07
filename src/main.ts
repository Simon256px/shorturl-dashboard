/**
 * Entry point: validate configuration, open storage, start the reporter, serve.
 *
 * Anything that can be wrong is checked before the listener opens, so a bad
 * deploy fails loudly at boot instead of quietly at the first request.
 */

import { getConfig } from "./config.ts";
import { Store } from "./db.ts";
import { DiscordReporter } from "./discord.ts";
import { resolveAdminHash } from "./auth.ts";
import { buildContext, createApp } from "./app.ts";

const MAINTENANCE_INTERVAL_MS = 6 * 3600 * 1000;

export async function main(): Promise<void> {
  const config = getConfig();

  await Deno.mkdir(config.dataDir, { recursive: true });
  const dbPath = `${config.dataDir}/shorturl.db`;

  const store = new Store(dbPath);
  const adminHash = resolveAdminHash(config);
  const discord = new DiscordReporter(store, config);

  const ctx = buildContext(store, config, adminHash, discord);
  const app = createApp(ctx);

  // Periodic housekeeping: expire sessions, rotate out old salts, enforce the
  // analytics retention window, and truncate the WAL so it can't grow forever.
  const maintenanceTimer = setInterval(() => {
    try {
      const purged = store.maintenance(config.retentionDays);
      store.checkpoint();
      if (purged.clicks || purged.sessions || purged.salts) {
        console.log(
          `[maintenance] purged ${purged.clicks} clicks, ${purged.sessions} sessions, ` +
            `${purged.salts} salts`,
        );
      }
    } catch (err) {
      console.error("[maintenance] failed:", err);
    }
  }, MAINTENANCE_INTERVAL_MS);
  Deno.unrefTimer(maintenanceTimer);

  // Run once at boot so a long-stopped instance cleans up immediately.
  store.maintenance(config.retentionDays);

  discord.start();

  const server = Deno.serve({
    hostname: config.host,
    port: config.port,
    onListen: ({ hostname, port }) => {
      console.log(`\n  shorturl-dashboard`);
      console.log(`  listening on http://${hostname}:${port}`);
      console.log(`  public base   ${config.baseUrl}`);
      console.log(`  database      ${dbPath}`);
      console.log(`  discord       ${discord.enabled ? "enabled" : "disabled"}`);
      console.log(`  dashboard     ${config.baseUrl}/dashboard\n`);
    },
  }, (req, info) => app.fetch(req, info));

  // --- Graceful shutdown -----------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, draining…`);

    clearInterval(maintenanceTimer);
    discord.stop();
    try {
      await server.shutdown();
    } catch { /* already closing */ }
    // Flush queued clicks before the file handle goes away, so the last few
    // redirects still show up in the analytics.
    store.close();
    console.log("[shutdown] done");
  };

  // SIGTERM is what systemd sends; Windows only supports SIGINT/SIGBREAK.
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
  for (const sig of signals) {
    try {
      Deno.addSignalListener(sig, () => void shutdown(sig));
    } catch (err) {
      console.warn(
        `[shutdown] cannot listen for ${sig}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await server.finished;
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error("\nFailed to start:\n  " + (err instanceof Error ? err.message : String(err)));
    console.error("\nCheck your .env against .env.example.\n");
    Deno.exit(1);
  }
}
