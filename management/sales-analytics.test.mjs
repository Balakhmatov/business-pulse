import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, createService } from "./core.mjs";
function fixture(t) {
  const db = openStore();
  t.after(() => db.close());
  const s = createService(db),
    o = s.owner({
      company: "Сеть",
      name: "Владелец",
      email: "test@example.test",
      password: "test-password-12345",
    }),
    a = { ...o, role: "owner", scope: [] };
  const l1 = s.save(a, "locations", { name: "Мира" }).id,
    l2 = s.save(a, "locations", { name: "Свободы" }).id;
  const p1 = s.save(a, "products", {
      name: "Товар А",
      category: "Уход",
      unit: "шт.",
      sku: "SKU-001",
    }).id,
    p2 = s.save(a, "products", {
      name: "Товар Б",
      category: "Здоровье",
      unit: "шт.",
    }).id;
  return {
    db,
    s,
    a,
    l1,
    l2,
    p1,
    p2,
    from: "2026-11-01",
    to: "2026-11-08",
    row: (id, point, product, date, quantity, amount, cost) => ({
      external_id: id,
      receipt_id: id,
      date,
      location_id: point,
      product_id: product,
      status: "sale",
      quantity,
      amount_kopecks: amount,
      cost_kopecks: cost,
    }),
  };
}
test("point/product drilldown exposes quantity, price and exact net sales contributions", (t) => {
  const f = fixture(t),
    { s, a, l1, l2, p1, p2, row, from, to } = f;
  s.importSales(a, {
    source: "pos",
    rows: [
      row("before-a", l1, p1, "2026-10-30", 10, 10000, 5000),
      row("now-a", l1, p1, "2026-11-04", 6, 12000, 6000),
      row("before-b", l2, p1, "2026-10-30", 8, 8000, 4000),
      row("now-b", l2, p1, "2026-11-04", 2, 1000, 800),
      row("gone", l1, p2, "2026-10-30", 3, 9000, 6000),
    ],
  });
  const r = s.salesReport(a, {
    from,
    to,
    group: "product",
    layout: "locations",
  });
  assert.equal(r.total, 3);
  const first = r.items.find((x) => x.id === p1 && x.location_id === l1);
  assert.equal(first.current.unit_price, 2000);
  assert.equal(first.quantity_change, -40);
  assert.equal(first.price_change, 100);
  assert.equal(first.sales_delta, 2000);
  assert.ok(
    Math.abs(
      first.quantity_effect + first.price_mix_effect - first.sales_delta,
    ) < 1e-9,
  );
  const gone = r.items.find((x) => x.id === p2);
  assert.equal(gone.status, "no_sales");
  assert.equal(gone.current.sales, 0);
  assert.equal(gone.sales_change, -100);
  assert.equal(gone.quantity_change, -100);
  assert.equal(gone.profit_delta, -3000);
  assert.equal(
    r.items.reduce((n, x) => n + x.current.sales, 0),
    r.totals.sales,
  );
  const category = s.salesReport(a, {
    from,
    to,
    group: "category",
    layout: "locations",
    location_id: l2,
    category: "Уход",
  });
  assert.equal(category.total, 1);
  assert.equal(category.items[0].sales_delta, -7000);
  assert.equal(category.items[0].location_name, "Свободы");
  const cross = s.salesReport(a, {
    from,
    to,
    group: "location",
    product_id: p1,
  });
  assert.equal(cross.total, 2);
  assert.equal(
    cross.items.reduce((n, x) => n + x.current.sales, 0),
    13000,
  );
});
test("receipt penetration uses all point receipts and does not add overlapping categories", (t) => {
  const { s, a, l1, p1, p2, row, from, to } = fixture(t);
  s.importSales(a, {
    source: "pos",
    rows: [
      {
        ...row("one", l1, p1, "2026-11-04", 1, 1000, 500),
        receipt_id: "shared",
      },
      {
        ...row("two", l1, p2, "2026-11-04", 1, 2000, 1000),
        receipt_id: "shared",
      },
      row("three", l1, p2, "2026-11-05", 1, 3000, 1500),
    ],
  });
  const all = s.salesReport(a, { from, to, group: "category" });
  assert.equal(all.totals.receipts, 2);
  assert.equal(
    all.items.reduce((n, x) => n + x.current.receipts, 0),
    3,
  );
  const filtered = s.salesReport(a, {
    from,
    to,
    group: "product",
    location_id: l1,
    category: "Уход",
  });
  assert.equal(filtered.items[0].penetration, 50);
  assert.equal(filtered.items[0].sales_share, (1000 / 6000) * 100);
  assert.equal(filtered.comparison_available, false);
  assert.equal(filtered.items[0].sales_delta, null);
  assert.equal(filtered.items[0].price_change, null);
});
test("refund and incomplete cost arithmetic never invent profit or add unlike units", (t) => {
  const { s, a, l1, p1, p2, row, from, to } = fixture(t);
  s.save(a, "products", {
    id: p2,
    name: "Весовой товар",
    category: "Уход",
    unit: "кг",
  });
  s.importSales(a, {
    source: "pos",
    rows: [
      {
        ...row("sold", l1, p1, "2026-11-04", 2, 10000, 6000),
        discount_kopecks: 1000,
      },
      {
        ...row("returned", l1, p1, "2026-11-05", 1, 5000, 3000),
        status: "refund",
      },
      row("weight", l1, p2, "2026-11-05", 0.5, 2000, null),
    ],
  });
  const r = s.salesReport(a, { from, to, group: "product" });
  const p = r.items.find((x) => x.id === p1);
  assert.equal(p.current.quantity, 1);
  assert.equal(p.current.sold_quantity, 2);
  assert.equal(p.current.returned_quantity, 1);
  assert.equal(p.current.unit_price, 5000);
  assert.equal(p.current.profit, 2000);
  assert.equal(p.current.cost, 3000);
  assert.equal(r.totals.quantity, null);
  assert.equal(r.totals.profit, null);
  assert.equal(r.totals.sales, 7000);
});
test("catalog searches 4000 products by name, SKU, internal ID and source code with paging", (t) => {
  const { s, a, db } = fixture(t);
  const insert = db.prepare(
    "INSERT INTO mg_products(id,company_id,name,category,unit,sku) VALUES(?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i < 4000; i++)
    insert.run(
      "bulk-" + i,
      a.company_id,
      "Номенклатура " + i,
      "Каталог",
      "шт.",
      "ART-" + i,
    );
  db.exec("COMMIT");
  db.prepare("INSERT INTO mg_catalog_ids VALUES(?,?,?,?,?)").run(
    a.company_id,
    "1С",
    "products",
    "CODE-Z999",
    "bulk-3999",
  );
  assert.equal(s.products(a, { category: "Каталог" }).total, 4000);
  assert.equal(s.products(a, { category: "Каталог" }).items.length, 50);
  assert.equal(
    s.products(a, { category: "Каталог", page: 80 }).items.length,
    50,
  );
  assert.equal(s.products(a, { q: "code-z999" }).items[0].id, "bulk-3999");
  assert.equal(
    s.products(a, { q: "номенклатура 3999" }).items[0].sku,
    "ART-3999",
  );
  assert.equal(s.products(a, { q: "bulk-3999" }).items[0].id, "bulk-3999");
  assert.equal(s.products(a, { q: "SKU-001" }).total, 1);
  const other = s.owner({
    company: "Другая",
    name: "Другой",
    email: "other@example.test",
    password: "test-password-12345",
  });
  assert.equal(
    s.products({ ...other, role: "owner", scope: [] }, { q: "CODE-Z999" })
      .total,
    0,
  );
});
test("SKU survives sparse catalog updates and external IDs are exposed without changing identity", (t) => {
  const { s, a } = fixture(t);
  const first = s.catalog(a, {
    source: "pos",
    entities: {
      products: [
        {
          external_id: "source-001",
          name: "Товар",
          category: "Категория",
          unit: "шт.",
          sku: "ART-001",
        },
      ],
    },
  }).products[0].id;
  s.catalog(a, {
    source: "pos",
    entities: {
      products: [
        {
          external_id: "source-001",
          name: "Товар новый",
          category: "Категория",
          unit: "шт.",
        },
      ],
    },
  });
  const p = s.products(a, { q: "source-001" }).items[0];
  assert.equal(p.id, first);
  assert.equal(p.sku, "ART-001");
  assert.deepEqual(p.external_ids, [
    { source: "pos", external_id: "source-001" },
  ]);
});
test("sales layouts and searches obey manager scope and never include another point", (t) => {
  const { s, a, l1, l2, p1, row, from, to } = fixture(t);
  s.importSales(a, {
    source: "pos",
    rows: [
      row("own", l1, p1, "2026-11-04", 1, 1000, 500),
      row("private", l2, p1, "2026-11-04", 1, 9000, 5000),
    ],
  });
  const manager = { ...a, role: "manager", scope: [l1] };
  const r = s.salesReport(manager, {
    from,
    to,
    group: "product",
    layout: "locations",
    q: "sku-001",
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].location_id, l1);
  assert.equal(r.totals.sales, 1000);
  assert.throws(
    () => s.salesReport(manager, { from, to, location_id: l2 }),
    (e) => e.status === 403,
  );
});
test("adding SKU to an existing database preserves products and historical operations", async (t) => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpm-sku-migration-")),
    file = path.join(dir, "management.db");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let db = openStore(file),
    s = createService(db),
    o = s.owner({
      company: "Старая база",
      name: "Владелец",
      email: "migration@example.test",
      password: "test-password-12345",
    }),
    a = { ...o, role: "owner", scope: [] };
  const p = s.save(a, "products", {
      name: "Существующий товар",
      category: "Категория",
      unit: "шт.",
    }).id,
    l = s.save(a, "locations", { name: "Точка" }).id;
  s.importSales(a, {
    source: "old",
    rows: [
      {
        external_id: "old-row",
        receipt_id: "old-check",
        date: "2026-11-01",
        location_id: l,
        product_id: p,
        status: "sale",
        quantity: 1,
        amount_kopecks: 10000,
        cost_kopecks: 5000,
      },
    ],
  });
  db.exec("ALTER TABLE mg_products DROP COLUMN sku");
  db.close();
  db = openStore(file);
  try {
    s = createService(db);
    assert.equal(s.products(a).items[0].id, p);
    assert.equal(s.products(a).items[0].sku, "");
    assert.equal(
      s.salesReport(a, {
        from: "2026-11-01",
        to: "2026-11-01",
        group: "product",
      }).totals.sales,
      10000,
    );
  } finally {
    db.close();
  }
});
