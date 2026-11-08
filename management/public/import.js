// Local file parsing: no workbook bytes are sent to a third party.
export function parseCSV(input) {
  const s = input.replace(/^\uFEFF/, "");
  const first = s.split(/\r?\n/, 1)[0],
    sep =
      (first.match(/;/g) || []).length > (first.match(/,/g) || []).length
        ? ";"
        : ",";
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (quoted && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell)
        throw Error("Кавычка внутри неэкранированного поля.");
      else quoted = !quoted;
    } else if (c === sep && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("Незакрытая кавычка в CSV.");
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
async function unzip(buffer) {
  const bytes = new Uint8Array(buffer),
    v = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error("Не удалось прочитать архив XLSX.");
  const count = v.getUint16(end + 10, true);
  if (count > 2000) throw Error("Слишком сложный XLSX.");
  let cursor = v.getUint32(end + 16, true),
    total = 0;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(cursor, true) !== 0x02014b50)
      throw Error("Повреждён XLSX.");
    const method = v.getUint16(cursor + 10, true),
      compressed = v.getUint32(cursor + 20, true),
      size = v.getUint32(cursor + 24, true),
      nl = v.getUint16(cursor + 28, true),
      extra = v.getUint16(cursor + 30, true),
      comment = v.getUint16(cursor + 32, true),
      offset = v.getUint32(cursor + 42, true),
      name = new TextDecoder().decode(
        bytes.slice(cursor + 46, cursor + 46 + nl),
      );
    if (v.getUint16(cursor + 8, true) & 1)
      throw Error("Зашифрованный XLSX не поддерживается.");
    total += size;
    if (total > 64 * 1024 * 1024 || size > 24 * 1024 * 1024)
      throw Error("Распакованный XLSX слишком большой.");
    entries.set(name, { method, compressed, size, offset });
    cursor += 46 + nl + extra + comment;
  }
  return async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const n = v.getUint16(e.offset + 26, true),
      x = v.getUint16(e.offset + 28, true),
      raw = bytes.slice(
        e.offset + 30 + n + x,
        e.offset + 30 + n + x + e.compressed,
      );
    let output;
    if (e.method === 0) output = raw;
    else if (e.method === 8) {
      const reader = new Blob([raw])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .getReader();
      const chunks = [];
      let length = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        length += r.value.length;
        if (length > e.size || length > 24 * 1024 * 1024) {
          await reader.cancel();
          throw Error("Некорректный размер XLSX.");
        }
        chunks.push(r.value);
      }
      output = new Uint8Array(length);
      let pos = 0;
      for (const c of chunks) {
        output.set(c, pos);
        pos += c.length;
      }
    } else throw Error("Этот способ сжатия XLSX не поддерживается.");
    if (output.length !== e.size) throw Error("Повреждён XLSX.");
    return new TextDecoder().decode(output);
  };
}
const xml = (s) => {
  if (!s || /<!DOCTYPE|<!ENTITY/i.test(s))
    throw Error("Некорректный XML в XLSX.");
  const d = new DOMParser().parseFromString(s, "application/xml");
  if (d.querySelector("parsererror")) throw Error("Повреждён XML в XLSX.");
  return d;
};
export async function readFile(file) {
  if (file.size > 16 * 1024 * 1024)
    throw Error("Максимальный размер файла — 16 МБ.");
  if (/\.csv$/i.test(file.name)) {
    let raw = await file.arrayBuffer(),
      s = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    if (s.includes("\uFFFD")) s = new TextDecoder("windows-1251").decode(raw);
    return { sheets: [{ name: file.name, rows: parseCSV(s) }] };
  }
  if (!/\.xlsx$/i.test(file.name)) throw Error("Выберите JSON, CSV или XLSX.");
  const get = await unzip(await file.arrayBuffer()),
    wb = xml(await get("xl/workbook.xml")),
    rels = xml(await get("xl/_rels/workbook.xml.rels"));
  const targets = new Map(
    [...rels.getElementsByTagName("Relationship")].map((r) => [
      r.getAttribute("Id"),
      r.getAttribute("Target"),
    ]),
  );
  const shared = await get("xl/sharedStrings.xml"),
    strings = shared
      ? [...xml(shared).getElementsByTagName("si")].map((e) =>
          [...e.getElementsByTagName("t")].map((t) => t.textContent).join(""),
        )
      : [];
  const styles = await get("xl/styles.xml"),
    dateStyles = new Set();
  if (styles) {
    const doc = xml(styles),
      custom = new Map(
        [...doc.getElementsByTagName("numFmt")].map((x) => [
          Number(x.getAttribute("numFmtId")),
          x.getAttribute("formatCode"),
        ]),
      );
    const xfs = doc.getElementsByTagName("cellXfs")[0];
    [...(xfs?.children || [])].forEach((x, i) => {
      const id = Number(x.getAttribute("numFmtId")),
        fmt = (custom.get(id) || "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[yd]/i.test(fmt))
        dateStyles.add(i);
    });
  }
  const sheets = [];
  const date1904 =
    wb.getElementsByTagName("workbookPr")[0]?.getAttribute("date1904") === "1";
  for (const sheet of [...wb.getElementsByTagName("sheet")]) {
    if (sheets.length >= 20) throw Error("В файле больше 20 листов.");
    const target = targets.get(sheet.getAttribute("r:id"));
    if (!target) continue;
    const name = target.startsWith("/")
      ? target.slice(1)
      : "xl/" + target.replace(/^\.\//, "");
    if (name.includes("..")) throw Error("Некорректный путь листа.");
    const data = await get(name);
    if (!data) continue;
    const doc = xml(data),
      rows = [];
    for (const row of [...doc.getElementsByTagName("row")]) {
      const cells = [];
      for (const cell of [...row.getElementsByTagName("c")]) {
        const address = cell.getAttribute("r") || "",
          letters = address.match(/^[A-Z]+/)?.[0];
        if (!letters) continue;
        let col = 0;
        for (const l of letters) col = col * 26 + l.charCodeAt(0) - 64;
        col--;
        if (col > 200) throw Error("В файле больше 200 столбцов.");
        const type = cell.getAttribute("t"),
          value = cell.getElementsByTagName("v")[0]?.textContent || "";
        let result =
          type === "s"
            ? strings[Number(value)] || ""
            : type === "inlineStr"
              ? [...cell.getElementsByTagName("t")]
                  .map((t) => t.textContent)
                  .join("")
              : value;
        if (
          type !== "s" &&
          type !== "inlineStr" &&
          dateStyles.has(Number(cell.getAttribute("s"))) &&
          value !== "" &&
          Number.isFinite(Number(value))
        ) {
          const ms = (Number(value) - (date1904 ? 24107 : 25569)) * 86400000;
          result = new Date(ms).toISOString().slice(0, 10);
        }
        cells[col] = result;
      }
      if (cells.some((x) => String(x || "").trim()))
        rows.push(
          Array.from({ length: cells.length }, (_, i) => cells[i] || ""),
        );
      if (rows.length > 5001) throw Error("Максимум 5000 строк на лист.");
    }
    sheets.push({ name: sheet.getAttribute("name"), rows });
  }
  if (!sheets.length) throw Error("В файле нет доступных листов.");
  return { sheets };
}
export const fields = [
  ["external_id", "ID строки", /external_id|id строки|код строки/i],
  ["receipt_id", "ID чека", /receipt_id|номер чека|чек|номер заказа/i],
  ["date", "Дата", /^date$|дата/i],
  ["location_id", "Точка", /location_id|точка|филиал|подразделени/i],
  ["employee_id", "Сотрудник", /employee_id|сотрудник|продавец/i],
  ["product_id", "Товар", /product_id|товар|номенклатур|услуга/i],
  ["quantity", "Количество", /quantity|количество|кол-во/i],
  ["amount_kopecks", "Сумма продажи", /amount_kopecks|сумма|продажи|выручка/i],
  ["cost_kopecks", "Себестоимость", /cost_kopecks|себестоим/i],
  ["discount_kopecks", "Скидка", /discount_kopecks|скидка/i],
  ["status", "Статус", /status|статус|тип операции/i],
  ["customer_id", "Клиент", /customer_id|id клиента/i],
  ["campaign_id", "Кампания", /campaign_id|id акции|кампания/i],
];
export function tableToSales(
  matrix,
  mapping,
  { source, moneyUnit = "rubles", locationId = "", state },
) {
  if (!matrix.length || matrix.length > 5001)
    throw Error("Нужно от 1 до 5000 строк данных.");
  const headers = matrix[0],
    data = matrix.slice(1).filter((r) => r.some((v) => String(v).trim()));
  const resolve = (kind, value) => {
    if (!value) return null;
    const all = state[kind].filter((x) => x.id === value || x.name === value);
    if (all.length !== 1)
      throw Error(
        `Не удалось однозначно найти «${value}» в справочнике ${kind}.`,
      );
    return all[0].id;
  };
  const num = (v, optional = false) => {
    if (v === "") {
      if (optional) return null;
      throw Error("Не заполнено число.");
    }
    const s = String(v)
      .replace(/[\s\u00a0₽]/g, "")
      .replace(",", ".");
    if (!/^-?\d+(?:\.\d+)?$/.test(s)) throw Error("Некорректное число: " + v);
    return Number(s);
  };
  const money = (v, optional = false) => {
    const n = num(v, optional);
    if (n === null) return null;
    const scaled = n * (moneyUnit === "rubles" ? 100 : 1);
    if (Math.abs(scaled - Math.round(scaled)) > 0.00001)
      throw Error("Сумма содержит доли копейки.");
    return Math.round(scaled);
  };
  return {
    source,
    rows: data.map((r, i) => {
      try {
        const get = (k) =>
          mapping[k] === undefined || mapping[k] === ""
            ? ""
            : String(r[Number(mapping[k])] ?? "").trim();
        let d = get("date");
        const match = d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (match) d = `${match[3]}-${match[2]}-${match[1]}`;
        const status = get("status").toLowerCase();
        let st;
        if (
          !status ||
          ["sale", "продажа", "оплачено", "реализация"].includes(status)
        )
          st = "sale";
        else if (["refund", "возврат"].includes(status)) st = "refund";
        else if (["cancelled", "отмена", "отменено"].includes(status))
          st = "cancelled";
        else throw Error("Неизвестный статус: " + status);
        const ext = get("external_id");
        if (!ext) throw Error("Нужен стабильный ID строки.");
        if (st === "cancelled") return { external_id: ext, status: st };
        return {
          external_id: ext,
          receipt_id: get("receipt_id"),
          date: d,
          location_id: resolve("locations", get("location_id") || locationId),
          employee_id: resolve("employees", get("employee_id")),
          product_id: resolve("products", get("product_id")),
          customer_id: get("customer_id") || null,
          campaign_id: get("campaign_id") || null,
          status: st,
          quantity: num(get("quantity")),
          amount_kopecks: money(get("amount_kopecks")),
          cost_kopecks: money(get("cost_kopecks"), true),
          discount_kopecks: money(get("discount_kopecks") || "0"),
        };
      } catch (e) {
        throw Error(`Строка ${i + 2}: ${e.message}`);
      }
    }),
  };
}
