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
        /Content-Disposition:[^\r\n]*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i
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

    fields.set(
  name,
  Buffer.from(
    contentText.replace(/\r\n$/, ""),
    "latin1"
  ).toString("utf8")
);
  }

  return {
    get(name) {
      return fields.get(name) || "";
    },

    getAll(name) {
      return [...fields.entries()]
        .filter(([key]) => key === name)
        .map(([, value]) => value);
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
    path.join(
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
    path.join(
      uploadsDir,
      filename
    );

  writeFileSync(
    filePath,
    file.data
  );

  return `/uploads/${filename}`;
}

async function saveUploadedFile(
  fileName,
  buffer
) {
  const safeName =
    path.basename(fileName);

  if (!safeName) {
    throw new Error(
      "Некорректное имя файла"
    );
  }

  const extension =
    path.extname(
      safeName
    ).toLowerCase();

  const allowedExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif"
  ];

  if (
    !allowedExtensions.includes(
      extension
    )
  ) {
    throw new Error(
      "Недопустимый формат изображения"
    );
  }

  const uniqueName =
    `${Date.now()}-${randomBytes(
      8
    ).toString("hex")}${extension}`;

  const filePath =
    path.join(
      UPLOADS_DIR,
      uniqueName
    );

  await fs.writeFile(
    filePath,
    buffer
  );

  return `/uploads/${uniqueName}`;
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
  excludeId = null
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
      Number(selectedId) ===
      Number(category.id)
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
        excludeId
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
        product.price *
        quantity
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
                    <a href="/admin/categories">
                      Управление категориями
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
        // КАТАЛОГ
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/catalog"
        ) {

          const cats =
            getCategories();

          const categoryFilter =
            url.searchParams.get(
              "category"
            );


          let products;


          if (categoryFilter) {

            products =
              db.prepare(`
                SELECT DISTINCT p.*
                FROM products p

                LEFT JOIN product_categories pc
                  ON pc.product_id = p.id

                WHERE
                  p.category_id = ?
                  OR pc.category_id = ?

                ORDER BY p.id DESC
              `).all(
                Number(categoryFilter),
                Number(categoryFilter)
              );

          } else {

            products =
              db.prepare(`
                SELECT *
                FROM products
                ORDER BY id DESC
              `).all();

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

            categoryLinks += `
              |
              <a
                href="/catalog?category=${category.id}"
              >
                ${escapeHtml(
                  category.name
                )}
              </a>
            `;
          }


          let productsHtml =
            "";


          if (
            products.length === 0
          ) {

            productsHtml =
              "<p>Товаров пока нет.</p>";

          } else {

            productsHtml =
              "<ul>";


            for (
              const product
              of products
            ) {

              const names =
                getProductCategoryNames(
                  product.id
                );


              productsHtml += `
                <li>

                  <a
                    href="/product/${product.id}"
                  >
                    ${escapeHtml(
                      product.name
                    )}
                  </a>

                  —
                  ${product.price}
                  руб.

                  ${
                    names.length
                      ? `[${escapeHtml(
                          names.join(", ")
                        )}]`
                      : ""
                  }

                  <br>

                  ${escapeHtml(
                    product.description ||
                    ""
                  )}

                  ${
  product.image
    ? `
      <br>
      <img
        src="${escapeHtml(product.image)}"
        alt="${escapeHtml(product.name)}"
        style="max-width:200px; max-height:200px;"
      >
      <br>
    `
    : ""
}

                  <br>

                  <a
                    href="/cart/add/${product.id}"
                  >
                    В корзину
                  </a>

                  ${
                    isAdmin(req)
                      ? `
                        |
                        <a
                          href="/edit-product/${product.id}"
                        >
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

                </li>
              `;
            }


            productsHtml +=
              "</ul>";
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
                  ${categoryLinks}
                </p>

                ${productsHtml}
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
            getProductCategoryNames(
              id
            );


          return sendHtml(
            res,
            renderPage(
              req,
              product.name,
              `
                <h1>
                  ${escapeHtml(
                    product.name
                  )}
                </h1>

                <p>
                  <strong>

                ${
                  product.image
                    ? `
                      <p>
                        <img
                          src="${escapeHtml(product.image)}"
                          alt="${escapeHtml(product.name)}"
                          style="max-width: 600px; width: 100%; height: auto;"
                        >
                      </p>
                    `
                    : ""
                }

                <p>
                  <strong>

                    ${product.price}
                    руб.
                  </strong>
                </p>

                <p>
                  ${escapeHtml(
                    product.description ||
                    ""
                  )}
                </p>

                <p>
                  Категории:
                  ${
                    escapeHtml(
                      names.join(", ") ||
                      "—"
                    )
                  }
                </p>

                <p>
                  <a
                    href="/cart/add/${id}"
                  >
                    В корзину
                  </a>
                </p>

                ${
                  isAdmin(req)
                    ? `
                      <p>
                        <a
                          href="/edit-product/${id}"
                        >
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
                ${item.price}
                руб.

                ×
                ${item.quantity}

                =
                ${item.sum}
                руб.

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
                    руб.
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
              SELECT id
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


          const total =
            items.reduce(
              (sum, item) =>
                sum + item.sum,
              0
            );


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
                    ${total}
                    руб.
                  </strong>
                </p>

                <form
                  method="POST"
                  action="/checkout"
                >

                  <p>
                    Имя:
                    <input
                      name="name"
                      required
                    >
                  </p>

                  <p>
                    Телефон:
                    <input
                      name="phone"
                      required
                    >
                  </p>

                  <p>
                    Адрес:
                    <input
                      name="address"
                      required
                    >
                  </p>

                  <p>
                    Email:
                    <input
                      type="email"
                      name="email"
                    >
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

                      Согласен
                      на обработку
                      персональных данных

                    </label>
                  </p>

                  <button>
                    Отправить заявку
                  </button>

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
            !address
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
                created_at,
                status
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              name,
              phone,
              address,
              total,
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
                sum
              )
              VALUES (?, ?, ?, ?, ?, ?)
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
              item.sum
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
                    руб.
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
              SELECT *
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
                  ${order.total}
                  руб.

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
                ${item.sum}
                руб.

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
                    ${order.total}
                    руб.
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


          const cats =
            getCategories();


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
                    >
                  </p>

                  <p>
                    Цена:

                    <input
                      type="number"
                      name="price"
                      min="0"
                      required
                    >
                  </p>

                  <p>
                    Описание:

                    <br>

                    <textarea
                      name="description"
                      required
                    ></textarea>
                  </p>

                                    <p>
                    Изображение товара:

                    <br>

                    <input
  type="file"
  name="image"
  accept="image/jpeg,image/png,image/webp,image/gif"
>
                    >
                  </p>

                  <p>
                    Артикул:

                    <br>

                    <input
                      type="text"
                      name="sku"
                      placeholder="Например: DEWALT-DCD777"
                    >
                  </p>

                  <p>
                    Бренд / производитель:

                    <br>

                    <input
                      type="text"
                      name="brand"
                      placeholder="Например: DEWALT"
                    >
                  </p>

                  <p>
                    Категории:

                    <br>

                    <select
                      name="category_ids"
                      multiple
                      size="8"
                    >

                      ${renderCategoryOptions(
                        cats
                      )}

                    </select>
                  </p>

                  <p>
                    Можно выбрать
                    несколько категорий.
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


          const description =
            params.get("description")
              ?.trim() || "";

          const imageFile =
  params.getFile("image");

const image =
  saveUploadedImage(imageFile);

          const sku =
            params.get("sku")
              ?.trim() || "";

          const brand =
            params.get("brand")
              ?.trim() || "";

          const categoryIds =
            params
              .getAll("category_ids")
              .map(Number)
              .filter(
                Number.isInteger
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
                brand
              )
              
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
  name,
  price,
  description,
  categoryIds[0] ||
  null,
  image,
  sku,
  brand
);


          const productId =
            Number(
              result.lastInsertRowid
            );


          saveProductCategories(
            productId,
            categoryIds
          );


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
                        product.name
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
                      value="${product.price}"
                      required
                    >
                  </p>

                  <p>
                    Описание:

                    <br>

                    <textarea
                      name="description"
                      required
                    >${escapeHtml(
                      product.description ||
                      ""
                    )}</textarea>
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


          const description =
            params.get("description")
              ?.trim() || "";

          const imageFile =
  params.getFile("image");

const image =
  saveUploadedImage(imageFile);

          const categoryIds =
            params
              .getAll("category_ids")
              .map(Number)
              .filter(
                Number.isInteger
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


          db.prepare(`
            UPDATE products

            SET
              name = ?,
              price = ?,
              description = ?,
              category_id = ?,
              image = ?

            WHERE id = ?
          `).run(
  name,
  price,
  description,
  categoryIds[0] || null,
  image,
  id
);


          saveProductCategories(
            id,
            categoryIds
          );


          return redirect(
            res,
            "/catalog"
          );
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
            DELETE FROM product_categories
            WHERE product_id = ?
          `).run(id);


          db.prepare(`
            DELETE FROM products
            WHERE id = ?
          `).run(id);


          return redirect(
            res,
            "/catalog"
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