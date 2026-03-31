import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { compactUnique, ensureBoolean, ensureInteger, sha256, slugify } from "./utils.js";

function defaultDocument() {
  return {
    global: {
      request_timeout: 30,
      default_target_interval_minutes: 10,
      default_feed_interval_minutes: 720,
    },
    targets: [],
    rss_feeds: [],
  };
}

function nextId(rawId, name, url, usedIds, prefix) {
  const base = slugify(rawId || name) || `${prefix}-${sha256(url || name || prefix).slice(0, 8)}`;
  let candidate = base;
  let index = 1;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeTarget(raw, usedIds, defaults) {
  const target = { ...(raw || {}) };
  target.id = nextId(target.id, target.name, target.url, usedIds, "target");
  target.name = String(target.name || target.id).trim();
  target.url = String(target.url || "").trim();
  target.open_url = target.open_url ? String(target.open_url).trim() : "";
  target.detection_mode = String(target.detection_mode || "content_hash").trim();
  target.check_interval_minutes = ensureInteger(
    target.check_interval_minutes,
    ensureInteger(defaults.default_target_interval_minutes, 10)
  );
  target.enabled = ensureBoolean(target.enabled, true);
  target.check_enabled = ensureBoolean(target.check_enabled, true);
  target.notify_enabled = ensureBoolean(target.notify_enabled, false);
  target.kind = "target";
  return target;
}

function normalizeFeed(raw, usedIds, defaults) {
  const feed = { ...(raw || {}) };
  feed.id = nextId(feed.id, feed.name, feed.url, usedIds, "feed");
  feed.name = String(feed.name || feed.id).trim();
  feed.url = String(feed.url || "").trim();
  feed.keywords = compactUnique((feed.keywords || []).map((item) => String(item).trim()), 100);
  feed.check_interval_minutes = ensureInteger(
    feed.check_interval_minutes,
    ensureInteger(defaults.default_feed_interval_minutes, 720)
  );
  feed.enabled = ensureBoolean(feed.enabled, true);
  feed.check_enabled = ensureBoolean(feed.check_enabled, true);
  feed.notify_enabled = ensureBoolean(feed.notify_enabled, false);
  feed.kind = "feed";
  return feed;
}

function stripRuntimeFields(source) {
  const clone = { ...(source || {}) };
  delete clone.kind;
  return clone;
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

export async function loadConfig(configPath) {
  let document;

  try {
    const raw = await readFile(configPath, "utf8");
    document = yaml.load(raw) || defaultDocument();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    document = defaultDocument();
    await saveConfig(configPath, {
      document,
      global: document.global,
      targets: [],
      feeds: [],
    });
  }

  const globalConfig = { ...(document.global || {}) };
  const usedIds = new Set();
  const targets = (document.targets || []).map((item) => normalizeTarget(item, usedIds, globalConfig));
  const feeds = (document.rss_feeds || document.feeds || []).map((item) => normalizeFeed(item, usedIds, globalConfig));

  return {
    document,
    global: globalConfig,
    targets,
    feeds,
  };
}

export async function saveConfig(configPath, model) {
  const document = {
    ...(model.document || {}),
    global: {
      ...((model.document && model.document.global) || {}),
      ...(model.global || {}),
    },
    targets: (model.targets || []).map(stripRuntimeFields),
    rss_feeds: (model.feeds || []).map(stripRuntimeFields),
  };

  delete document.feeds;

  const yamlText = yaml.dump(document, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await writeAtomic(configPath, yamlText);
}
