import { load as loadHtml } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import {
  compactUnique,
  extractHtmlTitle,
  normalizeSpace,
  nowIso,
  sha256,
  sourceDisplayName,
  summarizeChangeTitle,
  toArray,
} from "./utils.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
});

async function fetchText(url, options = {}) {
  const timeoutSeconds = options.timeoutSeconds || 30;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "showtimes-vps-service/1.0",
        accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

function pickPageContent(target, html) {
  if (!target.css_selector) {
    return html;
  }

  const $ = loadHtml(html);
  const nodes = $(target.css_selector);
  if (!nodes.length) {
    throw new Error(`Selector not found: ${target.css_selector}`);
  }

  const selectedText = normalizeSpace(nodes.text());
  return selectedText || nodes.html() || html;
}

function firstText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return normalizeSpace(value);
  }
  if (Array.isArray(value)) {
    return firstText(value[0]);
  }
  if (typeof value === "object") {
    return normalizeSpace(value["#text"] || value.href || value.url || value.value || "");
  }
  return normalizeSpace(String(value));
}

function firstLink(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstLink(item);
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }
  if (typeof value === "object") {
    return value.href || value.url || firstText(value);
  }
  return "";
}

function normalizeEntry(raw) {
  const title = firstText(raw.title);
  const link = firstLink(raw.link || raw.guid || raw.id);
  const published = firstText(raw.pubDate || raw.published || raw.updated || raw.published_at);
  const summary = firstText(raw.description || raw.summary || raw.content || raw.contentSnippet);
  const id = firstText(raw.guid || raw.id) || link || sha256(`${title}|${published}|${summary}`);

  return {
    id,
    title,
    link,
    published,
    summary,
  };
}

function parseRssEntries(parsed) {
  const channel = parsed?.rss?.channel || parsed?.channel;
  return toArray(channel?.item).map(normalizeEntry);
}

function parseAtomEntries(parsed) {
  const feed = parsed?.feed;
  return toArray(feed?.entry).map(normalizeEntry);
}

function matchesKeywords(entry, keywords) {
  if (!keywords || !keywords.length) {
    return true;
  }

  const haystack = normalizeSpace([entry.title, entry.summary, entry.link].filter(Boolean).join(" ")).toLowerCase();
  return keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

function entryKey(entry) {
  return sha256([entry.id, entry.link, entry.title, entry.published].filter(Boolean).join("|"));
}

function buildFeedEntries(xml) {
  const parsed = xmlParser.parse(xml);
  const entries = [...parseRssEntries(parsed), ...parseAtomEntries(parsed)].filter(
    (entry) => entry.title || entry.link || entry.summary
  );

  for (const entry of entries) {
    entry.key = entryKey(entry);
  }

  return entries;
}

export async function inspectTarget(target, previousState = {}, options = {}) {
  const checkedAt = nowIso();

  try {
    const html = await fetchText(target.url, options);
    const content = pickPageContent(target, html);
    const hash = sha256(content);
    const title = extractHtmlTitle(html) || sourceDisplayName(target);
    const baseline = !previousState.last_hash;
    const changed = !baseline && previousState.last_hash !== hash;
    const detail = target.css_selector ? `selector=${target.css_selector}` : title;

    const state = {
      ...previousState,
      last_hash: hash,
      last_title: title,
      last_status: "ok",
      last_detail: detail,
      last_checked_at: checkedAt,
      last_change_at: changed ? checkedAt : previousState.last_change_at || null,
    };

    const result = {
      ok: true,
      id: target.id,
      name: target.name,
      status: changed ? "changed" : "ok",
      detail: changed ? "content changed" : detail,
      open_url: target.open_url || target.url,
      latest_title: title,
    };

    const notification = changed
      ? {
          title: summarizeChangeTitle("target", target),
          text: [
            sourceDisplayName(target),
            "状态: 页面内容有更新",
            `标题: ${title}`,
            `打开: ${target.open_url || target.url}`,
          ].join("\n"),
        }
      : null;

    return { result, state, changed, notification };
  } catch (error) {
    const message = String(error?.message || error);
    return {
      result: {
        ok: false,
        id: target.id,
        name: target.name,
        status: "error",
        detail: message,
        open_url: target.open_url || target.url,
      },
      state: {
        ...previousState,
        last_status: "error",
        last_detail: message,
        last_checked_at: checkedAt,
      },
      changed: false,
      notification: null,
    };
  }
}

export async function inspectFeed(feed, previousState = {}, options = {}) {
  const checkedAt = nowIso();

  try {
    const xml = await fetchText(feed.url, options);
    const entries = buildFeedEntries(xml);
    const matched = entries.filter((entry) => matchesKeywords(entry, feed.keywords || []));
    const latest = matched[0] || entries[0] || null;
    const previousSeen = new Set(previousState.seen_ids || []);
    const baseline = previousSeen.size === 0;
    const fresh = baseline ? [] : matched.filter((entry) => !previousSeen.has(entry.key));

    const state = {
      ...previousState,
      seen_ids: compactUnique(
        [...matched.map((entry) => entry.key), ...(previousState.seen_ids || [])],
        200
      ),
      last_status: "ok",
      last_detail: latest ? `matched=${matched.length}` : "no matched items",
      last_checked_at: checkedAt,
      last_change_at: fresh.length ? checkedAt : previousState.last_change_at || null,
      last_latest_title: latest?.title || "",
      last_latest_published: latest?.published || "",
      last_latest_link: latest?.link || feed.url,
    };

    const result = {
      ok: true,
      id: feed.id,
      name: feed.name,
      status: fresh.length ? "changed" : "ok",
      detail: latest ? `matched=${matched.length}` : "no matched items",
      latest_title: latest?.title || "",
      latest_published: latest?.published || "",
      open_url: latest?.link || feed.url,
    };

    const notification = fresh.length
      ? {
          title: summarizeChangeTitle("feed", feed),
          text: [
            sourceDisplayName(feed),
            ...fresh.slice(0, 3).map((entry, index) => {
              const published = entry.published ? ` | ${entry.published}` : "";
              const link = entry.link ? `\n${entry.link}` : "";
              return `${index + 1}. ${entry.title || "Untitled"}${published}${link}`;
            }),
          ].join("\n"),
        }
      : null;

    return { result, state, changed: fresh.length > 0, notification };
  } catch (error) {
    const message = String(error?.message || error);
    return {
      result: {
        ok: false,
        id: feed.id,
        name: feed.name,
        status: "error",
        detail: message,
        open_url: feed.url,
      },
      state: {
        ...previousState,
        last_status: "error",
        last_detail: message,
        last_checked_at: checkedAt,
      },
      changed: false,
      notification: null,
    };
  }
}
