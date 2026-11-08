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
