import { readFile, fields, tableToSales } from "./import.js";
const baseURL = new URL("./", import.meta.url);
const publicBase = baseURL.href.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const roleNames = {
  owner: "Владелец",
  director: "Директор",
  deputy: "Заместитель директора",
  manager: "Руководитель точки",
  employee: "Сотрудник",
  marketing: "Маркетинг",
};
const titles = {
  overview: ["Обзор бизнеса", "Результаты, планы и отклонения на одном экране"],
  plans: ["Планы и KPI", "Цели компании, точек, сотрудников и товаров"],
  sales: ["Продажи и ассортимент", "От общей картины — до конкретного товара"],
  team: ["Точки и команда", "Структура компании и результаты сотрудников"],
  clients: ["Клиенты", "Контакты, покупки и данные программ лояльности"],
  marketing: ["Маркетинг", "Кампании, акции и связанные продажи"],
  data: ["Данные и интеграции", "Источники, загрузки и доступ по API"],
};
const icons = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  plans: "M4 20V10m8 10V4m8 16v-7",
  sales: "M3 17l6-6 4 3 8-10 M15 4h6v6",
  team: "M3 21V7l9-4 9 4v14 M8 21v-6h8v6 M8 9h1m6 0h1",
  clients:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M18 8a3 3 0 0 1 0 6 M22 21v-2a4 4 0 0 0-3-4",
  marketing: "M3 10v5h5l11 5V5L8 10H3 M7 15l2 6",
  data: "M4 6h16v14H4z M8 3v6m8-6v6 M8 13h8m-8 3h5",
};
let state = null,
  tab = "overview",
  demo = false,
  salesGroup = "by_category",
  editing = null,
  inviteToken = null,
  pendingFile = null;
const money = (n) =>
  n === null || n === undefined
    ? "—"
    : new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: "RUB",
        maximumFractionDigits: 0,
      }).format(n / 100);
const num = (n) =>
  n === null || n === undefined
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
const format = (n, metric) =>
  state?.metrics[metric]?.unit === "money"
    ? money(n)
    : num(n) +
      (state?.metrics[metric]?.unit === "percent" && n !== null ? "%" : "");
const date = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
    new Date(),
  );
$("from").value = date().slice(0, 7) + "-01";
$("to").value = date();
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 5000);
}
async function api(route, data) {
  const r = await fetch(new URL(route.replace(/^\/+/, ""), baseURL), {
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await r.json();
  if (!r.ok) throw Error(body.error || "Не удалось выполнить запрос.");
  return body;
}
const query = () =>
  new URLSearchParams({
    from: $("from").value,
    to: $("to").value,
    ...($("location").value ? { location_id: $("location").value } : {}),
  });
async function load() {
  document.body.classList.add("loading");
  try {
    state = await api((demo ? "/api/demo" : "/api/workspace") + "?" + query());
    $("welcome").hidden = true;
    $("workspace").hidden = false;
    const selected = $("location").value;
    $("location").innerHTML =
      '<option value="">Все доступные точки</option>' +
      state.locations
        .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`)
        .join("");
    $("location").value = selected;
    $("company").textContent = state.actor.company_name;
    $("identity").textContent =
      state.actor.name + " · " + roleNames[state.actor.role];
    $("mode").textContent = demo
      ? "Демонстрационные данные"
      : "Рабочая компания";
    render();
  } finally {
    document.body.classList.remove("loading");
  }
}
function allowed(t) {
  return (
    t !== "clients" ||
    (state.permissions.clients &&
      state.actor.scope.length === 0 &&
      state.actor.role !== "manager")
  );
}
function render() {
  if (!allowed(tab)) tab = "overview";
  $("nav").innerHTML = Object.keys(titles)
    .filter(allowed)
    .map(
      (t) =>
        `<button class="${tab === t ? "active" : ""}" data-tab="${t}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[t]}"/></svg>${titles[t][0]}</button>`,
    )
    .join("");
  $("title").textContent = titles[tab][0];
  $("subtitle").textContent = titles[tab][1];
  $("content").innerHTML =
    (demo
      ? '<div class="notice">Это пример с вымышленными данными. Создание и изменение объектов доступны после входа в свою компанию.</div>'
      : "") + views[tab]();
}
function action(label, kind, permission, id = "") {
  return state.permissions[permission]
    ? `<button class="${id ? "secondary" : "primary"}" data-action="${kind}" data-id="${esc(id)}" ${demo ? "disabled" : ""}>${esc(label)}</button>`
    : "";
}
const panel = (heading, description, body, button = "") =>
  `<section class="panel"><div class="section-head"><div><h2>${heading}</h2>${description ? `<p>${description}</p>` : ""}</div>${button}</div>${body}</section>`;
const empty = (title, description) =>
  `<div class="empty"><h3>${title}</h3><p>${description}</p></div>`;
function table(headers, rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("")}</tbody></table></div>`
    : empty(
        "Пока нет данных",
        "Добавьте объекты и загрузите продажи в разделе «Данные и интеграции».",
      );
}
const locName = (id) =>
  state.locations.find((x) => x.id === id)?.name || "Компания";
const empName = (id) => state.employees.find((x) => x.id === id)?.name || "";
const planName = (p) =>
  [
    locName(p.location_id),
    empName(p.employee_id),
    p.category,
    state.products.find((x) => x.id === p.product_id)?.name,
  ]
    .filter(Boolean)
    .join(" · ");
const status = (p) =>
  p.status === "good"
    ? "По плану"
    : p.status === "attention"
      ? "Отклонение"
      : p.status === "pending"
        ? "Ещё не начат"
        : "Нет данных";
function planRows(plans) {
  return plans.length
    ? plans
        .map(
          (p) =>
            `<div class="plan-row"><div class="row-between"><div><h3>${esc(state.metrics[p.metric].label)}</h3><div class="small">${esc(planName(p))}</div></div><span class="pill ${p.status}">${status(p)}</span></div><div class="row-between"><strong>${format(p.actual, p.metric)}</strong><span class="small">План к дате: ${format(p.target_to_date, p.metric)}</span></div>${p.completion === null ? "" : `<progress max="100" value="${Math.max(0, Math.min(100, p.completion))}" aria-label="Выполнение плана"></progress>`}<div class="small">План на период: ${format(p.target, p.metric)} · ${esc(p.start_on)} — ${esc(p.end_on)}</div>${p.forecast === null ? "" : `<div class="small">При текущем темпе: ${format(p.forecast, p.metric)} за весь период</div>`}${action("Изменить", "plan", "plans", p.id)}</div>`,
        )
        .join("")
    : empty(
        "Цели ещё не заданы",
        "Добавьте план, чтобы отслеживать выполнение и отклонения.",
      );
}
function cards() {
  const t = state.totals;
  return `<div class="cards">${[
    ["Продажи", money(t.sales), "За выбранный период", "hero"],
    ["Чеки", num(t.receipts), "Уникальные покупки", ""],
    ["Средний чек", money(t.average), "С учётом возвратов", ""],
    [
      "Валовая прибыль",
      money(t.profit),
      t.cost_complete
        ? "После себестоимости"
        : "Нужна себестоимость всех строк",
      "",
    ],
  ]
    .map(
      ([label, value, caption, cl]) =>
        `<article class="card ${cl}"><div class="label">${label}</div><div class="value">${value}</div><div class="small">${caption}</div></article>`,
    )
    .join("")}</div>`;
}
function chart() {
  const rs = state.trend;
  if (!rs.length)
    return empty(
      "Продажи появятся здесь",
      "Подключите источник или загрузите данные.",
    );
  const vals = rs.map((r) => r.sales),
    min = Math.min(0, ...vals),
    max = Math.max(1, ...vals),
    points = vals
      .map(
        (v, i) =>
          `${20 + (i * 660) / Math.max(1, vals.length - 1)},${150 - ((v - min) / (max - min)) * 125}`,
      )
      .join(" ");
  return `<svg class="chart" role="img" aria-label="Динамика продаж по дням" viewBox="0 0 700 170" preserveAspectRatio="none"><path d="M20 150H680" stroke="#e7e9f1"/><polyline points="${points}" fill="none" stroke="#7368e4" stroke-width="3" vector-effect="non-scaling-stroke"/></svg><div class="chart-caption"><span>${esc(rs[0].name)}</span><span>${esc(rs.at(-1).name)}</span></div>`;
}
const groupTable = (rows) =>
  table(
    ["Объект", "Продажи", "Чеки", "Средний чек", "Валовая прибыль", "Маржа"],
    rows.map((r) => [
      esc(r.name),
      money(r.sales),
      num(r.receipts),
      money(r.average),
      money(r.profit),
      r.margin === null ? "—" : num(r.margin) + "%",
    ]),
  );
const views = {
  overview() {
    const bad = state.plans
      .filter((p) => p.status === "attention")
      .sort(
        (a, b) =>
          Math.abs(b.deviation / (b.target_to_date || 1)) -
          Math.abs(a.deviation / (a.target_to_date || 1)),
      )
      .slice(0, 3);
    return (
      cards() +
      `<div class="grid-two">${panel("Динамика продаж", "С учётом возвратов", chart())}${panel("Требует внимания", "Отклонения от плана к выбранной дате", bad.length ? bad.map((p) => `<div class="attention-item"><h3>${esc(state.metrics[p.metric].label)} · ${esc(planName(p))}</h3><p>Факт ${format(p.actual, p.metric)}. Отклонение ${format(p.deviation, p.metric)}.</p><button class="inline-link" data-tab="plans">Открыть планы →</button></div>`).join("") : empty(state.plans.length ? "Нет отклонений от заданных целей" : "Добавьте планы", "Система сравнивает результат с планом на прошедшую часть периода."))}</div>` +
      panel(
        "Выполнение планов",
        "Планы оцениваются за собственный период, по выбранную дату включительно",
        planRows(state.plans.slice(0, 4)),
        action("Добавить план", "plan", "plans"),
      ) +
      panel(
        "Разбор результатов",
        "Короткий анализ выбранного периода и точки",
        `<div id="insights-output"><p class="small">Факты, отклонения и приоритетные проверки. При настроенном ИИ — интерпретация агрегатов без контактов клиентов.</p></div><button class="secondary" data-insights ${demo ? "disabled" : ""}>Получить разбор</button>`,
      ) +
      panel(
        "Результаты точек",
        "Сравнение в выбранном периоде",
        groupTable(state.by_location),
      )
    );
  },
  plans() {
    return (
      `<div class="notice">План продаж, количества и прибыли распределяется равномерно по дням. Для среднего чека, маржи и доли возвратов сравниваем фактический уровень с заданной целью. Прогноз — продолжение текущего темпа.</div>` +
      panel(
        "Планы компании",
        "Факт считается от начала каждого плана до выбранной даты. Изменения сохраняются с историей версий.",
        planRows(state.plans),
        action("Добавить план", "plan", "plans"),
      )
    );
  },
  sales() {
    return (
      cards() +
      factorPanel() +
      panel(
        "Продажи в деталях",
        "Чеки внутри категорий и товаров могут пересекаться: итоги числа чеков не суммируются.",
        `<div class="metric-tabs">${[
          ["by_category", "Категории"],
          ["by_product", "Товары"],
          ["by_location", "Точки"],
        ]
          .map(
            ([v, l]) =>
              `<button data-group="${v}" class="${salesGroup === v ? "active" : ""}">${l}</button>`,
          )
          .join("")}</div>` +
          groupTable(state[salesGroup]) +
          `<div class="small">Проданные единицы: ${num(state.totals.quantity)} ${esc(state.totals.unit || "")} · Единиц на чек: ${num(state.totals.basket)} · Возвраты: ${money(state.totals.refunds)} · Скидки: ${money(state.totals.discount)}</div>`,
        action("Добавить товар", "product", "structure"),
      ) +
      panel(
        "Справочник товаров",
        "ID используются для загрузки по API",
        table(
          ["Товар / ID", "Категория", "Единица"],
          state.products.map((p) => [
            `${esc(p.name)}<span class="id">${esc(p.id)}</span>`,
            esc(p.category),
            esc(p.unit),
          ]),
        ),
      )
    );
  },
  team() {
    return (
      panel(
        "Точки",
        "Одна компания — несколько подразделений",
        table(
          ["Название / ID", "Продажи", "Сотрудники"],
          state.locations.map((l) => [
            `${esc(l.name)}<span class="id">${esc(l.id)}</span>`,
            money(state.by_location.find((r) => r.id === l.id)?.sales || 0),
            esc(
              state.employees
                .filter((e) => e.location_ids.includes(l.id))
                .map((e) => e.name)
                .join(", "),
            ),
          ]),
        ),
        action("Добавить точку", "location", "structure"),
      ) +
      panel(
        "Сотрудники",
        "Сотрудник может работать в нескольких точках",
        table(
          ["Имя / ID", "Точки", "Продажи", "Чеки", ""],
          state.employees.map((e) => [
            `${esc(e.name)}<span class="id">${esc(e.id)}</span>`,
            esc(e.location_ids.map(locName).join(", ") || "Не назначены"),
            money(state.by_employee.find((r) => r.id === e.id)?.sales || 0),
            num(state.by_employee.find((r) => r.id === e.id)?.receipts || 0),
            action("Редактировать", "employee", "structure", e.id),
          ]),
        ),
        action("Добавить сотрудника", "employee", "structure"),
      ) +
      (state.permissions.members
        ? panel(
            "Доступ в компанию",
            "Приглашение действует 7 дней. Ссылка выдаёт только выбранную роль и точки.",
            table(
              ["Имя", "Email", "Роль", "Доступ", ""],
              state.members.map((m) => [
                esc(m.name),
                esc(m.email),
                esc(roleNames[m.role]),
                esc(
                  JSON.parse(m.scope_json).map(locName).join(", ") ||
                    "Вся компания",
                ),
                m.role === "owner" || m.user_id === state.actor.user_id
                  ? ""
                  : action("Изменить", "member", "members", m.user_id),
              ]),
            ),
            action("Пригласить", "invite", "members"),
          )
        : "")
    );
  },
  clients() {
    return panel(
      "Клиенты и лояльность",
      "Покупки и показатели — за выбранный период. Баланс бонусов — данные внешней программы.",
      table(
        ["Клиент / ID", "Контакты", "Лояльность", "Покупки", "Продажи", ""],
        state.customers.map((c) => [
          `${esc(c.name || "Без имени")}<span class="id">${esc(c.id)}</span><span class="small">${esc(c.tags.join(", "))}</span>`,
          `${esc(c.phone)}<br>${esc(c.email)}`,
          `${esc(c.loyalty.program || "—")}<br><span class="small">${esc(c.loyalty.level || "")} ${c.loyalty.balance !== undefined ? "· " + num(c.loyalty.balance) + " бонусов" : ""}</span>`,
          num(c.results.receipts),
          money(c.results.sales),
          action("Открыть", "customer", "clients", c.id),
        ]),
      ),
      action("Добавить клиента", "customer", "clients"),
    );
  },
  marketing() {
    return (
      `<div class="notice">Показываем продажи, явно связанные с кампанией или акцией. Это не оценка дополнительных продаж благодаря рекламе. Для такого вывода потребуется отдельное сравнение.</div>` +
      panel(
        "Кампании и акции",
        "Расходы задаются за весь срок кампании. Финансовый итог доступен при полном охвате её периода.",
        state.campaigns.length
          ? table(
              [
                "Название",
                "Период",
                "Расходы / бюджет",
                "Связанные продажи",
                "Прибыль после расходов",
                "",
              ],
              state.campaigns.map((c) => [
                `${esc(c.name)}<br><span class="small">${c.kind === "promotion" ? "Акция" : "Реклама"} · ${esc(c.channel)}</span>`,
                `${esc(c.start_on)}<br>${esc(c.end_on)}`,
                `${money(c.spend)} / ${money(c.budget)}`,
                money(c.results.sales),
                money(c.result_after_spend),
                action("Открыть", "campaign", "marketing", c.id),
              ]),
            )
          : empty(
              "Кампаний пока нет",
              "Добавьте акцию, укажите цель, товары и участвующие точки.",
            ),
        action("Добавить кампанию", "campaign", "marketing"),
      )
    );
  },
  data() {
    return (
      panel(
        "Загрузка продаж",
        "Excel, CSV, JSON или отправка по API. Суммы — в копейках; продажи и возвраты передаются положительными числами.",
        `<p class="small">Сначала создайте точки, сотрудников и товары. Их ID доступны в соответствующих разделах. Повторная загрузка с теми же source и external_id обновит строки. Отсутствующие строки сохраняются.</p><div class="actions">${action("Загрузить файл", "import", "integrations")}<button class="secondary" data-action="sample">Скачать образец</button></div>`,
      ) +
      (state.permissions.integrations
        ? panel(
            "API интеграций",
            "Ключ показывается один раз. Он позволяет передавать продажи только в эту компанию.",
            table(
              ["Название", "Последнее обновление", "Статус", ""],
              state.keys.map((k) => [
                esc(k.name),
                esc(k.last_success || "Ещё не использован"),
                k.revoked ? "Отозван" : "Активен",
                k.revoked
                  ? ""
                  : `<button class="secondary" data-revoke="${esc(k.id)}" ${demo ? "disabled" : ""}>Отозвать</button>`,
              ]),
            ),
            action("Создать ключ", "key", "integrations"),
          ) +
          panel(
            "Формат API",
            "Адрес этой расширенной версии",
            `<pre>POST ${esc(publicBase)}/api/v1/sales\nAuthorization: Bearer YOUR_KEY\nContent-Type: application/json\n\n${esc(JSON.stringify(sample(), null, 2))}</pre>`,
          ) +
          panel(
            "История синхронизации",
            "Успешные загрузки",
            table(
              ["Дата", "Источник", "Новых", "Обновлено", "Отменено"],
              state.sync_log.map((r) => [
                esc(r.created_at),
                esc(r.source),
                r.inserted,
                r.updated,
                r.cancelled,
              ]),
            ),
          )
        : "")
    );
  },
};
function factorPanel() {
  const c = state.comparison;
  return panel(
    "Из чего сложилось изменение продаж",
    `Сравнение с ${esc(c.from)} — ${esc(c.to)}. Это математический вклад показателей, а не доказанные причины.`,
    c.factors
      ? table(
          ["Составляющая", "Вклад в изменение"],
          c.factors.map((f) => [esc(f.name), money(f.contribution)]),
        ) +
          `<p class="small">Всего: ${money(state.totals.sales - c.previous.sales)}. Средняя цена зависит и от цен, и от состава покупок. Неполные загрузки периодов могут исказить сравнение.</p>`
      : empty(
          "Недостаточно данных для сравнения",
          "Разбор появится, когда в обоих периодах будут продажи.",
        ),
  );
}
function sample() {
  return {
    source: "my-pos",
    rows: [
      {
        external_id: "line-1001",
        receipt_id: "receipt-501",
        date: $("to").value,
        location_id: state.locations[0]?.id || "LOCATION_ID",
        employee_id: state.employees[0]?.id || null,
        product_id: state.products[0]?.id || "PRODUCT_ID",
        customer_id: null,
        campaign_id: null,
        status: "sale",
        quantity: 2,
        amount_kopecks: 100000,
        cost_kopecks: 60000,
        discount_kopecks: 0,
      },
    ],
  };
}
const input = (name, label, value = "", type = "text", required = false) =>
  `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""}></label>`;
const textarea = (name, label, value) =>
  `<label class="full">${esc(label)}<textarea name="${name}">${esc(value)}</textarea></label>`;
const select = (name, label, options, value = "", required = false) =>
  `<label>${esc(label)}<select name="${name}" ${required ? "required" : ""}>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
function categoryField(label, value = "") {
  const categories = [
    ...new Set(state.products.map((p) => p.category.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "ru"));
  return `<label>${esc(label)}<input name="category" type="text" list="category-options" value="${esc(value)}" maxlength="160" autocomplete="off" placeholder="Выберите или введите новую"><datalist id="category-options">${categories.map((category) => `<option value="${esc(category)}"></option>`).join("")}</datalist></label>`;
}
const locOptions = () => [
  ["", "Вся компания"],
  ...state.locations.map((l) => [l.id, l.name]),
];
function open(kind, id = "") {
  if (demo && kind !== "sample") return;
  if (kind === "sample") {
    const blob = new Blob([JSON.stringify(sample(), null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "business-pulse-sales.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const collection = {
      plan: "plans",
      customer: "customers",
      campaign: "campaigns",
      member: "members",
      employee: "employees",
    },
    r = id
      ? state[collection[kind]].find((x) => (x.id || x.user_id) === id)
      : {};
  editing = { kind, id };
  pendingFile = null;
  let fields = "",
    title = "";
  const start = $("from").value,
    end = $("to").value;
  if (kind === "location") {
    title = "Новая точка";
    fields = input("name", "Название", "", "text", true);
  }
  if (kind === "employee") {
    title = id ? "Редактировать сотрудника" : "Новый сотрудник";
    const selected = new Set(r.location_ids || []);
    fields =
      input("name", "Имя", r.name || "", "text", true) +
      '<fieldset class="full employee-locations"><legend>Точки работы</legend>' +
      (state.locations.length
        ? state.locations
            .map(
              (l) =>
                `<label class="check-line"><input type="checkbox" name="employee_location_ids" value="${esc(l.id)}" ${selected.has(l.id) ? "checked" : ""}>${esc(l.name)}</label>`,
            )
            .join("")
        : '<p class="small">Сначала добавьте точки в разделе «Точки и команда».</p>') +
      '<p class="small">Можно выбрать несколько точек или назначить их позже.</p></fieldset>';
  }
  if (kind === "product") {
    title = "Новый товар или услуга";
    fields =
      input("name", "Название", "", "text", true) +
      categoryField("Категория") +
      input("unit", "Единица измерения", "шт.");
  }
  if (kind === "plan") {
    title = id ? "Изменить план" : "Новый план";
    fields =
      select(
        "metric",
        "Показатель",
        Object.entries(state.metrics).map(([k, v]) => [k, v.label]),
        r.metric || "sales",
      ) +
      input(
        "target",
        "Цель (рубли, единицы или проценты)",
        id
          ? state.metrics[r.metric].unit === "money"
            ? r.target / 100
            : r.target
          : "",
        "number",
        true,
      ) +
      input("start_on", "Начало", r.start_on || start, "date", true) +
      input("end_on", "Окончание", r.end_on || end, "date", true) +
      select("location_id", "Точка", locOptions(), r.location_id || "") +
      select(
        "employee_id",
        "Сотрудник",
        [["", "Все сотрудники"], ...state.employees.map((e) => [e.id, e.name])],
        r.employee_id || "",
      ) +
      categoryField("Категория (необязательно)", r.category || "") +
      select(
        "product_id",
        "Товар",
        [["", "Все товары"], ...state.products.map((p) => [p.id, p.name])],
        r.product_id || "",
      );
  }
  if (kind === "customer") {
    title = id ? "Карточка клиента" : "Новый клиент";
    fields =
      input("name", "Имя", r.name || "") +
      input("phone", "Телефон", r.phone || "", "tel") +
      input("email", "Email", r.email || "", "email") +
      input("tags", "Теги через запятую", r.tags?.join(", ") || "") +
      input("program", "Программа лояльности", r.loyalty?.program || "") +
      input("card", "Номер карты", r.loyalty?.card || "") +
      input("level", "Уровень", r.loyalty?.level || "") +
      input("balance", "Бонусный баланс", r.loyalty?.balance ?? "", "number") +
      input("as_of", "Баланс на дату", r.loyalty?.as_of || date(), "date") +
      textarea("notes", "Заметки", r.notes || "") +
      textarea(
        "external_ids",
        "ID во внешних системах (JSON)",
        JSON.stringify(r.external_ids || {}, null, 2),
      ) +
      textarea(
        "consents",
        "Согласия по каналам (JSON)",
        JSON.stringify(r.consents || [], null, 2),
      ) +
      '<p class="small full">Пример согласия: [{"channel":"email","granted":true,"date":"' +
      date() +
      '","source":"Форма на сайте"}]. Телефон и email сами по себе не означают согласие на рассылки.</p>';
  }
  if (kind === "campaign") {
    title = id ? "Кампания или акция" : "Новая кампания";
    fields =
      input("name", "Название", r.name || "", "text", true) +
      select(
        "kind",
        "Тип",
        [
          ["promotion", "Акция"],
          ["campaign", "Рекламная кампания"],
        ],
        r.kind || "promotion",
      ) +
      input("channel", "Канал", r.channel || "") +
      input("promo_code", "Промокод", r.promo_code || "") +
      input("start_on", "Начало", r.start_on || start, "date", true) +
      input("end_on", "Окончание", r.end_on || end, "date", true) +
      input("budget", "Бюджет, ₽", (r.budget || 0) / 100, "number", true) +
      input(
        "spend",
        "Фактические расходы, ₽",
        (r.spend || 0) / 100,
        "number",
        true,
      ) +
      textarea("goal", "Цель", r.goal || "") +
      textarea(
        "location_ids",
        "ID точек через запятую (пусто — все)",
        r.location_ids?.join(", ") || "",
      ) +
      textarea(
        "product_ids",
        "ID товаров через запятую (пусто — все)",
        r.product_ids?.join(", ") || "",
      );
  }
  if (kind === "invite") {
    title = "Пригласить в компанию";
    fields =
      input("email", "Email получателя", "", "email", true) +
      select(
        "role",
        "Роль",
        Object.entries(roleNames).filter(
          ([k]) =>
            k !== "owner" &&
            (state.actor.role === "owner" ||
              !["director", "deputy"].includes(k)),
        ),
      ) +
      textarea(
        "location_ids",
        "ID доступных точек через запятую (пусто — вся компания)",
        "",
      ) +
      select("employee_id", "Сотрудник для личного кабинета", [
        ["", "Не привязан"],
        ...state.employees.map((e) => [e.id, e.name]),
      ]);
  }
  if (kind === "member") {
    title = "Доступ сотрудника";
    fields =
      select(
        "role",
        "Роль",
        Object.entries(roleNames).filter(
          ([k]) =>
            k !== "owner" &&
            (state.actor.role === "owner" ||
              !["director", "deputy"].includes(k)),
        ),
        r.role,
      ) +
      textarea(
        "location_ids",
        "ID доступных точек через запятую",
        JSON.parse(r.scope_json || "[]").join(", "),
      ) +
      select(
        "employee_id",
        "Личный кабинет сотрудника",
        [["", "Не привязан"], ...state.employees.map((e) => [e.id, e.name])],
        r.employee_id || "",
      ) +
      '<label class="check-line full"><input name="remove" type="checkbox">Отозвать доступ к компании</label>';
  }
  if (kind === "key") {
    title = "Новый ключ интеграции";
    fields = input("name", "Название источника", "", "text", true);
  }
  if (kind === "import") {
    title = "Загрузить продажи";
    fields =
      '<label class="full">Файл<input name="file" type="file" accept=".json,.csv,.xlsx" required></label><div id="file-mapping" class="full"></div><p class="small full">До 5000 строк в пакете. Для Excel и CSV выберите столбцы. Точки, товары и сотрудники должны быть созданы заранее; можно передать их ID или точные названия.</p>';
  }
  $("dialog-title").textContent = title;
  $("fields").innerHTML = '<div class="form-grid">' + fields + "</div>";
  $("form-error").textContent = "";
  $("save-dialog").hidden = false;
  $("save-dialog").textContent = "Сохранить";
  $("dialog").showModal();
  $("fields")
    .querySelectorAll('input[type="number"]')
    .forEach((el) => {
      el.step = "any";
      el.min = "0";
    });
}
const split = (v) =>
  (v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
function renderMapping() {
  const matrix =
      pendingFile.sheets[Number($("editor").elements.sheet?.value || 0)].rows,
    head = matrix[0] || [];
  const old = $("editor").elements.sheet?.value || "0";
  $("file-mapping").innerHTML =
    select(
      "sheet",
      "Лист",
      pendingFile.sheets.map((s, i) => [String(i), s.name]),
      old,
    ) +
    input(
      "source",
      "Постоянное название источника",
      "file-import",
      "text",
      true,
    ) +
    select("money_unit", "Единица денежных сумм", [
      ["rubles", "Рубли"],
      ["kopecks", "Копейки"],
    ]) +
    select(
      "default_location",
      "Точка, если в файле нет столбца",
      locOptions(),
    ) +
    fields
      .map(([k, label, re]) =>
        select(
          "map_" + k,
          label,
          [
            ["", "Не выбран"],
            ...head.map((h, i) => [String(i), h || "Столбец " + (i + 1)]),
          ],
          head.findIndex((h) => re.test(h)) < 0
            ? ""
            : String(head.findIndex((h) => re.test(h))),
        ),
      )
      .join("") +
    `<p class="small">${Math.max(0, matrix.length - 1)} строк. Первая строка должна содержать заголовки. Для одного чека с несколькими товарами каждой строке нужен свой ID.</p>`;
}
$("editor").addEventListener("change", async (e) => {
  if (editing?.kind !== "import") return;
  if (e.target.name === "sheet") {
    renderMapping();
    return;
  }
  if (e.target.name !== "file") return;
  const file = e.target.files[0];
  pendingFile = null;
  $("form-error").textContent = "";
  if (!file || /\.json$/i.test(file.name)) {
    $("file-mapping").innerHTML = "";
    return;
  }
  $("save-dialog").disabled = true;
  try {
    pendingFile = await readFile(file);
    renderMapping();
  } catch (err) {
    $("form-error").textContent = err.message;
  } finally {
    $("save-dialog").disabled = false;
  }
});
$("editor").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = $("save-dialog");
  b.disabled = true;
  $("form-error").textContent = "";
  try {
    const fd = new FormData(e.target),
      v = Object.fromEntries(fd);
    if (inviteToken) {
      const accepted = await api("/api/accept-invite", {
        ...v,
        token: inviteToken,
      });
      inviteToken = null;
      $("dialog").close();
      $("login").elements.email.value = accepted.email;
      toast("Аккаунт создан. Войдите с новым паролем.");
      return;
    }
    const { kind, id } = editing;
    let result;
    if (kind === "plan") {
      v.target =
        Number(v.target) * (state.metrics[v.metric].unit === "money" ? 100 : 1);
      result = await api("/api/plans", { ...v, id: id || undefined });
    } else if (kind === "invite")
      result = await api("/api/invites", {
        ...v,
        location_ids: split(v.location_ids),
      });
    else if (kind === "member")
      result = await api("/api/members", {
        ...v,
        user_id: id,
        location_ids: split(v.location_ids),
        remove: v.remove === "on",
      });
    else if (kind === "key") result = await api("/api/keys", v);
    else if (kind === "import") {
      const file = fd.get("file");
      let data;
      if (/\.json$/i.test(file.name)) data = JSON.parse(await file.text());
      else {
        if (!pendingFile) throw Error("Дождитесь чтения файла.");
        const sheet = pendingFile.sheets[Number(v.sheet || 0)];
        data = tableToSales(
          sheet.rows,
          Object.fromEntries(fields.map(([k]) => [k, v["map_" + k]])),
          {
            source: v.source,
            moneyUnit: v.money_unit,
            locationId: v.default_location,
            state,
          },
        );
      }
      result = await api("/api/import", data);
    } else {
      const types = {
        location: "locations",
        employee: "employees",
        product: "products",
        customer: "customers",
        campaign: "campaigns",
      };
      if (kind === "employee")
        v.location_ids = fd.getAll("employee_location_ids");
      if (kind === "customer") {
        v.tags = split(v.tags);
        v.external_ids = JSON.parse(v.external_ids);
        v.consents = JSON.parse(v.consents);
        v.loyalty = {
          program: v.program,
          card: v.card,
          level: v.level,
          ...(v.balance !== ""
            ? { balance: Number(v.balance), as_of: v.as_of }
            : {}),
        };
      }
      if (kind === "campaign") {
        v.budget = Math.round(Number(v.budget) * 100);
        v.spend = Math.round(Number(v.spend) * 100);
        v.location_ids = split(v.location_ids);
        v.product_ids = split(v.product_ids);
      }
      result = await api("/api/save", {
        type: types[kind],
        record: { ...v, id: id || undefined },
      });
    }
    await load();
    if (result.token) {
      $("dialog-title").textContent =
        kind === "key" ? "Сохраните ключ" : "Ссылка приглашения";
      $("fields").innerHTML =
        '<p class="small">' +
        (kind === "key"
          ? "Ключ больше не будет показан."
          : "Передайте ссылку указанному сотруднику. Срок — 7 дней.") +
        '</p><div class="secret">' +
        esc(
          kind === "key"
            ? result.token
            : publicBase + "/#invite=" + result.token,
        ) +
        "</div>";
      $("save-dialog").hidden = true;
    } else {
      $("dialog").close();
      toast(
        kind === "import"
          ? `Загрузка завершена: новых ${result.inserted}, обновлено ${result.updated}, отменено ${result.cancelled}`
          : "Сохранено",
      );
    }
  } catch (error) {
    $("form-error").textContent =
      error instanceof SyntaxError ? "Проверьте формат JSON." : error.message;
  } finally {
    b.disabled = false;
  }
});
$("content").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-insights")) {
    b.disabled = true;
    try {
      const r = await api("/api/insights?" + query());
      $("insights-output").innerHTML =
        '<span class="badge">' +
        (r.mode === "ai" ? "ИИ-анализ" : "Разбор по правилам") +
        "</span><p>" +
        esc(r.summary) +
        "</p>" +
        r.attention.map((x) => '<p class="small">' + esc(x) + "</p>").join("") +
        "<h3>Что проверить</h3>" +
        r.actions.map((x) => '<p class="small">' + esc(x) + "</p>").join("");
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  }
  if (b.dataset.action) open(b.dataset.action, b.dataset.id);
  if (b.dataset.tab) {
    tab = b.dataset.tab;
    render();
  }
  if (b.dataset.group) {
    salesGroup = b.dataset.group;
    render();
  }
  if (b.dataset.revoke && !demo) {
    try {
      await api("/api/keys/revoke", { id: b.dataset.revoke });
      await load();
      toast("Ключ отозван.");
    } catch (e) {
      toast(e.message);
    }
  }
});
$("nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) {
    tab = b.dataset.tab;
    render();
  }
});
$("apply").onclick = () => load().catch((e) => toast(e.message));
$("demo").onclick = () => {
  demo = true;
  load().catch((e) => toast(e.message));
};
$("exit-workspace").onclick = $("logout").onclick = async () => {
  try {
    if (!demo) await api("/api/logout", {});
    demo = false;
    state = null;
    $("workspace").hidden = true;
    $("welcome").hidden = false;
  } catch (e) {
    toast(e.message);
  }
};
$("login").onsubmit = async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("button");
  b.disabled = true;
  try {
    await api("/api/login", Object.fromEntries(new FormData(e.target)));
    demo = false;
    e.target.reset();
    await load();
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = false;
  }
};
$("close-dialog").onclick = $("cancel-dialog").onclick = () =>
  $("dialog").close();
async function boot() {
  const token = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (token) {
    inviteToken = token;
    history.replaceState(null, "", location.pathname);
    $("dialog-title").textContent = "Принять приглашение";
    $("fields").innerHTML =
      input("name", "Ваше имя", "", "text", true) +
      input("password", "Новый пароль — от 12 символов", "", "password", true);
    $("dialog").showModal();
    return;
  }
  try {
    await load();
  } catch {
    /* Login is shown for a new session. */
  }
}
boot();
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("invite")) boot();
});
