// All amounts are integer kopecks. Ratios and symmetric factor contributions may be fractional.
export function buildSalesReport(
  current,
  previous,
  {
    aggregate,
    group = "category",
    layout = "summary",
    page = 1,
    pageSize = 50,
    query = "",
    sort = "sales",
    baselineCurrent = current,
    baselinePrevious = previous,
  } = {},
) {
  const key =
    group === "product"
      ? "product_id"
      : group === "location"
        ? "location_id"
        : "category";
  const label =
    group === "product"
      ? "product_name"
      : group === "location"
        ? "location_name"
        : "category";
  const perLocation = layout === "locations" && group !== "location";
  const comparisonAvailable =
    baselineCurrent.length > 0 && baselinePrevious.length > 0;
  const base = aggregate(baselineCurrent),
    priorBase = aggregate(baselinePrevious);
  const buckets = new Map();
  for (const [period, rows] of [
    ["current", current],
    ["previous", previous],
  ])
    for (const row of rows) {
      const id = JSON.stringify([
        perLocation ? row.location_id : null,
        row[key],
      ]);
      if (!buckets.has(id))
        buckets.set(id, {
          key: id,
          id: row[key],
          name: row[label],
          location_id:
            perLocation || group === "location" ? row.location_id : null,
          location_name:
            perLocation || group === "location" ? row.location_name : null,
          category:
            group === "product"
              ? row.category
              : group === "category"
                ? row.category
                : null,
          sku: group === "product" ? row.sku || "" : "",
          codes: group === "product" ? row.product_codes || [] : [],
          unit: row.unit,
          current: [],
          previous: [],
        });
      buckets.get(id)[period].push(row);
    }
  const delta = (a, b) => (a === null || b === null ? null : a - b);
  const percent = (a, b) =>
    a === null || b === null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
  function facts(rows, unit) {
    return rows.length
      ? aggregate(rows)
      : {
          ...aggregate([]),
          quantity: 0,
          sold_quantity: 0,
          returned_quantity: 0,
          unit,
          cost: 0,
          profit: 0,
          cost_complete: true,
        };
  }
  const all = [...buckets.values()].map((b) => {
    const now = facts(b.current, b.unit),
      was = facts(b.previous, b.unit),
      unitMatches = now.unit === was.unit;
    const out = {
      key: b.key,
      id: b.id,
      name: b.name,
      location_id: b.location_id,
      location_name: b.location_name,
      category: b.category,
      sku: b.sku,
      external_ids: b.codes,
      current: now,
      previous: was,
      comparison_available: comparisonAvailable,
      sales_delta: comparisonAvailable ? now.sales - was.sales : null,
      sales_change: comparisonAvailable ? percent(now.sales, was.sales) : null,
      quantity_delta:
        comparisonAvailable && unitMatches
          ? delta(now.quantity, was.quantity)
          : null,
      quantity_change:
        comparisonAvailable && unitMatches
          ? percent(now.quantity, was.quantity)
          : null,
      profit_delta: comparisonAvailable ? delta(now.profit, was.profit) : null,
      profit_change: comparisonAvailable
        ? percent(now.profit, was.profit)
        : null,
      price_change:
        comparisonAvailable && unitMatches
          ? percent(now.unit_price, was.unit_price)
          : null,
      receipts_delta: comparisonAvailable ? now.receipts - was.receipts : null,
      sales_share: base.sales > 0 ? (now.sales / base.sales) * 100 : null,
      penetration:
        base.receipts > 0 ? (now.receipts / base.receipts) * 100 : null,
      previous_penetration:
        priorBase.receipts > 0
          ? (was.receipts / priorBase.receipts) * 100
          : null,
      status: !comparisonAvailable
        ? "unknown"
        : b.previous.length === 0 && b.current.length
          ? "new"
          : b.current.length === 0 && b.previous.length
            ? "no_sales"
            : now.sales < was.sales
              ? "decline"
              : now.sales > was.sales
                ? "growth"
                : "stable",
      quantity_effect: null,
      price_mix_effect: null,
    };
    // Exact decomposition of net sales; at category level the price term also includes mix.
    if (
      comparisonAvailable &&
      unitMatches &&
      now.quantity > 0 &&
      was.quantity > 0
    ) {
      const p0 = was.sales / was.quantity,
        p1 = now.sales / now.quantity;
      out.quantity_effect = ((now.quantity - was.quantity) * (p0 + p1)) / 2;
      out.price_mix_effect = ((p1 - p0) * (was.quantity + now.quantity)) / 2;
    }
    return out;
  });
  const term = query.trim().toLocaleLowerCase("ru");
  const selected = all.filter(
    (r) =>
      !term ||
      [
        r.name,
        r.id,
        r.sku,
        r.category,
        r.location_name,
        ...r.external_ids.map((x) => x.external_id),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("ru")
        .includes(term),
  );
  const sorters = {
    sales: (a, b) => b.current.sales - a.current.sales,
    sales_delta: (a, b) =>
      (a.sales_delta ?? Infinity) - (b.sales_delta ?? Infinity),
    profit_delta: (a, b) =>
      (a.profit_delta ?? Infinity) - (b.profit_delta ?? Infinity),
    quantity_delta: (a, b) =>
      (a.quantity_delta ?? Infinity) - (b.quantity_delta ?? Infinity),
    name: (a, b) => a.name.localeCompare(b.name, "ru"),
  };
  selected.sort(sorters[sort] || sorters.sales);
  const size = Math.max(1, Math.min(100, Math.floor(Number(pageSize)) || 50)),
    pages = Math.max(1, Math.ceil(selected.length / size)),
    selectedPage = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1));
  const declines = selected
    .filter((r) => r.sales_delta !== null && r.sales_delta < 0)
    .sort((a, b) => a.sales_delta - b.sales_delta)
    .slice(0, 5);
  return {
    group,
    layout: perLocation ? "locations" : "summary",
    items: selected.slice((selectedPage - 1) * size, selectedPage * size),
    total: selected.length,
    page: selectedPage,
    page_size: size,
    pages,
    totals: aggregate(current),
    previous: aggregate(previous),
    comparison_available: comparisonAvailable,
    declines,
    coverage: {
      current_days: new Set(baselineCurrent.map((r) => r.sold_on)).size,
      previous_days: new Set(baselinePrevious.map((r) => r.sold_on)).size,
    },
    baseline: { sales: base.sales, receipts: base.receipts },
    notes: {
      unit_price:
        "Цена после скидок до возвратов: продажи / проданные единицы.",
      penetration:
        "Доля чеков точки или доступной сети, в которых встречается объект. Доли товаров и категорий не суммируются.",
      comparison:
        "Предыдущий равный по длительности период. Отсутствие операций в выгрузке не доказывает отсутствие продаж или товара на остатках.",
    },
  };
}
