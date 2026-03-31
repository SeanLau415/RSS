import { loadConfig, saveConfig } from "./config-store.js";
import { inspectFeed, inspectTarget } from "./checkers.js";
import { loadState, saveState } from "./state-store.js";
import { ensureInteger, normalizeSpace, nowIso, sourceDisplayName, stableOffsetMs } from "./utils.js";

function clonePublicSource(source) {
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    open_url: source.open_url || "",
    enabled: Boolean(source.enabled),
    check_enabled: Boolean(source.check_enabled),
    notify_enabled: Boolean(source.notify_enabled),
    interval_minutes: source.check_interval_minutes,
    detection_mode: source.detection_mode || undefined,
    keywords: source.kind === "feed" ? source.keywords || [] : undefined,
  };
}

function controlMessage(source, changes) {
  const parts = [`已更新：${sourceDisplayName(source)}`];
  if (changes.check_enabled !== undefined) {
    parts.push(`自动抓取=${changes.check_enabled ? "on" : "off"}`);
  }
  if (changes.notify_enabled !== undefined) {
    parts.push(`自动推送=${changes.notify_enabled ? "on" : "off"}`);
  }
  if (changes.enabled !== undefined) {
    parts.push(`启用=${changes.enabled ? "on" : "off"}`);
  }
  return parts.join(" | ");
}

export class CrawlerService {
  constructor(options) {
    this.configPath = options.configPath;
    this.statePath = options.statePath;
    this.sharedToken = options.sharedToken;
    this.relayUrl = options.relayUrl || "";
    this.schedulerEnabled = options.schedulerEnabled !== false;
    this.schedulerPollSeconds = options.schedulerPollSeconds || 15;
    this.checkConcurrency = options.checkConcurrency || 4;
    this.serviceName = options.serviceName || "showtimes-vps";
    this.version = options.version || "1.0.0";

    this.config = null;
    this.state = null;
    this.nextRuns = new Map();
    this.running = new Set();
    this.timer = null;
  }

  async init() {
    this.config = await loadConfig(this.configPath);
    this.state = await loadState(this.statePath);
    this.refreshSchedules(true);
  }

  async close() {
    this.stopScheduler();
  }

  async persistState() {
    await saveState(this.statePath, this.state);
  }

  async persistConfig() {
    await saveConfig(this.configPath, this.config);
  }

  timeoutSeconds() {
    return ensureInteger(this.config.global.request_timeout || this.config.global.request_timeout_seconds, 30);
  }

  allSources() {
    return [...this.config.targets, ...this.config.feeds];
  }

  autoSources() {
    return this.allSources().filter((source) => source.enabled && source.check_enabled);
  }

  manualSources() {
    return this.allSources().filter((source) => source.enabled);
  }

  health() {
    return {
      ok: true,
      service: this.serviceName,
      version: this.version,
      time: nowIso(),
      targets_total: this.config.targets.length,
      feeds_total: this.config.feeds.length,
      scheduler_enabled: this.schedulerEnabled,
    };
  }

  listTargets() {
    return {
      ok: true,
      targets: this.config.targets.map(clonePublicSource),
    };
  }

  listFeeds() {
    return {
      ok: true,
      feeds: this.config.feeds.map(clonePublicSource),
    };
  }

  stateBucket(source) {
    return source.kind === "feed" ? this.state.feeds : this.state.targets;
  }

  normalizeQuery(query) {
    return normalizeSpace(query).toLowerCase();
  }

  resolveSource(query, kinds = ["target", "feed"]) {
    const needle = this.normalizeQuery(query);
    if (!needle) {
      throw new Error("Missing source query");
    }

    const candidates = this.allSources().filter((source) => kinds.includes(source.kind));
    const exactId = candidates.find((source) => this.normalizeQuery(source.id) === needle);
    if (exactId) {
      return exactId;
    }

    const exactName = candidates.find((source) => this.normalizeQuery(source.name) === needle);
    if (exactName) {
      return exactName;
    }

    const partial = candidates.find((source) => {
      return (
        this.normalizeQuery(source.id).includes(needle) ||
        this.normalizeQuery(source.name).includes(needle) ||
        this.normalizeQuery(source.url).includes(needle)
      );
    });

    if (!partial) {
      throw new Error(`Source not found: ${query}`);
    }

    return partial;
  }

  async relay(notification) {
    if (!notification || !this.relayUrl) {
      return false;
    }

    const response = await fetch(this.relayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.sharedToken}`,
      },
      body: JSON.stringify(notification),
    });

    if (!response.ok) {
      throw new Error(`Relay ${response.status}: ${await response.text()}`);
    }

    return true;
  }

  async runSourceCheck(source, options = {}) {
    const bucket = this.stateBucket(source);
    const previousState = bucket[source.id] || {};
    const inspect = source.kind === "feed" ? inspectFeed : inspectTarget;
    const outcome = await inspect(source, previousState, { timeoutSeconds: this.timeoutSeconds() });

    bucket[source.id] = outcome.state;
    await this.persistState();

    if (!options.manual && source.notify_enabled && outcome.changed) {
      try {
        await this.relay(outcome.notification);
      } catch (error) {
        console.error("Relay send failed", error);
      }
    }

    return outcome.result;
  }

  async checkAll(options = {}) {
    const manual = options.manual !== false;
    const targets = [];
    const feeds = [];
    let changes = 0;
    let errors = 0;

    for (const source of this.manualSources()) {
      const result = await this.runSourceCheck(source, { manual });
      if (result.status === "changed") {
        changes += 1;
      }
      if (result.status === "error") {
        errors += 1;
      }
      if (source.kind === "feed") {
        feeds.push(result);
      } else {
        targets.push(result);
      }
    }

    return {
      ok: true,
      summary: {
        targets_checked: targets.length,
        feeds_checked: feeds.length,
        changes,
        errors,
      },
      targets,
      feeds,
      time: nowIso(),
    };
  }

  async checkTarget(query, options = {}) {
    const source = this.resolveSource(query, ["target"]);
    return this.runSourceCheck(source, { manual: options.manual !== false });
  }

  async checkFeed(query, options = {}) {
    const source = this.resolveSource(query, ["feed"]);
    return this.runSourceCheck(source, { manual: options.manual !== false });
  }

  async runAutomatedOnce() {
    const results = [];
    for (const source of this.autoSources()) {
      results.push(await this.runSourceCheck(source, { manual: false }));
    }
    return results;
  }

  refreshSchedules(reset = false) {
    const active = this.autoSources();
    const activeIds = new Set(active.map((source) => source.id));
    for (const id of this.nextRuns.keys()) {
      if (!activeIds.has(id)) {
        this.nextRuns.delete(id);
      }
    }

    const now = Date.now();
    const spreadMs = Math.min(60000, Math.max(5000, active.length * 1500));
    for (const source of active) {
      if (reset || !this.nextRuns.has(source.id)) {
        this.nextRuns.set(source.id, now + stableOffsetMs(source.id, spreadMs));
      }
    }
  }

  async runDueChecks() {
    const dueSources = this.autoSources()
      .filter((source) => {
        const dueAt = this.nextRuns.get(source.id) || 0;
        return dueAt <= Date.now() && !this.running.has(source.id);
      })
      .slice(0, this.checkConcurrency);

    for (const source of dueSources) {
      this.running.add(source.id);
      const startedAt = Date.now();

      this.runSourceCheck(source, { manual: false })
        .catch((error) => {
          console.error("Scheduled source check failed", error);
        })
        .finally(() => {
          this.running.delete(source.id);
          const intervalMs = source.check_interval_minutes * 60 * 1000;
          const nextAt = Math.max(Date.now(), startedAt + intervalMs);
          this.nextRuns.set(source.id, nextAt);
        });
    }
  }

  startScheduler() {
    if (!this.schedulerEnabled || this.timer) {
      return;
    }
    this.refreshSchedules(true);
    this.timer = setInterval(() => {
      this.runDueChecks().catch((error) => {
        console.error("Scheduler loop failed", error);
      });
    }, this.schedulerPollSeconds * 1000);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stopScheduler() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async updateSourceControl(query, changes) {
    const source = this.resolveSource(query);
    if (changes.check_enabled !== undefined) {
      source.check_enabled = Boolean(changes.check_enabled);
    }
    if (changes.notify_enabled !== undefined) {
      source.notify_enabled = Boolean(changes.notify_enabled);
    }
    if (changes.enabled !== undefined) {
      source.enabled = Boolean(changes.enabled);
    }

    await this.persistConfig();
    this.refreshSchedules(true);

    return {
      ok: true,
      message: controlMessage(source, changes),
      source: clonePublicSource(source),
    };
  }

  async addTarget(payload) {
    const name = normalizeSpace(payload.name);
    const url = normalizeSpace(payload.url);
    if (!name || !url) {
      throw new Error("Both name and url are required");
    }

    if (this.config.targets.some((target) => target.url === url || this.normalizeQuery(target.name) === this.normalizeQuery(name))) {
      throw new Error("Target already exists");
    }

    const allIds = new Set(this.allSources().map((source) => source.id));
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "target";
    let id = base;
    let index = 1;
    while (allIds.has(id)) {
      id = `${base}-${index}`;
      index += 1;
    }

    const source = {
      id,
      kind: "target",
      name,
      url,
      open_url: normalizeSpace(payload.open_url),
      detection_mode: payload.detection_mode || "content_hash",
      check_interval_minutes: ensureInteger(
        payload.check_interval_minutes,
        ensureInteger(this.config.global.default_target_interval_minutes, 10)
      ),
      enabled: true,
      check_enabled: true,
      notify_enabled: false,
    };

    this.config.targets.push(source);
    await this.persistConfig();
    this.refreshSchedules(true);

    return {
      ok: true,
      message: `已加入网页目标：${source.name}`,
      target: clonePublicSource(source),
    };
  }

  async removeTarget(query) {
    const source = this.resolveSource(query, ["target"]);
    this.config.targets = this.config.targets.filter((target) => target.id !== source.id);
    delete this.state.targets[source.id];
    await this.persistConfig();
    await this.persistState();
    this.refreshSchedules(true);
    return {
      ok: true,
      message: `已移除网页目标：${source.name}`,
    };
  }

  async addFeed(payload) {
    const url = normalizeSpace(payload.url);
    if (!url) {
      throw new Error("Feed url is required");
    }

    if (this.config.feeds.some((feed) => feed.url === url)) {
      throw new Error("Feed already exists");
    }

    const name = normalizeSpace(payload.name || url);
    const allIds = new Set(this.allSources().map((source) => source.id));
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "feed";
    let id = base;
    let index = 1;
    while (allIds.has(id)) {
      id = `${base}-${index}`;
      index += 1;
    }

    const source = {
      id,
      kind: "feed",
      name,
      url,
      keywords: Array.isArray(payload.keywords) ? payload.keywords : [],
      check_interval_minutes: ensureInteger(
        payload.check_interval_minutes,
        ensureInteger(this.config.global.default_feed_interval_minutes, 720)
      ),
      enabled: true,
      check_enabled: true,
      notify_enabled: false,
    };

    this.config.feeds.push(source);
    await this.persistConfig();
    this.refreshSchedules(true);

    return {
      ok: true,
      message: `已加入 RSS 源：${source.name}`,
      feed: clonePublicSource(source),
    };
  }

  async removeFeed(query) {
    const source = this.resolveSource(query, ["feed"]);
    this.config.feeds = this.config.feeds.filter((feed) => feed.id !== source.id);
    delete this.state.feeds[source.id];
    await this.persistConfig();
    await this.persistState();
    this.refreshSchedules(true);
    return {
      ok: true,
      message: `已移除 RSS 源：${source.name}`,
    };
  }
}
