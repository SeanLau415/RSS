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
  truncateText,
  toArray,
} from "./utils.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
  processEntities: {
    enabled: true,
    maxTotalExpansions: 10000,
    maxExpandedLength: 1000000,
    maxEntityCount: 5000,
  },
});

const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const timeoutSeconds = options.timeoutSeconds || 30;
  let lastError = null;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
      const requestUrl = new URL(url);
      const headers = {
        "user-agent": DEFAULT_BROWSER_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
      };

      if (/nube\.sh$/i.test(requestUrl.hostname) || /nube\.sh$/i.test(requestUrl.hostname.replace(/^[^.]+\./, ""))) {
        headers.accept = "application/json, text/plain, */*";
        headers.origin = "https://nube.sh";
        headers.referer = "https://nube.sh/zh-cn";
      }

      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers,
      });

      const text = await response.text();
      if (!response.ok) {
        if (attempt < maxAttempts && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          await sleep(400 * attempt);
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      return text;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("fetch failed");
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

function hasMatch(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function parseJsonAvailability(target, rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    const requestUrl = new URL(target.url);
    const requestedRegion = String(requestUrl.searchParams.get("region") || "").trim().toUpperCase();
    const parsed = JSON.parse(trimmed);
    const data = parsed?.data;
    if (!data || typeof data !== "object") {
      return null;
    }

    const vmSpecs = Array.isArray(data.vmSpecComponents) ? data.vmSpecComponents : [];
    const networkSpecs = Array.isArray(data.networkSpecComponents) ? data.networkSpecComponents : [];
    const zones = Array.isArray(data.zones) ? data.zones : [];

    const hasVmSpecs = vmSpecs.some((component) => Array.isArray(component?.specifications) && component.specifications.length > 0);
    const hasChinaOptimized = networkSpecs.some((component) =>
      Array.isArray(component?.specifications) &&
      component.specifications.some((spec) =>
        /china-optimized/i.test(String(spec?.productName || "")) ||
        /china_direct/i.test(String(spec?.name || ""))
      )
    );

    const hasWantedZone = requestedRegion
      ? zones.some((zone) => new RegExp(requestedRegion, "i").test(String(zone?.name || "")))
      : zones.length > 0;

    if (hasVmSpecs && hasChinaOptimized && hasWantedZone) {
      return {
        status: "in_stock",
        detail: requestedRegion
          ? `nube api returned ${requestedRegion} + China-Optimized specs`
          : "nube api returned China-Optimized specs",
      };
    }

    if (hasVmSpecs) {
      return {
        status: "in_stock",
        detail: "nube api returned orderable vm specifications",
      };
    }

    return {
      status: "unknown",
      detail: "nube api returned data but no orderable specs",
    };
  } catch (error) {
    return null;
  }
}

function inferTargetAvailability(target, html, selectedContent) {
  const jsonAvailability = parseJsonAvailability(target, html);
  if (jsonAvailability) {
    return jsonAvailability;
  }

  const fullText = normalizeSpace(loadHtml(html).text()).toLowerCase();
  const selectedText = normalizeSpace(selectedContent).toLowerCase();
  const sourceText = `${fullText}\n${selectedText}\n${String(html || "").toLowerCase()}`;

  if (!sourceText.trim()) {
    return {
      status: "unknown",
      detail: "empty response",
    };
  }

  if (target.css_selector && target.detection_mode === "selector_appears") {
    const $ = loadHtml(html);
    const found = $(target.css_selector).length > 0;
    return {
      status: found ? "in_stock" : "out_of_stock",
      detail: found ? `selector appeared: ${target.css_selector}` : `selector missing: ${target.css_selector}`,
    };
  }

  if (target.css_selector && target.detection_mode === "selector_disappears") {
    const $ = loadHtml(html);
    const found = $(target.css_selector).length > 0;
    return {
      status: found ? "out_of_stock" : "in_stock",
      detail: found ? `selector present: ${target.css_selector}` : `selector disappeared: ${target.css_selector}`,
    };
  }

  const outOfStockPatterns = [
    /out of stock/i,
    /currently out of stock/i,
    /orders? .* suspended/i,
    /sold out/i,
    /page-error/i,
    /unavailable/i,
  ];
  const inStockPatterns = [
    /add to cart/i,
    /order now/i,
    /configure/i,
    /choose billing cycle/i,
    /product configuration/i,
  ];

  if (hasMatch(sourceText, outOfStockPatterns)) {
    return {
      status: "out_of_stock",
      detail: "out of stock markers detected",
    };
  }

  if (hasMatch(sourceText, inStockPatterns)) {
    return {
      status: "in_stock",
      detail: "order controls detected",
    };
  }

  return {
    status: "unknown",
    detail: "no clear stock markers detected",
  };
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
    const availability = inferTargetAvailability(target, html, content);
    const previousAvailability = previousState.last_availability_status || "unknown";
    const availabilityChanged = !baseline && previousAvailability !== availability.status;

    const state = {
      ...previousState,
      last_hash: hash,
      last_title: title,
      last_status: "ok",
      last_detail: availability.detail,
      last_availability_status: availability.status,
      last_availability_detail: availability.detail,
      last_checked_at: checkedAt,
      last_change_at: availabilityChanged ? checkedAt : previousState.last_change_at || null,
    };

    const result = {
      ok: true,
      id: target.id,
      name: target.name,
      status: availabilityChanged ? "changed" : "ok",
      detail: availabilityChanged
        ? `availability changed: ${previousAvailability} -> ${availability.status}`
        : availability.detail,
      checked_at: checkedAt,
      availability_status: availability.status,
      availability_detail: availability.detail,
      open_url: target.open_url || target.url,
      latest_title: title,
    };

    const availabilityLabel =
      availability.status === "in_stock"
        ? "有货 / In Stock"
        : availability.status === "out_of_stock"
        ? "售罄 / Out of Stock"
        : "未知 / Unknown";

    const notification = availabilityChanged
      ? {
          title: summarizeChangeTitle("target", target),
          text: [
            sourceDisplayName(target),
            `库存状态: ${availabilityLabel}`,
            `识别依据: ${availability.detail}`,
            `页面标题: ${title}`,
            `打开: ${target.open_url || target.url}`,
          ].join("\n"),
        }
      : null;

    return { result, state, changed: availabilityChanged, notification };
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
    const recentItems = matched.slice(0, 10).map((entry) => ({
      key: entry.key,
      title: entry.title || "Untitled",
      published: entry.published || "",
      link: entry.link || feed.url,
      summary: truncateText(entry.summary || "", 220),
    }));
    const freshPreview = fresh.slice(0, 5).map((entry) => ({
      title: entry.title || "Untitled",
      published: entry.published || "",
      link: entry.link || "",
      summary: truncateText(entry.summary || "", 220),
    }));
    const deliveredIds =
      previousState.delivered_initialized === true
        ? previousState.delivered_ids || []
        : matched.map((entry) => entry.key);

    const state = {
      ...previousState,
      seen_ids: compactUnique(
        [...matched.map((entry) => entry.key), ...(previousState.seen_ids || [])],
        5000
      ),
      delivered_initialized: true,
      delivered_ids: compactUnique(deliveredIds, 5000),
      last_status: "ok",
      last_detail: latest ? `matched=${matched.length}` : "no matched items",
      last_checked_at: checkedAt,
      last_change_at: fresh.length ? checkedAt : previousState.last_change_at || null,
      last_matched_count: matched.length,
      last_new_items_count: fresh.length,
      last_new_items: freshPreview,
      last_new_item_keys: fresh.slice(0, 20).map((entry) => entry.key),
      last_recent_items: recentItems,
      last_latest_title: latest?.title || "",
      last_latest_published: latest?.published || "",
      last_latest_summary: truncateText(latest?.summary || "", 220),
      last_latest_link: latest?.link || feed.url,
    };

    const result = {
      ok: true,
      id: feed.id,
      name: feed.name,
      status: fresh.length ? "changed" : "ok",
      detail: fresh.length ? `new_items=${fresh.length}` : latest ? `matched=${matched.length}` : "no matched items",
      checked_at: checkedAt,
      matched_count: matched.length,
      new_items_count: fresh.length,
      new_items: freshPreview,
      latest_title: latest?.title || "",
      latest_published: latest?.published || "",
      latest_summary: truncateText(latest?.summary || "", 220),
      latest_link: latest?.link || feed.url,
      open_url: latest?.link || feed.url,
    };

    const notification = fresh.length
      ? {
          title: summarizeChangeTitle("feed", feed),
          text: [
            sourceDisplayName(feed),
            fresh[0]?.title || "Untitled",
            truncateText(fresh[0]?.summary || "", 260),
            "",
            "Continue reading:",
            fresh[0]?.link || feed.url,
          ]
            .filter(Boolean)
            .join("\n"),
          preview_url: fresh[0]?.link || feed.url,
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
