import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, createService, today, aggregate } from "./core.mjs";
function fixture(t) {
  const db = openStore();
  t.after(() => db.close());
  const s = createService(db);
  const ids = s.owner({
    company: "Тестовая сеть",
    name: "Владелец",
    email: "owner@example.test",
    password: "test-password-12345",
  });
  const a = {
    ...ids,
    role: "owner",
    scope: [],
    name: "Владелец",
    company_name: "Тестовая сеть",
  };
  const l = s.save(a, "locations", { name: "Точка 1" }).id,
    l2 = s.save(a, "locations", { name: "Точка 2" }).id;
  const p = s.save(a, "products", {
      name: "Товар",
      category: "Уход",
      unit: "шт.",
    }).id,
    e = s.save(a, "employees", { name: "Анна", location_ids: [l] }).id;
  const row = {
    external_id: "r1",
    receipt_id: "check1",
    date: today(),
    location_id: l,
    employee_id: e,
    product_id: p,
    status: "sale",
    quantity: 2,
    amount_kopecks: 100000,
    cost_kopecks: 60000,
    discount_kopecks: 0,
  };
  return { db, s, a, l, l2, p, e, row };
}
test("sales upsert, refund and cancellation are atomic and tenant-bound", (t) => {
  const { s, a, l2, row } = fixture(t);
  assert.deepEqual(s.importSales(a, { source: "pos", rows: [row] }), {
    inserted: 1,
    updated: 0,
    cancelled: 0,
  });
  s.importSales(a, { source: "pos", rows: [row] });
  assert.equal(s.snapshot(a).totals.sales, 100000);
  s.importSales(a, {
    source: "pos",
    rows: [
      {
        ...row,
        external_id: "refund1",
        status: "refund",
        amount_kopecks: 50000,
        cost_kopecks: 30000,
        quantity: 1,
      },
    ],
  });
  assert.equal(s.snapshot(a).totals.profit, 20000);
  assert.throws(() =>
    s.importSales(a, {
      source: "pos",
      rows: [
        { ...row, external_id: "ok" },
        { ...row, external_id: "bad", location_id: "foreign" },
      ],
    }),
  );
  assert.equal(s.snapshot(a).totals.sales, 50000);
  s.importSales(a, {
    source: "pos",
    rows: [{ external_id: "refund1", status: "cancelled" }],
  });
  assert.equal(s.snapshot(a).totals.sales, 100000);
  assert.throws(
    () =>
      s.importSales(a, { source: "pos", rows: [{ ...row, location_id: l2 }] }),
    /Сотрудник/,
  );
});
test("manager and employee scope enforced, contacts never leak", (t) => {
  const { s, a, l, l2, e, row } = fixture(t);
  s.importSales(a, {
    source: "pos",
    rows: [
      row,
      {
        ...row,
        external_id: "2",
        employee_id: null,
        location_id: l2,
        amount_kopecks: 700000,
      },
    ],
  });
  s.save(a, "customers", { name: "Секретный клиент", phone: "+79991234567" });
  const manager = { ...a, role: "manager", scope: [l] };
  assert.equal(s.snapshot(manager).totals.sales, 100000);
  assert.equal(s.snapshot(manager).locations.length, 1);
  assert.equal(s.snapshot(manager).customers.length, 0);
  assert.throws(
    () => s.snapshot(manager, { location_id: l2 }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => s.save(manager, "customers", { name: "X" }),
    (e) => e.status === 403,
  );
  const employee = { ...a, role: "employee", scope: [l], employee_id: e };
  assert.equal(s.snapshot(employee).totals.sales, 100000);
  assert.throws(
    () => s.plan(employee, { metric: "sales" }),
    (e) => e.status === 403,
  );
  assert.equal(s.snapshot({ ...manager, scope: [] }).totals.sales, 0);
});
test("plans compare to elapsed period and preserve revision history", (t) => {
  const { s, a, db, row, l } = fixture(t);
  s.importSales(a, { source: "pos", rows: [row] });
  const start = today().slice(0, 7) + "-01",
    end = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0))
      .toISOString()
      .slice(0, 10);
  const p = s.plan(a, {
    metric: "sales",
    target: 300000,
    start_on: start,
    end_on: end,
    location_id: l,
  }).id;
  const plan = s.snapshot(a).plans[0];
  assert.equal(plan.actual, 100000);
  assert.equal(
    plan.target_to_date,
    (300000 * plan.elapsed_days) / plan.total_days,
  );
  assert.equal(plan.forecast, (100000 / plan.elapsed_days) * plan.total_days);
  s.plan(a, {
    id: p,
    metric: "sales",
    target: 400000,
    start_on: start,
    end_on: end,
    location_id: l,
  });
  assert.equal(db.prepare("SELECT count(*) n FROM mg_plan_history").get().n, 2);
  assert.equal(s.snapshot(a).plans[0].version, 2);
  s.plan(a, { metric: "refund_rate", target: 3, start_on: start, end_on: end });
  assert.equal(s.snapshot(a).plans[0].status, "good");
});
test("missing costs and mixed units do not invent profit or basket", () => {
  const base = {
    source: "s",
    location_id: "l",
    sold_on: "2026-11-01",
    receipt_id: "1",
    status: "sale",
    quantity: 1,
    amount: 500,
    cost: null,
    discount: 0,
    unit: "шт.",
  };
  assert.equal(aggregate([base]).profit, null);
  assert.equal(aggregate([base, { ...base, unit: "кг" }]).quantity, null);
  assert.equal(aggregate([base]).receipts, 1);
  assert.equal(aggregate([base, { ...base, source: "other" }]).receipts, 2);
});
test("cross company references and arbitrary table names are rejected", (t) => {
  const { s, a, p } = fixture(t);
  const other = s.owner({
    company: "Другие",
    name: "Другой",
    email: "other@example.test",
    password: "test-password-67890",
  });
  const b = { ...other, role: "owner", scope: [] };
  assert.throws(() => s.save(b, "products", { id: p, name: "Подмена" }));
  assert.throws(() => s.save(a, "keys", { id: "x" }));
  assert.throws(() =>
    s.importSales(b, {
      source: "s",
      rows: [{ external_id: "1", location_id: "x" }],
    }),
  );
});
test("invite assigns restricted role, single use; keys revoke immediately", (t) => {
  const { s, a, l, e, row } = fixture(t);
  const i = s.invite(a, {
    email: "staff@example.test",
    role: "employee",
    location_ids: [l],
    employee_id: e,
  });
  s.accept({
    token: i.token,
    name: "Сотрудник",
    password: "employee-test-12345",
  });
  assert.throws(() =>
    s.accept({
      token: i.token,
      name: "Второй",
      password: "employee-test-12345",
    }),
  );
  const login = s.login({
      email: "staff@example.test",
      password: "employee-test-12345",
    }),
    actor = s.actor(login.token);
  assert.equal(actor.role, "employee");
  assert.deepEqual(actor.scope, [l]);
  const k = s.key(a, "Касса");
  const ia = s.integration(k.token);
  s.importSales(ia, { source: "pos", rows: [row] });
  assert.equal(s.snapshot(a).totals.sales, 100000);
  s.revoke(a, k.id);
  assert.equal(s.integration(k.token), null);
  s.logout(login.token);
  assert.equal(s.actor(login.token), null);
});
test("marketing attribution respects dates/products and comparable costs", (t) => {
  const { s, a, l, p, row } = fixture(t);
  const cp = s.save(a, "campaigns", {
    name: "Акция",
    kind: "promotion",
    channel: "VK",
    start_on: today(),
    end_on: today(),
    budget: 10000,
    spend: 5000,
    goal: "Прибыль",
    location_ids: [l],
    product_ids: [p],
  }).id;
  s.importSales(a, { source: "pos", rows: [{ ...row, campaign_id: cp }] });
  const r = s.snapshot(a, { from: today(), to: today() }).campaigns[0];
  assert.equal(r.results.sales, 100000);
  assert.equal(r.result_after_spend, 35000);
  assert.equal(
    s.snapshot(a, { from: today(), to: today(), location_id: l }).campaigns[0]
      .result_after_spend,
    null,
  );
});
test("customer contacts optional, consents explicit and loyalty snapshots retained", (t) => {
  const { s, a } = fixture(t);
  const id = s.save(a, "customers", {
    name: "Клиент",
    external_ids: { pos: "001" },
    loyalty: { program: "Клуб", balance: 100, as_of: today() },
    consents: [
      { channel: "email", granted: false, date: today(), source: "Отказ" },
    ],
  }).id;
  const c = s.snapshot(a).customers.find((c) => c.id === id);
  assert.equal(c.phone, "");
  assert.equal(c.loyalty.balance, 100);
  assert.equal(c.consents[0].granted, false);
  assert.throws(() => s.save(a, "customers", { email: "bad" }));
});
test("catalog integration upserts references atomically; stable IDs survive rename", (t) => {
  const { s, a } = fixture(t),
    key = s.key(a, "POS"),
    ia = s.integration(key.token);
  const first = s.catalog(ia, {
    source: "pos",
    entities: {
      locations: [{ external_id: "shop1", name: "Магазин" }],
      products: [
        {
          external_id: "sku1",
          name: "Товар",
          category: "Категория",
          unit: "шт.",
        },
      ],
      employees: [
        { external_id: "person1", name: "Сотрудник", location_refs: ["shop1"] },
      ],
    },
  });
  const again = s.catalog(ia, {
    source: "pos",
    entities: {
      products: [
        {
          external_id: "sku1",
          name: "Переименованный товар",
          category: "Категория",
          unit: "шт.",
        },
      ],
    },
  });
  assert.equal(first.products[0].id, again.products[0].id);
  assert.throws(() =>
    s.catalog(ia, {
      source: "pos",
      entities: {
        locations: [{ external_id: "will-rollback", name: "Откат" }],
        employees: [
          { external_id: "bad", name: "Неизвестно", location_refs: ["nope"] },
        ],
      },
    }),
  );
  assert.equal(
    s.snapshot(a).locations.some((l) => l.name === "Откат"),
    false,
  );
});
test("changing membership changes existing session immediately, removing revokes it", (t) => {
  const { s, a, l, e } = fixture(t),
    i = s.invite(a, {
      email: "manager@example.test",
      role: "manager",
      location_ids: [l],
    });
  s.accept({
    token: i.token,
    name: "Управляющий",
    password: "manager-test-password",
  });
  const session = s.login({
      email: "manager@example.test",
      password: "manager-test-password",
    }),
    user = s.actor(session.token);
  s.member(a, {
    user_id: user.user_id,
    role: "employee",
    location_ids: [l],
    employee_id: e,
  });
  assert.equal(s.actor(session.token).role, "employee");
  s.member(a, { user_id: user.user_id, remove: true });
  assert.equal(s.actor(session.token), null);
  assert.throws(() => s.member(a, { user_id: a.user_id, remove: true }));
});
test("factor contributions reconcile exactly with change in sales", async () => {
  const { factorComparison } = await import("./core.mjs");
  const previous = {
      receipts: 100,
      average: 1000,
      sales: 100000,
      quantity: 200,
      unit: "шт.",
    },
    next = {
      receipts: 120,
      average: 1500,
      sales: 180000,
      quantity: 300,
      unit: "шт.",
    };
  const f = factorComparison(previous, next);
  assert.ok(Math.abs(f.reduce((n, x) => n + x.contribution, 0) - 80000) < 1e-8);
  assert.equal(f.length, 3);
  assert.equal(factorComparison(previous, next, false), null);
});
test("cancellation retries are idempotent, a restored sale clears its tombstone", (t) => {
  const { s, a, row } = fixture(t);
  s.importSales(a, { source: "pos", rows: [row] });
  const cancel = {
    source: "pos",
    rows: [{ external_id: row.external_id, status: "cancelled" }],
  };
  s.importSales(a, cancel);
  assert.deepEqual(s.importSales(a, cancel), {
    inserted: 0,
    updated: 0,
    cancelled: 0,
  });
  assert.equal(s.snapshot(a).totals.sales, 0);
  s.importSales(a, { source: "pos", rows: [row] });
  assert.equal(s.snapshot(a).totals.sales, 100000);
  s.importSales(a, cancel);
  assert.equal(s.snapshot(a).totals.sales, 0);
});
test("a scoped director cannot create company-wide integration keys or access grants", (t) => {
  const { s, a, l } = fixture(t),
    scoped = { ...a, role: "director", scope: [l] };
  assert.throws(
    () => s.key(scoped, "Escalation"),
    (e) => e.status === 403,
  );
  assert.throws(
    () =>
      s.invite(scoped, {
        email: "bad@example.test",
        role: "marketing",
        location_ids: [],
      }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => s.save(scoped, "locations", { name: "Other" }),
    (e) => e.status === 403,
  );
});
