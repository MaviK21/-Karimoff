import Database from "better-sqlite3";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = "C:/Users/MaviK23/-Karimoff";

const before = new Database("karimoff.db", { readonly: true });
const beforeTables = before
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map(r => r.name);
before.close();

console.log("таблиц до миграции:", beforeTables.length);
console.log("product_documents до:", beforeTables.includes("product_documents"));

// Прогон миграции (lib/db.js)
await import(pathToFileURL(path.join(workspace, "lib", "db.js")).href);

const after = new Database("karimoff.db", { readonly: true });

const schema = after
  .prepare("SELECT sql FROM sqlite_master WHERE name = 'product_documents'")
  .get();

console.log("");
console.log("SQL:", schema?.sql?.replace(/\s+/g, " "));
console.log("");
console.log(
  "колонки:",
  after
    .prepare("PRAGMA table_info(product_documents)")
    .all()
    .map(c => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value}`)
    .join(" | ")
);
console.log(
  "внешние ключи:",
  JSON.stringify(after.prepare("PRAGMA foreign_key_list(product_documents)").all())
);
console.log(
  "индексы:",
  after
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='product_documents'")
    .all()
);

const tables = after
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map(r => r.name);

console.log("");
console.log("таблиц после:", tables.length);
console.log("product_images и product_videos на месте:",
  tables.includes("product_images") && tables.includes("product_videos"));

after.close();

// Проверка записи и FK
const rw = new Database("karimoff.db");
const product = rw.prepare("SELECT id FROM products ORDER BY id LIMIT 1").get();

rw.prepare(
  "INSERT INTO product_documents (product_id, document, sort_order) VALUES (?, ?, ?)"
).run(product.id, "/uploads/doc1.pdf", 0);

console.log("");
console.log("после вставки:", rw.prepare("SELECT COUNT(*) AS n FROM product_documents").get().n);
console.log("default sort_order:", rw.prepare("SELECT sort_order FROM product_documents LIMIT 1").get().sort_order);

let fkError = "нет";
try {
  rw.prepare("INSERT INTO product_documents (product_id, document) VALUES (?, ?)")
    .run(999999, "/uploads/ghost.pdf");
} catch (error) {
  fkError = error.message;
}
console.log("вставка с несуществующим product_id:", fkError);

rw.close();
