import Database from "better-sqlite3";

const db = new Database("karimoff.db");

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

db.exec(`
  CREATE TABLE IF NOT EXISTS product_images (
    product_id INTEGER NOT NULL,
    image TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (product_id)
      REFERENCES products(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS characteristics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_filter INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS category_characteristics (
    category_id INTEGER NOT NULL,
    characteristic_id INTEGER NOT NULL,
    PRIMARY KEY (
      category_id,
      characteristic_id
    )
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS product_characteristics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    characteristic_id INTEGER NOT NULL,
    value TEXT
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

// Справочник брендов
db.exec(`
  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )
`);

if (!columnExists("products", "brand_id")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN brand_id INTEGER
  `);
}

db.exec(`
  INSERT OR IGNORE INTO brands (name)
  SELECT DISTINCT TRIM(brand)
  FROM products
  WHERE brand IS NOT NULL
    AND TRIM(brand) <> ''
`);

db.exec(`
  UPDATE products
  SET brand_id = (
    SELECT brands.id
    FROM brands
    WHERE brands.name = TRIM(products.brand)
  )
  WHERE brand IS NOT NULL
    AND TRIM(brand) <> ''
`);

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

// Скидка в процентах
if (!columnExists("products", "discount_percent")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0
  `);
}

// Порядок товаров
if (!columnExists("products", "sort_order")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
  `);
}

// Метка «Новинка»
if (!columnExists("products", "is_new")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0
  `);
}

// Метка «Хит»
if (!columnExists("products", "is_hit")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN is_hit INTEGER NOT NULL DEFAULT 0
  `);
}

// Единица измерения

if (!columnExists("products", "unit")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN unit TEXT NOT NULL DEFAULT 'шт.'
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

// Удалённый товар
if (!columnExists("products", "deleted")) {
  db.exec(`
    ALTER TABLE products
    ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0
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
    currency TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Новый',
    type TEXT NOT NULL DEFAULT 'Заказ товара',
    is_viewed INTEGER NOT NULL DEFAULT 0
  )
`);

if (!columnExists("orders", "type")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN type TEXT NOT NULL DEFAULT 'Заказ товара'
  `);
}

if (!columnExists("orders", "is_viewed")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN is_viewed INTEGER NOT NULL DEFAULT 0
  `);
}

if (!columnExists("orders", "currency")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN currency TEXT NOT NULL DEFAULT 'BYN'
  `);
}

if (!columnExists("orders", "comment")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN comment TEXT NOT NULL DEFAULT ''
  `);
}

// =====================================================
// ЗАЯВКИ НА УСЛУГУ И АРЕНДУ ТЕХНИКИ
// =====================================================

if (!columnExists("orders", "service_name")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN service_name TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "request_date")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN request_date TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "desired_time")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN desired_time TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "duration")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN duration TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "photos")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN photos TEXT NOT NULL DEFAULT ''
  `);
}

// =====================================================
// ЗАЯВКИ НА РЕМОНТ
// =====================================================

if (!columnExists("orders", "equipment_type")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN equipment_type TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "equipment_name")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN equipment_name TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "manufacturer")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN manufacturer TEXT NOT NULL DEFAULT ''
  `);
}

if (!columnExists("orders", "problem")) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN problem TEXT NOT NULL DEFAULT ''
  `);
}

// =====================================================
// ОДНОРАЗОВЫЕ ТОКЕНЫ БЫСТРОГО ЗАКАЗА
// =====================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS one_click_tokens (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
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

if (!columnExists("order_items", "price_on_request")) {
  db.exec(`
    ALTER TABLE order_items
    ADD COLUMN price_on_request INTEGER NOT NULL DEFAULT 0
  `);
}

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
// НАЧАЛЬНЫЕ БРЕНДЫ
// =====================================================

db.exec(`
  INSERT OR IGNORE INTO brands (name)
  VALUES
    ('Bosch'),
    ('Makita'),
    ('DeWalt')
`);

db.exec(`
  UPDATE products
  SET brand_id = (
    SELECT brands.id
    FROM brands
    WHERE brands.name = TRIM(products.brand)
  )
  WHERE brand IS NOT NULL
    AND TRIM(brand) <> ''
`);

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
      brand_id,
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
1,
"BYN",
    "in_stock",
    0,
    "Хит"
  );

  insertProduct.run(
    "Дрель Makita",
    2200,
    "Надёжная дрель для дома",
    2,
    "MAKITA-DR-001",
2,
"BYN",
    "in_stock",
    0,
    ""
  );

  insertProduct.run(
    "Шуруповёрт DeWalt",
    2800,
    "Аккумуляторный шуруповёрт",
    3,
    "DEWALT-SH-001",
3,
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