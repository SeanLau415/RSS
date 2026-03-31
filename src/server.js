import http from "node:http";
import { pathToFileURL } from "node:url";
import { CrawlerService } from "./service.js";

function envBoolean(name, fallback) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return !["0", "false", "off", "no"].includes(raw);
}

function envInteger(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function requireAuth(request, service) {
  const auth = request.headers.authorization || "";
  return auth === `Bearer ${service.sharedToken}`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function createServiceFromEnv() {
  const sharedToken = String(process.env.VPS_SHARED_TOKEN || "").trim();
  if (!sharedToken) {
    throw new Error("VPS_SHARED_TOKEN is required");
  }

  return new CrawlerService({
    configPath: process.env.CONFIG_PATH || "./data/config.yaml",
    statePath: process.env.STATE_PATH || "./data/state.json",
    sharedToken,
    relayUrl: process.env.RELAY_URL || "",
    schedulerEnabled: envBoolean("SCHEDULER_ENABLED", true),
    schedulerPollSeconds: envInteger("SCHEDULER_POLL_SECONDS", 15),
    checkConcurrency: envInteger("CHECK_CONCURRENCY", 4),
  });
}

export function createHttpServer(service) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(response, 200, service.health());
      }

      if (!requireAuth(request, service)) {
        return jsonResponse(response, 401, { ok: false, error: "Unauthorized" });
      }

      if (request.method === "GET" && url.pathname === "/targets") {
        return jsonResponse(response, 200, service.listTargets());
      }

      if (request.method === "GET" && url.pathname === "/feeds") {
        return jsonResponse(response, 200, service.listFeeds());
      }

      if (request.method === "POST" && url.pathname === "/check/all") {
        return jsonResponse(response, 200, await service.checkAll({ manual: true }));
      }

      if (request.method === "POST" && url.pathname === "/check/target") {
        const body = await readJsonBody(request);
        return jsonResponse(response, 200, await service.checkTarget(body.query, { manual: true }));
      }

      if (request.method === "POST" && url.pathname === "/check/feed") {
        const body = await readJsonBody(request);
        return jsonResponse(response, 200, await service.checkFeed(body.query, { manual: true }));
      }

      if (request.method === "POST" && url.pathname === "/sources/control") {
        const body = await readJsonBody(request);
        return jsonResponse(
          response,
          200,
          await service.updateSourceControl(body.query, {
            enabled: body.enabled,
            check_enabled: body.check_enabled,
            notify_enabled: body.notify_enabled,
          })
        );
      }

      if (request.method === "POST" && url.pathname === "/targets/add") {
        const body = await readJsonBody(request);
        return jsonResponse(response, 200, await service.addTarget(body));
      }

      if (request.method === "POST" && url.pathname === "/targets/remove") {
        const body = await readJsonBody(request);
        return jsonResponse(response, 200, await service.removeTarget(body.query));
      }

      if (request.method === "POST" && url.pathname === "/feeds/add") {
        const body = await readJsonBody(request);
        return jsonResponse(response, 200, await service.addFeed(body));
      }

      if (request.method === "POST" && url.pathname === "/feeds/remove") {
        const body = await readJsonBody(request);
        return jsonResponse(response, 200, await service.removeFeed(body.query));
      }

      return jsonResponse(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      return jsonResponse(response, 400, {
        ok: false,
        error: String(error?.message || error),
      });
    }
  });
}

export async function startServer(options = {}) {
  const service = options.service || createServiceFromEnv();
  await service.init();

  const server = createHttpServer(service);
  const port = options.port ?? envInteger("PORT", 8080);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";

  await new Promise((resolve) => server.listen(port, host, resolve));
  service.startScheduler();

  return { server, service };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
    .then(({ server, service }) => {
      console.log(
        JSON.stringify(
          {
            ok: true,
            service: service.serviceName,
            listen: server.address(),
          },
          null,
          2
        )
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
