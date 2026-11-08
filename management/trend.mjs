// Reaggregate raw operations per bucket: averages and margins must never be summed.
export function buildTrend(rows, { from, to, aggregate, asOf = to } = {}) {
  const length = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const granularity = length <= 45 ? "day" : length <= 180 ? "week" : "month";
  const shift = (d, n) =>
    new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const buckets = [];
  for (let date = from; date <= to;) {
    const last =
      granularity === "day"
        ? date
        : granularity === "week"
          ? shift(date, 6)
          : new Date(
              Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
            )
              .toISOString()
              .slice(0, 10);
    const end = last < to ? last : to;
    buckets.push({ from: date, to: end, rows: [] });
    date = shift(end, 1);
  }
  let index = 0;
  for (const row of [...rows].sort((a, b) =>
    a.sold_on.localeCompare(b.sold_on),
  )) {
    if (row.sold_on < from || row.sold_on > to) continue;
    while (index < buckets.length - 1 && row.sold_on > buckets[index].to)
      index++;
    buckets[index].rows.push(row);
  }
  return {
    granularity,
    from,
    to,
    points: buckets.map((b) => {
      const facts = aggregate(b.rows),
        future = b.from > asOf;
      return {
        ...facts,
        id: b.from,
        name: b.from,
        from: b.from,
        to: b.to,
        operations: b.rows.length,
        future,
        sales: future ? null : facts.sales,
        receipts: future ? null : facts.receipts,
        profit: future ? null : b.rows.length ? facts.profit : 0,
      };
    }),
  };
}
