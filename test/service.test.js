import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { startServer } from "../src/server.js";
import { CrawlerService } from "../src/service.js";

function rssXml(items) {
  const body = items
    .map(
      (item) => `
      <item>
        <title>${item.title}</title>
        <link>${item.link}</link>
        <guid>${item.id}</guid>
        <pubDate>${item.published}</pubDate>
        <description>${item.summary}</description>
      </item>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0">
    <channel>
      <title>Local Feed</title>
      ${body}
    </channel>
  </rss>`;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function setupHarness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "showtimes-vps-"));
  const state = {
    pageVersion: 1,
    pageAvailability: "out_of_stock",
    feedItems: [
      {
        id: "entry-1",
        title: "Entry One",
        link: "https://example.test/entry-1",
        published: "Tue, 31 Mar 2026 10:00:00 GMT",
        summary: "First item",
      },
    ],
    relayMessages: [],
  };

  const sourceServer = http.createServer((request, response) => {
    if (request.url === "/page") {
      const availabilityMarkup =
        state.pageAvailability === "in_stock"
          ? '<button type="button">Add to Cart</button>'
          : '<div class="stock-state">Currently out of stock</div>';
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Page ${state.pageVersion}</title></head><body>version-${state.pageVersion} ${availabilityMarkup}</body></html>`
      );
      return;
    }

    if (request.url === "/feed") {
      response.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
      response.end(rssXml(state.feedItems));
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  const relayServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/relay/send") {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    const auth = request.headers.authorization || "";
    if (auth !== "Bearer test-shared-token") {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    state.relayMessages.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  const sourcePort = await listen(sourceServer);
  const relayPort = await listen(relayServer);

  const configPath = path.join(root, "config.yaml");
  const statePath = path.join(root, "state.json");
  const config = {
    global: {
      request_timeout: 5,
      default_target_interval_minutes: 10,
      default_feed_interval_minutes: 60,
    },
    targets: [
      {
        id: "local-page",
        name: "Local Page",
        url: `http://127.0.0.1:${sourcePort}/page`,
        detection_mode: "content_hash",
        check_interval_minutes: 10,
        enabled: true,
        check_enabled: true,
        notify_enabled: false,
      },
    ],
    rss_feeds: [
      {
        id: "local-feed",
        name: "Local Feed",
        url: `http://127.0.0.1:${sourcePort}/feed`,
        keywords: [],
        check_interval_minutes: 60,
        enabled: true,
        check_enabled: true,
        notify_enabled: false,
      },
    ],
  };

  await writeFile(configPath, yaml.dump(config), "utf8");

  const { server, service } = await startServer({
    port: 0,
    host: "127.0.0.1",
    service: new CrawlerService({
      configPath,
      statePath,
      sharedToken: "test-shared-token",
      relayUrl: `http://127.0.0.1:${relayPort}/relay/send`,
      schedulerEnabled: false,
    }),
  });

  const apiPort = server.address().port;
  const base = `http://127.0.0.1:${apiPort}`;

  t.after(async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => sourceServer.close(resolve));
    await new Promise((resolve) => relayServer.close(resolve));
  });

  async function api(pathname, options = {}) {
    const response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: {
        authorization: "Bearer test-shared-token",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });

    const body = await response.text();
    return {
      status: response.status,
      json: body ? JSON.parse(body) : null,
    };
  }

  return { api, base, service, state, configPath };
}

test("core flows work end to end", async (t) => {
  const { api, base, service, state, configPath } = await setupHarness(t);

  const health = await fetch(`${base}/health`);
  const healthJson = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, "showtimes-vps");

  const targets = await api("/targets");
  assert.equal(targets.status, 200);
  assert.equal(targets.json.targets.length, 1);

  const feeds = await api("/feeds");
  assert.equal(feeds.status, 200);
  assert.equal(feeds.json.feeds.length, 1);

  const baseline = await api("/check/all", { method: "POST", body: "{}" });
  assert.equal(baseline.status, 200);
  assert.equal(baseline.json.summary.changes, 0);
  assert.equal(state.relayMessages.length, 0);

  state.pageVersion = 2;
  state.pageAvailability = "in_stock";
  state.feedItems.unshift({
    id: "entry-2",
    title: "Entry Two",
    link: "https://example.test/entry-2",
    published: "Tue, 31 Mar 2026 11:00:00 GMT",
    summary: "Second item",
  });

  const changedManual = await api("/check/all", { method: "POST", body: "{}" });
  assert.equal(changedManual.status, 200);
  assert.equal(changedManual.json.summary.changes, 2);
  assert.equal(state.relayMessages.length, 0);

  const firstView = await api("/feeds/view", {
    method: "POST",
    body: JSON.stringify({ query: "local-feed", limit: 5 }),
  });
  assert.equal(firstView.status, 200);
  assert.equal(firstView.json.new_items_count, 1);
  assert.equal(firstView.json.new_items[0].title, "Entry Two");

  const secondView = await api("/feeds/view", {
    method: "POST",
    body: JSON.stringify({ query: "local-feed", limit: 5, refresh: false }),
  });
  assert.equal(secondView.status, 200);
  assert.equal(secondView.json.new_items_count, 0);

  await api("/sources/control", {
    method: "POST",
    body: JSON.stringify({ query: "local-page", notify_enabled: true }),
  });
  await api("/sources/control", {
    method: "POST",
    body: JSON.stringify({ query: "local-feed", notify_enabled: true }),
  });

  state.pageVersion = 3;
  state.pageAvailability = "out_of_stock";
  state.feedItems.unshift({
    id: "entry-3",
    title: "Entry Three",
    link: "https://example.test/entry-3",
    published: "Tue, 31 Mar 2026 12:00:00 GMT",
    summary: "Third item",
  });

  const automated = await service.runAutomatedOnce();
  assert.equal(automated.length, 2);
  assert.equal(state.relayMessages.length, 2);
  assert.match(state.relayMessages[0].title, /(Page changed|RSS updated)/);

  await api("/targets/add", {
    method: "POST",
    body: JSON.stringify({ name: "Extra Target", url: "https://example.test/target" }),
  });
  await api("/feeds/add", {
    method: "POST",
    body: JSON.stringify({ url: "https://example.test/feed.xml" }),
  });

  const targetsAfterAdd = await api("/targets");
  const feedsAfterAdd = await api("/feeds");
  assert.equal(targetsAfterAdd.json.targets.length, 2);
  assert.equal(feedsAfterAdd.json.feeds.length, 2);

  await api("/targets/remove", {
    method: "POST",
    body: JSON.stringify({ query: "Extra Target" }),
  });
  await api("/feeds/remove", {
    method: "POST",
    body: JSON.stringify({ query: "https://example.test/feed.xml" }),
  });

  const targetsAfterRemove = await api("/targets");
  const feedsAfterRemove = await api("/feeds");
  assert.equal(targetsAfterRemove.json.targets.length, 1);
  assert.equal(feedsAfterRemove.json.feeds.length, 1);

  const persisted = yaml.load(await readFile(configPath, "utf8"));
  assert.equal(persisted.targets.length, 1);
  assert.equal(persisted.rss_feeds.length, 1);
});
