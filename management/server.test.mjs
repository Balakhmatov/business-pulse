import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openStore, createService, today } from "./core.mjs";
import { createApp } from "./server.mjs";
import { insightFacts, createInsights } from "./insights.mjs";
test("HTTP cookie auth, CSRF, isolated demo, invalid JSON and bearer import", async (t) => {
  const db = openStore(),
    s = createService(db);
  const owner = s.owner({
      company: "Real company",
      name: "Owner",
      email: "owner@test.example",
      password: "test-password-12345",
    }),
    a = { ...owner, role: "owner", scope: [] };
  const l = s.save(a, "locations", { name: "Location" }).id,
    p = s.save(a, "products", {
      name: "Product",
      category: "Cat",
      unit: "шт.",
    }).id;
  const app = createApp({ db, origin: "http://test.local", secure: false });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => {
    app.closeAllConnections();
    app.close();
    db.close();
  });
  const base = "http://127.0.0.1:" + app.address().port;
  const request = (route, data, headers = {}) =>
    fetch(base + route, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Origin: "http://test.local",
        "Content-Type": "application/json",
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  assert.equal((await request("/api/workspace")).status, 401);
  assert.equal((await request("/api/sales")).status, 401);
  assert.equal((await request("/api/products")).status, 401);
  assert.equal((await request("/api/demo")).status, 200);
  assert.equal((await request("/api/demo?configured=1")).status, 401);
  assert.equal(s.snapshot(a).totals.sales, 0);
  assert.equal(
    (
      await request(
        "/api/login",
        { email: "owner@test.example", password: "test-password-12345" },
        { Origin: "http://evil.local" },
      )
    ).status,
    403,
  );
  const login = await request("/api/login", {
      email: "owner@test.example",
      password: "test-password-12345",
    }),
    cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /bp_management_session/);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const snapshot = await request("/api/workspace", undefined, {
    Cookie: cookie,
  });
  assert.equal((await snapshot.json()).actor.company_name, "Real company");
  const personalDemo = await request("/api/demo?configured=1", undefined, {
    Cookie: cookie,
  });
  const illustrated = await personalDemo.json();
  assert.equal(illustrated.demo_configured, true);
  assert.equal(illustrated.locations[0].name, "Location");
  assert.ok(illustrated.totals.sales > 0);
  assert.equal(s.snapshot(a).totals.sales, 0);
  const catalogue = await (
    await request("/api/products?q=Product", undefined, { Cookie: cookie })
  ).json();
  assert.equal(catalogue.total, 1);
  const demoSales = await (
    await request(
      "/api/demo/sales?configured=1&group=product&layout=locations",
      undefined,
      { Cookie: cookie },
    )
  ).json();
  assert.ok(demoSales.items.length > 0);
  assert.ok(demoSales.totals.sales > 0);
  assert.equal(s.snapshot(a).totals.sales, 0);
  const k = s.key(a, "POS");
  assert.equal(
    (
      await request(
        "/api/v1/sales",
        {
          source: "pos",
          rows: [
            {
              external_id: "a",
              receipt_id: "r",
              date: today(),
              location_id: l,
              product_id: p,
              status: "sale",
              quantity: 1,
              amount_kopecks: 5000,
            },
          ],
        },
        { Authorization: "Bearer " + k.token },
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/workspace", undefined, { Cookie: cookie })).status,
    200,
  );
  s.revoke(a, k.id);
  assert.equal(
    (await request("/api/v1/sales", {}, { Authorization: "Bearer " + k.token }))
      .status,
    401,
  );
  const invalid = await fetch(base + "/api/save", {
    method: "POST",
    headers: {
      Origin: "http://test.local",
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: "{",
  });
  assert.equal(invalid.status, 400);
  await request("/api/logout", {}, { Cookie: cookie });
  assert.equal(
    (await request("/api/workspace", undefined, { Cookie: cookie })).status,
    401,
  );
});
test("AI facts exclude contacts and fallback is available without provider", async (t) => {
  const db = openStore();
  t.after(() => db.close());
  const s = createService(db),
    o = s.owner({
      company: "Private company",
      name: "Private owner",
      email: "owner@test.example",
      password: "test-password-12345",
    }),
    a = { ...o, role: "owner", scope: [] };
  s.save(a, "customers", {
    name: "PRIVATE CUSTOMER",
    phone: "+79991234567",
    notes: "PRIVATE NOTES",
  });
  const snapshot = s.snapshot(a),
    facts = JSON.stringify(insightFacts(snapshot));
  for (const forbidden of [
    "PRIVATE CUSTOMER",
    "79991234567",
    "PRIVATE NOTES",
    "owner@test.example",
  ])
    assert.equal(facts.includes(forbidden), false);
  const fallback = await createInsights({ key: null })(snapshot);
  assert.equal(fallback.mode, "rules");
  const degraded = await createInsights({
    key: "test",
    fetcher: async () => {
      throw Error("down");
    },
  })(snapshot);
  assert.equal(degraded.mode, "rules");
  assert.equal(degraded.provider_unavailable, true);
});

test("subpath serves assets and API only under mount, with isolated cookie path", async (t) => {
  const db = openStore(),
    s = createService(db);
  s.owner({
    company: "Mounted",
    name: "Owner",
    email: "mount@example.test",
    password: "test-password-12345",
  });
  const app = createApp({
    db,
    origin: "http://test.local",
    basePath: "/businesspulse",
    secure: false,
    demo: false,
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => {
    app.closeAllConnections();
    app.close();
    db.close();
  });
  const base = "http://127.0.0.1:" + app.address().port;
  const redirect = await fetch(base + "/businesspulse", { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/businesspulse/");
  assert.equal((await fetch(base + "/api/health")).status, 404);
  assert.equal((await fetch(base + "/businesspulse/api/health")).status, 200);
  const html = await (await fetch(base + "/businesspulse/")).text();
  assert.match(html, /href="\.\/styles.css"/);
  assert.match(html, /src="\.\/app.js"/);
  assert.equal((await fetch(base + "/businesspulse/import.js")).status, 200);
  const login = await fetch(base + "/businesspulse/api/login", {
    method: "POST",
    headers: {
      Origin: "http://test.local",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "mount@example.test",
      password: "test-password-12345",
    }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /Path=\/businesspulse\//);
});
