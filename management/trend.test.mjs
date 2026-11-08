import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "./core.mjs";
import { buildTrend } from "./trend.mjs";
const row = (date, id, amount, cost = 0, location = "one") => ({
  sold_on: date,
  source: "pos",
  location_id: location,
  receipt_id: id,
  status: "sale",
  quantity: 1,
  amount,
  cost,
  discount: 0,
  unit: "шт.",
});
test("daily graph covers selected dates, keeps zero days and distinguishes unknown costs", () => {
  const trend = buildTrend(
    [row("2026-11-01", "1", 10000, 6000), row("2026-11-03", "2", 5000, null)],
    { from: "2026-11-01", to: "2026-11-04", asOf: "2026-11-03", aggregate },
  );
  assert.equal(trend.granularity, "day");
  assert.equal(trend.points.length, 4);
  assert.deepEqual(
    trend.points.map((p) => p.sales),
    [10000, 0, 5000, null],
  );
  assert.equal(trend.points[0].profit, 4000);
  assert.equal(trend.points[1].operations, 0);
  assert.equal(trend.points[1].average, null);
  assert.equal(trend.points[2].profit, null);
  assert.equal(trend.points[3].future, true);
});
test("week buckets recompute weighted averages and unique receipt identity", () => {
  const rows = [
    row("2026-10-01", "1", 10000),
    row("2026-10-02", "2", 1000),
    row("2026-10-02", "3", 1000),
    row("2026-10-02", "4", 1000),
  ];
  const t = buildTrend(rows, {
    from: "2026-10-01",
    to: "2026-11-29",
    aggregate,
  });
  assert.equal(t.granularity, "week");
  assert.equal(t.points[0].sales, 13000);
  assert.equal(t.points[0].receipts, 4);
  assert.equal(t.points[0].average, 3250);
  assert.equal(t.points.at(-1).to, "2026-11-29");
});
test("long ranges use clipped calendar months and preserve total sales and profit", () => {
  const rows = [
    row("2026-01-20", "same", 10000, 5000),
    row("2026-02-20", "same", 20000, 12000),
    row("2026-08-03", "same", 30000, 10000),
  ];
  const t = buildTrend(rows, {
    from: "2026-01-15",
    to: "2026-08-10",
    aggregate,
  });
  assert.equal(t.granularity, "month");
  assert.equal(t.points[0].from, "2026-01-15");
  assert.equal(t.points[0].to, "2026-01-31");
  assert.equal(t.points.at(-1).to, "2026-08-10");
  assert.equal(
    t.points.reduce((n, p) => n + p.sales, 0),
    aggregate(rows).sales,
  );
  assert.equal(
    t.points.reduce((n, p) => n + p.profit, 0),
    aggregate(rows).profit,
  );
});
test("refund-only days can be negative without inventing average checks", () => {
  const rows = [
    { ...row("2026-11-02", "refund", 10000, 6000), status: "refund" },
  ];
  const t = buildTrend(rows, {
    from: "2026-11-01",
    to: "2026-11-03",
    aggregate,
  });
  assert.equal(t.points[1].sales, -10000);
  assert.equal(t.points[1].profit, -4000);
  assert.equal(t.points[1].receipts, 0);
  assert.equal(t.points[1].average, null);
});
