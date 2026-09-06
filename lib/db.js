import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("karimoff.db");

// =====================================================
// ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ
// =====================================================

function columnExists(tableName, columnName) {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all();

  return columns.some(
    column => column.name === columnName);
}

// =====================================================
// ТАБЛИЦА КАТЕГОРИЙ
// =====================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  )
`);

// =====================================================
// СОВМЕСТИМОСТЬ КАТЕГОРИЙ СО СТАРОЙ БАЗОЙ
// =====================================================

if (!columnExists("categories", "parent_id")) {
  db.exec(`
    ALTER TABLE categories
    ADD COLUMN parent_id INTEGER
  `);
}

if (!columnExists("categories", "sort_order")) {
  db.exec(`
    ALTER TABLE categories
    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
  `);
}

if (!columnExists("categories", "hidden")) {
  db.exec(`
    ALTER TABLE categories
    ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
  `);
}

// =====================================================
// ТАБЛИЦА ТОВАРОВ
// =====================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    description TEXT,
    category_id INTEGER,
    image TEXT
  )
`);

// =====================================================
// НОВЫЕ ПОЛЯ ТОВАРОВ
// =====================================================

// Артикул
if (!columnExists("products", "sku")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN sku TEXT
  `);
}

// Бренд / производитель
if (!columnExists("products", "brand")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN brand TEXT
  `);
}

// Валюта
if (!columnExists("products", "currency")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN currency TEXT NOT NULL DEFAULT 'BYN'
  `);
}

// Наличие
if (!columnExists("products", "availability")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN availability TEXT NOT NULL DEFAULT 'in_stock'
  `);
}

// Цена по запросу
if (!columnExists("products", "price_on_request")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN price_on_request INTEGER NOT NULL DEFAULT 0
  `);
}

// Метки товара
if (!columnExists("products", "badges")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN badges TEXT
  `);
}

// Изображение товара
if (!columnExists("products", "image")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN image TEXT
  `);
}

// =====================================================
// СВЯЗЬ ТОВАРОВ И КАТЕГОРИЙ
// =====================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS product_categories (
    product_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    PRIMARY KEY (product_id, category_id)
  )
`);

// =====================================================
// ЗАКАЗЫ
// =====================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Новый'
  )
`);

// =====================================================
// ТОВАРЫ В ЗАКАЗАХ
// =====================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    sum INTEGER NOT NULL
  )
`);

// =====================================================
// НАЧАЛЬНЫЕ КАТЕГОРИИ
// =====================================================

const categoryCount = db
  .prepare(
    "SELECT COUNT(*) AS total FROM categories"
  )
  .get();

if (categoryCount.total === 0) {
  const insertCategory = db.prepare(`
    INSERT INTO categories
    (name, parent_id, sort_order, hidden)
    VALUES (?, ?, ?, 0)
  `);

  insertCategory.run(
    "Инструменты",
    null,
    1
  );

  insertCategory.run(
    "Стройматериалы",
    null,
    2
  );

  insertCategory.run(
    "Крепёж",
    null,
    3
  );
}

// =====================================================
// НАЧАЛЬНЫЕ ТОВАРЫ
// =====================================================

const productCount = db
  .prepare(
    "SELECT COUNT(*) AS total FROM products"
  )
  .get();

if (productCount.total === 0) {
  const insertProduct = db.prepare(`
    INSERT INTO products
    (
      name,
      price,
      description,
      category_id,
      sku,
      brand,
      currency,
      availability,
      price_on_request,
      badges
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertProduct.run(
    "Перфоратор Bosch",
    3580,
    "Мощный перфоратор для ремонта",
    1,
    "BOSCH-PF-001",
    "Bosch",
    "BYN",
    "in_stock",
    0,
    "Хит"
  );

  insertProduct.run(
    "Дрель Makita",
    2200,
    "Надёжная дрель для дома",
    1,
    "MAKITA-DR-001",
    "Makita",
    "BYN",
    "in_stock",
    0,
    ""
  );

  insertProduct.run(
    "Шуруповёрт DeWalt",
    2800,
    "Аккумуляторный шуруповёрт",
    1,
    "DEWALT-SH-001",
    "DeWalt",
    "BYN",
    "in_stock",
    0,
    "Новинка"
  );
}

// =====================================================
// ЭКСПОРТ
// =====================================================

export default db;