import { createServer } from "http";
import { randomBytes } from "crypto";
import db from "./lib/db.js";

import pathModule from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { mkdirSync, writeFileSync } from "fs";

const PORT = 3000;
const ADMIN_PASSWORD = "12345";

let adminToken = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

const UPLOADS_DIR =
  pathModule.join(
    __dirname,
    "uploads"
  );

await fs.mkdir(
  UPLOADS_DIR,
  {
    recursive: true
  }
);


// ======================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ======================================================

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = {};

  for (const part of cookieHeader.split(";")) {
    const pieces = part.trim().split("=");

    const name = pieces.shift();

    if (!name) {
      continue;
    }

    cookies[name] = decodeURIComponent(
      pieces.join("=") || ""
    );
  }

  return cookies;
}

function normalizeSearchText(value = "") {
  return String(value)
    .toLowerCase()
    .replaceAll("ё", "е")
    .trim();
}

function searchDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(
              matrix[i - 1][j] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j - 1] + 1
            );
    }
  }

  return matrix[b.length][a.length];
}

function isAdmin(req) {
  const cookies = parseCookies(req);

  return Boolean(
    adminToken &&
    cookies.admin === adminToken
  );
}


function requireAdmin(req, res) {
  if (isAdmin(req)) {
    return true;
  }

  sendHtml(
    res,
    `
      ${renderMenu(req)}

      <h1>Доступ запрещён</h1>

      <p>
        Эта страница доступна только администратору.
      </p>

      <p>
        <a href="/admin">
          Войти как администратор
        </a>
      </p>
    `,
    403
  );

  return false;
}


function sendHtml(
  res,
  body,
  statusCode = 200
) {
  res.writeHead(statusCode, {
    "Content-Type":
      "text/html; charset=utf-8"
  });

  res.end(body);
}


function redirect(res, location) {
  res.writeHead(302, {
    Location: location
  });

  res.end();
}


function renderPage(
  req,
  title,
  content
) {
  return `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>${escapeHtml(title)}</title>
</head>

<body>

${renderMenu(req)}

${content}

</body>
</html>
  `;
}


function renderMenu(req) {
  if (isAdmin(req)) {
    return `
      <nav>
        <a href="/">Главная</a> |
        <a href="/catalog">Каталог</a> |
        <a href="/about">О нас</a> |
        <a href="/cart">Корзина</a> |
        <a href="/admin">Админ-панель</a> |
        <a href="/orders">Заказы</a> |
        <a href="/add-product">Добавить товар</a> |
        <a href="/admin/categories">Категории</a> |
        <a href="/admin/logout">Выйти</a>
      </nav>

      <hr>
    `;
  }

  return `
    <nav>
      <a href="/">Главная</a> |
      <a href="/catalog">Каталог</a> |
      <a href="/about">О нас</a> |
      <a href="/cart">Корзина</a> |
      <a href="/admin">Админ</a>
    </nav>

    <hr>
  `;
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1_000_000) {
        req.destroy();
      }
    });

    req.on("end", () => {
      resolve(
        new URLSearchParams(body)
      );
    });

    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", chunk => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function parseMultipartBody(buffer, contentType) {

  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

  if (!match) {
    throw new Error("Не найден boundary multipart/form-data");
  }

  const boundary = match[1] || match[2];

  const body = buffer.toString("latin1");
  const delimiter = `--${boundary}`;

  const parts = body.split(delimiter);

  const fields = new Map();
  const files = new Map();

  for (let part of parts) {
    part = part.trim();

    if (!part || part === "--") {
      continue;
    }

    if (part.endsWith("--")) {
      part = part.slice(0, -2);
    }

    const separatorIndex = part.indexOf("\r\n\r\n");

    if (separatorIndex === -1) {
      continue;
    }

    const headersText =
      part.slice(0, separatorIndex);

    const contentText =
      part.slice(separatorIndex + 4);

    const dispositionMatch =
      headersText.match(
    /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i
  );

    if (!dispositionMatch) {
      continue;
    }

    const name = dispositionMatch[1];
    const filename = dispositionMatch[2];

    if (filename !== undefined) {
      const contentTypeMatch =
        headersText.match(
          /Content-Type:\s*([^\r\n]+)/i
        );

      files.set(name, {
        filename,
        contentType:
          contentTypeMatch
            ? contentTypeMatch[1].trim()
            : "application/octet-stream",
        data: Buffer.from(
          contentText,
          "latin1"
        )
      });

      continue;
    }

    const value =
  Buffer.from(
    contentText.replace(/\r\n$/, ""),
    "latin1"
  ).toString("utf8");

if (!fields.has(name)) {
  fields.set(name, []);
}

fields.get(name).push(value);
  }

  return {
    get(name) {
  const values = fields.get(name) || [];
  return values[0] || "";
},

getAll(name) {
  return fields.get(name) || [];
},

    getFile(name) {
      return files.get(name) || null;
    }
  };
}

function saveUploadedImage(file) {

  if (!file || !file.filename || !file.data.length) {
    return "";
  }

  const allowedTypes = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };

  const extension =
    allowedTypes[file.contentType];

  if (!extension) {
    throw new Error(
      "Разрешены только JPG, PNG, WebP и GIF"
    );
  }

  if (
    file.data.length >
    10 * 1024 * 1024
  ) {
    throw new Error(
      "Изображение слишком большое. Максимум 10 МБ."
    );
  }

  const uploadsDir =
    pathModule.join(
      process.cwd(),
      "uploads"
    );

  mkdirSync(
    uploadsDir,
    {
      recursive: true
    }
  );

  const filename =
    `${randomBytes(16).toString("hex")}${extension}`;

  const filePath =
  pathModule.join(
    uploadsDir,
    filename
  );

  writeFileSync(
    filePath,
    file.data
  );

  return `/uploads/${filename}`;
}

// ======================================================
// КАТЕГОРИИ
// ======================================================

function getCategories() {
  return db
    .prepare(`
      SELECT *
      FROM categories
      ORDER BY
        COALESCE(parent_id, 0),
        sort_order,
        id
    `)
    .all();
}

function getCategoryProductCounts() {
  const rows = db.prepare(`
    SELECT
      c.id,
      COUNT(DISTINCT p.id) AS product_count
    FROM categories c

    LEFT JOIN products p
  ON p.deleted = 0
  AND (
    p.category_id = c.id
          OR EXISTS (
        SELECT 1
        FROM product_categories pc
        WHERE
          pc.product_id = p.id
          AND pc.category_id = c.id
      )
    )

    GROUP BY c.id
  `).all();

  return new Map(
    rows.map(row => [
      row.id,
      Number(row.product_count)
    ])
  );
}

function getCategoryLevel(
  categoryId,
  categories
) {
  let level = 0;

  let current =
    categories.find(
      category =>
        category.id === categoryId
    );

  while (
    current &&
    current.parent_id !== null &&
    level < 20
  ) {
    level++;

    current =
      categories.find(
        category =>
          category.id ===
          current.parent_id
      );
  }

  return level;
}


function getCategoryChildren(
  categories,
  parentId = null
) {
  return categories
    .filter(category => {
      if (parentId === null) {
        return category.parent_id === null;
      }

      return (
        category.parent_id === parentId
      );
    })
    .sort((a, b) => {
      if (
        a.sort_order !==
        b.sort_order
      ) {
        return (
          a.sort_order -
          b.sort_order
        );
      }

      return a.id - b.id;
    });
}


function renderCategoryOptions(
  categories,
  parentId = null,
  level = 0,
  selectedId = null,
  excludeId = null,
  selectedIds = []
) {
  let html = "";

  const children =
    getCategoryChildren(
      categories,
      parentId
    );

  for (const category of children) {
    if (
      category.id === excludeId
    ) {
      continue;
    }

    const selected =
  selectedIds.includes(
    String(category.id)
  )
    ? "selected"
    : "";

    html += `
      <option
        value="${category.id}"
        ${selected}
      >
        ${"&nbsp;".repeat(level * 4)}
        ${escapeHtml(category.name)}
      </option>
    `;

    html +=
  renderCategoryOptions(
    categories,
    category.id,
    level + 1,
    selectedId,
    excludeId,
    selectedIds
  );
  }

  return html;
}


function renderCategoryTree(
  categories,
  parentId = null,
  level = 0
) {
  let html = "";

  const children =
    getCategoryChildren(
      categories,
      parentId
    );

  for (const category of children) {
    const hidden =
      category.hidden
        ? " 🔒 скрыта"
        : "";

    html += `
      <li>
        ${"— ".repeat(level)}

        <strong>
          ${escapeHtml(category.name)}
        </strong>

        ${hidden}

        <br>

        <a
          href="/admin/categories/edit/${category.id}"
        >
          Редактировать
        </a>

        |

        <a
          href="/admin/categories/toggle/${category.id}"
        >
          ${
            category.hidden
              ? "Показать"
              : "Скрыть"
          }
        </a>

        |

        <a
          href="/admin/categories/delete/${category.id}"
          onclick="return confirm('Удалить категорию?')"
        >
          Удалить
        </a>

        ${renderCategoryTree(
          categories,
          category.id,
          level + 1
        )}
      </li>
    `;
  }

  return html;
}


// ======================================================
// ТОВАРЫ И КАТЕГОРИИ
// ======================================================

function getProductCategoryIds(
  productId
) {
  return db
    .prepare(`
      SELECT category_id
      FROM product_categories
      WHERE product_id = ?
    `)
    .all(productId)
    .map(row => row.category_id);
}


function saveProductCategories(
  productId,
  categoryIds
) {
  db.prepare(`
    DELETE FROM product_categories
    WHERE product_id = ?
  `).run(productId);

  const insert =
    db.prepare(`
      INSERT OR IGNORE INTO product_categories
      (
        product_id,
        category_id
      )
      VALUES (?, ?)
    `);

  for (const categoryId of categoryIds) {
    insert.run(
      productId,
      categoryId
    );
  }
}


function getProductCategoryNames(
  productId
) {
  return db
    .prepare(`
      SELECT c.name
      FROM categories c

      JOIN product_categories pc
        ON pc.category_id = c.id

      WHERE pc.product_id = ?

      ORDER BY
        c.sort_order,
        c.id
    `)
    .all(productId)
    .map(row => row.name);
}

function getProductCharacteristics(
  productId
) {
  return db
    .prepare(`
      SELECT
        c.id,
        c.name,
        pc.value
      FROM product_characteristics pc

      JOIN characteristics c
        ON c.id = pc.characteristic_id

      WHERE pc.product_id = ?

      ORDER BY
        c.id
    `)
    .all(productId);
}


function getCategoryCharacteristicRows() {
  return db
    .prepare(`
      SELECT
        c.id,
        c.name,
        cc.category_id
      FROM characteristics c

      JOIN category_characteristics cc
        ON cc.characteristic_id = c.id

      ORDER BY
        c.id,
        cc.category_id
    `)
    .all();
}


function getCategoryCharacteristicIds(
  categoryId
) {
  return db
    .prepare(`
      SELECT characteristic_id
      FROM category_characteristics
      WHERE category_id = ?
    `)
    .all(categoryId)
    .map(row => row.characteristic_id);
}


function getCharacteristicsForCategoryIds(
  categoryIds
) {
  const ids = categoryIds
    .map(Number)
    .filter(Number.isInteger);

  if (ids.length === 0) {
    return [];
  }

  const placeholders =
    ids.map(() => "?").join(", ");

  return db
    .prepare(`
      SELECT DISTINCT
        c.id,
        c.name,
        c.is_filter
      FROM characteristics c

      JOIN category_characteristics cc
        ON cc.characteristic_id = c.id

      WHERE cc.category_id IN (${placeholders})

      ORDER BY c.id
    `)
    .all(...ids);
}


function getCatalogFilterData(
  categoryId
) {
  if (!Number.isInteger(categoryId)) {
    return [];
  }

  const characteristics = db
    .prepare(`
      SELECT
        c.id,
        c.name
      FROM category_characteristics cc

      JOIN characteristics c
        ON c.id = cc.characteristic_id

      WHERE
        cc.category_id = ?
        AND c.is_filter = 1

      ORDER BY c.id
    `)
    .all(categoryId);

  if (characteristics.length === 0) {
    return [];
  }

  const characteristicIds = characteristics.map(
    characteristic => characteristic.id
  );
  const placeholders = characteristicIds
    .map(() => "?")
    .join(", ");

  const values = db
    .prepare(`
      SELECT DISTINCT
        pc.characteristic_id,
        pc.value
      FROM product_characteristics pc

      JOIN products p
        ON p.id = pc.product_id

      LEFT JOIN product_categories productCategory
        ON productCategory.product_id = p.id

      WHERE
        pc.characteristic_id IN (${placeholders})
        AND TRIM(pc.value) <> ''
        AND (
          p.category_id = ?
          OR productCategory.category_id = ?
        )

      ORDER BY
        pc.characteristic_id,
        pc.value
    `)
    .all(
      ...characteristicIds,
      categoryId,
      categoryId
    );

  return characteristics.map(characteristic => ({
    ...characteristic,
    values: values
      .filter(
        value =>
          value.characteristic_id ===
          characteristic.id
      )
      .map(value => value.value)
  }));
}


function getSubmittedCharacteristicValues(
  params,
  characteristics
) {
  const values = [];

  for (const characteristic of characteristics) {
    const value =
      params
        .get(`characteristic_${characteristic.id}`)
        ?.trim() || "";

    if (value) {
      values.push({
        characteristicId: characteristic.id,
        value
      });
    }
  }

  return values;
}


function renderCharacteristicInputs(
  categoryCharacteristicRows,
  valuesByCharacteristicId = new Map()
) {
  const characteristics = new Map();

  for (const row of categoryCharacteristicRows) {
    if (!characteristics.has(row.id)) {
      characteristics.set(row.id, {
        id: row.id,
        name: row.name,
        categoryIds: []
      });
    }

    characteristics.get(row.id)
      .categoryIds.push(row.category_id);
  }

  let html = "";

  for (const characteristic of characteristics.values()) {
    html += `
      <p
        data-characteristic-category-ids="${characteristic.categoryIds.join(",")}"
        hidden
      >
        ${escapeHtml(characteristic.name)}:

        <input
          type="text"
          name="characteristic_${characteristic.id}"
          value="${escapeHtml(
            valuesByCharacteristicId.get(
              characteristic.id
            ) || ""
          )}"
        >
      </p>
    `;
  }

  return html;
}


function renderCharacteristicSelectionScript() {
  return `
    <script>
      (() => {
        const categorySelect =
          document.getElementById(
            "product-categories"
          );

        const characteristicRows =
          document.querySelectorAll(
            "[data-characteristic-category-ids]"
          );

        if (!categorySelect) {
          return;
        }

        function updateCharacteristics() {
          const selectedIds = new Set(
            Array.from(
              categorySelect.selectedOptions
            ).map(option => option.value)
          );

          for (const row of characteristicRows) {
            const categoryIds = row.dataset
              .characteristicCategoryIds
              .split(",")
              .filter(Boolean);

            row.hidden = !categoryIds.some(
              categoryId =>
                selectedIds.has(categoryId)
            );
          }
        }

        categorySelect.addEventListener(
          "change",
          updateCharacteristics
        );

        updateCharacteristics();
      })();
    </script>
  `;
}

function getCharacteristics() {
  return db
    .prepare(`
      SELECT *
      FROM characteristics
      ORDER BY id
    `)
    .all();
}

// ======================================================
// КОРЗИНА
// ======================================================

function getCart(req) {
  const cookies =
    parseCookies(req);

  try {
    return cookies.cart
      ? JSON.parse(cookies.cart)
      : {};
  } catch {
    return {};
  }
}


function setCart(res, cart) {
  const value =
    encodeURIComponent(
      JSON.stringify(cart)
    );

  res.setHeader(
    "Set-Cookie",
    `cart=${value}; Path=/; Max-Age=2592000; SameSite=Lax`
  );
}


function getCartItems(req) {
  const cart =
    getCart(req);

  const ids =
    Object.keys(cart)
      .map(Number)
      .filter(
        Number.isInteger
      );

  if (ids.length === 0) {
    return [];
  }

  const items = [];

  for (const id of ids) {
    const product =
      db.prepare(`
        SELECT *
        FROM products
        WHERE id = ?
      `).get(id);

    if (!product) {
      continue;
    }

    const quantity =
      Math.max(
        1,
        Number(cart[id]) || 1
      );

    items.push({
      ...product,
      quantity,
      sum:
  product.price_on_request
    ? 0
    : product.price *
      quantity *
      (1 - (Number(product.discount_percent) || 0) / 100)
    });
  }

  return items;
}


// ======================================================
// SERVER
// ======================================================

const server =
  createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
          );

        const path =
          url.pathname;

          if (
  req.method === "GET" &&
  path.startsWith("/uploads/")
) {
  const requestedName =
    decodeURIComponent(
      path.slice("/uploads/".length)
    );

  const safeName =
    requestedName
      .split("/")
      .pop()
      .split("\\")
      .pop();

  const filePath =
    pathModule.join(
      UPLOADS_DIR,
      safeName
    );

  try {
    const data =
      await fs.readFile(filePath);

    const ext =
      pathModule
        .extname(safeName)
        .toLowerCase();

    const contentTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif"
    };

    res.writeHead(200, {
      "Content-Type":
        contentTypes[ext] ||
        "application/octet-stream"
    });

    return res.end(data);
  } catch {
    return sendHtml(
      res,
      "Файл не найден",
      404
    );
  }
}

// ==================================================
// ПОДСКАЗКИ ПОИСКА
// ==================================================

if (
  req.method === "GET" &&
  path === "/search-suggestions"
) {
  const query =
  url.searchParams
    .get("q")
    ?.trim()
    .toLowerCase() || "";

  const suggestions =
  query
    ? db.prepare(`
        SELECT id, name, sku
        FROM products
        WHERE deleted = 0
        ORDER BY name
      `).all().filter(product => {
        const name =
          normalizeSearchText(product.name || "");

        const sku =
          normalizeSearchText(product.sku || "");

        if (
          name.includes(query) ||
          sku.includes(query)
        ) {
          return true;
        }

        const words = `${name} ${sku}`
          .split(/\s+/)
          .filter(Boolean);

        return words.some(word => {
          if (
            word.length < 4 ||
            query.length < 4
          ) {
            return false;
          }

          const maxDistance =
            query.length >= 7 ? 2 : 1;

          return (
            searchDistance(word, query) <=
            maxDistance
          );
        });
      }).slice(0, 8)
    : [];

  res.writeHead(200, {
    "Content-Type":
      "application/json; charset=utf-8"
  });

  return res.end(
    JSON.stringify(suggestions)
  );
}

        // ==================================================
        // ГЛАВНАЯ
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/"
        ) {

          return sendHtml(
            res,
            renderPage(
              req,
              "Karimoff",
              `
                <h1>Karimoff</h1>

                <p>
                  Добро пожаловать
                  на сайт Karimoff!
                </p>

                <p>
                  <a href="/catalog">
                    Перейти в каталог
                  </a>
                </p>
              `
            )
          );
        }


        // ==================================================
        // О НАС
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/about"
        ) {

          return sendHtml(
            res,
            renderPage(
              req,
              "О компании",
              `
                <h1>О компании</h1>

                <p>
                  Интернет-магазин
                  Karimoff.
                </p>
              `
            )
          );
        }


        // ==================================================
        // АДМИН — GET
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin"
        ) {

          if (!isAdmin(req)) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Вход администратора",
                `
                  <h1>
                    Вход администратора
                  </h1>

                  <form
                    method="POST"
                    action="/admin"
                  >

                    <p>
                      Пароль:
                      <input
                        type="password"
                        name="password"
                        required
                      >
                    </p>

                    <button>
                      Войти
                    </button>

                  </form>
                `
              )
            );
          }


          return sendHtml(
            res,
            renderPage(
              req,
              "Админ-панель",
              `
                <h1>
                  Админ-панель
                </h1>

                <ul>

                  <li>
                    <a href="/catalog">
                      Управление товарами
                    </a>
                  </li>

                  <li>
                    <a href="/add-product">
                      Добавить товар
                    </a>
                  </li>

<li>
  <a href="/admin/brands">
    Управление брендами
  </a>
</li>

                  <li>
                    <a href="/admin/categories">
                      Управление категориями
                    </a>
                  </li>

                  <li>
                    <a href="/admin/deleted-products">
                      Удалённые товары
                    </a>
                  </li>

                  <li>
                    <a href="/admin/characteristics">
                      Управление характеристиками
                    </a>
                  </li>

                  <li>
                    <a href="/admin/category-characteristics">
                      Характеристики категорий
                    </a>
                  </li>

                  <li>
                    <a href="/orders">
                      Заказы
                    </a>
                  </li>

                </ul>
              `
            )
          );
        }


         // ==================================================
        // ХАРАКТЕРИСТИКИ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/characteristics"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

          const characteristics =
            getCharacteristics();

          let characteristicsHtml =
            "";

          for (
            const characteristic
            of characteristics
          ) {

            characteristicsHtml += `
              <li>
                ${escapeHtml(
                  characteristic.name
                )}

                ${
                  characteristic.is_filter
                    ? "(фильтр)"
                    : ""
                }
              </li>
            `;
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Управление характеристиками",
              `
                <h1>
                  Управление характеристиками
                </h1>

                <form
                  method="POST"
                  action="/admin/characteristics"
                >

                  <p>
                    Название характеристики:

                    <input
                      type="text"
                      name="name"
                      required
                    >
                  </p>

                  <p>
                    Использовать как фильтр:

                    <input
                      type="checkbox"
                      name="is_filter"
                      value="1"
                    >
                  </p>

                  <button>
                    Добавить
                  </button>

                </form>

                <h2>
                  Существующие характеристики
                </h2>

                <ul>
                  ${characteristicsHtml}
                </ul>

                <p>
                  <a href="/admin">
                    Назад в админ-панель
                  </a>
                </p>
              `
            )
          );
        }


        // ==================================================
        // АДМИН — POST
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin"
        ) {

          const params =
            await readBody(req);

          const password =
            params.get("password");

          if (
            password !==
            ADMIN_PASSWORD
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Неверный пароль
                  </h1>

                  <p>
                    Пароль введён
                    неправильно.
                  </p>

                  <p>
                    <a href="/admin">
                      Попробовать снова
                    </a>
                  </p>
                `
              ),
              401
            );
          }


          adminToken =
            randomBytes(
              32
            ).toString("hex");


          res.setHeader(
            "Set-Cookie",
            `admin=${adminToken}; HttpOnly; Path=/; SameSite=Lax`
          );


          return redirect(
            res,
            "/admin"
          );
        }


                // ==================================================
        // ХАРАКТЕРИСТИКИ — POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/characteristics"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

          const params =
            await readBody(req);

          const name =
            params.get("name");

          const isFilter =
            params.get("is_filter") === "1"
              ? 1
              : 0;

          if (!name) {
            return redirect(
              res,
              "/admin/characteristics"
            );
          }

          db.prepare(`
            INSERT INTO characteristics
            (
              name,
              is_filter
            )
            VALUES (?, ?)
          `).run(
            name,
            isFilter
          );

          return redirect(
            res,
            "/admin/characteristics"
          );
        }


        // ==================================================
        // ХАРАКТЕРИСТИКИ КАТЕГОРИЙ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/category-characteristics"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const categories = getCategories();
          const characteristics = getCharacteristics();
          const categoryParam =
            url.searchParams.get("category");

          let selectedCategory = null;

          if (categoryParam) {
            const categoryId = Number(categoryParam);

            selectedCategory = categories.find(
              category => category.id === categoryId
            );

            if (!selectedCategory) {
              return sendHtml(
                res,
                renderPage(
                  req,
                  "Категория не найдена",
                  `<h1>Категория не найдена.</h1>`
                ),
                404
              );
            }
          } else {
            selectedCategory = categories[0] || null;
          }

          let categoryOptions = "";

          for (const category of categories) {
            categoryOptions += `
              <option
                value="${category.id}"
                ${
                  selectedCategory &&
                  category.id === selectedCategory.id
                    ? "selected"
                    : ""
                }
              >
                ${escapeHtml(category.name)}
              </option>
            `;
          }

          const selectedCharacteristicIds =
            selectedCategory
              ? getCategoryCharacteristicIds(
                  selectedCategory.id
                )
              : [];

          let characteristicsHtml = "";

          for (const characteristic of characteristics) {
            characteristicsHtml += `
              <p>
                <label>
                  <input
                    type="checkbox"
                    name="characteristic_ids"
                    value="${characteristic.id}"
                    ${
                      selectedCharacteristicIds.includes(
                        characteristic.id
                      )
                        ? "checked"
                        : ""
                    }
                  >
                  ${escapeHtml(characteristic.name)}
                </label>
              </p>
            `;
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Характеристики категорий",
              `
                <h1>
                  Характеристики категорий
                </h1>

                <p>
                  <a href="/admin">
                    ← Назад в админ-панель
                  </a>
                </p>

                <form
                  method="GET"
                  action="/admin/category-characteristics"
                >
                  <p>
                    Категория:

                    <select name="category">
                      ${categoryOptions}
                    </select>

                    <button>
                      Выбрать
                    </button>
                  </p>
                </form>

                ${
                  selectedCategory
                    ? `
                      <form
                        method="POST"
                        action="/admin/category-characteristics"
                      >
                        <input
                          type="hidden"
                          name="category_id"
                          value="${selectedCategory.id}"
                        >

                        <h2>
                          ${escapeHtml(
                            selectedCategory.name
                          )}
                        </h2>

                        ${
                          characteristicsHtml ||
                          "<p>Характеристик пока нет.</p>"
                        }

                        <button>
                          Сохранить назначения
                        </button>
                      </form>
                    `
                    : "<p>Категорий пока нет.</p>"
                }
              `
            )
          );
        }

        // ==================================================
        // ХАРАКТЕРИСТИКИ КАТЕГОРИЙ — POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/category-characteristics"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const params = await readBody(req);
          const categoryId = Number(
            params.get("category_id")
          );
          const category = getCategories().find(
            item => item.id === categoryId
          );

          if (!Number.isInteger(categoryId) || !category) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Выберите существующую категорию.</h1>`
              ),
              400
            );
          }

          const submittedCharacteristicIds =
            params.getAll("characteristic_ids");

          const characteristicIds =
            submittedCharacteristicIds.map(Number);

          if (
            characteristicIds.some(
              characteristicId =>
                !Number.isInteger(characteristicId)
            )
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Некорректная характеристика.</h1>`
              ),
              400
            );
          }

          const availableCharacteristicIds = new Set(
            getCharacteristics().map(
              characteristic => characteristic.id
            )
          );

          if (
            characteristicIds.some(
              characteristicId =>
                !availableCharacteristicIds.has(
                  characteristicId
                )
            )
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Выбрана несуществующая характеристика.</h1>`
              ),
              400
            );
          }

          const uniqueCharacteristicIds = [
            ...new Set(characteristicIds)
          ];

          db.exec("BEGIN");

          try {
            db.prepare(`
              DELETE FROM category_characteristics
              WHERE category_id = ?
            `).run(categoryId);

            const insert = db.prepare(`
              INSERT INTO category_characteristics
              (
                category_id,
                characteristic_id
              )
              VALUES (?, ?)
            `);

            for (const characteristicId of uniqueCharacteristicIds) {
              insert.run(categoryId, characteristicId);
            }

            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }

          return redirect(
            res,
            `/admin/category-characteristics?category=${categoryId}`
          );
        }

        // ==================================================
        // АДМИН — LOGOUT
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/logout"
        ) {

          adminToken = null;

          res.setHeader(
            "Set-Cookie",
            "admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
          );

          return redirect(
            res,
            "/"
          );
        }

// ==================================================
// БРЕНДЫ — GET
// ПУБЛИЧНАЯ СТРАНИЦА
// ==================================================

if (
  req.method === "GET" &&
  path === "/brands"
) {

  const brands =
    db.prepare(`
      SELECT id, name
      FROM brands
      ORDER BY name
    `).all();

  return sendHtml(
    res,
    renderPage(
      req,
      "Бренды",
      `
        <h1>Бренды</h1>

        <ul>
          ${brands.map(brand => `
            <li>
              <a href="/brand/${brand.id}">
                ${escapeHtml(brand.name)}
              </a>
            </li>
          `).join("")}
        </ul>
      `
    )
  );
}

// ==================================================
// БРЕНД — GET
// ПУБЛИЧНАЯ СТРАНИЦА
// ==================================================

if (
  req.method === "GET" &&
  path.startsWith("/brand/")
) {

  const id =
    Number(
      path.split("/")[2]
    );

  const brand =
    db.prepare(`
      SELECT id, name
      FROM brands
      WHERE id = ?
    `).get(id);

  if (!brand) {
    return sendHtml(
      res,
      renderPage(
        req,
        "Бренд не найден",
        `
          <h1>Бренд не найден</h1>

          <p>
            <a href="/brands">
              ← Вернуться к брендам
            </a>
          </p>
        `
      )
    );
  }

  const products =
    db.prepare(`
      SELECT *
      FROM products
      WHERE brand_id = ?
        AND deleted = 0
      ORDER BY id DESC
    `).all(brand.id);

  return sendHtml(
    res,
    renderPage(
      req,
      brand.name,
      `
        <h1>
          ${escapeHtml(brand.name)}
        </h1>

        <p>
          <a href="/brands">
            ← Все бренды
          </a>
        </p>

        ${
          products.length === 0
            ? "<p>Товаров этого бренда пока нет.</p>"
            : `
              <ul>
                ${products.map(product => `
                  <li>
                    <a href="/product/${product.id}">
                      ${escapeHtml(product.name)}
                    </a>
                  </li>
                `).join("")}
              </ul>
            `
        }
      `
    )
  );
}

      // ==================================================
// КАТАЛОГ
// ==================================================

if (
  req.method === "GET" &&
  path === "/catalog"
) {

  const categoryProductCounts =
  getCategoryProductCounts();

  const cats =
    getCategories();

  const categoryFilter =
    url.searchParams.get("category");

const searchQuery =
  url.searchParams.get("search")?.trim() || "";

  const sort =
  url.searchParams.get("sort") || "";

  const priceMin =
  url.searchParams.get("price_min") || "";

const priceMax =
  url.searchParams.get("price_max") || "";

const selectedAvailability =
  url.searchParams.getAll("availability");

const selectedBrands =
  url.searchParams.getAll("brand");

  const catalogFilterData =
  categoryFilter
    ? getCatalogFilterData(Number(categoryFilter))
    : [];

    const selectedFilters = {};

for (const characteristic of catalogFilterData) {
  const parameterName =
    `filter_${characteristic.id}`;

  const values =
    url.searchParams.getAll(parameterName);

  if (values.length > 0) {
    selectedFilters[characteristic.id] = values;
  }
}

const catalogStateHiddenHtml = `
  <input
    type="hidden"
    name="category"
    value="${escapeHtml(categoryFilter || "")}"
  >

  <input
    type="hidden"
    name="price_min"
    value="${escapeHtml(priceMin)}"
  >

  <input
    type="hidden"
    name="price_max"
    value="${escapeHtml(priceMax)}"
  >

  ${selectedBrands.map(brand => `
    <input
      type="hidden"
      name="brand"
      value="${escapeHtml(brand)}"
    >
  `).join("")}

  ${selectedAvailability.map(availability => `
    <input
      type="hidden"
      name="availability"
      value="${escapeHtml(availability)}"
    >
  `).join("")}

  ${Object.entries(selectedFilters).flatMap(
    ([characteristicId, values]) =>
      values.map(value => `
        <input
          type="hidden"
          name="filter_${characteristicId}"
          value="${escapeHtml(value)}"
        >
      `)
  ).join("")}
`;

  let products;

  if (categoryFilter) {

    products =
      db.prepare(`
        SELECT DISTINCT p.*
        FROM products p

LEFT JOIN product_categories pc
  ON pc.product_id = p.id

LEFT JOIN categories c
  ON c.id = ?
  
WHERE
  p.deleted = 0
  AND c.hidden = 0
  AND (
            p.category_id = ?
            OR pc.category_id = ?
          )

        ORDER BY p.id DESC
      `).all(
  Number(categoryFilter),
  Number(categoryFilter),
  Number(categoryFilter)
);

  } else {

    products =
      db.prepare(`
        SELECT *
        FROM products
        WHERE deleted = 0
        ORDER BY id DESC
      `).all();

  }

      const availableBrands =
  db.prepare(`
    SELECT id, name
    FROM brands
    ORDER BY name
  `).all();

     if (searchQuery) {
  const query = normalizeSearchText(searchQuery);

products = products.filter(product => {
  const name = normalizeSearchText(product.name || "");
  const sku = normalizeSearchText(product.sku || "");

  if (
    name.includes(query) ||
    sku.includes(query)
  ) {
    return true;
  }

  const words = `${name} ${sku}`
    .split(/\s+/)
    .filter(Boolean);

  return words.some(word => {
    if (word.length < 4 || query.length < 4) {
      return false;
    }

    const maxDistance =
      query.length >= 7 ? 2 : 1;

    return searchDistance(word, query) <= maxDistance;
  });
});
}

      if (sort === "price_asc") {
      products.sort((a, b) => a.price - b.price);
    }

    if (sort === "price_desc") {
      products.sort((a, b) => b.price - a.price);
    }

    if (sort === "popular") {
    const sales = db.prepare(`
      SELECT
        product_id,
        SUM(quantity) AS total_quantity
      FROM order_items
      GROUP BY product_id
    `).all();

  const salesMap = new Map(
    sales.map(item => [
      item.product_id,
      Number(item.total_quantity)
    ])
  );

  products.sort(
    (a, b) =>
      (salesMap.get(b.id) || 0) -
      (salesMap.get(a.id) || 0)
  );
}

  if (priceMin) {
  products = products.filter(product =>
    Number(product.price) >= Number(priceMin)
  );
}

if (priceMax) {
  products = products.filter(product =>
    Number(product.price) <= Number(priceMax)
  );
}

if (selectedAvailability.length > 0) {
  products = products.filter(product =>
    selectedAvailability.includes(product.availability)
  );
}

if (selectedBrands.length > 0) {
  products = products.filter(product =>
  selectedBrands.includes(String(product.brand_id))
  );
}

const selectedCharacteristicIds =
  Object.keys(selectedFilters).map(Number);

if (selectedCharacteristicIds.length > 0) {
  products = products.filter(product => {
    const characteristics =
      getProductCharacteristics(product.id);

    return selectedCharacteristicIds.every(
      characteristicId => {
        const selectedValues =
          selectedFilters[characteristicId];

        return characteristics.some(
          characteristic =>
            characteristic.id === characteristicId &&
            selectedValues.includes(
              characteristic.value
            )
        );
      }
    );
  });
}

  let categoryLinks = `
    <a href="/catalog">
      Все категории
    </a>
  `;

  for (
    const category
    of cats
  ) {

    if (category.hidden) {
      continue;
    }

    if (
  (categoryProductCounts.get(category.id) || 0) === 0
) {
  continue;
}

    categoryLinks += `
      |
      <a href="/catalog?category=${category.id}">
        ${escapeHtml(category.name)}
(${categoryProductCounts.get(category.id) || 0})
      </a>
    `;
  }

  let productsHtml = "";

  if (products.length === 0) {

    productsHtml =
      "<p>Товаров пока нет.</p>";

  } else {

    productsHtml = "<ul>";

    for (
      const product
      of products
    ) {

      const discountPercent =
        Number(product.discount_percent) || 0;

      const discountedPrice =
        discountPercent > 0
          ? product.price * (1 - discountPercent / 100)
          : product.price;

      const names =
        getProductCategoryNames(
          product.id
        );

      productsHtml += `
        <li>

          <p>
            <a href="/product/${product.id}">
              <strong>
                ${escapeHtml(product.name)}
              </strong>
            </a>
          </p>

          <p>
  Бренд: ${
    product.brand_id
      ? db.prepare(`
          SELECT name
          FROM brands
          WHERE id = ?
        `).get(product.brand_id)?.name || "—"
      : "—"
  }
</p>

          <p>
            ${
              product.price_on_request
                ? "Цена по запросу"
                : discountPercent > 0
                  ? `<s>${product.price} ${product.currency}</s>
                     →
                     ${discountedPrice} ${product.currency}`
                  : `${product.price} ${product.currency}`
            }
          </p>

          <p>
            Наличие:
            ${
              product.availability === "in_stock"
                ? "В наличии"
                : product.availability === "on_order"
                  ? "Под заказ"
                  : "Нет в наличии"
            }
          </p>

          <p>
  ${
    Number(product.discount_percent) > 0
      ? "Акция "
      : ""
  }
  ${
    product.is_new
      ? "Новинка "
      : ""
  }
  ${
    product.is_hit
      ? "Хит"
      : ""
  }
</p>

          ${
            names.length
              ? `
                <p>
                  Категории:
                  ${escapeHtml(names.join(", "))}
                </p>
              `
              : ""
          }

          <p>
            ${escapeHtml(product.description || "")}
          </p>

          ${
            product.image
              ? `
                <p>
                  <img
                    src="${escapeHtml(product.image)}"
                    alt="${escapeHtml(product.name)}"
                    style="max-width:200px; max-height:200px;"
                  >
                </p>
              `
              : ""
          }

          <p>
            <a href="/cart/add/${product.id}">
              В корзину
            </a>

            ${
              isAdmin(req)
                ? `
                  |
                  <a href="/edit-product/${product.id}">
                    Редактировать
                  </a>

                  |
                  <a
                    href="/delete-product/${product.id}"
                    onclick="return confirm('Удалить товар?')"
                  >
                    Удалить
                  </a>
                `
                : ""
            }
          </p>

        </li>

        <hr>
      `;
    }

    productsHtml += "</ul>";
  }

  return sendHtml(
    res,
    renderPage(
      req,
      "Каталог",
      `
        <h1>
          Каталог товаров
        </h1>

        <p>
          Найдено товаров: ${products.length}
        </p>

<form method="GET" action="/catalog">

<div style="position:relative;">

  <input
    type="text"
    name="search"
    value="${escapeHtml(searchQuery)}"
    placeholder="Поиск товара"
  >

  <div
  id="search-suggestions"
  style="
    display:none;
    position:absolute;
    z-index:1000;
    background:white;
    border:1px solid #ccc;
    width:100%;
    box-sizing:border-box;
  "
></div>

</div>

${catalogStateHiddenHtml.replace(
  /<input\s+type="hidden"\s+name="search"\s+value="[^"]*"\s*>\s*/i,
  ""
)}

  <button type="submit">
    Найти
  </button>

</form>

<details>
  <summary>Фильтры</summary>

  <form method="GET" action="/catalog">

    <input
      type="hidden"
      name="search"
      value="${escapeHtml(searchQuery)}"
    >

    <input
      type="hidden"
      name="category"
      value="${escapeHtml(categoryFilter || "")}"
    >

    <p>
      <label>
        Цена от:
        <input
          type="number"
          name="price_min"
          value="${escapeHtml(priceMin)}"
        >
      </label>
    </p>

    <p>
      <label>
        Цена до:
        <input
          type="number"
          name="price_max"
          value="${escapeHtml(priceMax)}"
        >
      </label>
    </p>

        <fieldset>
      <legend>Наличие</legend>

      <label>
        <input
          type="checkbox"
          name="availability"
          value="in_stock"
          ${selectedAvailability.includes("in_stock") ? "checked" : ""}
        >
        В наличии
      </label>

      <br>

      <label>
        <input
          type="checkbox"
          name="availability"
          value="on_order"
          ${selectedAvailability.includes("on_order") ? "checked" : ""}
        >
        Под заказ
      </label>

      <br>

      <label>
        <input
          type="checkbox"
          name="availability"
          value="out_of_stock"
          ${selectedAvailability.includes("out_of_stock") ? "checked" : ""}
        >
        Нет в наличии
      </label>
    </fieldset>

<fieldset>    
  <legend>Бренд</legend>

  ${
    availableBrands.length
      ? availableBrands.map(brand => `
  <label>
    <input
      type="checkbox"
      name="brand"
      value="${brand.id}"
      ${selectedBrands.includes(String(brand.id)) ? "checked" : ""}
    >
    ${escapeHtml(brand.name)}
  </label>
  <br>
`).join("")
      : "<p>Брендов пока нет.</p>"
  }
</fieldset>

    ${
      catalogFilterData.map(characteristic => `
        <fieldset>
          <legend>
            ${escapeHtml(characteristic.name)}
          </legend>

          ${
            characteristic.values.length > 0
              ? characteristic.values.map(value => `
                  <label>
                    <input
                      type="checkbox"
                      name="filter_${characteristic.id}"
                      value="${escapeHtml(value)}"
                      ${
                        (
                          selectedFilters[characteristic.id] || []
                        ).includes(value)
                          ? "checked"
                          : ""
                      }
                    >
                      ${escapeHtml(value)}
                  </label>
                  <br>
                `).join("")
              : "<p>Значений пока нет.</p>"
          }
        </fieldset>
      `).join("")
    }

    <fieldset>
  <legend>Сортировка</legend>

  <select name="sort">
    <option value="" ${sort === "" ? "selected" : ""}>
      По умолчанию
    </option>

    <option value="price_asc" ${sort === "price_asc" ? "selected" : ""}>
      Дешевле
    </option>

    <option value="price_desc" ${sort === "price_desc" ? "selected" : ""}>
      Дороже
    </option>

    <option value="popular" ${sort === "popular" ? "selected" : ""}>
      Популярные
    </option>
  </select>
</fieldset>

    <button type="submit">
      Применить
    </button>

  </form>

<a href="/catalog">
  Сбросить фильтры
</a>

</details>

        <p>
          ${categoryLinks}
        </p>

        ${productsHtml}

<script>
  const searchInput =
    document.querySelector('input[name="search"]');

  const searchSuggestions =
    document.getElementById("search-suggestions");

searchInput.addEventListener("input", async () => {
  const query =
    searchInput.value.trim();

  if (!query) {
    searchSuggestions.innerHTML = "";
    searchSuggestions.style.display = "none";
    return;
  }

  const response =
    await fetch(
      "/search-suggestions?q=" +
      encodeURIComponent(query)
    );

    if (!response.ok) {
  console.error(
    "Ошибка подсказок:",
    response.status
  );
  return;
}

  const suggestions =
    await response.json();

  if (suggestions.length === 0) {
    searchSuggestions.innerHTML = "";
    searchSuggestions.style.display = "none";
    return;
  }

 searchSuggestions.innerHTML =
  suggestions.map(product =>
    '<div class="search-suggestion" data-value="' +
    product.name.replace(/"/g, "&quot;") +
    '">' +
    product.name +
    '</div>'
  ).join("");

  searchSuggestions.style.display = "block";
});

searchSuggestions.addEventListener("click", (event) => {
  const suggestion =
    event.target.closest(".search-suggestion");

  if (!suggestion) {
    return;
  }

  searchInput.value =
    suggestion.dataset.value;

  searchSuggestions.innerHTML = "";
  searchSuggestions.style.display = "none";
});

    </script>

      `
    )
  );
}

// ==================================================
// КАРТОЧКА ТОВАРА
// ==================================================

if (
  req.method === "GET" &&
  /^\/product\/\d+$/.test(path)
) {

  const id =
    Number(path.split("/")[2]);

  const product =
    db.prepare(`
      SELECT *
      FROM products
      WHERE id = ?
        AND deleted = 0
    `).get(id);

  if (!product) {
    return sendHtml(
      res,
      renderPage(
        req,
        "Товар не найден",
        `
          <h1>Товар не найден</h1>

          <p>
            <a href="/catalog">
              Вернуться в каталог
            </a>
          </p>
        `
      ),
      404
    );
  }

  const names =
    getProductCategoryNames(id);

    const brand =
  product.brand_id
    ? db.prepare(`
        SELECT name
        FROM brands
        WHERE id = ?
      `).get(product.brand_id)?.name || ""
    : "";

  const characteristics =
    getProductCharacteristics(id);

  let characteristicsHtml = "";

  for (const characteristic of characteristics) {
    characteristicsHtml += `
      <p>
        <strong>
          ${escapeHtml(characteristic.name)}:
        </strong>
        ${escapeHtml(characteristic.value || "")}
      </p>
    `;
  }

  return sendHtml(
    res,
    renderPage(
      req,
      product.name,
      `
        <h1>
          ${escapeHtml(product.name)}
        </h1>

        <p>Бренд: ${escapeHtml(brand || "—")}</p>

        ${
          product.image
            ? `
              <p>
                <img
                  src="${escapeHtml(product.image)}"
                  alt="${escapeHtml(product.name)}"
                  style="max-width:600px;width:100%;height:auto;"
                >
              </p>
            `
            : ""
        }

        <p>
          <strong>
            ${
  product.price_on_request
    ? "Цена по запросу"
    : Number(product.discount_percent) > 0
      ? `<s>${product.price} ${product.currency}</s>
         → ${product.price * (1 - product.discount_percent / 100)}
         ${product.currency} / ${product.unit}
         (−${product.discount_percent}%)`
      : `${product.price} ${product.currency} / ${product.unit}`
}
          </strong>
        </p>

        <p>
          Наличие:
          ${
            product.availability === "in_stock"
              ? "В наличии"
              : product.availability === "on_order"
                ? "Под заказ"
                : "Нет в наличии"
          }
        </p>

                <p>
          ${
            Number(product.discount_percent) > 0
              ? "Акция "
              : ""
          }
          ${
            product.is_new
              ? "Новинка "
              : ""
          }
          ${
            product.is_hit
              ? "Хит"
              : ""
          }
        </p>

        <p>
          ${escapeHtml(product.description || "")}
        </p>

        ${characteristicsHtml}

        <p>
          Категории:
          ${escapeHtml(names.join(", ") || "—")}
        </p>

        <p>
<a href="/cart/add/${id}">
              В корзину
          </a>
        </p>

        ${
          isAdmin(req)
            ? `
              <p>
                <a href="/edit-product/${id}">
                  Редактировать товар
                </a>
              </p>
            `
            : ""
        }
      `
    )
  );
}

        // ==================================================
        // КОРЗИНА
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/cart"
        ) {

          const items =
            getCartItems(req);


          if (
            items.length === 0
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Корзина",
                `
                  <h1>
                    Корзина
                  </h1>

                  <p>
                    Корзина пуста.
                  </p>
                `
              )
            );
          }


          const total =
            items.reduce(
              (sum, item) =>
                sum + item.sum,
              0
            );


          let itemsHtml =
            "<ul>";


          for (
            const item
            of items
          ) {

            itemsHtml += `
              <li>

                ${escapeHtml(
                  item.name
                )}

                —
            ${
  item.price_on_request
    ? "Цена по запросу"
    : Number(item.discount_percent) > 0
      ? `<s>${item.price} ${item.currency}</s> → ${item.price * (1 - item.discount_percent / 100)} ${item.currency}`
      : `${item.price} ${item.currency}`
}

                ×
                ${item.quantity}

                =
                ${item.sum}
                ${item.currency}

                <a
                  href="/cart/remove/${item.id}"
                >
                  Убрать
                </a>

              </li>
            `;
          }


          itemsHtml +=
            "</ul>";


          return sendHtml(
            res,
            renderPage(
              req,
              "Корзина",
              `
                <h1>
                  Корзина
                </h1>

                ${itemsHtml}

                <p>
                  <strong>
                    Итого:
                  ${total}
                  ${items[0].currency}
                  </strong>
                </p>

                <p>

                  <a href="/checkout">
                    Оформить заказ
                  </a>

                  |

                  <a href="/cart/clear">
                    Очистить корзину
                  </a>

                </p>
              `
            )
          );
        }


        // ==================================================
        // ДОБАВИТЬ В КОРЗИНУ
        // ==================================================

        if (
          req.method === "GET" &&
          path.startsWith(
            "/cart/add/"
          )
        ) {

          const id =
            Number(
              path.split("/")[3]
            );


          const product =
            db.prepare(`
              SELECT id, currency
              FROM products
              WHERE id = ?
                  AND deleted = 0
              `).get(id);


          if (!product) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Товар не найден",
                `
                  <h1>
                    Товар не найден
                  </h1>
                `
              ),
              404
            );
          }

                const cart =
        getCartItems(req);

      if (
        cart.length > 0 &&
        cart.some(item =>
          item.currency !== product.currency
        )
      ) {
        return sendHtml(
          res,
          renderPage(
            req,
            "Нельзя добавить товар",
            `
              <h1>
                Нельзя добавить товар
              </h1>

              <p>
                В корзине уже есть товары
                в другой валюте.
              </p>

              <p>
                Очистите корзину или выберите
                товар в той же валюте.
              </p>

              <p>
                <a href="/cart">
                  Вернуться в корзину
                </a>
              </p>
            `
          ),
          400
        );
      }

          const currentCart =
            getCart(req);


          currentCart[id] =
            (
              Number(
                currentCart[id]
              ) || 0
            ) + 1;


          setCart(
            res,
            currentCart
          );


          return redirect(
            res,
            "/cart"
          );
        }


        // ==================================================
        // УДАЛИТЬ ИЗ КОРЗИНЫ
        // ==================================================

        if (
          req.method === "GET" &&
          path.startsWith(
            "/cart/remove/"
          )
        ) {

          const id =
            Number(
              path.split("/")[3]
            );


          const currentCart =
            getCart(req);


          delete currentCart[id];


          setCart(
            res,
            currentCart
          );


          return redirect(
            res,
            "/cart"
          );
        }


        // ==================================================
        // ОЧИСТИТЬ КОРЗИНУ
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/cart/clear"
        ) {

          setCart(
            res,
            {}
          );


          return redirect(
            res,
            "/cart"
          );
        }


        // ==================================================
        // ОФОРМЛЕНИЕ ЗАКАЗА — GET
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/checkout"
        ) {

          const items =
            getCartItems(req);


          if (
            items.length === 0
          ) {

            return redirect(
              res,
              "/cart"
            );
          }

          const currency =
  items[0].currency || "BYN";

          const total =
            items.reduce(
              (sum, item) =>
                sum + item.sum,
              0
            );

            const hasPriceOnRequest =
  items.some(item => item.price_on_request);

          return sendHtml(
            res,
            renderPage(
              req,
              "Оформление заказа",
              `
                <h1>
                  Оформление заказа
                </h1>

                <p>
                  Сумма заказа:
                    <strong>
                      ${
                        hasPriceOnRequest
                        ? "Уточняется менеджером"
                        : `${total} ${currency}`
                      }
                    </strong>
                </p>

                <form
                  method="POST"
                  action="/checkout"
                   novalidate
                >

                  <p>
                    Имя:
                    <input
                      name="name"
                      required
                    >

                    <small
                    id="name-error"
                    style="display:none; color:red;"
                  >
                    Укажите имя
                  </small>
                </p>

                  <p>
                    Телефон:
                    <input
                      type="tel"
                      name="phone"
                      inputmode="tel"
                      pattern=".{7,}"
                      required
                    >

                    <small
                      id="phone-error"
                      style="display:none; color:red;"
                    >
                      Номер телефона указан некорректно
                    </small>
                  </p>

                  <p>
                    Адрес:
                    <input
                      name="address"
                    >

                    <small
                      id="address-error"
                      style="display:none; color:red;"
                    >
                      Укажите адрес
                    </small>
                  </p>

                  <p>
                    Email:
                    <input
                      type="email"
                      name="email"
                    >

                    <small
  id="email-error"
  style="display:none; color:red;"
>
  Введите корректный адрес электронной почты
</small>
                  </p>

                  <p>
                    Комментарий:
                    <br>
                    <textarea
                      name="comment"
                    ></textarea>
                  </p>

                  <p>
                    Вид оплаты:

                    <select
                      name="payment"
                      required
                    >
                      <option value="cash">
                        Наличные
                      </option>

                      <option value="card">
                        Карта при получении
                      </option>

                      <option value="installment">
                        Рассрочка
                      </option>
                    </select>
                  </p>

                  <p>
                    Вид получения:

                    <select
                      name="delivery"
                      required
                    >
                      <option value="delivery">
                        Доставка
                      </option>

                      <option value="pickup">
                        Самовывоз
                      </option>
                    </select>
                  </p>

                  <p>
                    <label>

                      <input
                        type="checkbox"
                        name="agree"
                        value="1"
                        required
                      >

                      <small
  id="agree-error"
  style="display:none; color:red;"
>
  Необходимо согласиться на обработку персональных данных
</small>

                      Согласен
                      на обработку
                      персональных данных

                    </label>
                  </p>

                  <button>
                    Отправить заявку
                  </button>

                  <script>
  const checkoutForm =
    document.querySelector('form[action="/checkout"]');

  const nameInput =
    checkoutForm.querySelector('input[name="name"]');

  const phoneInput =
    checkoutForm.querySelector('input[name="phone"]');

  const addressInput =
    checkoutForm.querySelector('input[name="address"]');

    const deliveryInput =
  checkoutForm.querySelector('select[name="delivery"]');

  const nameError =
    checkoutForm.querySelector('#name-error');

  const phoneError =
    checkoutForm.querySelector('#phone-error');

  const addressError =
    checkoutForm.querySelector('#address-error');

    const agreeInput =
checkoutForm.querySelector('input[name="agree"]');

const agreeError =
checkoutForm.querySelector('#agree-error');

const emailInput =
checkoutForm.querySelector('input[name="email"]');

const emailError =
checkoutForm.querySelector('#email-error');

     function isValidPhone(phone) {
  const digits = phone.replace(/[^0-9]/g, "");

  if (digits.length === 11) {
    if (
      digits.startsWith("7") ||
      digits.startsWith("8")
    ) {
      return true;
    }
  }

  if (
    digits.length === 12 &&
    digits.startsWith("375")
  ) {
    return true;
  }

  return false;
}

  checkoutForm.addEventListener("submit", (event) => {

    let valid = true;

    nameError.style.display = "none";
    phoneError.style.display = "none";
    addressError.style.display = "none";
    agreeError.style.display = "none";

if (!agreeInput.checked) {
  agreeError.style.display = "block";
  valid = false;
}

const email = emailInput.value.trim();

if (
  email &&
!emailInput.checkValidity()
) {
  emailError.style.display = "block";
  valid = false;
}

    if (!nameInput.value.trim()) {
      nameError.style.display = "block";
      valid = false;
    }

    const phone =
  phoneInput.value.trim();

if (!isValidPhone(phone)) {

      phoneError.style.display = "block";
      valid = false;
    }

    if (
  deliveryInput.value === "delivery" &&
  !addressInput.value.trim()
) {
  addressError.style.display = "block";
  valid = false;
}

    if (!valid) {
      event.preventDefault();
    }
  });

  nameInput.addEventListener("input", () => {
    if (nameInput.value.trim()) {
      nameError.style.display = "none";
    }
  });

  phoneInput.addEventListener("input", () => {

    const phone =
  phoneInput.value.trim();

if (isValidPhone(phone)) {

      phoneError.style.display = "none";
    }
  });

  addressInput.addEventListener("input", () => {
    if (addressInput.value.trim()) {
      addressError.style.display = "none";
    }
  });
</script>

                </form>
              `
            )
          );
        }


        // ==================================================
        // ОФОРМЛЕНИЕ ЗАКАЗА — POST
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/checkout"
        ) {

          const params =
            await readBody(req);


          if (
            params.get("agree") !==
            "1"
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Ошибка
                  </h1>

                  <p>
                    Необходимо согласиться
                    на обработку данных.
                  </p>

                  <p>
                    <a href="/checkout">
                      Вернуться
                    </a>
                  </p>
                `
              ),
              400
            );
          }


          const items =
            getCartItems(req);


          if (
            items.length === 0
          ) {

            return redirect(
              res,
              "/cart"
            );
          }

          const currency =
  items[0].currency || "BYN";

          const name =
            params.get("name")
              ?.trim() || "";

          const phone =
            params.get("phone")
              ?.trim() || "";

          const address =
            params.get("address")
              ?.trim() || "";

         if (
  !name ||
  !phone ||
  (
    params.get("delivery") === "delivery" &&
    !address
  )
) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Заполните
                    обязательные поля.
                  </h1>
                `
              ),
              400
            );
          }


          const total =
            items.reduce(
              (sum, item) =>
                sum + item.sum,
              0
            );


          const result =
            db.prepare(`
              INSERT INTO orders
              (
                name,
                phone,
                address,
                total,
                currency,
                created_at,
                status
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              name,
              phone,
              address,
              total,
              currency,
              new Date().toISOString(),
              "Новый"
            );


          const orderId =
            Number(
              result.lastInsertRowid
            );


          const insertItem =
            db.prepare(`
              INSERT INTO order_items
              (
                order_id,
                product_id,
                product_name,
                price,
                quantity,
                sum,
                price_on_request
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);


          for (
            const item
            of items
          ) {

            insertItem.run(
              orderId,
              item.id,
              item.name,
              item.price,
              item.quantity,
              item.sum,
              item.price_on_request ? 1 : 0
            );
          }


          setCart(
            res,
            {}
          );


          return sendHtml(
            res,
            renderPage(
              req,
              "Заказ принят",
              `
                <h1>
                  Спасибо за заказ!
                </h1>

                <p>
                  Номер заказа:
                  <strong>
                    №${orderId}
                  </strong>
                </p>

                <p>
                  Сумма:
                  <strong>
                    ${total}
                    ${currency}
                  </strong>
                </p>

                <p>
                  <a href="/catalog">
                    Вернуться в каталог
                  </a>
                </p>
              `
            )
          );
        }


        // ==================================================
        // ЗАКАЗЫ — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/orders"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const orders =
            db.prepare(`
              SELECT
  orders.*,
  EXISTS (
    SELECT 1
    FROM order_items
    WHERE order_items.order_id = orders.id
      AND order_items.price_on_request = 1
  ) AS has_price_on_request
FROM orders
ORDER BY id DESC
            `).all();


          let content =
            "<h1>Заказы</h1>";


          if (
            orders.length === 0
          ) {

            content +=
              "<p>Заказов пока нет.</p>";

          } else {

            content +=
              "<ul>";


            for (
              const order
              of orders
            ) {

              content += `
                <li>

                  <strong>
                    Заказ №${order.id}
                  </strong>

                  —
                  ${escapeHtml(
                    order.name
                  )}

                  —
                 ${order.has_price_on_request ? "Уточняется менеджером" : order.total}
                  ${order.has_price_on_request ? "" : order.currency}

                  —
                  ${escapeHtml(
                    order.status
                  )}

                  <br>

                  <a
                    href="/orders/${order.id}"
                  >
                    Открыть заказ
                  </a>

                  |

                  <a
                    href="/orders/delete/${order.id}"
                    onclick="return confirm('Удалить заказ?')"
                  >
                    Удалить
                  </a>

                </li>
              `;
            }


            content +=
              "</ul>";
          }


          return sendHtml(
            res,
            renderPage(
              req,
              "Заказы",
              content
            )
          );
        }


        // ==================================================
        // ПРОСМОТР ЗАКАЗА — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/orders\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const orderId =
            Number(
              path.split("/")[2]
            );


          const order =
            db.prepare(`
              SELECT *
              FROM orders
              WHERE id = ?
                  AND deleted = 0
            `).get(orderId);


          if (!order) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Заказ не найден",
                `
                  <h1>
                    Заказ не найден
                  </h1>

                  <p>
                    <a href="/orders">
                      Назад
                    </a>
                  </p>
                `
              ),
              404
            );
          }


          const items =
            db.prepare(`
              SELECT *
              FROM order_items
              WHERE order_id = ?
            `).all(orderId);


          let itemsHtml =
            "<ul>";


          for (
            const item
            of items
          ) {

            itemsHtml += `
              <li>

                ${escapeHtml(
                  item.product_name
                )}

                ×
                ${item.quantity}

                —
               ${item.price_on_request ? "Цена по запросу" : item.sum}
                ${item.price_on_request ? "" : currency}

              </li>
            `;
          }

          itemsHtml +=
            "</ul>";

          return sendHtml(
            res,
            renderPage(
              req,
              `Заказ №${orderId}`,
              `
                <h1>
                  Заказ №${orderId}
                </h1>

                <p>
                  Имя:
                  ${escapeHtml(
                    order.name
                  )}
                </p>

                <p>
                  Телефон:
                  ${escapeHtml(
                    order.phone
                  )}
                </p>

                <p>
                  Адрес:
                  ${escapeHtml(
                    order.address
                  )}
                </p>

                <p>
                  Статус:
                  ${escapeHtml(
                    order.status
                  )}
                </p>

                <h2>
                  Товары
                </h2>

                ${itemsHtml}

                <p>
                  <strong>
                    Итого:
${
  items.some(item => item.price_on_request)
    ? "Уточняется менеджером"
    : `${order.total} ${order.currency}`
}
                  </strong>
                </p>

                <p>
                  <a href="/orders">
                    ← Назад к заказам
                  </a>
                </p>
              `
            )
          );
        }

        // ==================================================
        // УДАЛЕНИЕ ЗАКАЗА — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path.startsWith(
            "/orders/delete/"
          )
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const orderId =
            Number(
              path.split("/")[3]
            );


          db.prepare(`
            DELETE FROM order_items
            WHERE order_id = ?
          `).run(orderId);


          db.prepare(`
            DELETE FROM orders
            WHERE id = ?
          `).run(orderId);


          return redirect(
            res,
            "/orders"
          );
        }


        // ==================================================
        // ДОБАВИТЬ ТОВАР — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/add-product"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

const priceError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("priceError") || "";

  const sortOrderError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("sortOrderError") || "";

  const queryParams =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  );

  const priceValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("price") || "";

const discountValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("discount") || "0";

  const unitValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("unit") || "шт.";

  const nameValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("name") || "";

  const skuValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("sku") || "";

const brandValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("brand_id") || "";

  const currencyValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("currency") || "";

  const availabilityValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("availability") || "";

  const categoryValues =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("category_ids")
    ?.split(",")
    .filter(Boolean) || [];

  const descriptionValue =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("description") || "";

          const cats =
            getCategories();

          const categoryCharacteristicRows =
            getCategoryCharacteristicRows();

           const characteristicValues =
  new Map();

const characteristicsParam =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("characteristics") || "";

for (
  const item of characteristicsParam.split("|")
) {
  if (!item) {
    continue;
  }

  const separatorIndex =
    item.indexOf(":");

  if (separatorIndex === -1) {
    continue;
  }

  const id =
    Number(
      item.slice(0, separatorIndex)
    );

  const value =
    item.slice(
      separatorIndex + 1
    );

  if (
    Number.isInteger(id) &&
    value
  ) {
    characteristicValues.set(
      id,
      value
    );
  }
}

          return sendHtml(
            res,
            renderPage(
              req,
              "Добавить товар",
              `
                <h1>
                  Добавить товар
                </h1>

                <form
                  method="POST"
                  action="/add-product"
                  enctype="multipart/form-data"
                >

                  <p>
  Название:

  <input
    type="text"
    name="name"
    required
    value="${escapeHtml(nameValue)}"
  >
</p>
                    <p>
  Цена:

  <input
    type="number"
    name="price"
    min="0"
    required
    value="${priceValue || ""}"
  >

                  </p>

                  <p style="color:red;">
  ${priceError || ""}
</p>  

                  <p>
                    Цена по запросу:

                    <input
                      type="checkbox"
                      name="price_on_request"
                      value="1"
                    >
                  </p>

                  <p>
                  Скидка (%):
                  <input
                    type="number"
                    name="discount_percent"
                    min="0"
                    max="100"
                    step="1"
                    value="${escapeHtml(discountValue)}"                  >
                </p>

                <p>
  <label>
    <input
      type="checkbox"
      name="is_new"
      value="1"
    >
    Новинка
  </label>
</p>

<p>
  <label>
    <input
      type="checkbox"
      name="is_hit"
      value="1"
    >
    Хит
  </label>
</p>

<p>
  Порядок:

  <input
    type="number"
    name="sort_order"
    value="0"
  >
</p>

<p style="color:red;">
  ${sortOrderError || ""}
</p>

                  <p>
                    Единица измерения:

                 <select name="unit">
                  <option value="шт." ${unitValue === "шт." ? "selected" : ""}>шт. — штука</option>
                  <option value="компл." ${unitValue === "компл." ? "selected" : ""}>компл. — комплект</option>
                  <option value="кг" ${unitValue === "кг" ? "selected" : ""}>кг — килограмм</option>
                  <option value="г" ${unitValue === "г" ? "selected" : ""}>г — грамм</option>
                  <option value="т" ${unitValue === "т" ? "selected" : ""}>т — тонна</option>
                  <option value="м" ${unitValue === "м" ? "selected" : ""}>м — метр</option>
                  <option value="см" ${unitValue === "см" ? "selected" : ""}>см — сантиметр</option>
                  <option value="мм" ${unitValue === "мм" ? "selected" : ""}>мм — миллиметр</option>
                  <option value="км" ${unitValue === "км" ? "selected" : ""}>км — километр</option>
                  <option value="м²" ${unitValue === "м²" ? "selected" : ""}>м² — квадратный метр</option>
                  <option value="см²" ${unitValue === "см²" ? "selected" : ""}>см² — квадратный сантиметр</option>
                  <option value="м³" ${unitValue === "м³" ? "selected" : ""}>м³ — кубический метр</option>
                  <option value="л" ${unitValue === "л" ? "selected" : ""}>л — литр</option>
                  <option value="мл" ${unitValue === "мл" ? "selected" : ""}>мл — миллилитр</option>
                  <option value="ч" ${unitValue === "ч" ? "selected" : ""}>ч — час</option>
                  <option value="мин" ${unitValue === "мин" ? "selected" : ""}>мин — минута</option>
                  </select>
                  </p>

                  <p>
                    Описание:

                    <br>

                    <textarea
  name="description"
  required
>${escapeHtml(descriptionValue)}</textarea>
                  </p>

                                    <p>
                    Изображение товара:

                    <br>

                    <input
  type="file"
  name="image"
  accept="image/jpeg,image/png,image/webp,image/gif"
>
                  </p>

                  <p>
                    Артикул:

                    <br>

                   <input
  type="text"
  name="sku"
  placeholder="Например: DEWALT-DCD777"
  value="${escapeHtml(skuValue)}"
>
                  </p>

                  <p>
                    Бренд / производитель:

                    <br>

                    <select name="brand_id">
  <option value="">Без бренда</option>
  ${db.prepare("SELECT id, name FROM brands ORDER BY name").all().map(brand => `
<option value="${brand.id}" ${String(brand.id) === String(brandValue) ? "selected" : ""}>${escapeHtml(brand.name)}</option>
  `).join("")}
</select>
                  </p>

                                    <p>
                    Валюта:

                    <select name="currency">
                      <option value="BYN" ${currencyValue === "BYN" ? "selected" : ""}>BYN</option>
                      <option value="USD" ${currencyValue === "USD" ? "selected" : ""}>USD</option>
                    </select>
                  </p>


                  <p>
                    Наличие:

                    <select name="availability">
                      <option value="in_stock" ${availabilityValue === "in_stock" ? "selected" : ""}>В наличии</option>
                      <option value="on_order" ${availabilityValue === "on_order" ? "selected" : ""}>Под заказ</option>
                      <option value="out_of_stock" ${availabilityValue === "out_of_stock" ? "selected" : ""}>Нет в наличии</option>
                    </select>
                  </p>

                  <p>
                    Категории:

                    <br>

                    <select
                      id="product-categories"
                      name="category_ids"
                      multiple
                      size="8"
                    >

                      ${renderCategoryOptions(
  cats,
  null,
  0,
  null,
  null,
  categoryValues
)}

                    </select>
                  </p>

                  <p>
                    Можно выбрать
                    несколько категорий.
                  </p>

                  ${renderCharacteristicInputs(
                    categoryCharacteristicRows,
                    characteristicValues
                  )}

                  <button>
                    Сохранить
                  </button>

                </form>

                ${renderCharacteristicSelectionScript()}
              `
            )
          );
        }


        // ==================================================
        // ДОБАВИТЬ ТОВАР — POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/add-product"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const contentType =
  req.headers["content-type"] || "";

const rawBody =
  await readRawBody(req);

const params =
  parseMultipartBody(
    rawBody,
    contentType
  );


          const name =
            params.get("name")
              ?.trim() || "";


          const price =
            Number(
              params.get("price")
            );

            const submittedCharacteristics =
  getSubmittedCharacteristicValues(
    params,
    getCharacteristics()
  );


  
           if (price <= 0) {
  return redirect(
    res,
`/add-product?name=${encodeURIComponent(params.get("name") || "")}&sku=${encodeURIComponent(params.get("sku") || "")}&brand_id=${encodeURIComponent(params.get("brand_id") || "")}&currency=${encodeURIComponent(params.get("currency") || "")}&availability=${encodeURIComponent(params.get("availability") || "")}&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}&price=&characteristics=${encodeURIComponent(
  submittedCharacteristics
    .map(item => `${item.characteristicId}:${item.value}`)
    .join("|")
)}&price=${encodeURIComponent(params.get("price") || "")}&description=${encodeURIComponent(params.get("description") || "")}&discount=${encodeURIComponent(params.get("discount_percent") || "0")}&unit=${encodeURIComponent(params.get("unit") || "шт.")}&priceError=%D0%A6%D0%B5%D0%BD%D0%B0%20%D0%B4%D0%BE%D0%BB%D0%B6%D0%BD%D0%B0%20%D0%B1%D1%8B%D1%82%D1%8C%20%D0%B1%D0%BE%D0%BB%D1%8C%D1%88%D0%B5%200.`
  );
}

          const description =
            params.get("description")
              ?.trim() || "";

const imageFile =
  params.getFile("image");

const image =
  imageFile
    ? saveUploadedImage(imageFile)
    : "";

          const sku =
            params.get("sku")
              ?.trim() || "";

          const brandId = Number(params.get("brand_id")) || null;

              const currency =
          params.get("currency") || "BYN";

              const availability =
          params.get("availability") || "in_stock";

                  const priceOnRequest =
          params.get("price_on_request") === "1"
            ? 1
            : 0;

        const discountPercent =
          Number(params.get("discount_percent")) || 0;

        const unit =
          params.get("unit") || "шт.";

const isNew =
  params.get("is_new") === "1"
    ? 1
    : 0;

const isHit =
  params.get("is_hit") === "1"
    ? 1
    : 0;

    const sortOrder =
  Number(
    params.get("sort_order") || 0
  );

  if (sortOrder < 1) {
  return redirect(
    res,
    `/add-product?name=${encodeURIComponent(params.get("name") || "")}` +
      `&sku=${encodeURIComponent(params.get("sku") || "")}` +
      `&brand_id=${encodeURIComponent(params.get("brand_id") || "")}` +
      `&currency=${encodeURIComponent(params.get("currency") || "")}` +
      `&availability=${encodeURIComponent(params.get("availability") || "")}` +
      `&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}` +
      `&price=${encodeURIComponent(params.get("price") || "")}` +
      `&description=${encodeURIComponent(params.get("description") || "")}` +
      `&discount=${encodeURIComponent(params.get("discount_percent") || "0")}` +
      `&unit=${encodeURIComponent(params.get("unit") || "шт.")}` +
      `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
      `&sortOrderError=${encodeURIComponent("Порядок должен быть больше 0.")}`
  );
}

          const categoryIds =
            params
              .getAll("category_ids")
              .map(Number)
              .filter(
                Number.isInteger
              );

          const characteristicValues =
            getSubmittedCharacteristicValues(
              params,
              getCharacteristicsForCategoryIds(
                categoryIds
              )
            );


          if (
            !name ||
            !Number.isFinite(price) ||
            price < 0 ||
            !description
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Заполните
                    все поля правильно.
                  </h1>
                `
              ),
              400
            );
          }

      

          const result =
            db.prepare(`
              INSERT INTO products
            (
              name,
              price,
              description,
              category_id,
              image,
              sku,
              brand_id,
              currency,
              availability,
              price_on_request,
              unit,
              discount_percent,
              is_new,
              is_hit,
              sort_order
            )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
            name,
            price,
            description,
            categoryIds[0] ||
            null,
            image,
            sku,
            brandId,
            currency,
            availability,
            priceOnRequest,
            unit,
            discountPercent,
            isNew,
            isHit,
            sortOrder
          );


          const productId =
            Number(
              result.lastInsertRowid
            );


          saveProductCategories(
            productId,
            categoryIds
          );

          for (const characteristic of characteristicValues) {
            db.prepare(`
              INSERT INTO product_characteristics
              (
                product_id,
                characteristic_id,
                value
              )
              VALUES (?, ?, ?)
            `).run(
              productId,
              characteristic.characteristicId,
              characteristic.value
            );
          }


          return redirect(
            res,
            "/catalog"
          );
        }


        // ==================================================
        // РЕДАКТИРОВАТЬ ТОВАР — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/edit-product\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const id =
            Number(
              path.split("/")[2]
            );

          const product =
            db.prepare(`
              SELECT *
              FROM products
              WHERE id = ?
            `).get(id);


          if (!product) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Товар не найден",
                `
                  <h1>
                    Товар не найден
                  </h1>
                `
              ),
              404
            );
          }


          const cats =
            getCategories();

          const selectedIds =
            getProductCategoryIds(
              id
            );

          const categoryCharacteristicRows =
            getCategoryCharacteristicRows();

          const valuesByCharacteristicId =
            new Map(
              getProductCharacteristics(id).map(
                characteristic => [
                  characteristic.id,
                  characteristic.value || ""
                ]
              )
            );


          let options =
            "";


          for (
            const category
            of cats
          ) {

            options += `
              <option
                value="${category.id}"
                ${
                  selectedIds.includes(
                    category.id
                  )
                    ? "selected"
                    : ""
                }
              >
                ${escapeHtml(
                  category.name
                )}
              </option>
            `;
          }

          const characteristicsHtml =
            renderCharacteristicInputs(
              categoryCharacteristicRows,
              valuesByCharacteristicId
            );

            const sortOrderError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("sortOrderError") || "";

  const queryParams =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  );

          return sendHtml(
            res,
            renderPage(
              req,
              "Редактировать товар",
              `
                <h1>
                  Редактировать товар
                </h1>

                <form
  method="POST"
  action="/edit-product/${id}"
  enctype="multipart/form-data"
>

                  <p>
                    Название:

                    <input
                      type="text"
                      name="name"
                      value="${escapeHtml(
  queryParams.get("name") ?? product.name
)}"

                      required
                    >
                  </p>

                  <p>
                    Цена: 

                    <input
                      type="number"
                      name="price"
                      min="0"
                      value="${priceValue || product.price}"
                      required
                    >
                  </p>

                  <p>
                    Скидка (%):

                    <input
                      type="number"
                      name="discount_percent"
                      min="0"
                      max="100"
                      step="1"
                      value="${product.discount_percent || 0}"
                    >
                  </p>

                  <p>
                    Цена по запросу:

                    <input
                      type="checkbox"
                      name="price_on_request"
                      value="1"
                      ${
                        product.price_on_request
                          ? "checked"
                          : ""
                      }
                    >
                  </p>

                  <p>
                  Единица измерения:

                  <select name="unit">
                    <option
                      value="шт."
                      ${
                        product.unit === "шт."
                          ? "selected"
                          : ""
                      }
                    >
                      шт. — штука
                    </option>

                    <option
                      value="компл."
                      ${
                        product.unit === "компл."
                          ? "selected"
                          : ""
                      }
                    >
                      компл. — комплект
                    </option>

                    <option
                      value="кг"
                      ${
                        product.unit === "кг"
                          ? "selected"
                          : ""
                      }
                    >
                      кг — килограмм
                    </option>

                    <option
                      value="г"
                      ${
                        product.unit === "г"
                          ? "selected"
                          : ""
                      }
                    >
                      г — грамм
                    </option>

                    <option
                      value="т"
                      ${
                        product.unit === "т"
                          ? "selected"
                          : ""
                      }
                    >
                      т — тонна
                    </option>

                    <option
                      value="м"
                      ${
                        product.unit === "м"
                          ? "selected"
                          : ""
                      }
                    >
                      м — метр
                    </option>

                    <option
                      value="см"
                      ${
                        product.unit === "см"
                          ? "selected"
                          : ""
                      }
                    >
                      см — сантиметр
                    </option>

                    <option
                      value="мм"
                      ${
                        product.unit === "мм"
                          ? "selected"
                          : ""
                      }
                    >
                      мм — миллиметр
                    </option>

                    <option
                      value="км"
                      ${
                        product.unit === "км"
                          ? "selected"
                          : ""
                      }
                    >
                      км — километр
                    </option>

                    <option
                      value="м²"
                      ${
                        product.unit === "м²"
                          ? "selected"
                          : ""
                      }
                    >
                      м² — квадратный метр
                    </option>

                    <option
                      value="см²"
                      ${
                        product.unit === "см²"
                          ? "selected"
                          : ""
                      }
                    >
                      см² — квадратный сантиметр
                    </option>

                    <option
                      value="м³"
                      ${
                        product.unit === "м³"
                          ? "selected"
                          : ""
                      }
                    >
                      м³ — кубический метр
                    </option>

                    <option
                      value="л"
                      ${
                        product.unit === "л"
                          ? "selected"
                          : ""
                      }
                    >
                      л — литр
                    </option>

                    <option
                      value="мл"
                      ${
                        product.unit === "мл"
                          ? "selected"
                          : ""
                      }
                    >
                      мл — миллилитр
                    </option>

                    <option
                      value="ч"
                      ${
                        product.unit === "ч"
                          ? "selected"
                          : ""
                      }
                    >
                      ч — час
                    </option>

                    <option
                      value="мин"
                      ${
                        product.unit === "мин"
                          ? "selected"
                          : ""
                      }
                    >
                      мин — минута
                    </option>
                  </select>
                </p>

                 <p>
                   Артикул:

                   <br>

                   <input
                     type="text"
                     name="sku"
                     value="${escapeHtml(product.sku || "")}"
                   >
                 </p>

                 <p>
                   Бренд / производитель:

                   <br>

                   <select name="brand_id">
  <option value="">Без бренда</option>
  ${db.prepare("SELECT id, name FROM brands ORDER BY name").all().map(brand => `
    <option value="${brand.id}" ${product.brand_id === brand.id ? "selected" : ""}>
      ${escapeHtml(brand.name)}
    </option>
  `).join("")}

</select>
                 </p>

                  <p>
                    Валюта:

                    <select name="currency">
                      <option
                        value="BYN"
                        ${
                          product.currency === "BYN"
                            ? "selected"
                            : ""
                        }
                      >
                        BYN
                      </option>

                      <option
                        value="USD"
                        ${
                          product.currency === "USD"
                            ? "selected"
                            : ""
                        }
                      >
                        USD
                      </option>
                    </select>
                  </p>

                        <p>
                  Наличие:

                  <select name="availability">
                    <option
                      value="in_stock"
                      ${
                        product.availability === "in_stock"
                          ? "selected"
                          : ""
                      }
                    >
                      В наличии
                    </option>

                    <option
                      value="on_order"
                      ${
                        product.availability === "on_order"
                          ? "selected"
                          : ""
                      }
                    >
                      Под заказ
                    </option>

                    <option
                      value="out_of_stock"
                      ${
                        product.availability === "out_of_stock"
                          ? "selected"
                          : ""
                      }
                    >
                      Нет в наличии
                    </option>
                  </select>
                </p>

                                 <p>
                   <label>
                     <input
                       type="checkbox"
                       name="is_new"
                       value="1"
                       ${product.is_new ? "checked" : ""}
                     >
                     Новинка
                   </label>
                 </p>

                 <p>
  <label>
    <input
      type="checkbox"
      name="is_hit"
      value="1"
      ${product.is_hit ? "checked" : ""}
    >
    Хит
  </label>
</p>

<p>
  Порядок:

  <input
    type="number"
    name="sort_order"
    value="${product.sort_order}"
  >
</p>

<p style="color:red;">
  ${sortOrderError || ""}
</p>

                  ${characteristicsHtml}  

                  <p>
                    Описание:

                    <br>

                    <textarea
                      name="description"
                      required
                    >
                    ${escapeHtml(
  queryParams.get("description") ?? product.description ?? ""
)}
                    </textarea>
                  </p>

                  <p>
                    Изображение товара:

                    <br>

                    <input
  type="file"
  name="image"
  accept="image/jpeg,image/png,image/webp,image/gif"
>
                  </p>

                  <p>
                    Категории:

                    <br>

                    <select
                      id="product-categories"
                      name="category_ids"
                      multiple
                      size="8"
                    >

                      ${options}

                    </select>
                  </p>

                  <button>
                    Сохранить
                  </button>

                </form>

                ${renderCharacteristicSelectionScript()}
              `
            )
          );
        }

        // ==================================================
// РЕДАКТИРОВАТЬ ТОВАР — POST
// ТОЛЬКО АДМИН
// ==================================================

if (
  req.method === "POST" &&
  /^\/edit-product\/\d+$/.test(path)
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const id = Number(path.split("/")[2]);

  const contentType = req.headers["content-type"] || "";
  const rawBody = await readRawBody(req);
  const params = parseMultipartBody(rawBody, contentType);

  const existingProduct =
    db.prepare(`
      SELECT *
      FROM products
      WHERE id = ?
    `).get(id);

  if (!existingProduct) {
    return sendHtml(
      res,
      renderPage(
        req,
        "Товар не найден",
        `<h1>Товар не найден</h1>`
      ),
      404
    );
  }

  const name = params.get("name")?.trim() || "";
  const price = Number(params.get("price"));
  const description = params.get("description")?.trim() || "";
  const sku = params.get("sku")?.trim() || "";  
const brandId = Number(params.get("brand_id")) || null;
  const currency = params.get("currency") || "BYN";

const availability =
  params.get("availability") || "in_stock";

  const priceOnRequest =
  params.get("price_on_request") === "1"
    ? 1
    : 0;

    const discountPercent =
  Number(params.get("discount_percent")) || 0;

    const unit =
  params.get("unit") || "шт.";

const isNew =
  params.get("is_new") === "1"
    ? 1
    : 0;

const isHit =
  params.get("is_hit") === "1"
    ? 1
    : 0;

    const sortOrder =
  Number(
    params.get("sort_order") || 0
  );

if (sortOrder < 1) {
  return redirect(
    res,
    `/edit-product/${id}?name=${encodeURIComponent(params.get("name") || "")}` +
      `&description=${encodeURIComponent(params.get("description") || "")}` +
      `&price=${encodeURIComponent(params.get("price") || "")}` +
      `&sortOrderError=${encodeURIComponent("Порядок должен быть больше 0.")}`
  );
}

  const categoryIds = params
    .getAll("category_ids")
    .map(Number)
    .filter(Boolean);

  const characteristicValues =
    getSubmittedCharacteristicValues(
      params,
      getCharacteristicsForCategoryIds(
        categoryIds
      )
    );

  const imageFile = params.getFile("image");

  const image =
    imageFile
      ? saveUploadedImage(imageFile)
      : existingProduct.image || "";

  db.prepare(`
    UPDATE products
    SET
      name = ?,
      price = ?,
      description = ?,
      sku = ?,
      brand_id = ?,
      category_id = ?,
      image = ?,
      currency = ?,
      availability = ?,
      price_on_request = ?,
      unit = ?,
      discount_percent = ?,
      is_new = ?,
      is_hit = ?,
      sort_order = ?
      WHERE id = ?

  `).run(
    name,
    price,
    description,
    sku,
    brandId,
    categoryIds[0] || null,
    image,
    currency,
    availability,
    priceOnRequest,
    unit,
    discountPercent,
    isNew,
    isHit,
    sortOrder,
    id,
  );

  db.prepare(`
    DELETE FROM product_characteristics
    WHERE product_id = ?
  `).run(id);

  for (
    const characteristic
    of characteristicValues
  ) {
    db.prepare(`
      INSERT INTO product_characteristics
      (
        product_id,
        characteristic_id,
        value
      )
      VALUES (?, ?, ?)
    `).run(
      id,
      characteristic.characteristicId,
      characteristic.value
    );
  }

  saveProductCategories(id, categoryIds);

  return redirect(res, "/catalog");
}

        // ==================================================
        // УДАЛИТЬ ТОВАР
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path.startsWith(
            "/delete-product/"
          )
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const id =
            Number(
              path.split("/")[2]
            );

         db.prepare(`
            UPDATE products
            SET deleted = 1
            WHERE id = ?
          `).run(id);


          return redirect(
            res,
            "/catalog"
          );
        }

// ==================================================
// УДАЛЁННЫЕ ТОВАРЫ — GET
// ТОЛЬКО АДМИН
// ==================================================

if (
  req.method === "GET" &&
  path === "/admin/deleted-products"
) {

  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  const deletedProducts =
    db.prepare(`
      SELECT *
      FROM products
      WHERE deleted = 1
      ORDER BY id DESC
    `).all();

  return sendHtml(
    res,
    renderPage(
      req,
      "Удалённые товары",
      `
        <h1>
          Удалённые товары
        </h1>

        <p>
          <a href="/admin">
            ← Назад в админ-панель
          </a>
        </p>

        ${
          deletedProducts.length === 0
            ? "<p>Удалённых товаров нет.</p>"
            : `
              <ul>
                ${deletedProducts.map(product => `
                  <li>
                    <strong>
                      ${escapeHtml(product.name)}
                    </strong>

                    <a href="/edit-product/${product.id}">
                      Редактировать
                    </a>

                    <form
                      method="POST"
                      action="/admin/deleted-products/restore/${product.id}"
                      style="display:inline"
                    >
                      <button type="submit">
                        Восстановить
                      </button>
                    </form>

                  </li>
                `).join("")}
              </ul>
            `
        }
      `
    )
  );
}

// ==================================================
// ВОССТАНОВИТЬ ТОВАР
// ТОЛЬКО АДМИН
// ==================================================

if (
  req.method === "POST" &&
  path.startsWith(
    "/admin/deleted-products/restore/"
  )
) {

  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  const id =
    Number(
      path.split("/")[4]
    );

  db.prepare(`
    UPDATE products
    SET deleted = 0
    WHERE id = ?
      AND deleted = 1
  `).run(id);

  return redirect(
    res,
    "/admin/deleted-products"
  );
}

        // ==================================================
        // КАТЕГОРИИ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/categories"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const cats =
            getCategories();


          return sendHtml(
            res,
            renderPage(
              req,
              "Категории",
              `
                <h1>
                  Управление категориями
                </h1>

                <p>
                  <a href="/admin">
                    ← Назад в админ-панель
                  </a>
                </p>

                <h2>
                  Добавить категорию
                </h2>

                <form
                  method="POST"
                  action="/admin/categories"
                >

                  <p>
                    Название:

                    <input
                      type="text"
                      name="name"
                      required
                    >
                  </p>

                  <p>
                    Родительская категория:

                    <select
                      name="parent_id"
                    >

                      <option value="">
                        Верхний уровень
                      </option>

                      ${renderCategoryOptions(
                        cats
                      )}

                    </select>
                  </p>

                  <p>
                    Порядок:

                    <input
                      type="number"
                      name="sort_order"
                      value="0"
                    >
                  </p>

                  <button>
                    Добавить категорию
                  </button>

                </form>

                <hr>

                <h2>
                  Категории
                </h2>

                <ul>
                  ${
                    renderCategoryTree(
                      cats
                    )
                  }
                </ul>
              `
            )
          );
        }


        // ==================================================
        // КАТЕГОРИИ — POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/categories"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const params =
            await readBody(req);


          const name =
            params.get("name")
              ?.trim() || "";


          const parentRaw =
            params.get("parent_id");


          const parentId =
            parentRaw
              ? Number(parentRaw)
              : null;


          const sortOrder =
            Number(
              params.get(
                "sort_order"
              ) || 0
            );


          const cats =
            getCategories();


          if (!name) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Введите название категории.
                  </h1>
                `
              ),
              400
            );
          }


          if (
            !Number.isFinite(
              sortOrder
            )
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Неверный порядок категории.
                  </h1>
                `
              ),
              400
            );
          }


          if (
            parentId !== null
          ) {

            const parent =
              cats.find(
                category =>
                  category.id ===
                  parentId
              );


            if (!parent) {

              return sendHtml(
                res,
                renderPage(
                  req,
                  "Ошибка",
                  `
                    <h1>
                      Родительская
                      категория
                      не найдена.
                    </h1>
                  `
                ),
                400
              );
            }


            const level =
              getCategoryLevel(
                parentId,
                cats
              );


            if (
              level >= 2
            ) {

              return sendHtml(
                res,
                renderPage(
                  req,
                  "Ошибка",
                  `
                    <h1>
                      Максимальная
                      вложенность —
                      3 уровня.
                    </h1>
                  `
                ),
                400
              );
            }
          }


          db.prepare(`
            INSERT INTO categories
            (
              name,
              parent_id,
              sort_order,
              hidden
            )
            VALUES (?, ?, ?, 0)
          `).run(
            name,
            parentId,
            sortOrder
          );


          return redirect(
            res,
            "/admin/categories"
          );
        }

            // ==================================================
    // БРЕНДЫ — EDIT GET
    // ТОЛЬКО АДМИН
    // ==================================================

    if (
      req.method === "GET" &&
      path.startsWith("/admin/brands/edit/")
    ) {

      if (
        !requireAdmin(
          req,
          res
        )
      ) {
        return;
      }

      const id =
        Number(
          path.split("/")[4]
        );

      const brand =
        db.prepare(`
          SELECT id, name
          FROM brands
          WHERE id = ?
        `).get(id);

      if (!brand) {

        return sendHtml(
          res,
          renderPage(
            req,
            "Ошибка",
            `
              <h1>
                Бренд не найден.
              </h1>

              <p>
                <a href="/admin/brands">
                  ← Назад к брендам
                </a>
              </p>
            `
          ),
          404
        );
      }

      return sendHtml(
        res,
        renderPage(
          req,
          "Редактирование бренда",
          `
            <h1>
              Редактирование бренда
            </h1>

            <p>
              <a href="/admin/brands">
                ← Назад к брендам
              </a>
            </p>

            <form
              method="POST"
              action="/admin/brands/edit/${brand.id}"
            >

              <p>
                Название:

                <input
                  type="text"
                  name="name"
                  value="${escapeHtml(brand.name)}"
                  required
                >
              </p>

              <button>
                Сохранить
              </button>

            </form>
          `
        )
      );
    }

            // ==================================================
    // БРЕНДЫ — POST
    // ТОЛЬКО АДМИН
    // ==================================================

    if (
      req.method === "POST" &&
      path === "/admin/brands"
    ) {

      if (
        !requireAdmin(
          req,
          res
        )
      ) {
        return;
      }

      const params =
        await readBody(req);

      const name =
        params.get("name")
          ?.trim() || "";

      if (!name) {

        return sendHtml(
          res,
          renderPage(
            req,
            "Ошибка",
            `
              <h1>
                Введите название бренда.
              </h1>
            `
          ),
          400
        );
      }

      db.prepare(`
        INSERT INTO brands
        (
          name
        )
        VALUES (?)
      `).run(
        name
      );

      return redirect(
        res,
        "/admin/brands"
      );
    }

        // ==================================================
    // БРЕНДЫ — EDIT POST
    // ТОЛЬКО АДМИН
    // ==================================================

    if (
      req.method === "POST" &&
      path.startsWith("/admin/brands/edit/")
    ) {

      if (
        !requireAdmin(
          req,
          res
        )
      ) {
        return;
      }

      const id =
        Number(
          path.split("/")[4]
        );

      const params =
        await readBody(req);

      const name =
        params.get("name")
          ?.trim() || "";

      if (!name) {

        return sendHtml(
          res,
          renderPage(
            req,
            "Ошибка",
            `
              <h1>
                Введите название бренда.
              </h1>
            `
          ),
          400
        );
      }

      const brand =
        db.prepare(`
          SELECT id
          FROM brands
          WHERE id = ?
        `).get(id);

      if (!brand) {

        return sendHtml(
          res,
          renderPage(
            req,
            "Ошибка",
            `
              <h1>
                Бренд не найден.
              </h1>
            `
          ),
          404
        );
      }

      db.prepare(`
        UPDATE brands
        SET name = ?
        WHERE id = ?
      `).run(
        name,
        id
      );

      return redirect(
        res,
        "/admin/brands"
      );
    }

        // ==================================================
    // БРЕНДЫ — DELETE
    // ТОЛЬКО АДМИН
    // ==================================================

    if (
      req.method === "POST" &&
      path.startsWith("/admin/brands/delete/")
    ) {

      if (
        !requireAdmin(
          req,
          res
        )
      ) {
        return;
      }

      const id =
        Number(
          path.split("/")[4]
        );

      const brand =
        db.prepare(`
          SELECT id, name
          FROM brands
          WHERE id = ?
        `).get(id);

      if (!brand) {

        return sendHtml(
          res,
          renderPage(
            req,
            "Ошибка",
            `
              <h1>
                Бренд не найден.
              </h1>
            `
          ),
          404
        );
      }

      const productsCount =
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM products
          WHERE brand_id = ?
        `).get(id).count;

      if (productsCount > 0) {

        return sendHtml(
          res,
          renderPage(
            req,
            "Ошибка",
            `
              <h1>
                Нельзя удалить бренд.
              </h1>

              <p>
                Бренд используется товарами:
                ${productsCount}
              </p>

              <p>
                <a href="/admin/brands">
                  ← Назад к брендам
                </a>
              </p>
            `
          ),
          400
        );
      }

      db.prepare(`
        DELETE FROM brands
        WHERE id = ?
      `).run(id);

      return redirect(
        res,
        "/admin/brands"
      );
    }

        // ==================================================
        // БРЕНДЫ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/brands"
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

          const brands =
            db.prepare(`
              SELECT id, name
              FROM brands
              ORDER BY name
            `).all();



          return sendHtml(
            res,
            renderPage(
              req,
              "Бренды",
              `
                <h1>
                  Управление брендами
                </h1>

                <p>
                  <a href="/admin">
                    ← Назад в админ-панель
                  </a>
                </p>

                <h2>
                  Бренды
                </h2>

<h2>
  Добавить бренд
</h2>

<form
  method="POST"
  action="/admin/brands"
>
  <p>
    Название:

    <input
      type="text"
      name="name"
      required
    >
  </p>

  <button>
    Добавить бренд
  </button>
</form>

<hr>

                <ul>
                  ${
                    brands.map(brand => `
                      <li>
                        <li>
  ${escapeHtml(brand.name)}

  <a href="/admin/brands/edit/${brand.id}">
    Изменить
  </a>

  <form
    method="POST"
    action="/admin/brands/delete/${brand.id}"
    style="display:inline"
  >
    <button type="submit">
      Удалить
    </button>
  </form>
</li>
                      </li>
                    `).join("")
                  }
                </ul>
              `
            )
          );
        }

        // ==================================================
        // РЕДАКТИРОВАТЬ КАТЕГОРИЮ — GET
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/categories\/edit\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const id =
            Number(
              path.split("/")[4]
            );


          const category =
            db.prepare(`
              SELECT *
              FROM categories
              WHERE id = ?
            `).get(id);


          if (!category) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Категория не найдена",
                `
                  <h1>
                    Категория не найдена.
                  </h1>
                `
              ),
              404
            );
          }


          const cats =
            getCategories();


          return sendHtml(
            res,
            renderPage(
              req,
              "Редактировать категорию",
              `
                <h1>
                  Редактировать категорию
                </h1>

                <form
                  method="POST"
                  action="/admin/categories/edit/${id}"
                >

                  <p>
                    Название:

                    <input
                      type="text"
                      name="name"
                      value="${escapeHtml(
                        category.name
                      )}"
                      required
                    >
                  </p>

                  <p>
                    Родительская категория:

                    <select
                      name="parent_id"
                    >

                      <option value="">
                        Верхний уровень
                      </option>

                      ${renderCategoryOptions(
                        cats,
                        null,
                        0,
                        category.parent_id,
                        category.id
                      )}

                    </select>
                  </p>

                  <p>
                    Порядок:

                    <input
                      type="number"
                      name="sort_order"
                      value="${category.sort_order}"
                    >
                  </p>

                  <button>
                    Сохранить
                  </button>

                </form>

                <p>
                  <a href="/admin/categories">
                    ← Назад
                  </a>
                </p>
              `
            )
          );
        }


        // ==================================================
        // РЕДАКТИРОВАТЬ КАТЕГОРИЮ — POST
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/admin\/categories\/edit\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const id =
            Number(
              path.split("/")[4]
            );


          const params =
            await readBody(req);


          const name =
            params.get("name")
              ?.trim() || "";


          const parentRaw =
            params.get("parent_id");


          const parentId =
            parentRaw
              ? Number(parentRaw)
              : null;


          const sortOrder =
            Number(
              params.get(
                "sort_order"
              ) || 0
            );


          const cats =
            getCategories();


          if (!name) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Название обязательно.
                  </h1>
                `
              ),
              400
            );
          }


          if (
            !Number.isFinite(
              sortOrder
            )
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Неверный порядок.
                  </h1>
                `
              ),
              400
            );
          }


          if (
            parentId === id
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Нельзя выбрать
                    категорию
                    родителем самой себя.
                  </h1>
                `
              ),
              400
            );
          }


          if (
            parentId !== null
          ) {

            const parent =
              cats.find(
                category =>
                  category.id ===
                  parentId
              );


            if (!parent) {

              return sendHtml(
                res,
                renderPage(
                  req,
                  "Ошибка",
                  `
                    <h1>
                      Родительская
                      категория
                      не найдена.
                    </h1>
                  `
                ),
                400
              );
            }


            const level =
              getCategoryLevel(
                parentId,
                cats
              );


            if (
              level >= 2
            ) {

              return sendHtml(
                res,
                renderPage(
                  req,
                  "Ошибка",
                  `
                    <h1>
                      Максимальная
                      вложенность —
                      3 уровня.
                    </h1>
                  `
                ),
                400
              );
            }
          }


          db.prepare(`
            UPDATE categories

            SET
              name = ?,
              parent_id = ?,
              sort_order = ?

            WHERE id = ?
          `).run(
            name,
            parentId,
            sortOrder,
            id
          );


          return redirect(
            res,
            "/admin/categories"
          );
        }


        // ==================================================
        // СКРЫТЬ / ПОКАЗАТЬ КАТЕГОРИЮ
        // ==================================================

        if (
          req.method === "GET" &&
          path.startsWith(
            "/admin/categories/toggle/"
          )
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const id =
            Number(
              path.split("/")[4]
            );


          db.prepare(`
            UPDATE categories

            SET hidden =
              CASE
                WHEN hidden = 1
                  THEN 0
                ELSE 1
              END

            WHERE id = ?
          `).run(id);


          return redirect(
            res,
            "/admin/categories"
          );
        }


        // ==================================================
        // УДАЛИТЬ КАТЕГОРИЮ
        // ==================================================

        if (
          req.method === "GET" &&
          path.startsWith(
            "/admin/categories/delete/"
          )
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }


          const id =
            Number(
              path.split("/")[4]
            );


          const category =
            db.prepare(`
              SELECT *
              FROM categories
              WHERE id = ?
            `).get(id);


          if (!category) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Категория не найдена",
                `
                  <h1>
                    Категория не найдена.
                  </h1>
                `
              ),
              404
            );
          }


          const children =
            db.prepare(`
              SELECT COUNT(*) AS total
              FROM categories
              WHERE parent_id = ?
            `).get(id);


          if (
            children.total > 0
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Нельзя удалить категорию.
                  </h1>

                  <p>
                    Сначала удалите
                    или перенесите
                    дочерние категории.
                  </p>

                  <p>
                    <a
                      href="/admin/categories"
                    >
                      ← Назад
                    </a>
                  </p>
                `
              ),
              400
            );
          }


          db.prepare(`
            DELETE FROM product_categories
            WHERE category_id = ?
          `).run(id);


          db.prepare(`
            UPDATE products

            SET category_id = NULL

            WHERE category_id = ?
          `).run(id);


          db.prepare(`
            DELETE FROM categories
            WHERE id = ?
          `).run(id);


          return redirect(
            res,
            "/admin/categories"
          );
        }


        // ==================================================
        // 404
        // ==================================================

        return sendHtml(
          res,
          renderPage(
            req,
            "404",
            `
              <h1>
                404 — Страница не найдена
              </h1>

              <p>
                Такой страницы
                не существует.
              </p>

              <p>
                <a href="/catalog">
                  Перейти в каталог
                </a>
              </p>
            `
          ),
          404
        );

      } catch (error) {

        console.error(
          "Ошибка сервера:",
          error
        );


        if (
          !res.headersSent
        ) {

          sendHtml(
            res,
            renderPage(
              req,
              "500",
              `
                <h1>
                  500 — Ошибка сервера
                </h1>

                <p>
                  Произошла внутренняя
                  ошибка сервера.
                </p>
              `
            ),
            500
          );

        } else {

          res.end();

}}});


// ======================================================
// START SERVER
// ======================================================

server.listen(
  PORT,
  () => {
    console.log(
      `Сервер запущен: http://localhost:${PORT}`
    );
  }
);
