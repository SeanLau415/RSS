import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config-store.js";
import { inspectFeed, inspectTarget } from "../src/checkers.js";

function parseArgs(argv) {
  const options = {
    config: "./config.example.yaml",
    rounds: 1,
    delayMs: 0,
    timeoutSeconds: 20,
    output: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--config" && next) {
      options.config = next;
      i += 1;
    } else if (arg === "--rounds" && next) {
      options.rounds = Number.parseInt(next, 10) || 1;
      i += 1;
    } else if (arg === "--delay-ms" && next) {
      options.delayMs = Number.parseInt(next, 10) || 0;
      i += 1;
    } else if (arg === "--timeout-seconds" && next) {
      options.timeoutSeconds = Number.parseInt(next, 10) || 20;
      i += 1;
    } else if (arg === "--output" && next) {
      options.output = next;
      i += 1;
    }
  }

  options.rounds = Math.max(1, options.rounds);
  options.delayMs = Math.max(0, options.delayMs);
  options.timeoutSeconds = Math.max(1, options.timeoutSeconds);
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneSource(source) {
  return {
    kind: source.kind,
    id: source.id,
    name: source.name,
    url: source.url,
    open_url: source.open_url || "",
    detection_mode: source.detection_mode || "",
    keywords: source.keywords || [],
    enabled: Boolean(source.enabled),
    check_enabled: Boolean(source.check_enabled),
    notify_enabled: Boolean(source.notify_enabled),
    interval_minutes: source.check_interval_minutes,
  };
}

function aggregateRoundResults(entries) {
  const summary = {
    total: entries.length,
    ok: 0,
    changed: 0,
    error: 0,
    by_kind: {
      target: { total: 0, ok: 0, changed: 0, error: 0 },
      feed: { total: 0, ok: 0, changed: 0, error: 0 },
    },
  };

  for (const entry of entries) {
    const bucket = summary.by_kind[entry.kind];
    bucket.total += 1;
    summary.total += 0;

    if (entry.result?.status === "error" || entry.result?.ok === false) {
      summary.error += 1;
      bucket.error += 1;
    } else if (entry.result?.status === "changed") {
      summary.changed += 1;
      bucket.changed += 1;
    } else {
      summary.ok += 1;
      bucket.ok += 1;
    }
  }

  return summary;
}

function aggregateBySource(entries) {
  const map = new Map();

  for (const entry of entries) {
    const key = `${entry.kind}:${entry.id}`;
    if (!map.has(key)) {
      map.set(key, {
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        checks: 0,
        errors: 0,
        changed: 0,
        ok: 0,
        last_result: null,
      });
    }

    const current = map.get(key);
    current.checks += 1;
    current.last_result = entry.result;

    if (entry.result?.status === "error" || entry.result?.ok === false) {
      current.errors += 1;
    } else if (entry.result?.status === "changed") {
      current.changed += 1;
    } else {
      current.ok += 1;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(path.resolve(options.config));
  const sources = [...config.targets, ...config.feeds];
  const state = {
    targets: {},
    feeds: {},
  };
  const allEntries = [];

  for (let round = 1; round <= options.rounds; round += 1) {
    const startedAt = new Date().toISOString();
    const roundEntries = [];

    for (const source of sources) {
      const previousState = source.kind === "feed" ? state.feeds[source.id] || {} : state.targets[source.id] || {};
      const inspect = source.kind === "feed" ? inspectFeed : inspectTarget;

      try {
        const outcome = await inspect(source, previousState, {
          timeoutSeconds: options.timeoutSeconds,
        });

        if (source.kind === "feed") {
          state.feeds[source.id] = outcome.state;
        } else {
          state.targets[source.id] = outcome.state;
        }

        roundEntries.push({
          round,
          started_at: startedAt,
          kind: source.kind,
          id: source.id,
          name: source.name,
          result: outcome.result,
        });
      } catch (error) {
        roundEntries.push({
          round,
          started_at: startedAt,
          kind: source.kind,
          id: source.id,
          name: source.name,
          result: {
            ok: false,
            status: "error",
            detail: String(error?.message || error),
          },
        });
      }

      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    allEntries.push(...roundEntries);
    const summary = aggregateRoundResults(roundEntries);
    console.log(
      JSON.stringify(
        {
          round,
          started_at: startedAt,
          summary,
        },
        null,
        2
      )
    );
  }

  const report = {
    generated_at: new Date().toISOString(),
    config_path: path.resolve(options.config),
    rounds: options.rounds,
    delay_ms: options.delayMs,
    timeout_seconds: options.timeoutSeconds,
    sources: sources.map(cloneSource),
    entries: allEntries,
    by_source: aggregateBySource(allEntries),
  };

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Saved report: ${outputPath}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
