import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(input) {
  return crypto.createHash("sha256").update(String(input ?? "")).digest("hex");
}

export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizeSpace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function ensureBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

export function ensureInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

export function extractHtmlTitle(html) {
  const match = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return "";
  }
  return normalizeSpace(decodeHtml(match[1]));
}

export function stableNumber(input) {
  return Number.parseInt(sha256(input).slice(0, 8), 16);
}

export function stableOffsetMs(id, spreadMs) {
  if (!spreadMs || spreadMs <= 0) {
    return 0;
  }
  return stableNumber(id) % spreadMs;
}

export function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function compactUnique(values, max = 200) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    output.push(text);
    if (output.length >= max) {
      break;
    }
  }
  return output;
}

export function sourceDisplayName(source) {
  return source?.name || source?.id || "Unnamed source";
}

export function summarizeChangeTitle(kind, source) {
  const label = sourceDisplayName(source);
  return kind === "feed" ? `RSS updated: ${label}` : `Page changed: ${label}`;
}
