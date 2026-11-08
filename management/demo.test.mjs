import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, createService, today } from "./core.mjs";
import { configuredDemo } from "./demo.mjs";
test("configured demo uses own structure but leaves real sales and contacts untouched", (t) => {
  const db = openStore();
  t.after(() => db.close());
  const s = createService(db),
    owner = s.owner({
      company: "Моя сеть",
      name: "Владелец",
      email: "owner@test.example",
      password: "test-password-12345",
    }),
    a = { ...owner, role: "owner", scope: [], company_name: "Моя сеть" };
  const loc = s.save(a, "locations", { name: "Моя точка" }).id;
  s.save(a, "products", {
    name: "Мой товар",
    category: "Моя категория",
    unit: "шт.",
  });
  s.save(a, "employees", { name: "Мой сотрудник", location_ids: [loc] });
  s.save(a, "customers", { name: "PRIVATE CUSTOMER", phone: "+79991234567" });
  s.plan(a, {
    metric: "sales",
    target: 5000000,
    start_on: today().slice(0, 7) + "-01",
    end_on: today(),
    location_id: loc,
  });
  const before = s.snapshot(a),
    example = configuredDemo(before, {
      from: today().slice(0, 7) + "-01",
      to: today(),
    });
  t.after(() => example.db.close());
  const demo = example.service.snapshot(example.actor, {
    from: example.start,
    to: example.end,
  });
  assert.equal(demo.locations[0].name, "Моя точка");
  assert.equal(demo.products[0].category, "Моя категория");
  assert.equal(demo.employees[0].name, "Мой сотрудник");
  assert.equal(demo.locations[0].id, loc);
  assert.ok(demo.totals.sales > 0);
  assert.ok(demo.trend.length > 0);
  assert.ok(demo.plans[0].actual > 0);
  assert.ok(demo.comparison.factors);
  assert.equal(JSON.stringify(demo).includes("PRIVATE CUSTOMER"), false);
  assert.equal(JSON.stringify(demo).includes("79991234567"), false);
  assert.equal(s.snapshot(a).totals.sales, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM mg_sales").get().n, 0);
  assert.equal(s.snapshot(a).customers[0].phone, "+79991234567");
});
