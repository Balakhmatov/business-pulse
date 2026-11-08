import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, createService, fail } from "./core.mjs";
import { createInsights } from "./insights.mjs";
import { createHash } from "node:crypto";
import { demoWorkspace, configuredDemo } from "./demo.mjs";
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
// One content version for the complete UI, including imported modules and styles.
// Changing any browser asset invalidates every browser/CDN entry point together.
const assetFiles = ["index.html", "app.js", "kpi.js", "import.js", "styles.css"];
const rawAssets = Object.fromEntries(assetFiles.map(file => [file, fs.readFileSync(path.join(publicDir, file), "utf8")]));
const assetVersion = createHash("sha256").update(assetFiles.map(file => file + "\0" + rawAssets[file]).join("\0")).digest("hex").slice(0, 16);
const assets = Object.fromEntries(assetFiles.map(file => [file, rawAssets[file].replaceAll("__BPM_ASSET_VERSION__", assetVersion)]));
const COOKIE = "bp_management_session";
const cookie = (req) =>
  (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(COOKIE + "="))
    ?.slice(COOKIE.length + 1) || "";
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let size = 0,
    parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 4 * 1024 * 1024) fail("Запрос превышает 4 МБ.", 413);
    parts.push(part);
  }
  try {
    const data = JSON.parse(Buffer.concat(parts).toString());
    if (!data || Array.isArray(data) || typeof data !== "object")
      fail("Ожидается объект JSON.");
    return data;
  } catch (e) {
    if (e.status) throw e;
    fail("Некорректный JSON.");
  }
}
export function createApp({
  db,
  origin = "http://127.0.0.1:3128",
  secure = origin.startsWith("https:"),
  demo = true,
  basePath = "",
}) {
  const mount = basePath.replace(/\/$/, "");
  if (mount && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount))
    throw Error("Invalid BPM_BASE_PATH");
  const cookiePath = (mount || "") + "/";
  const service = createService(db),
    example = demo ? demoWorkspace() : null,
    attempts = new Map(),
    insights = createInsights(),
    demoCache = new Map();
  function rate(req) {
    const key = req.socket.remoteAddress,
      now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.until < now) {
      entry = { n: 0, until: now + 15 * 60000 };
      attempts.set(key, entry);
    }
    if (++entry.n > 30) fail("Слишком много попыток. Повторите позже.", 429);
    if (attempts.size > 10000)
      for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  }
  function demoFor(req, url) {
    let workspace = example;
    const filters = Object.fromEntries(url.searchParams);
    if (url.searchParams.get("configured") === "1") {
      const actor = service.actor(cookie(req));
      if (!actor) fail("Войдите в компанию для демо на её структуре.", 401);
      const range = { from: filters.from, to: filters.to };
      const live = service.snapshot(actor, range);
      const config = {
        actor: live.actor,
        kpi_definitions:live.kpi_definitions,
        locations: live.locations,
        products: live.products,
        employees: live.employees,
        plans: live.plans.map(
          ({
            id,
            metric,
            target,
            start_on,
            end_on,
            location_id,
            employee_id,
            category,
            product_id,
            options,
          }) => ({
            id,
            metric,
            target,
            start_on,
            end_on,
            location_id,
            employee_id,
            category,
            product_id,
            options,
          }),
        ),
      };
      const cacheKey = createHash("sha256")
        .update(
          JSON.stringify({
            company: actor.company_id,
            role: actor.role,
            scope: actor.scope,
            config,
            range,
          }),
        )
        .digest("hex");
      workspace = demoCache.get(cacheKey);
      if (!workspace) {
        workspace = configuredDemo(config, range);
        if (demoCache.size >= 6) {
          const first = demoCache.keys().next().value;
          demoCache.get(first).db.close();
          demoCache.delete(first);
        }
        demoCache.set(cacheKey, workspace);
      }
    }
    return workspace;
  }
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (mount && url.pathname === mount) {
        res.writeHead(308, { Location: mount + "/" + url.search });
        return res.end();
      }
      if (mount && !url.pathname.startsWith(mount + "/"))
        return json(res, 404, { error: "Маршрут не найден." });
      const p = mount ? url.pathname.slice(mount.length) : url.pathname;
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (!["GET", "POST"].includes(req.method))
        return json(res, 405, { error: "Метод не поддерживается." });
      if (req.method === "POST" && !p.startsWith("/api/v1/")) {
        if (req.headers.origin !== origin)
          fail("Недопустимый источник запроса.", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          fail("Используйте application/json.", 415);
      }
      if (p === "/api/health" && req.method === "GET")
        return json(res, 200, {
          ok: db.prepare("SELECT 1 AS n").get().n === 1,
          service: "business-pulse-management",
        });
      if (
        ["/api/demo", "/api/demo/sales", "/api/demo/products"].includes(p) &&
        req.method === "GET" &&
        example
      ) {
        const workspace = demoFor(req, url),
          filters = {
            from: workspace.start,
            to: workspace.end,
            ...Object.fromEntries(url.searchParams),
          };
        const result = p.endsWith("/sales")
          ? workspace.service.salesReport(workspace.actor, filters)
          : p.endsWith("/products")
            ? workspace.service.products(workspace.actor, filters)
            : workspace.service.snapshot(workspace.actor, filters);
        return json(res, 200, {
          ...result,
          demo: true,
          demo_configured: Boolean(workspace.configured),
        });
      }
      if (p === "/api/login" && req.method === "POST") {
        rate(req);
        const { token } = service.login(await body(req));
        return json(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=604800${secure ? "; Secure" : ""}`,
          },
        );
      }
      if (p === "/api/accept-invite" && req.method === "POST") {
        rate(req);
        return json(res, 200, service.accept(await body(req)));
      }
      if (p.startsWith("/api/v1/")) {
        const a = service.integration(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        );
        if (!a) fail("Ключ интеграции недействителен.", 401);
        if (req.method === "POST" && p === "/api/v1/heartbeat") return json(res,200,service.heartbeat(a,await body(req)));
        if (req.method === "POST" && p === "/api/v1/kpi-values") return json(res,200,service.importKpi(a,await body(req)));
        if (req.method === "POST" && p === "/api/v1/catalog")
          return json(res, 200, service.catalog(a, await body(req)));
        if (req.method === "POST" && p === "/api/v1/sales")
          return json(res, 200, service.importSales(a, await body(req)));
        fail("Маршрут не найден.", 404);
      }
      if (p.startsWith("/api/")) {
        const token = cookie(req),
          a = service.actor(token);
        if (!a) fail("Войдите в кабинет.", 401);
        if (p === "/api/logout" && req.method === "POST") {
          service.logout(token);
          return json(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0${secure ? "; Secure" : ""}`,
            },
          );
        }
        if (p === "/api/products" && req.method === "GET")
          return json(
            res,
            200,
            service.products(a, Object.fromEntries(url.searchParams)),
          );
        if (p === "/api/sales" && req.method === "GET")
          return json(
            res,
            200,
            service.salesReport(a, Object.fromEntries(url.searchParams)),
          );
        if (p === "/api/insights" && req.method === "GET") {
          const snapshot = service.snapshot(
            a,
            Object.fromEntries(url.searchParams),
          );
          if (url.searchParams.get("sales") === "1") {
            const params = Object.fromEntries(url.searchParams);
            snapshot.sales_analysis = service.salesReport(a, {
              ...params,
              page_size: 5,
            });
            snapshot.plans = snapshot.plans.filter(
              (p) =>
                (!params.category || p.category === params.category) &&
                (!params.product_id || p.product_id === params.product_id),
            );
          }
          return json(
            res,
            200,
            await insights(snapshot, a.company_id + ":" + a.user_id),
          );
        }
        if (p === "/api/plans/history" && req.method === "GET") return json(res,200,service.planHistory(a,url.searchParams.get("id")));
        if (p === "/api/workspace" && req.method === "GET")
          return json(
            res,
            200,
            service.snapshot(a, Object.fromEntries(url.searchParams)),
          );
        if (req.method === "POST") {
          const input = await body(req);
          if (p === "/api/save")
            return json(res, 200, service.save(a, input.type, input.record));
          if (p === "/api/members")
            return json(res, 200, service.member(a, input));
          if (p === "/api/catalog")
            return json(res, 200, service.catalog(a, input));
          if (p === "/api/plans") return json(res, 200, service.plan(a, input));
          if (p === "/api/plans/copy") return json(res,200,service.copyPlans(a,input));
          if (p === "/api/kpi-definitions") return json(res,200,service.defineKpi(a,input));
          if (p === "/api/kpi-values") return json(res,200,service.importKpi(a,input));
          if (p === "/api/notifications/seen") return json(res,200,service.acknowledge(a,input.id));
          if (p === "/api/invites")
            return json(res, 200, service.invite(a, input));
          if (p === "/api/keys")
            return json(res, 200, service.key(a, input.name));
          if (p === "/api/keys/revoke")
            return json(res, 200, service.revoke(a, input.id));
          if (p === "/api/import")
            return json(res, 200, service.importSales(a, input));
        }
        fail("Маршрут не найден.", 404);
      }
      if (req.method !== "GET") fail("Маршрут не найден.", 404);
      const files = {
        "/": "index.html",
        "/app.js": "app.js",
        "/kpi.js":"kpi.js",
        "/import.js": "import.js",
        "/styles.css": "styles.css",
      };
      if (!files[p]) fail("Страница не найдена.", 404);
      const file = files[p],
        mime = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html";
      res.writeHead(200, {
        "Content-Type": mime + "; charset=utf-8",
        "Cache-Control": file !== "index.html" && url.searchParams.get("v") === assetVersion
          ? "public, max-age=31536000, immutable"
          : "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(assets[file]);
    } catch (e) {
      if (!res.headersSent)
        json(res, e.status || 500, {
          error: e.status ? e.message : "Ошибка сервера. Повторите запрос.",
        });
      else res.end();
      if (!e.status) console.error("Management request failed:", e.message);
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file =
    process.env.BPM_DB_FILE ||
    "/var/lib/business-pulse-management/management.db";
  // Never run the management schema against the production database.
  if (path.basename(file) === "pulse.db" || file === process.env.BP_DB_FILE)
    throw Error("Management requires its own database.");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = openStore(file),
    port = Number(process.env.BPM_PORT || 3128),
    origin = process.env.BPM_ORIGIN || "http://127.0.0.1:" + port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Invalid BPM_PORT");
  const app = createApp({
    db,
    origin,
    basePath: process.env.BPM_BASE_PATH || "",
  });
  app.listen(port, "127.0.0.1", () =>
    console.log("Business Pulse management listening on 127.0.0.1:" + port),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      app.close(() => {
        db.close();
        process.exit();
      }),
    );
}
