import { openStore, createService, today } from "./core.mjs";
export function demoWorkspace() {
  const db = openStore(),
    service = createService(db);
  const a = {
    ...service.owner({
      company: "Сеть «Орион» · пример",
      name: "Демонстрация",
      email: "demo@example.test",
      password: "not-a-real-demo-login-" + Math.random(),
    }),
    role: "owner",
    scope: [],
    name: "Демонстрация",
    company_name: "Сеть «Орион» · пример",
  };
  const north = service.save(a, "locations", { name: "Центральная" }).id,
    south = service.save(a, "locations", { name: "Заречная" }).id;
  const anna = service.save(a, "employees", {
      name: "Анна",
      location_ids: [north],
    }).id,
    ivan = service.save(a, "employees", {
      name: "Иван",
      location_ids: [south],
    }).id;
  const products = [
    ["Шампунь", "Уход", 49000, 28000],
    ["Крем для рук", "Уход", 32000, 15000],
    ["Витамины", "Здоровье", 87000, 53000],
  ].map(([name, category, price, cost]) => ({
    id: service.save(a, "products", { name, category, unit: "шт." }).id,
    price,
    cost,
  }));
  const end = today(),
    start = end.slice(0, 7) + "-01";
  const campaign = service.save(a, "campaigns", {
    name: "Неделя ухода",
    kind: "promotion",
    channel: "ВКонтакте",
    start_on: start,
    end_on: end,
    budget: 250000,
    spend: 180000,
    goal: "Увеличить продажи категории «Уход»",
    location_ids: [],
    product_ids: products.slice(0, 2).map((p) => p.id),
    promo_code: "CARE",
  }).id;
  const customer = service.save(a, "customers", {
    name: "Пример клиента",
    phone: "",
    email: "",
    tags: ["Постоянный"],
    loyalty: { program: "Клуб", level: "Серебро", balance: 350, as_of: end },
    external_ids: { demo: "client-1" },
    consents: [],
  }).id;
  const rows = [];
  for (let d = 1; d <= Number(end.slice(8)); d++) {
    for (let l = 0; l < 2; l++)
      for (let n = 0; n < 9; n++) {
        const p = products[(d + n) % 3],
          q = 1 + (n % 3),
          promo = n % 3 === 0 && (d + n) % 3 < 2;
        rows.push({
          external_id: `${d}-${l}-${n}`,
          receipt_id: `${d}-${l}-${Math.floor(n / 2)}`,
          date: start.slice(0, 8) + String(d).padStart(2, "0"),
          location_id: l ? south : north,
          employee_id: l ? ivan : anna,
          product_id: p.id,
          customer_id: n % 2 ? customer : null,
          campaign_id: promo ? campaign : null,
          status: "sale",
          quantity: q,
          amount_kopecks: p.price * q - (promo ? 2000 : 0),
          cost_kopecks: p.cost * q,
          discount_kopecks: promo ? 2000 : 0,
        });
      }
  }
  service.importSales(a, { source: "demo", rows });
  const monthEnd = new Date(
    Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
  service.plan(a, {
    metric: "sales",
    target: 45000000,
    start_on: start,
    end_on: monthEnd,
  });
  service.plan(a, {
    metric: "sales",
    target: 30000000,
    start_on: start,
    end_on: monthEnd,
    location_id: south,
  });
  service.plan(a, {
    metric: "margin",
    target: 40,
    start_on: start,
    end_on: monthEnd,
  });
  return { db, service, actor: a, start, end };
}

// Read-only illustration built in an independent in-memory SQLite database.
// Only configuration is copied. Real sales, contacts and balances are never copied.
export function configuredDemo(source, range = {}) {
  const end = range.to && range.to < today() ? range.to : today();
  const shift = (d, n) =>
    new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const start =
    range.from && range.from > shift(end, -89) ? range.from : shift(end, -29);
  if (start > end)
    throw Object.assign(
      Error("Для демо выберите прошедшие или текущие даты."),
      { status: 400 },
    );
  const span = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  const db = openStore(),
    service = createService(db),
    companyName = source.actor.company_name + " · демо";
  const a = {
    ...service.owner({
      company: companyName,
      name: "Демонстрация",
      email: "configured-demo@example.test",
      password: "demo-only-" + Math.random() + Math.random(),
    }),
    role: "owner",
    scope: [],
    name: "Демонстрация",
    company_name: companyName,
  };
  try {
    const locs = source.locations.slice(0, 12),
      prods = source.products.slice(0, 40),
      allowed = new Set(locs.map((l) => l.id));
    if (!locs.length || !prods.length) {
      db.close();
      return demoWorkspace();
    }
    for (const l of locs)
      db.prepare("INSERT INTO mg_locations VALUES(?,?,?)").run(
        l.id,
        a.company_id,
        l.name,
      );
    for (const p of prods)
      db.prepare("INSERT INTO mg_products VALUES(?,?,?,?,?)").run(
        p.id,
        a.company_id,
        p.name,
        p.category,
        p.unit,
      );
    const staff = source.employees
      .slice(0, 120)
      .map((e, i) => ({
        ...e,
        location_ids: e.location_ids.filter((id) => allowed.has(id)),
      }));
    for (const [i, e] of staff.entries()) {
      if (!e.location_ids.length) e.location_ids = [locs[i % locs.length].id];
      db.prepare("INSERT INTO mg_employees VALUES(?,?,?,?)").run(
        e.id,
        a.company_id,
        e.name,
        JSON.stringify(e.location_ids),
      );
    }
    const plans = source.plans.filter(
      (p) =>
        (!p.location_id || allowed.has(p.location_id)) &&
        (!p.product_id || prods.some((x) => x.id === p.product_id)) &&
        (!p.employee_id || staff.some((e) => e.id === p.employee_id)),
    );
    for (const p of plans)
      service.plan(a, {
        metric: p.metric,
        target: p.target,
        start_on: p.start_on,
        end_on: p.end_on,
        location_id: p.location_id,
        employee_id: p.employee_id,
        category: p.category,
        product_id: p.product_id,
      });
    const customers = Array.from(
      { length: 12 },
      (_, i) =>
        service.save(a, "customers", {
          name: "Демо-клиент " + String(i + 1).padStart(2, "0"),
          tags: [i % 2 ? "Повторный" : "Новый"],
          loyalty: {
            program: "Демонстрационный клуб",
            level: i % 3 ? "Базовый" : "Серебро",
            balance: 100 + i * 45,
            as_of: end,
          },
        }).id,
    );
    const campaign = service.save(a, "campaigns", {
      name: "Пример акции",
      kind: "promotion",
      channel: "Демонстрация",
      start_on: start,
      end_on: end,
      budget: 200000,
      spend: 120000,
      goal: "Увеличить повторные покупки",
      location_ids: [],
      product_ids: [],
    }).id;
    const historicalStart = shift(start, -span),
      rows = [];
    for (
      let date = historicalStart, index = 0;
      date <= end;
      date = shift(date, 1), index++
    ) {
      for (const [li, l] of locs.entries()) {
        const applicable = plans.filter(
          (p) =>
            p.metric === "sales" &&
            !p.category &&
            !p.product_id &&
            !p.employee_id &&
            p.start_on <= date &&
            p.end_on >= date,
        );
        const target =
          applicable.find((p) => p.location_id === l.id) ||
          applicable.find((p) => !p.location_id);
        const daily = target
          ? target.target /
            (Math.round(
              (Date.parse(target.end_on) - Date.parse(target.start_on)) /
                86400000,
            ) +
              1) /
            (target.location_id ? 1 : locs.length)
          : 2500000;
        const tickets = 5 + ((index + li) % 5),
          pointStaff = staff.filter((e) => e.location_ids.includes(l.id));
        const trend = 0.8 + (index % 7) * 0.045 + (index >= span ? 0.08 : 0),
          performance = 0.8 + (li % 4) * 0.12;
        for (let n = 0; n < tickets; n++) {
          const lines = 1 + (n % 3);
          for (let line = 0; line < lines; line++) {
            const p = prods[(index + n + line + li) % prods.length],
              quantity = 1 + ((n + line) % 3);
            const amount = Math.max(
              100,
              Math.round((daily * trend * performance) / tickets / lines),
            );
            rows.push({
              external_id: `${date}-${li}-${n}-${line}`,
              receipt_id: `${date}-${li}-${n}`,
              date,
              location_id: l.id,
              employee_id: pointStaff.length
                ? pointStaff[n % pointStaff.length].id
                : null,
              product_id: p.id,
              customer_id: customers[(n + index + li) % customers.length],
              campaign_id: date >= start && n % 3 === 0 ? campaign : null,
              status: "sale",
              quantity,
              amount_kopecks: amount,
              cost_kopecks: Math.round(amount * (0.58 + (n % 3) * 0.05)),
              discount_kopecks: n % 3 === 0 ? Math.round(amount * 0.05) : 0,
            });
          }
        }
      }
    }
    for (let i = 0; i < rows.length; i += 5000)
      service.importSales(a, {
        source: "synthetic-demo",
        rows: rows.slice(i, i + 5000),
      });
    if (!plans.length)
      service.plan(a, {
        metric: "sales",
        target: 2500000 * locs.length * span,
        start_on: start,
        end_on: end,
      });
    return { db, service, actor: a, start, end, configured: true };
  } catch (e) {
    db.close();
    throw e;
  }
}
