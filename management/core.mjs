import { initKpi, createKpi, evaluateKpi } from "./kpi.mjs";
import { buildTrend } from "./trend.mjs";
import { buildSalesReport } from "./sales-analytics.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const ROLES = {
  owner: "Владелец",
  director: "Директор",
  deputy: "Заместитель директора",
  manager: "Руководитель точки",
  employee: "Сотрудник",
  marketing: "Маркетинг",
};
export const METRICS = {
  sales: { label: "Продажи", unit: "money", direction: "up" },
  receipts: { label: "Чеки", unit: "number", direction: "up" },
  average: { label: "Средний чек", unit: "money", direction: "up" },
  quantity: { label: "Проданные единицы", unit: "number", direction: "up" },
  basket: { label: "Единиц на чек", unit: "number", direction: "up" },
  profit: { label: "Валовая прибыль", unit: "money", direction: "up" },
  margin: { label: "Валовая маржа", unit: "percent", direction: "up" },
  refund_rate: { label: "Доля возвратов", unit: "percent", direction: "down" },
};
const hash = (x) => createHash("sha256").update(x).digest("hex");
export const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
export const text = (v, max = 160, required = true) => {
  if (v === undefined || v === null || v === "") {
    if (required) fail("Заполните обязательные поля.");
    return "";
  }
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    fail("Некорректное текстовое поле.");
  return v.trim();
};
const email = (v) => {
  const e = text(v, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail("Укажите корректный email.");
  return e;
};
const number = (v, { min = 0, integer = false, nullable = false } = {}) => {
  if (nullable && (v === null || v === undefined || v === "")) return null;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    Math.abs(v) > 1e12 ||
    v < min ||
    (integer && !Number.isSafeInteger(v))
  )
    fail("Некорректное число.");
  return v;
};
export const day = (v) => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    Number.isNaN(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    fail("Некорректная дата.");
  return v;
};
export const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
    new Date(),
  );
const days = (a, b) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const secret = () => randomBytes(32).toString("hex");
const passwordDigest = (p, s) => scryptSync(p, s, 64);
const checkPassword = (p) => {
  if (typeof p !== "string" || p.length < 12 || p.length > 128)
    fail("Пароль должен содержать от 12 до 128 символов.");
};
const writeRoles = {
  structure: ["owner", "director"],
  plans: ["owner", "director", "deputy", "manager"],
  marketing: ["owner", "director", "deputy", "marketing"],
  clients: ["owner", "director", "deputy", "manager"],
  integrations: ["owner", "director"],
  members: ["owner", "director"],
};
export const can = (actor, action) =>
  Boolean(writeRoles[action]?.includes(actor.role)) &&
  !(
    actor.scope?.length &&
    ["structure", "integrations", "members"].includes(action)
  );

export function openStore(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS mg_companies(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_members(company_id TEXT NOT NULL REFERENCES mg_companies(id),user_id TEXT NOT NULL REFERENCES mg_users(id),role TEXT NOT NULL,scope_json TEXT NOT NULL DEFAULT '[]',employee_id TEXT,PRIMARY KEY(company_id,user_id));
 CREATE TABLE IF NOT EXISTS mg_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES mg_users(id),expires_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_invites(token_hash TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),email TEXT NOT NULL,role TEXT NOT NULL,scope_json TEXT NOT NULL,employee_id TEXT,expires_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_locations(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_employees(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),name TEXT NOT NULL,locations_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_products(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),name TEXT NOT NULL,category TEXT NOT NULL,unit TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_customers(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL,external_ids_json TEXT NOT NULL,tags_json TEXT NOT NULL,notes TEXT NOT NULL,loyalty_json TEXT NOT NULL,consents_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_campaigns(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),name TEXT NOT NULL,kind TEXT NOT NULL,channel TEXT NOT NULL,start_on TEXT NOT NULL,end_on TEXT NOT NULL,budget INTEGER NOT NULL,spend INTEGER NOT NULL,goal TEXT NOT NULL,locations_json TEXT NOT NULL,products_json TEXT NOT NULL,promo_code TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_sales(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),source TEXT NOT NULL,external_id TEXT NOT NULL,receipt_id TEXT NOT NULL,sold_on TEXT NOT NULL,location_id TEXT NOT NULL,employee_id TEXT,product_id TEXT NOT NULL,customer_id TEXT,campaign_id TEXT,status TEXT NOT NULL,quantity REAL NOT NULL,amount INTEGER NOT NULL,cost INTEGER,discount INTEGER NOT NULL,UNIQUE(company_id,source,external_id));
 CREATE INDEX IF NOT EXISTS mg_sales_period ON mg_sales(company_id,sold_on,location_id);
 CREATE TABLE IF NOT EXISTS mg_plans(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),metric TEXT NOT NULL,target REAL NOT NULL,start_on TEXT NOT NULL,end_on TEXT NOT NULL,location_id TEXT,employee_id TEXT,category TEXT,product_id TEXT,direction TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS mg_plan_history(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,company_id TEXT NOT NULL,actor_id TEXT NOT NULL,changed_at TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_keys(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mg_companies(id),name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,last_success TEXT,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS mg_sync_log(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,key_id TEXT,source TEXT NOT NULL,created_at TEXT NOT NULL,inserted INTEGER NOT NULL,updated INTEGER NOT NULL,cancelled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS mg_cancelled(company_id TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT NOT NULL,PRIMARY KEY(company_id,source,external_id));
 CREATE TABLE IF NOT EXISTS mg_catalog_ids(company_id TEXT NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,external_id TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(company_id,source,kind,external_id));
 CREATE TABLE IF NOT EXISTS mg_audit(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,entity_id TEXT NOT NULL,created_at TEXT NOT NULL);
 `);
  const productColumns = db
    .prepare("PRAGMA table_info(mg_products)")
    .all()
    .map((c) => c.name);
  if (!productColumns.includes("sku"))
    db.exec("ALTER TABLE mg_products ADD COLUMN sku TEXT NOT NULL DEFAULT ''");
  initKpi(db);
  db.exec("CREATE TABLE IF NOT EXISTS mg_sales_updated(sale_id TEXT PRIMARY KEY,updated_at TEXT NOT NULL)");
  return db;
}
let transactionId=0;
const transaction = (db, fn) => {
  const name="bp_"+(++transactionId);
  db.exec("SAVEPOINT "+name);
  try {
    const v = fn();
    db.exec("RELEASE "+name);
    return v;
  } catch (e) {
    db.exec("ROLLBACK TO "+name);
    db.exec("RELEASE "+name);
    throw e;
  }
};
export function createService(db) {
  const get = (table, c, id) =>
    db
      .prepare(`SELECT * FROM mg_${table} WHERE company_id=? AND id=?`)
      .get(c, id);
  const list = (table, c) =>
    db
      .prepare(
        `SELECT * FROM mg_${table} WHERE company_id=? ORDER BY rowid DESC`,
      )
      .all(c);
  const audit = (a, action, id) =>
    db
      .prepare("INSERT INTO mg_audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        a.company_id,
        a.user_id || "integration",
        action,
        id,
        new Date().toISOString(),
      );
  function owner({ company, name, email: raw, password }) {
    checkPassword(password);
    const address = email(raw),
      n = text(name),
      cn = text(company),
      salt = secret(),
      digest = passwordDigest(password, salt).toString("hex");
    return transaction(db, () => {
      const uid = randomUUID(),
        cid = randomUUID();
      db.prepare("INSERT INTO mg_companies VALUES(?,?)").run(cid, cn);
      db.prepare("INSERT INTO mg_users VALUES(?,?,?,?,?)").run(
        uid,
        address,
        n,
        salt,
        digest,
      );
      db.prepare("INSERT INTO mg_members VALUES(?,?,'owner','[]',NULL)").run(
        cid,
        uid,
      );
      return { user_id: uid, company_id: cid };
    });
  }
  function login({ email: raw, password }) {
    const address = email(raw);
    if (typeof password !== "string" || password.length > 128)
      fail("Неверный email или пароль.", 401);
    const u = db.prepare("SELECT * FROM mg_users WHERE email=?").get(address);
    const p = passwordDigest(password, u?.salt || "missing-account");
    if (!u || !timingSafeEqual(p, Buffer.from(u.password_hash, "hex")))
      fail("Неверный email или пароль.", 401);
    const token = secret();
    db.prepare("DELETE FROM mg_sessions WHERE expires_ms<?").run(Date.now());
    db.prepare("INSERT INTO mg_sessions VALUES(?,?,?)").run(
      hash(token),
      u.id,
      Date.now() + 7 * 86400000,
    );
    return { token };
  }
  function actor(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const a = db
      .prepare(
        "SELECT m.*,u.name,u.email,c.name AS company_name FROM mg_sessions s JOIN mg_users u ON u.id=s.user_id JOIN mg_members m ON m.user_id=u.id JOIN mg_companies c ON c.id=m.company_id WHERE s.token_hash=? AND s.expires_ms>?",
      )
      .get(hash(token), Date.now());
    return a ? { ...a, scope: JSON.parse(a.scope_json) } : null;
  }
  function requireAction(a, action) {
    if (!can(a, action)) fail("Недостаточно прав.", 403);
  }
  function within(a, location) {
    if (a.scope.length && !a.scope.includes(location))
      fail("Нет доступа к этой точке.", 403);
    if (["manager", "employee"].includes(a.role) && !a.scope.length)
      fail("Точки доступа не назначены.", 403);
  }
  function ref(table, c, id, required = false) {
    if (!id) {
      if (required) fail("Выберите связанный объект.");
      return null;
    }
    id = text(id, 160);
    if (!get(table, c, id)) fail("Связанный объект не найден в компании.");
    return id;
  }
  function locations(a, ids) {
    if (!Array.isArray(ids) || ids.length > 100)
      fail("Некорректный список точек.");
    return [
      ...new Set(
        ids.map((id) => {
          ref("locations", a.company_id, id, true);
          within(a, id);
          return id;
        }),
      ),
    ];
  }
  function visible(a, row) {
    if (a.scope.length && !a.scope.includes(row.location_id)) return false;
    if (["manager", "employee"].includes(a.role) && !a.scope.length)
      return false;
    if (a.role === "employee" && row.employee_id !== a.employee_id)
      return false;
    return true;
  }
  function productRecords(a) {
    const aliases = db
      .prepare(
        "SELECT source,external_id,entity_id FROM mg_catalog_ids WHERE company_id=? AND kind='products'",
      )
      .all(a.company_id);
    const byId = new Map();
    for (const alias of aliases) {
      if (!byId.has(alias.entity_id)) byId.set(alias.entity_id, []);
      byId
        .get(alias.entity_id)
        .push({ source: alias.source, external_id: alias.external_id });
    }
    return list("products", a.company_id).map((p) => ({
      ...p,
      external_ids: byId.get(p.id) || [],
    }));
  }
  function products(a, filters = {}) {
    const term = text(filters.q, 160, false).toLocaleLowerCase("ru"),
      category = text(filters.category, 160, false);
    const all = productRecords(a),
      categories = [...new Set(all.map((p) => p.category))].sort((a, b) =>
        a.localeCompare(b, "ru"),
      );
    const matches = all
      .filter(
        (p) =>
          (!category || p.category === category) &&
          (!term ||
            [p.name, p.sku, p.id, ...p.external_ids.map((x) => x.external_id)]
              .join(" ")
              .toLocaleLowerCase("ru")
              .includes(term)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const size = Math.min(
        100,
        Math.max(1, Math.floor(Number(filters.page_size)) || 50),
      ),
      pages = Math.max(1, Math.ceil(matches.length / size)),
      page = Math.min(
        pages,
        Math.max(1, Math.floor(Number(filters.page)) || 1),
      );
    return {
      items: matches.slice((page - 1) * size, page * size),
      total: matches.length,
      page,
      page_size: size,
      pages,
      categories,
    };
  }
  function rows(a, filters = {}) {
    const from = day(filters.from || today().slice(0, 7) + "-01"),
      to = day(filters.to || today());
    if (from > to || days(from, to) > 1096)
      fail("Допустимый период — до трёх лет.");
    if (filters.location_id) within(a, filters.location_id);
    return db
      .prepare(
        "SELECT s.*,su.updated_at,p.name AS product_name,p.category,p.unit,p.sku,l.name AS location_name,e.name AS employee_name FROM mg_sales s LEFT JOIN mg_sales_updated su ON su.sale_id=s.id JOIN mg_products p ON p.id=s.product_id JOIN mg_locations l ON l.id=s.location_id LEFT JOIN mg_employees e ON e.id=s.employee_id WHERE s.company_id=? AND s.sold_on>=? AND s.sold_on<=?",
      )
      .all(a.company_id, from, to)
      .filter(
        (r) =>
          visible(a, r) &&
          (!filters.location_id || r.location_id === filters.location_id) &&
          (!filters.employee_id || r.employee_id === filters.employee_id) &&
          (!filters.category || r.category === filters.category) &&
          (!filters.product_id || r.product_id === filters.product_id),
      );
  }
  function save(a, type, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail("Некорректная запись.");
    return transaction(db, () => saveRecord(a, type, input));
  }
  function saveRecord(a, type, input) {
    const c = a.company_id,
      id = input.id || randomUUID();
    if (
      ![
        "locations",
        "employees",
        "products",
        "customers",
        "campaigns",
      ].includes(type)
    )
      fail("Неизвестный объект.");
    if (input.id && !get(type, c, id)) fail("Объект не найден.", 404);
    if (type === "locations") {
      requireAction(a, "structure");
      db.prepare(
        "INSERT INTO mg_locations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
      ).run(id, c, text(input.name));
    } else if (type === "employees") {
      requireAction(a, "structure");
      const loc = locations(a, input.location_ids || []);
      db.prepare(
        "INSERT INTO mg_employees VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,locations_json=excluded.locations_json",
      ).run(id, c, text(input.name), JSON.stringify(loc));
    } else if (type === "products") {
      requireAction(a, "structure");
      db.prepare(
        "INSERT INTO mg_products(id,company_id,name,category,unit,sku) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,unit=excluded.unit,sku=excluded.sku",
      ).run(
        id,
        c,
        text(input.name),
        text(input.category || "Без категории"),
        text(input.unit || "шт.", 30),
        input.sku === undefined
          ? get("products", c, id)?.sku || ""
          : text(input.sku, 160, false),
      );
    } else if (type === "customers") {
      requireAction(a, "clients");
      if (a.scope.length || a.role === "manager")
        fail("Контакты клиентов доступны только на уровне компании.", 403);
      const phone = text(input.phone, 40, false).replace(/[\s()\-]/g, "");
      if (phone && !/^\+?\d{7,15}$/.test(phone)) fail("Некорректный телефон.");
      const mail = input.email ? email(input.email) : "";
      const ext = input.external_ids || {},
        tags = input.tags || [],
        loyalty = input.loyalty || {},
        consents = input.consents || [];
      if (
        !ext ||
        Array.isArray(ext) ||
        typeof ext !== "object" ||
        Object.keys(ext).length > 20
      )
        fail("Некорректные идентификаторы.");
      for (const [k, v] of Object.entries(ext)) {
        text(k, 80);
        text(v, 160);
      }
      if (!Array.isArray(tags) || tags.length > 30) fail("Некорректные теги.");
      tags.forEach((x) => text(x, 80));
      if (!loyalty || Array.isArray(loyalty) || typeof loyalty !== "object")
        fail("Некорректная программа лояльности.");
      for (const k of Object.keys(loyalty))
        if (!["program", "card", "level", "balance", "as_of"].includes(k))
          fail("Неизвестное поле лояльности.");
      for (const k of ["program", "card", "level"])
        if (loyalty[k] !== undefined) text(loyalty[k], 160, false);
      if (loyalty.balance !== undefined) number(loyalty.balance);
      if (loyalty.as_of) day(loyalty.as_of);
      if (!Array.isArray(consents) || consents.length > 20)
        fail("Некорректные согласия.");
      for (const v of consents) {
        if (
          !["email", "sms", "phone", "messenger"].includes(v.channel) ||
          typeof v.granted !== "boolean"
        )
          fail("Укажите канал и статус согласия.");
        day(v.date);
        text(v.source, 160);
      }
      db.prepare(
        "INSERT INTO mg_customers VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,email=excluded.email,external_ids_json=excluded.external_ids_json,tags_json=excluded.tags_json,notes=excluded.notes,loyalty_json=excluded.loyalty_json,consents_json=excluded.consents_json",
      ).run(
        id,
        c,
        text(input.name, 160, false),
        phone,
        mail,
        JSON.stringify(ext),
        JSON.stringify(tags),
        text(input.notes, 2000, false),
        JSON.stringify(loyalty),
        JSON.stringify(consents),
      );
    } else if (type === "campaigns") {
      requireAction(a, "marketing");
      const start = day(input.start_on),
        end = day(input.end_on);
      if (end < start) fail("Конец раньше начала.");
      if (!["campaign", "promotion"].includes(input.kind))
        fail("Выберите тип кампании.");
      const loc = locations(a, input.location_ids || []);
      if (a.scope.length && !loc.length) fail("Укажите доступные точки.");
      const prods = input.product_ids || [];
      if (!Array.isArray(prods) || prods.length > 1000)
        fail("Некорректные товары.");
      prods.forEach((x) => ref("products", c, x, true));
      const old = get(type, c, id);
      if (old) checkCampaign(a, old);
      db.prepare(
        "INSERT INTO mg_campaigns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,channel=excluded.channel,start_on=excluded.start_on,end_on=excluded.end_on,budget=excluded.budget,spend=excluded.spend,goal=excluded.goal,locations_json=excluded.locations_json,products_json=excluded.products_json,promo_code=excluded.promo_code",
      ).run(
        id,
        c,
        text(input.name),
        input.kind,
        text(input.channel, 120, false),
        start,
        end,
        number(input.budget, { integer: true }),
        number(input.spend, { integer: true }),
        text(input.goal, 400, false),
        JSON.stringify(loc),
        JSON.stringify(prods),
        text(input.promo_code, 80, false),
      );
    } else fail("Неизвестный объект.");
    audit(a, "save:" + type, id);
    return { id };
  }
  function checkCampaign(a, r) {
    const loc = JSON.parse(r.locations_json);
    if (
      a.scope.length &&
      (!loc.length || loc.some((x) => !a.scope.includes(x)))
    )
      fail("Кампания вне области доступа.", 403);
  }
  const kpi=createKpi({db,fail,text,number,day,today,can,within,ref,transaction,audit});
  function plan(a, input) {
    requireAction(a, "plans");
    const id = input.id || randomUUID(),
      old = get("plans", a.company_id, id);
    if (input.id && !old) fail("План не найден.", 404);
    if (old) {
      if (old.location_id) within(a, old.location_id);
      else if (a.scope.length || a.role === "manager")
        fail("Нет доступа к общему плану.", 403);
    }
    const metric = text(input.metric, 80);
    const definition=({...METRICS,...kpi.definitions(a)})[metric];
    if (!Object.hasOwn({...METRICS,...kpi.definitions(a)},metric)) fail("Неизвестный KPI.");
    const start = day(input.start_on),
      end = day(input.end_on);
    if (end < start || days(start, end) > 1096) fail("Неверный период плана.");
    const location = ref("locations", a.company_id, input.location_id);
    if (location) within(a, location);
    if ((a.scope.length || a.role === "manager") && !location)
      fail("Выберите свою точку.");
    const employee = ref("employees", a.company_id, input.employee_id),
      product = ref("products", a.company_id, input.product_id);
    if (
      employee &&
      location &&
      !JSON.parse(
        get("employees", a.company_id, employee).locations_json,
      ).includes(location)
    )
      fail("Сотрудник не относится к точке.");
    const target = number(input.target, {min: metric.startsWith("custom_") ? -1e12 : 0}),
      direction = definition.direction,
      category = text(input.category, 160, false) || null;
    if (metric.startsWith("custom_") && (category || product)) fail("Для собственного KPI доступны компания, точка и сотрудник.");
    const priorOptions=input.id?kpi.options(a,input.id):{};
    const planOptions=kpi.validateOptions(a,input,{id:input.id,start_on:start,end_on:end,target,direction});
    return transaction(db, () => {
      db.prepare(
        "INSERT INTO mg_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target=excluded.target,start_on=excluded.start_on,end_on=excluded.end_on,metric=excluded.metric,location_id=excluded.location_id,employee_id=excluded.employee_id,category=excluded.category,product_id=excluded.product_id,direction=excluded.direction,version=mg_plans.version+1",
      ).run(
        id,
        a.company_id,
        metric,
        target,
        start,
        end,
        location,
        employee,
        category,
        product,
        direction,
        old ? old.version + 1 : 1,
      );
      kpi.saveOptions(a,id,planOptions);
      db.prepare("INSERT INTO mg_plan_history VALUES(?,?,?,?,?,?)").run(
        randomUUID(),
        id,
        a.company_id,
        a.user_id,
        new Date().toISOString(),
        JSON.stringify({
          before: old ? {...old,options:input.id ? priorOptions : {}} : null,
          after: {...get("plans", a.company_id, id), options:planOptions},
        }),
      );
      audit(a, "save:plan", id);
      return { id };
    });
  }
  function invite(a, input) {
    requireAction(a, "members");
    if (
      !ROLES[input.role] ||
      input.role === "owner" ||
      (a.role === "director" && ["director", "deputy"].includes(input.role))
    )
      fail("Нельзя выдать эту роль.", 403);
    const scopes = locations(a, input.location_ids || []),
      employee = ref("employees", a.company_id, input.employee_id);
    if (["manager", "employee"].includes(input.role) && !scopes.length)
      fail("Укажите точки доступа.");
    if (input.role === "employee" && !employee) fail("Выберите сотрудника.");
    if (
      employee &&
      scopes.some(
        (x) =>
          !JSON.parse(
            get("employees", a.company_id, employee).locations_json,
          ).includes(x),
      )
    )
      fail("Сотрудник не относится к выбранным точкам.");
    const token = secret();
    db.prepare("INSERT INTO mg_invites VALUES(?,?,?,?,?,?,?)").run(
      hash(token),
      a.company_id,
      email(input.email),
      input.role,
      JSON.stringify(scopes),
      employee,
      Date.now() + 7 * 86400000,
    );
    audit(a, "invite", input.email);
    return { token };
  }
  function accept({ token, name, password }) {
    checkPassword(password);
    const salt = secret(),
      digest = passwordDigest(password, salt).toString("hex");
    return transaction(db, () => {
      const i = db
        .prepare("SELECT * FROM mg_invites WHERE token_hash=? AND expires_ms>?")
        .get(hash(text(token, 64)), Date.now());
      if (!i) fail("Приглашение истекло или использовано.");
      if (db.prepare("SELECT 1 FROM mg_users WHERE email=?").get(i.email))
        fail("Email уже зарегистрирован.", 409);
      const uid = randomUUID();
      db.prepare("INSERT INTO mg_users VALUES(?,?,?,?,?)").run(
        uid,
        i.email,
        text(name),
        salt,
        digest,
      );
      db.prepare("INSERT INTO mg_members VALUES(?,?,?,?,?)").run(
        i.company_id,
        uid,
        i.role,
        i.scope_json,
        i.employee_id,
      );
      db.prepare("DELETE FROM mg_invites WHERE token_hash=?").run(i.token_hash);
      return { email: i.email };
    });
  }
  function key(a, name) {
    requireAction(a, "integrations");
    const token = secret(),
      id = randomUUID();
    db.prepare("INSERT INTO mg_keys VALUES(?,?,?,?,?,?,0)").run(
      id,
      a.company_id,
      text(name),
      hash(token),
      new Date().toISOString(),
      null,
    );
    audit(a, "create:key", id);
    return { id, token };
  }
  function integration(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const k = db
      .prepare("SELECT * FROM mg_keys WHERE token_hash=? AND revoked=0")
      .get(hash(token));
    return k
      ? {
          company_id: k.company_id,
          user_id: "key:" + k.id,
          role: "integration",
          scope: [],
          key_id: k.id,
        }
      : null;
  }
  function importSales(a, input) {
    if (a.role !== "integration") requireAction(a, "integrations");
    const source = text(input.source, 80),
      batch = input.rows;
    if (!Array.isArray(batch) || !batch.length || batch.length > 5000)
      fail("Отправьте от 1 до 5000 строк.");
    const seen = new Set();
    const prepared = batch.map((r) => {
      const external = text(r.external_id, 160);
      if (seen.has(external)) fail("Повторный ID строки внутри пакета.");
      seen.add(external);
      const prior = db
        .prepare(
          "SELECT * FROM mg_sales WHERE company_id=? AND source=? AND external_id=?",
        )
        .get(a.company_id, source, external);
      if (r.status === "cancelled") {
        if (
          !prior &&
          !db
            .prepare(
              "SELECT 1 FROM mg_cancelled WHERE company_id=? AND source=? AND external_id=?",
            )
            .get(a.company_id, source, external)
        )
          fail("Неизвестная строка отмены.");
        return { cancel: true, prior, external };
      }
      if (!["sale", "refund"].includes(r.status))
        fail("Статус должен быть sale, refund или cancelled.");
      const loc = ref("locations", a.company_id, r.location_id, true),
        prod = ref("products", a.company_id, r.product_id, true),
        emp = ref("employees", a.company_id, r.employee_id),
        cust = ref("customers", a.company_id, r.customer_id),
        campaign = ref("campaigns", a.company_id, r.campaign_id);
      if (
        emp &&
        !JSON.parse(
          get("employees", a.company_id, emp).locations_json,
        ).includes(loc)
      )
        fail("Сотрудник не относится к точке.");
      const date = day(r.date);
      if (date > today()) fail("Продажа не может быть в будущем.");
      if (campaign) {
        const cp = get("campaigns", a.company_id, campaign),
          ls = JSON.parse(cp.locations_json),
          ps = JSON.parse(cp.products_json);
        if (
          date < cp.start_on ||
          date > cp.end_on ||
          (ls.length && !ls.includes(loc)) ||
          (ps.length && !ps.includes(prod))
        )
          fail("Продажа не соответствует условиям кампании.");
      }
      return {
        id: prior?.id || randomUUID(),
        prior,
        external,
        receipt: text(r.receipt_id),
        date,
        loc,
        prod,
        emp,
        cust,
        campaign,
        status: r.status,
        quantity: number(r.quantity, { min: 0.000001 }),
        amount: number(r.amount_kopecks, { integer: true }),
        cost: number(r.cost_kopecks, { integer: true, nullable: true }),
        discount: number(r.discount_kopecks ?? 0, { integer: true }),
      };
    });
    return transaction(db, () => {
      let inserted = 0,
        updated = 0,
        cancelled = 0;
      const stmt = db.prepare(
        "INSERT INTO mg_sales VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,source,external_id) DO UPDATE SET receipt_id=excluded.receipt_id,sold_on=excluded.sold_on,location_id=excluded.location_id,employee_id=excluded.employee_id,product_id=excluded.product_id,customer_id=excluded.customer_id,campaign_id=excluded.campaign_id,status=excluded.status,quantity=excluded.quantity,amount=excluded.amount,cost=excluded.cost,discount=excluded.discount",
      );
      for (const r of prepared) {
        if (r.cancel) {
          if (!r.prior) continue;
          db.prepare("INSERT OR IGNORE INTO mg_cancelled VALUES(?,?,?)").run(
            a.company_id,
            source,
            r.external,
          );
          db.prepare("DELETE FROM mg_sales WHERE id=? AND company_id=?").run(
            r.prior.id,
            a.company_id,
          );
          cancelled++;
          continue;
        }
        db.prepare(
          "DELETE FROM mg_cancelled WHERE company_id=? AND source=? AND external_id=?",
        ).run(a.company_id, source, r.external);
        stmt.run(
          r.id,
          a.company_id,
          source,
          r.external,
          r.receipt,
          r.date,
          r.loc,
          r.emp,
          r.prod,
          r.cust,
          r.campaign,
          r.status,
          r.quantity,
          r.amount,
          r.cost,
          r.discount,
        );
        db.prepare("INSERT INTO mg_sales_updated VALUES(?,?) ON CONFLICT(sale_id) DO UPDATE SET updated_at=excluded.updated_at").run(r.id,new Date().toISOString());
        r.prior ? updated++ : inserted++;
      }
      const at = new Date().toISOString();
      db.prepare("INSERT INTO mg_sync_log VALUES(?,?,?,?,?,?,?,?)").run(
        randomUUID(),
        a.company_id,
        a.key_id || null,
        source,
        at,
        inserted,
        updated,
        cancelled,
      );
      if (a.key_id)
        db.prepare("UPDATE mg_keys SET last_success=? WHERE id=?").run(
          at,
          a.key_id,
        );
      audit(a, "import", source);
      return { inserted, updated, cancelled };
    });
  }
  function catalog(a, input) {
    if (a.role !== "integration") requireAction(a, "integrations");
    const source = text(input.source, 80),
      data = input.entities;
    if (!data || Array.isArray(data) || typeof data !== "object")
      fail("Укажите entities.");
    const kinds = ["locations", "employees", "products", "customers"];
    if (Object.keys(data).some((k) => !kinds.includes(k)))
      fail("Неизвестный справочник.");
    if (
      Object.values(data).some((v) => !Array.isArray(v)) ||
      Object.values(data).reduce((n, v) => n + v.length, 0) > 1000
    )
      fail("Максимум 1000 объектов.");
    return transaction(db, () => {
      const result = {};
      for (const kind of kinds) {
        result[kind] = [];
        const seen = new Set();
        for (const item of data[kind] || []) {
          const ext = text(item.external_id, 160);
          if (seen.has(ext)) fail("Повторный ID справочника.");
          seen.add(ext);
          const old = db
            .prepare(
              "SELECT entity_id FROM mg_catalog_ids WHERE company_id=? AND source=? AND kind=? AND external_id=?",
            )
            .get(a.company_id, source, kind, ext);
          const record = { ...item, id: old?.entity_id };
          delete record.external_id;
          if (kind === "employees" && item.location_refs) {
            if (!Array.isArray(item.location_refs))
              fail("Некорректные точки сотрудника.");
            record.location_ids = item.location_refs.map((x) => {
              const r = db
                .prepare(
                  "SELECT entity_id FROM mg_catalog_ids WHERE company_id=? AND source=? AND kind='locations' AND external_id=?",
                )
                .get(a.company_id, source, text(x));
              if (!r) fail("Неизвестная точка сотрудника.");
              return r.entity_id;
            });
          }
          const saved = saveRecord({ ...a, role: "owner" }, kind, record);
          db.prepare(
            "INSERT INTO mg_catalog_ids VALUES(?,?,?,?,?) ON CONFLICT(company_id,source,kind,external_id) DO UPDATE SET entity_id=excluded.entity_id",
          ).run(a.company_id, source, kind, ext, saved.id);
          result[kind].push({ external_id: ext, id: saved.id });
        }
      }
      return result;
    });
  }
  function member(a, input) {
    requireAction(a, "members");
    const current = db
      .prepare("SELECT * FROM mg_members WHERE company_id=? AND user_id=?")
      .get(a.company_id, text(input.user_id));
    if (!current) fail("Участник не найден.", 404);
    if (
      current.role === "owner" ||
      current.user_id === a.user_id ||
      (a.role === "director" && ["director", "deputy"].includes(current.role))
    )
      fail("Нельзя изменить этот доступ.", 403);
    if (input.remove === true) {
      db.prepare("DELETE FROM mg_members WHERE company_id=? AND user_id=?").run(
        a.company_id,
        current.user_id,
      );
      audit(a, "remove:member", current.user_id);
      return { ok: true };
    }
    if (
      !ROLES[input.role] ||
      input.role === "owner" ||
      (a.role === "director" && ["director", "deputy"].includes(input.role))
    )
      fail("Нельзя выдать эту роль.", 403);
    const loc = locations(a, input.location_ids || []),
      employee = ref("employees", a.company_id, input.employee_id);
    if (["manager", "employee"].includes(input.role) && !loc.length)
      fail("Назначьте точки.");
    if (input.role === "employee" && !employee) fail("Назначьте сотрудника.");
    if (
      employee &&
      loc.some(
        (id) =>
          !JSON.parse(
            get("employees", a.company_id, employee).locations_json,
          ).includes(id),
      )
    )
      fail("Сотрудник не относится к точке.");
    db.prepare(
      "UPDATE mg_members SET role=?,scope_json=?,employee_id=? WHERE company_id=? AND user_id=?",
    ).run(
      input.role,
      JSON.stringify(loc),
      employee,
      a.company_id,
      current.user_id,
    );
    audit(a, "update:member", current.user_id);
    return { ok: true };
  }
  function salesReport(a, filters = {}) {
    const from = day(filters.from || today().slice(0, 7) + "-01"),
      to = day(filters.to || today()),
      span = days(from, to),
      shift = (d, n) =>
        new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
    const current = rows(a, filters),
      previous = rows(a, {
        ...filters,
        from: shift(from, -span),
        to: shift(from, -1),
      });
    const baseFilters = { ...filters, category: null, product_id: null };
    const baselineCurrent =
      filters.category || filters.product_id ? rows(a, baseFilters) : current;
    const baselinePrevious =
      filters.category || filters.product_id
        ? rows(a, {
            ...baseFilters,
            from: shift(from, -span),
            to: shift(from, -1),
          })
        : previous;
    const records = productRecords(a),
      byId = new Map(records.map((p) => [p.id, p]));
    for (const row of [...current, ...previous])
      row.product_codes = byId.get(row.product_id)?.external_ids || [];
    const report = buildSalesReport(current, previous, {
      aggregate,
      group: ["product", "location"].includes(filters.group)
        ? filters.group
        : "category",
      layout: filters.layout,
      page: filters.page,
      pageSize: filters.page_size,
      query: text(filters.q, 160, false),
      sort: filters.sort,
      baselineCurrent,
      baselinePrevious,
    });
    return {
      ...report,
      trend: buildTrend(current, { from, to, aggregate, asOf: today() }),
      period: {
        from,
        to,
        previous_from: shift(from, -span),
        previous_to: shift(from, -1),
      },
      selection: {
        location_id: filters.location_id || null,
        category: filters.category || null,
        product_id: filters.product_id || null,
      },
    };
  }
  function snapshot(a, filters = {}) {
    const rs = rows(a, filters),
      totals = aggregate(rs);
    const rangeFrom = filters.from || today().slice(0, 7) + "-01",
      rangeTo = filters.to || today(),
      length = days(rangeFrom, rangeTo),
      shift = (d, n) =>
        new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
    const previousRows = rows(a, {
        ...filters,
        from: shift(rangeFrom, -length),
        to: shift(rangeFrom, -1),
      }),
      previous = aggregate(previousRows),
      factors = factorComparison(
        previous,
        totals,
        previousRows.length > 0 && rs.length > 0,
      );
    const locs = list("locations", a.company_id).filter(
      (l) =>
        (!a.scope.length && !["manager", "employee"].includes(a.role)) ||
        a.scope.includes(l.id),
    );
    const employees = list("employees", a.company_id).filter((e) =>
      a.role === "employee"
        ? e.id === a.employee_id
        : (!a.scope.length && a.role !== "manager") ||
          JSON.parse(e.locations_json).some((id) => a.scope.includes(id)),
    );
    const scoped =
      Boolean(a.scope.length) || ["manager", "employee"].includes(a.role);
    const visiblePlanRecords = list("plans", a.company_id)
      .filter(
        (p) =>
          (!scoped || (p.location_id && a.scope.includes(p.location_id))) &&
          (a.role !== "employee" || p.employee_id === a.employee_id) &&
          (!filters.location_id || p.location_id === filters.location_id),
      );
    const chartPlanId=visiblePlanRecords.some(p=>p.id===filters.plan_chart_id)?filters.plan_chart_id:visiblePlanRecords[0]?.id;
    const plans=visiblePlanRecords.map((p) => {
        const asof =
            (filters.to || today()) > today() ? today() : filters.to || today(),
          cut = asof < p.end_on ? asof : p.end_on,
          elapsed = cut < p.start_on ? 0 : days(p.start_on, cut),
          totalDays = days(p.start_on, p.end_on);
        const opts=kpi.options(a,p.id), defs=kpi.definitions(a), def=defs[p.metric];
        const selectedRows=def ? (elapsed?kpi.customRows(a,{...p,options:{...opts,source:opts.source||def.source}},cut):[]) : (elapsed?rows(a,{from:p.start_on,to:cut,location_id:p.location_id,employee_id:p.employee_id,category:p.category,product_id:p.product_id}).filter(r=>!opts.source||r.source===opts.source):[]);
        const health=kpi.health(a,p,opts.source||def?.source);
        const dataThrough=selectedRows.reduce((d,r)=>(r.date||r.sold_on)>d?(r.date||r.sold_on):d,health?.through_date||'');
        const coverage=dataThrough>=cut;
        const actual=def?kpi.aggregateCustom(def,selectedRows):selectedRows.length?aggregate(selectedRows)[p.metric]:health?.through_date>=cut&&['sales','receipts','profit'].includes(p.metric)?0:null;
        const additive=def ? def.aggregation==='sum' : ['sales','receipts','quantity','profit'].includes(p.metric);
        const evaluated=evaluateKpi(p,actual,asof,additive,opts);
        let cumulative=0;
        const step=Math.max(1,Math.ceil(evaluated.timeline.length/40));
        const includeChart=p.id===chartPlanId;
        const timeline=includeChart?evaluated.timeline.map((d,i)=>{cumulative+=d.weight;return {...d,plan:additive?p.target*cumulative/evaluated.total_weight:p.target,upper:p.direction==='range'?(additive?opts.upper*cumulative/evaluated.total_weight:opts.upper):null,index:i};}).filter((d,i,ds)=>i%step===0||i===ds.length-1||d.date===cut).map(d=>({...d,actual:d.date>cut?null:def?kpi.aggregateCustom(def,selectedRows.filter(r=>r.date<=d.date)):aggregate(selectedRows.filter(r=>r.sold_on<=d.date))[p.metric]})):[];
        // Bars compare each displayed interval, while lines retain cumulative progress.
        for (const [i, point] of timeline.entries()) {
          const previous = timeline[i-1];
          const from = previous ? shift(previous.date,1) : p.start_on;
          const periodRows = selectedRows.filter(r => (r.date||r.sold_on)>=from && (r.date||r.sold_on)<=point.date);
          const periodActual = point.date>cut ? null : def
            ? kpi.aggregateCustom(def,def.aggregation==='latest'?selectedRows.filter(r=>r.date<=point.date):periodRows)
            : periodRows.length ? aggregate(periodRows)[p.metric]
            : health?.through_date>=point.date&&['sales','receipts','profit'].includes(p.metric)?0:null;
          point.interval={from,to:point.date,actual:periodActual,
            plan:additive?point.plan-(previous?.plan||0):point.plan,
            upper:p.direction==='range'?(additive?point.upper-(previous?.upper||0):point.upper):null};
        }
        const lastUpdate=def?selectedRows.reduce((last,r)=>r.updated_at>last?r.updated_at:last,''):selectedRows.reduce((last,r)=>{const at=r.updated_at||'';return at>last?at:last;},'');
        return {...p,...evaluated,timeline,as_of:cut,data_through:dataThrough||null,coverage_confirmed:coverage,last_update:[lastUpdate,health?.updated_at||''].sort().at(-1)||null,elapsed_days:elapsed,total_days:totalDays};
      });
    const contacts =
      can(a, "clients") && !scoped
        ? list("customers", a.company_id).map((r) => ({
            ...r,
            ...Object.fromEntries(
              ["external_ids", "tags", "loyalty", "consents"].map((k) => [
                k,
                JSON.parse(r[k + "_json"]),
              ]),
            ),
            ...customerFacts(r.id, rs),
          }))
        : [];
    const campaigns =
      a.role === "employee"
        ? []
        : list("campaigns", a.company_id)
            .filter((cp) => {
              try {
                checkCampaign(a, cp);
                return true;
              } catch {
                return false;
              }
            })
            .map((cp) => {
              const selected = rs.filter((r) => r.campaign_id === cp.id),
                facts = aggregate(selected),
                full =
                  (filters.from || today().slice(0, 7) + "-01") <=
                    cp.start_on &&
                  (filters.to || today()) >= cp.end_on &&
                  today() >= cp.end_on &&
                  !filters.location_id;
              return {
                ...cp,
                location_ids: JSON.parse(cp.locations_json),
                product_ids: JSON.parse(cp.products_json),
                results: facts,
                spend_comparable: full,
                result_after_spend:
                  full && facts.profit !== null
                    ? facts.profit - cp.spend
                    : null,
              };
            });
    return {
      actor: {
        user_id: a.user_id,
        name: a.name,
        role: a.role,
        scope: a.scope,
        company_name: a.company_name,
      },
      permissions: Object.fromEntries(
        Object.keys(writeRoles).map((k) => [k, can(a, k)]),
      ),
      metrics: {...METRICS,...kpi.definitions(a)},
      kpi_definitions:kpi.records(a),
      kpi_values: kpi.visibleValues(a),
      notifications:(!filters.to||filters.to===today())?kpi.notifications(a,plans):[],
      totals,
      comparison: {
        from: shift(rangeFrom, -length),
        to: shift(rangeFrom, -1),
        previous,
        factors,
      },
      locations: locs,
      employees: employees.map((e) => ({
        ...e,
        location_ids: JSON.parse(e.locations_json),
      })),
      products: productRecords(a),
      customers: contacts,
      plans,
      campaigns,
      by_location: group(rs, "location_id", "location_name"),
      by_employee: group(rs, "employee_id", "employee_name"),
      by_category: group(rs, "category", "category"),
      by_product: group(rs, "product_id", "product_name"),
      trend: buildTrend(rs, {
        from: rangeFrom,
        to: rangeTo,
        aggregate,
        asOf: today(),
      }).points,
      trend_meta: {
        from: rangeFrom,
        to: rangeTo,
        granularity:
          days(rangeFrom, rangeTo) <= 45
            ? "day"
            : days(rangeFrom, rangeTo) <= 180
              ? "week"
              : "month",
      },
      keys: can(a, "integrations")
        ? list("keys", a.company_id).map(({ token_hash, ...k }) => k)
        : [],
      sync_log: can(a, "integrations")
        ? list("sync_log", a.company_id).slice(0, 30)
        : [],
      members: can(a, "members")
        ? db
            .prepare(
              "SELECT m.user_id,m.role,m.scope_json,m.employee_id,u.name,u.email FROM mg_members m JOIN mg_users u ON u.id=m.user_id WHERE m.company_id=?",
            )
            .all(a.company_id)
        : [],
    };
  }
  function revoke(a, id) {
    requireAction(a, "integrations");
    if (!get("keys", a.company_id, id)) fail("Ключ не найден.", 404);
    db.prepare("UPDATE mg_keys SET revoked=1 WHERE id=? AND company_id=?").run(
      id,
      a.company_id,
    );
    audit(a, "revoke:key", id);
    return { ok: true };
  }
  const locationsForCopy=(a,ids)=>locations(a,ids);
  return {
    owner,
    login,
    actor,
    save,
    plan,
    defineKpi:kpi.definition,
    importKpi:kpi.values,
    heartbeat:kpi.heartbeat,
    planHistory:(a,id)=>kpi.history(a,id,snapshot(a).plans),
    acknowledge:(a,id)=>kpi.acknowledge(a,id,kpi.notifications(a,snapshot(a).plans)),
    copyPlans:(a,input)=>transaction(db,()=>{
      if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100) fail("Выберите от 1 до 100 планов.");
      const visible=snapshot(a).plans;
      const targetStart=day(input.start_on), targetEnd=day(input.end_on);
      const locations=input.location_ids?.length?locationsForCopy(a,input.location_ids):[null];
      if(input.ids.length*locations.length>500) fail("За один раз можно создать до 500 планов.");
      const saved=[];
      for(const id of [...new Set(input.ids)]) {
        const old=visible.find(p=>p.id===id);if(!old) fail("План недоступен.",403);
        const offset=Math.round((Date.parse(targetStart)-Date.parse(old.start_on))/86400000);
        const dates=Object.fromEntries(Object.entries(old.options.dates).map(([d,w])=>[shift(d,offset),w]).filter(([d])=>d>=targetStart&&d<=targetEnd));
        for(const location of locations) saved.push(plan(a,{...old,id:undefined,start_on:targetStart,end_on:targetEnd,location_id:location||old.location_id,options:{...old.options,dates}}).id);
      }
      return {ids:saved};
    }),
    invite,
    accept,
    key,
    integration,
    importSales,
    catalog,
    member,
    snapshot,
    products,
    salesReport,
    revoke,
    logout: (token) =>
      db.prepare("DELETE FROM mg_sessions WHERE token_hash=?").run(hash(token)),
  };
}
export function aggregate(rs) {
  const active = rs.filter((r) => r.status === "sale"),
    refunds = rs.filter((r) => r.status === "refund");
  const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
  const gross = sum(active, "amount"),
    returned = sum(refunds, "amount"),
    sales = gross - returned;
  const receiptKey = (r) =>
    [r.source, r.location_id, r.sold_on, r.receipt_id].join("\0");
  const receipts = new Set(active.map(receiptKey)).size;
  const units = [...new Set(rs.map((r) => r.unit))];
  const quantity =
    units.length === 1
      ? sum(active, "quantity") - sum(refunds, "quantity")
      : null;
  const costComplete = rs.length > 0 && rs.every((r) => r.cost !== null);
  const profit = costComplete
    ? sales - (sum(active, "cost") - sum(refunds, "cost"))
    : null;
  return {
    sales,
    receipts,
    average: receipts ? sales / receipts : null,
    quantity,
    basket: quantity !== null && receipts ? quantity / receipts : null,
    profit,
    margin: profit !== null && sales > 0 ? (profit / sales) * 100 : null,
    refund_rate: gross > 0 ? (returned / gross) * 100 : null,
    gross_sales: gross,
    sold_quantity: units.length === 1 ? sum(active, "quantity") : null,
    returned_quantity: units.length === 1 ? sum(refunds, "quantity") : null,
    unit_price:
      units.length === 1 && sum(active, "quantity") > 0
        ? gross / sum(active, "quantity")
        : null,
    cost: costComplete ? sum(active, "cost") - sum(refunds, "cost") : null,
    profit_per_unit: profit !== null && quantity > 0 ? profit / quantity : null,
    discount_rate:
      gross + sum(active, "discount") > 0
        ? (sum(active, "discount") / (gross + sum(active, "discount"))) * 100
        : null,
    refunds: returned,
    discount: sum(active, "discount") - sum(refunds, "discount"),
    cost_complete: costComplete,
    unit: units.length === 1 ? units[0] : null,
    customers: new Set(active.map((r) => r.customer_id).filter(Boolean)).size,
  };
}
function group(rs, key, label) {
  const groups = new Map();
  for (const r of rs) {
    const id = r[key] || "unassigned";
    if (!groups.has(id))
      groups.set(id, { id, name: r[label] || "Не назначен", rows: [] });
    groups.get(id).rows.push(r);
  }
  return [...groups.values()]
    .map((g) => ({ id: g.id, name: g.name, ...aggregate(g.rows) }))
    .sort((a, b) => b.sales - a.sales);
}
function customerFacts(id, rs) {
  const own = rs.filter((r) => r.customer_id === id);
  return {
    results: aggregate(own),
    last_purchase:
      own
        .filter((r) => r.status === "sale")
        .map((r) => r.sold_on)
        .sort()
        .at(-1) || null,
  };
}

export function factorComparison(before, after, available = true) {
  if (!available || !before.receipts || !after.receipts) return null;
  const n0 = before.receipts,
    n1 = after.receipts,
    a0 = before.average,
    a1 = after.average;
  const basic = [
    { name: "Количество чеков", contribution: ((n1 - n0) * (a0 + a1)) / 2 },
    { name: "Средний чек", contribution: ((a1 - a0) * (n0 + n1)) / 2 },
  ];
  if (
    before.quantity === null ||
    after.quantity === null ||
    before.unit !== after.unit ||
    before.quantity <= 0 ||
    after.quantity <= 0
  )
    return basic;
  const x = [n0, before.quantity / n0, before.sales / before.quantity],
    y = [n1, after.quantity / n1, after.sales / after.quantity],
    contributions = [0, 0, 0],
    permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
  for (const order of permutations) {
    const current = [...x];
    for (const i of order) {
      const was = current.reduce((a, b) => a * b, 1);
      current[i] = y[i];
      contributions[i] += (current.reduce((a, b) => a * b, 1) - was) / 6;
    }
  }
  return [
    "Количество чеков",
    "Единиц на чек",
    "Средняя цена единицы и состав покупок",
  ].map((name, i) => ({ name, contribution: contributions[i] }));
}
