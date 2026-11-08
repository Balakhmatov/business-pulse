// Optional browser checks. Install Playwright; BPM_PLAYWRIGHT_MODULE/BPM_CHROMIUM_PATH can select an existing runtime.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { openStore, createService, today } from "./core.mjs";
import { createApp } from "./server.mjs";
const { chromium } = await import(
  process.env.BPM_PLAYWRIGHT_MODULE || "playwright"
);
const db = openStore(),
  s = createService(db),
  port = 3138,
  origin = "http://127.0.0.1:" + port;
const owner = s.owner({
    company: "Проверка интерфейса",
    name: "Владелец",
    email: "owner@example.test",
    password: "test-password-12345",
  }),
  a = { ...owner, role: "owner", scope: [] };
const location = s.save(a, "locations", { name: "Первая точка" }).id,
  product = s.save(a, "products", {
    name: "Тестовый товар",
    category: "Уход",
    unit: "шт.",
  }).id;
const basePath = process.env.BPM_BASE_PATH || "";
const root = origin + basePath;
const app = createApp({ db, origin, basePath });
app.listen(port, "127.0.0.1");
await once(app, "listening");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BPM_CHROMIUM_PATH
    ? {
        executablePath: process.env.BPM_CHROMIUM_PATH,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--no-zygote",
          "--single-process",
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--in-process-gpu",
        ],
      }
    : {}),
});
try {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(10000);
  console.log("Browser started");
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("401"))
      errors.push(m.text());
  });
  await page.goto(root + "/");
  await page.getByRole("button", { name: "Посмотреть пример" }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  for (const name of [
    "Планы и KPI",
    "Продажи",
    "Ассортимент",
    "Точки и команда",
    "Клиенты",
    "Маркетинг",
    "Данные и интеграции",
    "Обзор бизнеса",
  ]) {
    await page
      .locator("#nav")
      .getByRole("button", { name, exact: true })
      .click();
    await page.locator("#content .panel").first().waitFor();
  }
  await page
    .locator("#nav")
    .getByRole("button", { name: "Продажи", exact: true })
    .click();
  await page.locator("#sales-search-form").waitFor();
  await page.locator('[data-group="by_location"]').click();
  const locationButton = page
    .locator('#content [data-sales-location][data-sales-drill="by_category"]')
    .first();
  await locationButton.waitFor();
  const selectedLocation = await locationButton.getAttribute(
    "data-sales-location",
  );
  await locationButton.click();
  await page.waitForFunction(
    (id) => document.querySelector("#sales-point")?.value === id,
    selectedLocation,
  );
  const categoryButton = page.locator("[data-sales-category]").first();
  await categoryButton.waitFor();
  const selectedCategory = await categoryButton.getAttribute(
    "data-sales-category",
  );
  await categoryButton.click();
  await page.waitForFunction(
    (value) => document.querySelector("#sales-category")?.value === value,
    selectedCategory,
  );
  const productButton = page.locator("[data-sales-product]").first();
  await productButton.waitFor();
  await productButton.click();
  await page.waitForFunction(
    () => document.querySelector("#sales-point")?.value === "",
  );
  await page.locator('[data-sales-preset="prices"]').click();
  await page
    .getByRole("columnheader", { name: "Средняя цена, ₽", exact: true })
    .waitFor();
  await page.screenshot({
    path: "/tmp/business-pulse-sales-details-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "sales mobile overflow",
  );
  await page.screenshot({
    path: "/tmp/business-pulse-sales-details-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator("#nav")
    .getByRole("button", { name: "Ассортимент", exact: true })
    .click();
  await page.locator("[name=catalog_q]").waitFor();
  await page.locator("[name=catalog_q]").fill("Шампунь");
  await page
    .locator("#catalog-search-form")
    .getByRole("button", { name: "Найти", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#content tbody tr").length === 1 &&
      !document.body.classList.contains("loading"),
  );
  await page.getByRole("cell", { name: "Уход", exact: true }).waitFor();
  assert.equal(await page.locator("#content tbody tr").count(), 1);
  await page
    .locator("#nav")
    .getByRole("button", { name: "Обзор бизнеса", exact: true })
    .click();
  console.log("Sales drilldown, presets, assortment search and mobile passed");
  await page.screenshot({
    path: "/tmp/business-pulse-management-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "mobile overflow",
  );
  await page.screenshot({
    path: "/tmp/business-pulse-management-mobile.png",
    fullPage: true,
  });
  console.log("Demo/mobile passed");
  await page.locator("#exit-workspace").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#login input[name=email]").fill("owner@example.test");
  await page.locator("#login input[name=password]").fill("test-password-12345");
  await page.locator("#login button").click();
  await page
    .getByRole("heading", { name: "Обзор бизнеса", exact: true })
    .waitFor();
  await page
    .locator("#nav")
    .getByRole("button", { name: "Точки и команда", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить точку", exact: true })
    .click();
  await page.locator("#editor input[name=name]").fill("Новая точка");
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(s.snapshot(a).locations.length, 2);
  console.log("Login and location passed");
  await page
    .locator("#nav")
    .getByRole("button", { name: "Планы и KPI", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить план", exact: true })
    .click();
  await page.locator("#editor input[name=target]").fill("50000");
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(s.snapshot(a).plans[0].target, 5000000);
  await page
    .locator("#nav")
    .getByRole("button", { name: "Клиенты", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить клиента", exact: true })
    .click();
  await page.locator("#editor input[name=name]").fill("Тестовый клиент");
  await page.locator("#editor input[name=phone]").fill("+79991234567");
  await page.locator("#editor input[name=balance]").fill("200");
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(s.snapshot(a).customers[0].loyalty.balance, 200);
  console.log("Plans/customer passed");
  await page
    .locator("#nav")
    .getByRole("button", { name: "Данные и интеграции", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Загрузить файл", exact: true })
    .click();
  const csv = `external_id;receipt_id;date;location_id;product_id;quantity;amount_kopecks;cost_kopecks\nline-ui;receipt-ui;${today()};${location};${product};2;100000;60000\n`;
  await page.locator("#editor input[type=file]").setInputFiles({
    name: "sales.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.locator("[name=money_unit]").waitFor();
  await page.locator("[name=money_unit]").selectOption("kopecks");
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(s.snapshot(a).totals.sales, 100000);
  console.log("CSV passed");
  await page
    .locator("#nav")
    .getByRole("button", { name: "Ассортимент", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Редактировать", exact: true })
    .first()
    .click();
  await page.locator("#editor input[name=sku]").fill("ART-UI-001");
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(s.products(a, { q: "ART-UI-001" }).total, 1);
  await page.locator("[name=catalog_q]").fill("ART-UI-001");
  await page
    .locator("#catalog-search-form")
    .getByRole("button", { name: "Найти", exact: true })
    .click();
  await page.getByRole("cell", { name: "ART-UI-001", exact: true }).waitFor();

  // Exercise CSV quoting and the XLSX date decoder in the real browser.
  const parser = await page.evaluate(async () => {
    const { parseCSV } = await import(
      new URL("./import.js", window.location.href).href
    );
    return parseCSV('a;b\n"x;y";"hello ""there"""\n');
  });
  assert.deepEqual(parser, [
    ["a", "b"],
    ["x;y", 'hello "there"'],
  ]);
  console.log("Parsing passed");
  if (process.env.BPM_XLSX_FIXTURE) {
    const bytes = fs.readFileSync(process.env.BPM_XLSX_FIXTURE);
    const workbook = await page.evaluate(async (data) => {
      const { readFile } = await import(
        new URL("./import.js", window.location.href).href
      );
      return readFile(new File([new Uint8Array(data)], "fixture.xlsx"));
    }, Array.from(bytes));
    assert.equal(workbook.sheets.length, 2);
    assert.equal(workbook.sheets[0].rows[1][0], "2026-11-08");
  }
  await page
    .locator("#nav")
    .getByRole("button", { name: "Обзор бизнеса", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Получить разбор", exact: true })
    .click();
  await page.locator("#insights-output .badge").waitFor();
  console.log("Insights passed");
  await page.locator("#workspace-demo").click();
  await page.getByText("Демонстрационные данные", { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "Обзор бизнеса", exact: true })
    .waitFor();
  assert.ok(
    await page
      .locator("#content")
      .textContent()
      .then((t) => t.includes("Новая точка")),
  );
  assert.equal(s.snapshot(a).totals.sales, 100000);
  await page.locator("#workspace-demo").click();
  await page.getByText("Рабочая компания", { exact: true }).waitFor();
  console.log("Configured demo and return passed");
  // Invite and use the same editor afterwards: acceptance must not retain a stale submit handler.
  const invite = s.invite(a, {
    email: "manager@example.test",
    role: "manager",
    location_ids: [location],
  });
  await page.locator("#logout").click();
  await page.goto(root + "/#invite=" + invite.token);
  await page.locator("#dialog").waitFor();
  await page.locator("#editor input[name=name]").fill("Управляющий");
  await page.locator("#editor input[name=password]").fill("manager-test-12345");
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#login input[name=password]").fill("manager-test-12345");
  await page.locator("#login button").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  assert.equal(await page.locator("#location option").count(), 2);
  assert.equal(
    await page
      .locator("#nav")
      .getByRole("button", { name: "Клиенты", exact: true })
      .count(),
    0,
  );
  await page
    .locator("#nav")
    .getByRole("button", { name: "Планы и KPI", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить план", exact: true })
    .click();
  await page.locator("#editor input[name=target]").fill("1000");
  await page.locator("#editor select[name=location_id]").selectOption(location);
  await page.locator("#save-dialog").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: desktop/mobile, navigation, CRUD, CSV, insights, invitation, scoped role.",
  );
} finally {
  await browser.close();
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  db.close();
}
