import fs from "node:fs";
import path from "node:path";
import { openStore, createService } from "./core.mjs";
const file =
  process.env.BPM_DB_FILE || "/var/lib/business-pulse-management/management.db";
if (path.basename(file) === "pulse.db" || file === process.env.BP_DB_FILE)
  throw Error("Use a separate management database.");
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const db = openStore(file);
try {
  createService(db).owner({
    company: process.env.BPM_COMPANY,
    name: process.env.BPM_OWNER_NAME,
    email: process.env.BPM_OWNER_EMAIL,
    password: process.env.BPM_OWNER_PASSWORD,
  });
  console.log("Владелец создан.");
} finally {
  db.close();
}
