import { createHash } from "node:crypto";
const money = (n) =>
  n === null
    ? "нет данных"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
        n / 100,
      ) + " ₽";
// Explicit allowlist: no customer contacts, names, external IDs, notes or consent records.
export function insightFacts(snapshot) {
  return {
    totals: snapshot.totals,
    comparison: snapshot.comparison,
    plans: snapshot.plans.map((p) => ({
      metric: p.metric,
      target: p.target,
      target_to_date: p.target_to_date,
      actual: p.actual,
      deviation: p.deviation,
      status: p.status,
    })),
    locations: snapshot.by_location.map((r, i) => ({
      point: i + 1,
      sales: r.sales,
      receipts: r.receipts,
      profit: r.profit,
      margin: r.margin,
    })),
  };
}
export function rulesInsights(snapshot) {
  const t = snapshot.totals,
    bad = snapshot.plans.filter((p) => p.status === "attention");
  return {
    mode: "rules",
    summary: `Продажи за период: ${money(t.sales)}. ${bad.length ? "Планов с отклонением: " + bad.length + "." : "Отклонений от заданных планов нет."}`,
    attention: [
      ...bad
        .slice(0, 3)
        .map(
          (p) =>
            `${snapshot.metrics[p.metric].label}: факт ${p.actual === null ? "не рассчитан" : snapshot.metrics[p.metric].unit === "money" ? money(p.actual) : p.actual.toFixed(2)}, цель к дате ${snapshot.metrics[p.metric].unit === "money" ? money(p.target_to_date) : p.target_to_date.toFixed(2)}.`,
        ),
      ...(!t.cost_complete
        ? ["Валовая прибыль не рассчитана: не у всех строк есть себестоимость."]
        : []),
    ],
    actions: bad.length
      ? [
          "Откройте продажи по точкам и категориям: определите, где сосредоточено отклонение.",
          "Проверьте полноту загрузки и изменения количества чеков и состава покупок.",
        ]
      : ["Сопоставьте результат с целями по валовой прибыли и возвратам."],
  };
}
export function createInsights({
  key = process.env.BPM_OPENAI_API_KEY,
  model = process.env.BPM_AI_MODEL || "gpt-6-luna",
  fetcher = fetch,
} = {}) {
  const cache = new Map();
  return async (snapshot, context = "") => {
    const facts = insightFacts(snapshot),
      hash = createHash("sha256")
        .update(context + JSON.stringify(facts))
        .digest("hex");
    const old = cache.get(hash);
    if (old && old.until > Date.now()) return old.result;
    let result = rulesInsights(snapshot);
    if (key) {
      try {
        const r = await fetcher("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content:
                  "Ты аналитик Бизнес Пульса. Пиши по-русски, кратко. Анализируй только переданные факты. Денежные суммы в копейках. Не выдумывай причины, данные, причинную эффективность рекламы или расчёты. Различай отклонение от плана и сравнение с прошлым периодом. Предлагай проверки как гипотезы. Ответ — JSON: summary (до 400 символов), attention (до 3 коротких строк), actions (до 3 коротких строк). Не обещай гарантированный результат.",
              },
              { role: "user", content: JSON.stringify(facts) },
            ],
            response_format: { type: "json_object" },
          }),
        });
        if (!r.ok) throw Error("Provider failure");
        const data = await r.json(),
          parsed = JSON.parse(data.choices?.[0]?.message?.content || "");
        if (
          typeof parsed.summary !== "string" ||
          parsed.summary.length > 1200 ||
          !Array.isArray(parsed.attention) ||
          !Array.isArray(parsed.actions) ||
          [...parsed.attention, ...parsed.actions].some(
            (x) => typeof x !== "string" || x.length > 800,
          )
        )
          throw Error("Invalid response");
        result = {
          mode: "ai",
          summary: parsed.summary,
          attention: parsed.attention.slice(0, 3),
          actions: parsed.actions.slice(0, 3),
        };
      } catch {
        result = { ...result, provider_unavailable: true };
      }
    }
    if (cache.size > 200) cache.clear();
    cache.set(hash, { until: Date.now() + 10 * 60000, result });
    return result;
  };
}
