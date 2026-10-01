import dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { createServer } from "http";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import Busboy from "busboy";
import db from "./lib/db.js";

import pathModule from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { mkdirSync, writeFileSync } from "fs";

const PORT = 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  throw new Error(
    "Ошибка конфигурации: переменная окружения ADMIN_PASSWORD не задана."
  );
}

const mailTransporter =
  nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

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


function isValidPhone(phone) {
  const value = String(phone || "").trim();

  if (/^\+[0-9]{8,15}$/.test(value)) {
    return true;
  }

  const digits = value.replace(/[^0-9]/g, "");

  return (
    (digits.length === 11 &&
      (digits.startsWith("7") || digits.startsWith("8"))) ||
    (digits.length === 12 && digits.startsWith("375"))
  );
}

const contactSettingKeys = [
  "contact_phone",
  "contact_email",
  "contact_address",
  "contact_working_hours",
  "contact_telegram",
  "contact_whatsapp",
  "contact_viber",
  "contact_vk",
  "contact_instagram",
  "contact_facebook"
];

function getContactSettings() {
  const rows = db.prepare(`
    SELECT key, value
    FROM site_settings
    WHERE key IN (${contactSettingKeys.map(() => "?").join(",")})
  `).all(...contactSettingKeys);

  return Object.fromEntries(
    contactSettingKeys.map(key => [
      key,
      rows.find(row => row.key === key)?.value || ""
    ])
  );
}

function validateContactSettings(values) {
  const errors = {};

  if (values.contact_phone && !isValidPhone(values.contact_phone)) {
    errors.contact_phone = "Укажите корректный номер телефона.";
  }

  if (
    values.contact_email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact_email)
  ) {
    errors.contact_email = "Укажите корректный email.";
  }

  for (const key of [
    "contact_telegram",
    "contact_whatsapp",
    "contact_viber",
    "contact_vk",
    "contact_instagram",
    "contact_facebook"
  ]) {
    if (values[key] && !/^https?:\/\//i.test(values[key])) {
      errors[key] = "Ссылка должна начинаться с http:// или https://.";
    }
  }

  return errors;
}

function saveContactSettings(values) {
  const statement = db.prepare(`
    INSERT INTO site_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `);

  const transaction = db.transaction(() => {
    for (const key of contactSettingKeys) {
      statement.run(key, values[key] || "");
    }
  });

  transaction();
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
        <a href="/service-request">Услуги / аренда</a> |
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
      <a href="/service-request">Услуги / аренда</a> |
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

function parseMultipartBody(req, contentType) {
  return new Promise((resolve, reject) => {
    let parser;

    try {
      parser = Busboy({
        headers: {
          "content-type": contentType
        }
      });
    } catch (error) {
      reject(error);
      return;
    }

    const fields = new Map();
    const files = new Map();
    const filePromises = [];

    parser.on("field", (name, value) => {
      if (!fields.has(name)) {
        fields.set(name, []);
      }

      fields.get(name).push(value);
    });

    parser.on("file", (name, file, info) => {
      const chunks = [];

      const filePromise = new Promise((resolveFile, rejectFile) => {
        file.on("data", chunk => {
          chunks.push(chunk);
        });

        file.on("end", () => {
          const fileData = {
            filename: info.filename,
            contentType: info.mimeType || "application/octet-stream",
            data: Buffer.concat(chunks)
          };

          if (!files.has(name)) {
            files.set(name, []);
          }

          files.get(name).push(fileData);
          resolveFile();
        });

        file.on("error", rejectFile);
      });

      filePromises.push(filePromise);
    });

    parser.on("error", reject);

    parser.on("finish", async () => {
      try {
        await Promise.all(filePromises);

        resolve({
          get(name) {
            const values = fields.get(name) || [];
            return values[0] || "";
          },

          getAll(name) {
            return fields.get(name) || [];
          },

          getFile(name) {
            return files.get(name)?.[0] || null;
          },

          getAllFiles(name) {
            return files.get(name) || [];
          }
        });
      } catch (error) {
        reject(error);
      }
    });

    req.pipe(parser);
  });
}

function saveUploadedImage(file, allowedTypesOverride) {

  if (!file || !file.filename || !file.data.length) {
    return "";
  }

  const allowedTypes = allowedTypesOverride || {
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

const VIDEO_MAX_BYTES =
  50 * 1024 * 1024;

const VIDEO_ALLOWED_TYPES = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov"
};

const VIDEO_ALLOWED_MESSAGE =
  "Разрешены только MP4, WebM, OGG и MOV. Размер — до 50 МБ.";

// Проверяет видео до сохранения, чтобы не создавать товар
// и не писать файлы, если хотя бы один файл не подходит.
// Возвращает текст ошибки или пустую строку.
function getVideoValidationError(files) {

  for (const file of files) {

    if (!file || !file.filename || !file.data.length) {
      continue;
    }

    if (!VIDEO_ALLOWED_TYPES[file.contentType]) {
      return VIDEO_ALLOWED_MESSAGE;
    }

    if (file.data.length > VIDEO_MAX_BYTES) {
      return VIDEO_ALLOWED_MESSAGE;
    }
  }

  return "";
}

function saveUploadedVideo(file, allowedTypesOverride) {

  if (!file || !file.filename || !file.data.length) {
    return "";
  }

  const allowedTypes =
    allowedTypesOverride || VIDEO_ALLOWED_TYPES;


  const extension =
    allowedTypes[file.contentType];

  if (!extension) {
    throw new Error(
      VIDEO_ALLOWED_MESSAGE
    );
  }

  if (
    file.data.length >
    VIDEO_MAX_BYTES
  ) {
    throw new Error(
      VIDEO_ALLOWED_MESSAGE
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

const DOCUMENT_MAX_BYTES =
  20 * 1024 * 1024;

const DOCUMENT_ALLOWED_TYPES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt"
};

const DOCUMENT_ALLOWED_MESSAGE =
  "Разрешены только PDF, DOC, DOCX, XLS, XLSX и TXT. Размер — до 20 МБ.";

// Проверяет документы до сохранения, чтобы не создавать товар
// и не писать файлы, если хотя бы один файл не подходит.
// Возвращает текст ошибки или пустую строку.
function getDocumentValidationError(files) {

  for (const file of files) {

    if (!file || !file.filename || !file.data.length) {
      continue;
    }

    if (!DOCUMENT_ALLOWED_TYPES[file.contentType]) {
      return DOCUMENT_ALLOWED_MESSAGE;
    }

    if (file.data.length > DOCUMENT_MAX_BYTES) {
      return DOCUMENT_ALLOWED_MESSAGE;
    }
  }

  return "";
}

function saveUploadedDocument(file, allowedTypesOverride) {

  if (!file || !file.filename || !file.data.length) {
    return "";
  }

  const allowedTypes =
    allowedTypesOverride || DOCUMENT_ALLOWED_TYPES;

  const extension =
    allowedTypes[file.contentType];

  if (!extension) {
    throw new Error(
      DOCUMENT_ALLOWED_MESSAGE
    );
  }

  if (
    file.data.length >
    DOCUMENT_MAX_BYTES
  ) {
    throw new Error(
      DOCUMENT_ALLOWED_MESSAGE
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
// ОДНОРАЗОВЫЕ ТОКЕНЫ ФОРМ ЗАЯВОК
// ======================================================

function createRequestToken() {
  const token = randomBytes(32).toString("hex");

  db.prepare(`
    INSERT INTO one_click_tokens
    (
      token,
      expires_at
    )
    VALUES (?, ?)
  `).run(
    token,
    Date.now() + 10 * 60 * 1000
  );

  return token;
}

function consumeRequestToken(token) {
  if (!token) {
    return false;
  }

  return db.prepare(`
    DELETE FROM one_click_tokens
    WHERE token = ?
      AND expires_at > ?
  `).run(token, Date.now()).changes === 1;
}

// ======================================================
// ФОРМА ЗАЯВКИ НА УСЛУГУ / АРЕНДУ ТЕХНИКИ
// ======================================================

function renderServiceRequestForm(values = {}, errors = {}) {

  const fieldError = key =>
    errors[key]
      ? `<small style="display:block; color:red;">${escapeHtml(errors[key])}</small>`
      : "";

  return `
    <h1>
      Заявка на услугу / аренду техники
    </h1>

    <form
      method="POST"
      action="/service-request"
      enctype="multipart/form-data"
    >
      <input
        type="hidden"
        name="request_token"
        value="${escapeHtml(values.request_token || createRequestToken())}"
      >

      <p>
        <label>
          Имя:
          <input
            type="text"
            name="name"
            value="${escapeHtml(values.name || "")}"
            required
          >
        </label>

        ${fieldError("name")}
      </p>

      <p>
        <label>
          Телефон:
          <input
            type="tel"
            name="phone"
            value="${escapeHtml(values.phone || "")}"
            inputmode="tel"
            autocomplete="tel"
            required
            oninput="this.value = this.value.replace(/[^0-9+() -]/g, '')"
          >
        </label>

        ${fieldError("phone")}
      </p>

      <p>
        <label>
          Тип заявки:
          <select name="type" required>
            <option value="">Выберите тип заявки</option>
            <option value="Услуга" ${values.type === "Услуга" ? "selected" : ""}>Услуга</option>
            <option value="Аренда техники" ${values.type === "Аренда техники" ? "selected" : ""}>Аренда техники</option>
          </select>
        </label>

        ${fieldError("type")}
      </p>

      <p>
        <label>
          Услуга / техника:
          <input
            type="text"
            name="service_name"
            placeholder="Например: аренда перфоратора или отделочные работы"
            value="${escapeHtml(values.service_name || "")}"
            required
          >
        </label>

        ${fieldError("service_name")}
      </p>

      <p>
        <label>
          Дата:
          <input
            type="date"
            name="request_date"
            value="${escapeHtml(values.request_date || "")}"
            required
          >
        </label>

        ${fieldError("request_date")}
      </p>

      <p>
        <label>
          Желаемое время:
          <input
            type="time"
            name="desired_time"
            value="${escapeHtml(values.desired_time || "")}"
            required
          >
        </label>

        ${fieldError("desired_time")}
      </p>

      <p>
        <label>
          Адрес объекта:
          <input
            type="text"
            name="address"
            value="${escapeHtml(values.address || "")}"
            required
          >
        </label>

        ${fieldError("address")}
      </p>

      <p>
        <label>
          Длительность:
          <input
            type="text"
            name="duration"
            placeholder="Например: 3 дня или 2 часа"
            value="${escapeHtml(values.duration || "")}"
          >
        </label>
      </p>

      <p>
        <label>
          Комментарий:
          <textarea
            name="comment"
          >${escapeHtml(values.comment || "")}</textarea>
        </label>
      </p>

      <p>
        <label>
          Фото объекта (можно несколько):
          <input
            type="file"
            name="photos"
            multiple
            accept="image/jpeg,image/png,image/webp,image/heic"
            id="service-request-photos"
          >
        </label>

        <div
          id="service-request-photo-previews"
          style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;"
        ></div>

        <small
          id="service-request-photos-error"
          style="display:none; color:red;"
        >
          Можно прикрепить не более 10 фото.
        </small>

        ${fieldError("photos")}
      </p>

      <p>
        <label>
          <input
            type="checkbox"
            name="agree"
            value="1"
            ${values.agree ? "checked" : ""}
            required
          >
          Согласен на обработку персональных данных
        </label>

        ${fieldError("agree")}
      </p>

      <button type="submit">
        Отправить заявку
      </button>
    </form>

    <script>
      (
        function () {
          const photoInput =
            document.getElementById(
              "service-request-photos"
            );

          const previewsContainer =
            document.getElementById(
              "service-request-photo-previews"
            );

          if (
            !photoInput ||
            !previewsContainer
          ) {
            return;
          }

          let selectedFiles =
            [];

          const maxPhotos = 10;

          const errorElement =
            document.getElementById(
              "service-request-photos-error"
            );

          function showError(
            message
          ) {
            if (
              !errorElement
            ) {
              return;
            }

            if (message) {
              errorElement
                .textContent =
                  message;

              errorElement
                .style
                .display =
                  "block";
            } else {
              errorElement
                .style
                .display =
                  "none";
            }
          }

          function renderPreviews() {
            previewsContainer
              .innerHTML = "";

            const dataTransfer =
              new DataTransfer();

            for (
              let i = 0;
              i < selectedFiles.length;
              i++
            ) {
              const file =
                selectedFiles[i];

              dataTransfer
                .items
                .add(file);

              const wrapper =
                document
                  .createElement(
                    "div"
                  );

              wrapper
                .style
                .position =
                  "relative";

              const thumbnail =
                document
                  .createElement(
                    "img"
                  );

              thumbnail
                .src =
                  URL
                    .createObjectURL(
                      file
                    );

              thumbnail
                .style =
                "width:80px; height:80px; object-fit:cover; border:1px solid #ccc; border-radius:4px;";

              const removeButton =
                document
                  .createElement(
                    "button"
                  );

              removeButton
                .type =
                  "button";

              removeButton
                .textContent =
                  "✕";

              removeButton
                .title =
                  "Удалить фото";

              removeButton
                .style =
                "position:absolute; top:-6px; right:-6px; width:20px; height:20px; padding:0; border:none; border-radius:50%; background:#d9534f; color:#fff; cursor:pointer; font-size:12px; line-height:1;";

              removeButton
                .addEventListener(
                  "click",
                  function () {
                    URL
                      .revokeObjectURL(
                        thumbnail
                          .src
                      );

                    selectedFiles
                      .splice(
                        i,
                        1
                      );

                    renderPreviews();
                  }
                );

              wrapper
                .appendChild(
                  thumbnail
                );

              wrapper
                .appendChild(
                  removeButton
                );

              previewsContainer
                .appendChild(
                  wrapper
                );
            }

            photoInput
              .files =
              dataTransfer
                .files;
          }

          photoInput
            .addEventListener(
              "change",
              function () {
                const newFiles =
                  Array
                    .from(
                      photoInput
                        .files
                    );

                const remainingSlots =
                  maxPhotos -
                  selectedFiles.length;

                if (
                  newFiles.length >
                  remainingSlots
                ) {
                  showError(
                    "Можно прикрепить не более " +
                    maxPhotos +
                    " фото. Добавлено только " +
                    Math.max(remainingSlots, 0) +
                    " из выбранных " +
                    newFiles.length +
                    "."
                  );
                } else {
                  showError(
                    ""
                  );
                }

                const filesToAdd =
                  newFiles.slice(
                    0,
                    Math.max(
                      remainingSlots,
                      0
                    )
                  );

                for (
                  let i = 0;
                  i < filesToAdd.length;
                  i++
                ) {
                  selectedFiles
                    .push(
                      filesToAdd[i]
                    );
                }

                renderPreviews();
              }
            );
        }
      )();
    </script>
  `;
}

// ======================================================
// ФОРМА ЗАЯВКИ НА РЕМОНТ
// ======================================================

function renderRepairRequestForm(values = {}, errors = {}) {

  const fieldError = key =>
    errors[key]
      ? `<small style="display:block; color:red;">${escapeHtml(errors[key])}</small>`
      : "";

  return `
    <h1>
      Заявка на ремонт
    </h1>

    <form
      id="repair-form-1"
      method="POST"
      action="/repair-request"
      enctype="multipart/form-data"
    >
      <input
        type="hidden"
        name="request_token"
        value="${escapeHtml(values.request_token || createRequestToken())}"
      >

      <p>
        <label>
          Имя:
          <input
            type="text"
            name="name"
            value="${escapeHtml(values.name || "")}"
            required
          >
        </label>

        ${fieldError("name")}
      </p>

      <p>
        <label>
          Телефон:
          <input
            type="tel"
            name="phone"
            value="${escapeHtml(values.phone || "")}"
            inputmode="tel"
            autocomplete="tel"
            required
            oninput="this.value = this.value.replace(/[^0-9+() -]/g, '')"
          >
        </label>

        ${fieldError("phone")}
      </p>

      <p>
        <label>
          Тип оборудования:
          <input
            type="text"
            name="equipment_type"
            placeholder="Например: дрель, стиральная машина, телевизор"
            value="${escapeHtml(values.equipment_type || "")}"
            required
          >
        </label>

        ${fieldError("equipment_type")}
      </p>

      <p>
        <label>
          Название оборудования:
          <input
            type="text"
            name="equipment_name"
            placeholder="Например: Bosch GSB 16 RE"
            value="${escapeHtml(values.equipment_name || "")}"
            required
          >
        </label>

        ${fieldError("equipment_name")}
      </p>

      <p>
        <label>
          Производитель:
          <input
            type="text"
            name="manufacturer"
            placeholder="Например: Bosch"
            value="${escapeHtml(values.manufacturer || "")}"
            required
          >
        </label>

        ${fieldError("manufacturer")}
      </p>

      <p>
        <label>
          Описание проблемы:
          <textarea
            name="problem"
            required
          >${escapeHtml(values.problem || "")}</textarea>
        </label>

        ${fieldError("problem")}
      </p>

      <p>
        <label>
          Фото (можно несколько):
          <input
            type="file"
            name="photos"
            multiple
            accept="image/jpeg,image/png,image/webp,image/heic"
          >
        </label>

        ${fieldError("photos")}
      </p>

      <p>
        <label>
          <input
            type="checkbox"
            name="agree"
            value="1"
            ${values.agree ? "checked" : ""}
            required
          >
          Согласен на обработку персональных данных
        </label>

        ${fieldError("agree")}
      </p>

      <button type="submit">
        Отправить заявку
      </button>
    </form>
  `;
}

// ======================================================
// ФОРМА ОБРАТНОГО ЗВОНКА
// ======================================================

function renderCallbackRequestForm(values = {}, errors = {}) {

  const fieldError = key =>
    errors[key]
      ? `<small style="display:block; color:red;">${escapeHtml(errors[key])}</small>`
      : "";

  return `
    <h1>
      Обратный звонок
    </h1>

    <form
      method="POST"
      action="/callback-request"
    >
      <input
        type="hidden"
        name="request_token"
        value="${escapeHtml(values.request_token || createRequestToken())}"
      >

      <p>
        <label>
          Имя:
          <input
            type="text"
            name="name"
            value="${escapeHtml(values.name || "")}"
            required
          >
        </label>

        ${fieldError("name")}
      </p>

      <p>
        <label>
          Телефон:
          <input
            type="tel"
            name="phone"
            value="${escapeHtml(values.phone || "")}"
            inputmode="tel"
            autocomplete="tel"
            required
            oninput="this.value = this.value.replace(/[^0-9+() -]/g, '')"
          >
        </label>

        ${fieldError("phone")}
      </p>

      <p>
        <label>
          <input
            type="checkbox"
            name="agree"
            value="1"
            ${values.agree ? "checked" : ""}
            required
          >
          Согласен на обработку персональных данных
        </label>

        ${fieldError("agree")}
      </p>

      <button type="submit">
        Заказать звонок
      </button>
    </form>
  `;
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


// ======================================================
// РЕКОМЕНДОВАННЫЕ ТОВАРЫ
// ======================================================

function getProductRecommendationIds(
  productId
) {
  return db
    .prepare(`
      SELECT recommended_product_id
      FROM product_recommendations
      WHERE product_id = ?
      ORDER BY
        sort_order,
        id
    `)
    .all(productId)
    .map(row => row.recommended_product_id);
}


// Заменяет старые связи текущего товара на новый список.
// sort_order хранит порядок выбора. Товар не может
// рекомендовать сам себя.
function saveProductRecommendations(
  productId,
  recommendedProductIds
) {
  db.prepare(`
    DELETE FROM product_recommendations
    WHERE product_id = ?
  `).run(productId);

  const insert =
    db.prepare(`
      INSERT INTO product_recommendations
      (
        product_id,
        recommended_product_id,
        sort_order
      )
      VALUES (?, ?, ?)
    `);

  let sortOrder = 0;

  for (const recommendedProductId of recommendedProductIds) {
    if (recommendedProductId === productId) {
      continue;
    }

    insert.run(
      productId,
      recommendedProductId,
      sortOrder++
    );
  }
}


function getProductsForRecommendations(
  excludeProductId = null
) {
  return db
    .prepare(`
      SELECT
        id,
        name
      FROM products
      WHERE deleted = 0
      ORDER BY
        name,
        id
    `)
    .all()
    .filter(
      product =>
        excludeProductId === null ||
        product.id !== excludeProductId
    );
}


function renderProductRecommendationOptions(
  products,
  selectedIds = []
) {
  let html = "";

  const selectedSet =
    new Set(selectedIds.map(String));

  for (const product of products) {
    const selected =
      selectedSet.has(String(product.id))
        ? "selected"
        : "";

    html += `
      <option
        value="${product.id}"
        ${selected}
      >
        ${escapeHtml(product.name)}
      </option>
    `;
  }

  return html;
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
      })()
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
      ".gif": "image/gif",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".ogv": "video/ogg",
      ".mov": "video/quicktime"
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
          const services = db.prepare(`
            SELECT name, short_description, image
            FROM services
            WHERE is_visible = 1
            ORDER BY sort_order, id
          `).all();

          const projects = db.prepare(`
            SELECT name, description, image
            FROM projects
            WHERE is_visible = 1
            ORDER BY sort_order, id
          `).all();

          const news = db.prepare(`
            SELECT title, short_text, image
            FROM news
            WHERE is_visible = 1
            ORDER BY sort_order, id
          `).all();

          const mainBanner = db.prepare(`
            SELECT title, description, image, button_text, button_url
            FROM main_banners
            WHERE is_visible = 1
            ORDER BY id
            LIMIT 1
          `).get();

          return sendHtml(
            res,
            renderPage(
              req,
              "Karimoff",
              `
                ${
                  mainBanner
                    ? `
                      <section>
                        ${
                          mainBanner.image
                            ? `
                              <p>
                                <img
                                  src="${escapeHtml(mainBanner.image)}"
                                  alt="${escapeHtml(mainBanner.title)}"
                                  style="max-width:100%; max-height:400px;"
                                >
                              </p>
                            `
                            : ""
                        }
                        <h1>${escapeHtml(mainBanner.title)}</h1>
                        <p>${escapeHtml(mainBanner.description)}</p>
                        <p>
                          <a href="${escapeHtml(mainBanner.button_url)}">
                            ${escapeHtml(mainBanner.button_text)}
                          </a>
                        </p>
                      </section>
                    `
                    : ""
                }

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

                ${
                  services.length > 0
                    ? `
                      <h2>Услуги</h2>

                      <ul>
                        ${services.map(service => `
                          <li>
                            <h3>${escapeHtml(service.name)}</h3>

                            ${
                              service.image
                                ? `
                                  <p>
                                    <img
                                      src="${escapeHtml(service.image)}"
                                      alt="${escapeHtml(service.name)}"
                                      style="max-width:200px; max-height:200px;"
                                    >
                                  </p>
                                `
                                : ""
                            }

                            <p>
                              ${escapeHtml(service.short_description || "")}
                            </p>
                          </li>
                        `).join("")}
                      </ul>
                    `
                    : ""
                }

                ${
                  projects.length > 0
                    ? `
                      <h2>Проекты</h2>

                      <ul>
                        ${projects.map(project => `
                          <li>
                            <h3>${escapeHtml(project.name)}</h3>

                            ${
                              project.image
                                ? `
                                  <p>
                                    <img
                                      src="${escapeHtml(project.image)}"
                                      alt="${escapeHtml(project.name)}"
                                      style="max-width:200px; max-height:200px;"
                                    >
                                  </p>
                                `
                                : ""
                            }

                            <p>
                              ${escapeHtml(project.description || "")}
                            </p>
                          </li>
                        `).join("")}
                      </ul>
                    `
                    : ""
                }

                ${
                  news.length > 0
                    ? `
                      <h2>Новости</h2>

                      <ul>
                        ${news.map(item => `
                          <li>
                            <h3>${escapeHtml(item.title)}</h3>

                            ${
                              item.image
                                ? `
                                  <p>
                                    <img
                                      src="${escapeHtml(item.image)}"
                                      alt="${escapeHtml(item.title)}"
                                      style="max-width:200px; max-height:200px;"
                                    >
                                  </p>
                                `
                                : ""
                            }

                            <p>
                              ${escapeHtml(item.short_text || "")}
                            </p>
                          </li>
                        `).join("")}
                      </ul>
                    `
                    : ""
                }
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

                   <li>
                     <a href="/admin/settings">
                       Настройки заявок
                     </a>
                   </li>

                   <li>
                     <a href="/admin/contacts">
                       Контакты
                     </a>
                   </li>

                   <li>
                     <a href="/admin/services">
                       Услуги
                     </a>
                   </li>

                    <li>
                      <a href="/admin/projects">
                        Проекты
                      </a>
                    </li>

                    <li>
                      <a href="/admin/news">
                        Новости
                      </a>
                    </li>

                    <li>
                      <a href="/admin/main-banner">
                        Главный баннер
                      </a>
                    </li>

                    <li>
                      <a href="/admin/pages">
                        Страницы
                      </a>
                    </li>

                   </ul>
              `
            )
          );
         }


          // ==================================================
          // КОНТАКТЫ — GET
          // ТОЛЬКО АДМИН
          // ==================================================

          if (
            req.method === "GET" &&
            path === "/admin/contacts"
          ) {
            if (!requireAdmin(req, res)) {
              return;
            }

            const values = getContactSettings();

            return sendHtml(
              res,
              renderPage(
                req,
                "Контакты",
                `
                  <h1>Контакты</h1>

                  <form method="POST" action="/admin/contacts">
                    <p>
                      <label>
                        Телефон:
                        <input type="tel" name="contact_phone" value="${escapeHtml(values.contact_phone)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Email:
                        <input type="email" name="contact_email" value="${escapeHtml(values.contact_email)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Адрес:
                        <input type="text" name="contact_address" value="${escapeHtml(values.contact_address)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Часы работы:
                        <input type="text" name="contact_working_hours" value="${escapeHtml(values.contact_working_hours)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Telegram:
                        <input type="url" name="contact_telegram" value="${escapeHtml(values.contact_telegram)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        WhatsApp:
                        <input type="url" name="contact_whatsapp" value="${escapeHtml(values.contact_whatsapp)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Viber:
                        <input type="url" name="contact_viber" value="${escapeHtml(values.contact_viber)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        VK:
                        <input type="url" name="contact_vk" value="${escapeHtml(values.contact_vk)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Instagram:
                        <input type="url" name="contact_instagram" value="${escapeHtml(values.contact_instagram)}">
                      </label>
                    </p>

                    <p>
                      <label>
                        Facebook:
                        <input type="url" name="contact_facebook" value="${escapeHtml(values.contact_facebook)}">
                      </label>
                    </p>

                    <button type="submit">Сохранить</button>
                  </form>
                `
              )
            );
          }

          // ==================================================
          // КОНТАКТЫ — POST
          // ТОЛЬКО АДМИН
          // ==================================================

          if (
            req.method === "POST" &&
            path === "/admin/contacts"
          ) {
            if (!requireAdmin(req, res)) {
              return;
            }

            const params = await readBody(req);
            const values = Object.fromEntries(
              contactSettingKeys.map(key => [
                key,
                params.get(key)?.trim() || ""
              ])
            );
            const errors = validateContactSettings(values);

            if (Object.keys(errors).length > 0) {
              return sendHtml(
                res,
                renderPage(
                  req,
                  "Ошибка в контактах",
                  `
                    <h1>Ошибка валидации</h1>
                    <ul>
                      ${Object.values(errors).map(error => `<li>${escapeHtml(error)}</li>`).join("")}
                    </ul>
                    <p><a href="/admin/contacts">Вернуться к контактам</a></p>
                  `
                ),
                400
              );
            }

            saveContactSettings(values);
            return redirect(res, "/admin/contacts");
          }

          // ==================================================
          // НАСТРОЙКИ САЙТА — GET
          // ТОЛЬКО АДМИН
          // ==================================================

          if (
            req.method === "GET" &&
            path === "/admin/settings"
          ) {

           if (!requireAdmin(req, res)) {
             return;
           }

           const setting =
             db.prepare(`
               SELECT value
               FROM site_settings
               WHERE key = ?
             `).get("orders_email");

           return sendHtml(
             res,
             renderPage(
               req,
               "Настройки заявок",
               `
                 <h1>
                   Настройки заявок
                 </h1>

                 <form
                   method="POST"
                   action="/admin/settings"
                 >
                   <p>
                     <label>
                       Рабочий email:
                       <input
                         type="email"
                         name="orders_email"
                         value="${escapeHtml(setting?.value || "")}" 
                       >
                     </label>
                   </p>

                    <button type="submit">
                      Сохранить
                    </button>
                  </form>
                 `
               )
             );
           }


           // ==================================================
           // НАСТРОЙКИ САЙТА — POST
           // ТОЛЬКО АДМИН
           // ==================================================

          if (
            req.method === "POST" &&
            path === "/admin/settings"
          ) {

            if (!requireAdmin(req, res)) {
              return;
            }

            const params =
              await readBody(req);

            const email =
              params.get("orders_email")?.trim() || "";

            db.prepare(`
              INSERT INTO site_settings
              (key, value)
              VALUES (?, ?)
              ON CONFLICT(key)
              DO UPDATE SET value = excluded.value
            `).run(
              "orders_email",
              email
            );

            return redirect(
              res,
              "/admin/settings"
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
// КУПИТЬ В 1 КЛИК — ФОРМА
// ==================================================
if (req.method === "GET" && path === "/buy-one-click") {
  const productId = Number(url.searchParams.get("product_id"));

  if (!Number.isInteger(productId) || productId < 1) {
    return sendHtml(
      res,
      renderPage(
        req,
        "Ошибка",
        `
          <h1>Ошибка</h1>
          <p>Не указан товар.</p>
        `
      ),
      400
    );
  }

  const product = db
    .prepare(`
      SELECT *
      FROM products
      WHERE id = ? AND deleted = 0
    `)
    .get(productId);

  if (!product) {
    return sendHtml(
      res,
      renderPage(
        req,
        "Товар не найден",
        `
          <h1>Товар не найден</h1>
          <p>Выбранный товар больше не существует.</p>
        `
      ),
      404
    );
  }

  const oneClickToken =
    randomBytes(32).toString("hex");

  db.prepare(`
    INSERT INTO one_click_tokens
    (
      token,
      expires_at
    )
    VALUES (?, ?)
  `).run(
    oneClickToken,
    Date.now() + 10 * 60 * 1000
  );

  const oneClickFormCookie =
    parseCookies(req).one_click_form || "";

  let oneClickForm = {
    quantity: "1",
    name: "",
    phone: "",
    comment: "",
    agree: false,
    error: ""
  };

  if (oneClickFormCookie) {
    try {
      const parsed = JSON.parse(oneClickFormCookie);

      oneClickForm = {
        ...oneClickForm,
        ...parsed
      };
    } catch {
      // Поврежденное временное состояние формы игнорируем.
    }

    res.setHeader(
      "Set-Cookie",
      "one_click_form=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/buy-one-click"
    );
  }

  return sendHtml(
    res,
    renderPage(
      req,
      "Купить в 1 клик",
      `
         <h1>Купить в 1 клик</h1>

         ${
           oneClickForm.error
             ? `<p style="color:red;">${escapeHtml(oneClickForm.error)}</p>`
             : ""
         }

         <h2>
          ${escapeHtml(product.name)}
        </h2>

        <form
          method="POST"
          action="/buy-one-click"
        >
           <input
             type="hidden"
             name="product_id"
             value="${product.id}"
           >

           <input
             type="hidden"
             name="one_click_token"
             value="${escapeHtml(oneClickToken)}"
           >

           <p>
            <label>
              Количество:
              <input
                type="number"
                 name="quantity"
                 value="${escapeHtml(String(oneClickForm.quantity))}"
                 min="1"
                max="99"
                required
              >
            </label>
          </p>

          <p>
            <label>
              Имя:
              <input
                 type="text"
                 name="name"
                 value="${escapeHtml(oneClickForm.name)}"
                 required
              >
            </label>
          </p>

          <p>
            <label>
              Телефон:
              <input
  type="tel"
   name="phone"
   value="${escapeHtml(oneClickForm.phone)}"
   inputmode="tel"
  autocomplete="tel"
  required
  oninput="this.value = this.value.replace(/[^0-9+() -]/g, '')"
>
            </label>
          </p>

          <p>
            <label>
              Комментарий:
               <textarea
                 name="comment"
               >${escapeHtml(oneClickForm.comment)}</textarea>
            </label>
          </p>

          <p>
            <label>
              <input
                 type="checkbox"
                 name="agree"
                 value="1"
                 ${oneClickForm.agree ? "checked" : ""}
                 required
              >
              Согласен на обработку персональных данных
            </label>
          </p>

          <button type="submit">
            Купить в 1 клик
          </button>
        </form>

        <p>
          <a href="/product/${product.id}">
            Вернуться к товару
          </a>
        </p>
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

  const galleryImages =
    db.prepare(`
      SELECT
        image
      FROM product_images
      WHERE product_id = ?
      ORDER BY
        sort_order,
        image
    `).all(id);

  let galleryHtml = "";

  if (galleryImages.length > 0) {
    galleryHtml += `
      <h2>
        Галерея
      </h2>

      <div>
    `;

    for (const galleryImage of galleryImages) {
      galleryHtml += `
        <a href="${escapeHtml(galleryImage.image)}">
          <img
            src="${escapeHtml(galleryImage.image)}"
            alt="${escapeHtml(product.name)}"
            width="150"
            style="margin:4px;"
          >
        </a>
      `;
    }

    galleryHtml += `
      </div>
    `;
  }

  const productVideos =
    db.prepare(`
      SELECT
        video
      FROM product_videos
      WHERE product_id = ?
      ORDER BY
        sort_order,
        video
    `).all(id);

  let videoHtml = "";

  if (productVideos.length > 0) {
    videoHtml += `
      <h2>
        Видео
      </h2>

      <div>
    `;

    for (const productVideo of productVideos) {
      videoHtml += `
        <video
          src="${escapeHtml(productVideo.video)}"
          controls
          width="360"
          style="margin:4px; max-width:100%;"
        ></video>
      `;
    }

    videoHtml += `
      </div>
    `;
  }

  const productDocuments =
    db.prepare(`
      SELECT
        document
      FROM product_documents
      WHERE product_id = ?
      ORDER BY
        sort_order,
        document
    `).all(id);

  const recommendedProducts =
    db.prepare(`
      SELECT
        p.id,
        p.name,
        p.image
      FROM product_recommendations pr

      JOIN products p
        ON p.id = pr.recommended_product_id

      WHERE
        pr.product_id = ?
        AND p.deleted = 0

      ORDER BY
        pr.sort_order,
        pr.id
    `).all(id);

  let documentHtml = "";

  if (productDocuments.length > 0) {
    documentHtml += `
      <h2>
        Документы
      </h2>

      <ul>
    `;

    for (const productDocument of productDocuments) {
      const documentName =
        productDocument.document
          .split("/")
          .pop();

      documentHtml += `
        <li>
          <a
            href="${escapeHtml(productDocument.document)}"
            target="_blank"
            rel="noopener"
          >${escapeHtml(documentName)}</a>
        </li>
      `;
    }

    documentHtml += `
      </ul>
    `;
  }

  let recommendationHtml = "";

  if (recommendedProducts.length > 0) {
    recommendationHtml += `
      <h2>
        Рекомендованные товары
      </h2>

      <ul>
    `;

    for (const recommendedProduct of recommendedProducts) {
      recommendationHtml += `
        <li>
          <p>
            <a href="/product/${recommendedProduct.id}">
              <strong>
                ${escapeHtml(recommendedProduct.name)}
              </strong>
            </a>
          </p>

          ${
            recommendedProduct.image
              ? `
                <p>
                  <img
                    src="${escapeHtml(recommendedProduct.image)}"
                    alt="${escapeHtml(recommendedProduct.name)}"
                    style="max-width:200px; max-height:200px;"
                  >
                </p>
              `
              : ""
          }
        </li>
      `;
    }

    recommendationHtml += `
      </ul>
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

        ${galleryHtml}

        ${videoHtml}

        ${documentHtml}

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
  <a href="/buy-one-click?product_id=${id}">
    Купить в 1 клик
  </a>
</p>

        <p>
          <a href="/cart/add/${id}">
            В корзину
          </a>
        </p>

        ${recommendationHtml}

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
        // КУПИТЬ В 1 КЛИК
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/buy-one-click"
        ) {

           const params =
             await readBody(req);

           const oneClickToken =
             params.get("one_click_token") || "";

           const productId =
            Number(
              params.get("product_id")
            );

          const quantity =
            Number(
              params.get("quantity")
            );

          const name =
            params.get("name")
              ?.trim() || "";

          const phone =
            params.get("phone")
              ?.trim() || "";

          const comment =
            params.get("comment")
              ?.trim() || "";

          const product =
            db.prepare(`
              SELECT *
              FROM products
              WHERE id = ?
                AND deleted = 0
            `).get(productId);

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

          const validPhone =
            isValidPhone(phone);

          if (
            params.get("agree") !== "1" ||
            !name ||
            !validPhone ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 99
          ) {
            let errorMessage =
              "Проверьте данные формы.";

            if (!name) {
              errorMessage = "Укажите имя.";
            } else if (!validPhone) {
              errorMessage = "Укажите корректный номер телефона.";
            } else if (
              !Number.isInteger(quantity) ||
              quantity < 1 ||
              quantity > 99
            ) {
              errorMessage = "Количество должно быть от 1 до 99.";
            } else if (params.get("agree") !== "1") {
              errorMessage =
                "Необходимо согласиться на обработку персональных данных.";
            }

            const formState = {
              quantity: Number.isInteger(quantity) ? quantity : (params.get("quantity") || ""),
              name,
              phone,
              comment,
              agree: params.get("agree") === "1",
              error: errorMessage
            };

            res.setHeader(
  "Set-Cookie",
  "one_click_form=" +
    encodeURIComponent(JSON.stringify(formState)) +
    "; Max-Age=600; HttpOnly; SameSite=Lax; Path=/buy-one-click"
);

return redirect(
  res,
  "/buy-one-click?product_id=" + productId
);
          }

          const tokenResult = db
            .prepare(`
              DELETE FROM one_click_tokens
              WHERE token = ?
                AND expires_at > ?
            `)
            .run(
              oneClickToken,
              Date.now()
            );

          if (tokenResult.changes !== 1) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заявка уже отправлена или форма устарела.</h1>`
              ),
              400
            );
          }

          const priceOnRequest =
            product.price_on_request ? 1 : 0;

          const sum =
            priceOnRequest
              ? 0
              : product.price *
                quantity *
                (
                  1 -
                  (
                    Number(product.discount_percent) || 0
                  ) / 100
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
                status,
                comment,
                type
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              name,
              phone,
              "",
              sum,
              product.currency,
              new Date().toISOString(),
               "Новая",
               comment,
               "Заказ товара"
            );

          const orderId =
            Number(
              result.lastInsertRowid
            );

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
           `).run(
             orderId,
             product.id,
             product.name,
             product.price,
             quantity,
             sum,
             priceOnRequest
           );

           const ordersEmail =
             db.prepare(`
               SELECT value
               FROM site_settings
               WHERE key = ?
             `).get("orders_email")?.value?.trim();

           if (ordersEmail) {
             try {
               await mailTransporter.sendMail({
                 from: process.env.SMTP_USER,
                 to: ordersEmail,
                 subject: `Новая заявка №${orderId}`,
                 text: [
                   `Номер заявки: №${orderId}`,
                   "Тип: Заказ товара",
                   `Имя: ${name}`,
                   `Телефон: ${phone}`,
                   `Товар: ${product.name}`,
                   `Количество: ${quantity}`,
                    `Сумма: ${product.price_on_request ? "По запросу" : `${sum} ${product.currency}`}`,
                   `Комментарий: ${comment}`
                 ].join("\n")
               });
             } catch (error) {
               console.error(
                 "Ошибка отправки email заявки:",
                 error?.message || error
               );
             }
           }

           return sendHtml(
            res,
            renderPage(
              req,
              "Быстрый заказ принят",
              `
                <h1>
                  Спасибо за заявку!
                </h1>

                <p>
                  Номер заявки:
                  <strong>
                    №${orderId}
                  </strong>
                </p>

                <p>
                  ${
                    priceOnRequest
                      ? "Стоимость уточняется менеджером."
                      : `Сумма: <strong>${sum} ${escapeHtml(product.currency)}</strong>`
                  }
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
         // ОБРАТНЫЙ ЗВОНОК — GET
         // ==================================================

         if (
           req.method === "GET" &&
           path === "/callback-request"
         ) {

           return sendHtml(
             res,
             renderPage(
               req,
               "Обратный звонок",
               renderCallbackRequestForm()
             )
           );
         }

         // ==================================================
         // ОБРАТНЫЙ ЗВОНОК — POST
         // ==================================================

         if (
           req.method === "POST" &&
           path === "/callback-request"
         ) {

           const params =
             await readBody(req);

           const name =
             params.get("name")
               ?.trim() || "";

           const phone =
             params.get("phone")
               ?.trim() || "";

           const validPhone =
             isValidPhone(phone);

            const formValues = {
              name,
              phone,
              request_token: params.get("request_token") || "",
              agree: params.get("agree") === "1"
            };

           const formErrors = {};

           if (!name) {
             formErrors.name = "Укажите имя.";
           }

           if (!validPhone) {
             formErrors.phone = "Укажите корректный номер телефона.";
           }

           if (params.get("agree") !== "1") {
             formErrors.agree = "Необходимо согласиться на обработку персональных данных.";
           }

           if (
             Object.keys(formErrors).length > 0
           ) {
             return sendHtml(
               res,
               renderPage(
                 req,
                 "Обратный звонок",
                 renderCallbackRequestForm(
                   formValues,
                   formErrors
                 )
               )
             );
            }

            if (!consumeRequestToken(params.get("request_token"))) {
              return sendHtml(
                res,
                renderPage(
                  req,
                  "Заявка уже отправлена",
                  `<h1>Заявка уже отправлена или форма устарела.</h1>`
                ),
                400
              );
            }

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
                  status,
                  comment,
                  type
                )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             `).run(
               name,
               phone,
               "",
               0,
               "BYN",
               new Date().toISOString(),
               "Новая",
               "",
               "Обратный звонок"
             );

           const orderId =
             Number(
               result.lastInsertRowid
             );

           const ordersEmail =
             db.prepare(`
               SELECT value
               FROM site_settings
               WHERE key = ?
             `).get("orders_email")?.value?.trim();

           if (ordersEmail) {
             try {
               await mailTransporter.sendMail({
                 from: process.env.SMTP_USER,
                 to: ordersEmail,
                 subject: `Новая заявка №${orderId}`,
                 text: [
                   `Номер заявки: №${orderId}`,
                   "Тип: Обратный звонок",
                   `Имя: ${name}`,
                   `Телефон: ${phone}`
                 ].join("\n")
               });
             } catch (emailError) {
               console.error(
                 "Ошибка отправки email заявки:",
                 emailError?.message || emailError
               );
             }
           }

           return sendHtml(
             res,
             renderPage(
               req,
               "Заявка принята",
               `
                 <h1>
                   Спасибо за заявку!
                 </h1>

                 <p>
                   Номер заявки:
                   <strong>
                     №${orderId}
                   </strong>
                 </p>

                 <p>
                   Мы перезвоним вам в ближайшее время.
                 </p>

                 <p>
                   <a href="/callback-request">
                     Отправить ещё одну заявку
                   </a>
                 </p>
               `
             )
           );
         }

         // ==================================================
         // ЗАЯВКА НА РЕМОНТ — GET
         // ==================================================

         if (
           req.method === "GET" &&
           path === "/repair-request"
         ) {

           return sendHtml(
             res,
             renderPage(
               req,
               "Заявка на ремонт",
               renderRepairRequestForm()
             )
           );
         }

         // ==================================================
         // ЗАЯВКА НА РЕМОНТ — POST
         // ==================================================

         if (
           req.method === "POST" &&
           path === "/repair-request"
         ) {

           const contentType =
             req.headers["content-type"] || "";

            const params =
              await parseMultipartBody(
                req,
                contentType
              );

           const name =
             params.get("name")
               ?.trim() || "";

           const phone =
             params.get("phone")
               ?.trim() || "";

           const equipmentType =
             params.get("equipment_type")
               ?.trim() || "";

           const equipmentName =
             params.get("equipment_name")
               ?.trim() || "";

           const manufacturer =
             params.get("manufacturer")
               ?.trim() || "";

           const problem =
             params.get("problem")
               ?.trim() || "";

           const validPhone =
             isValidPhone(phone);

            const formValues = {
              name,
              phone,
              request_token: params.get("request_token") || "",
              equipment_type: equipmentType,
             equipment_name: equipmentName,
             manufacturer,
             problem,
             agree: params.get("agree") === "1"
           };

           const formErrors = {};

           if (!name) {
             formErrors.name = "Укажите имя.";
           }

           if (!validPhone) {
             formErrors.phone = "Укажите корректный номер телефона.";
           }

           if (!equipmentType) {
             formErrors.equipment_type = "Укажите тип оборудования.";
           }

           if (!equipmentName) {
             formErrors.equipment_name = "Укажите название оборудования.";
           }

           if (!manufacturer) {
             formErrors.manufacturer = "Укажите производителя.";
           }

           if (!problem) {
             formErrors.problem = "Опишите проблему.";
           }

           if (params.get("agree") !== "1") {
             formErrors.agree = "Необходимо согласиться на обработку персональных данных.";
           }

           if (
             Object.keys(formErrors).length > 0
           ) {
             return sendHtml(
               res,
               renderPage(
                 req,
                 "Заявка на ремонт",
                 renderRepairRequestForm(
                   formValues,
                   formErrors
                 )
               )
             );
           }

            let photoPaths = [];

            const photoFiles =
              params.getAllFiles("photos");

            if (photoFiles.length > 10) {
              formErrors.photos = "Можно прикрепить не более 10 фото.";

              return sendHtml(
                res,
                renderPage(
                  req,
                  "Заявка на ремонт",
                  renderRepairRequestForm(
                    formValues,
                    formErrors
                  )
                )
              );
            }

            // Браузеры часто не знают MIME-тип HEIC и отправляют application/octet-stream.
            // Определяем тип по расширению файла, чтобы фото не терялись.
            const photoFilesWithFallbackType =
              photoFiles.map(photoFile => {
                if (
                  photoFile.contentType &&
                  photoFile.contentType !== "application/octet-stream"
                ) {
                  return photoFile;
                }

                const lowerName =
                  (photoFile.filename || "")
                    .toLowerCase();

                if (
                  lowerName.endsWith(".jpg") ||
                  lowerName.endsWith(".jpeg")
                ) {
                  return { ...photoFile, contentType: "image/jpeg" };
                }

                if (lowerName.endsWith(".png")) {
                  return { ...photoFile, contentType: "image/png" };
                }

                if (lowerName.endsWith(".webp")) {
                  return { ...photoFile, contentType: "image/webp" };
                }

                if (
                  lowerName.endsWith(".heic") ||
                  lowerName.endsWith(".heif")
                ) {
                  return { ...photoFile, contentType: "image/heic" };
                }

                return photoFile;
              });

            if (photoFilesWithFallbackType.length > 0) {
              try {
                photoPaths = photoFilesWithFallbackType.map(
                  photoFile =>
                    saveUploadedImage(
                      photoFile,
                      {
                        "image/jpeg": ".jpg",
                        "image/png": ".png",
                        "image/webp": ".webp",
                        "image/heic": ".heic",
                        "image/heic-sequence": ".heic"
                      }
                    )
                ).filter(Boolean);
              } catch (uploadError) {
                formErrors.photos =
                  uploadError?.message ||
                  "Не удалось загрузить фото. Разрешены форматы JPG, JPEG, PNG, WEBP, HEIC, размер — до 10 МБ.";

                return sendHtml(
                  res,
                  renderPage(
                    req,
                    "Заявка на ремонт",
                    renderRepairRequestForm(
                      formValues,
                      formErrors
                    )
                  )
                );
              }
            }

            if (!consumeRequestToken(params.get("request_token"))) {
              return sendHtml(
                res,
                renderPage(
                  req,
                  "Заявка уже отправлена",
                  `<h1>Заявка уже отправлена или форма устарела.</h1>`
                ),
                400
              );
            }

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
                   status,
                   comment,
                   type,
                   equipment_type,
                  equipment_name,
                  manufacturer,
                  problem,
                  photos
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                name,
                phone,
                "",
                0,
                "BYN",
                new Date().toISOString(),
                "Новая",
                "",
                "Ремонт",
                equipmentType,
                equipmentName,
                manufacturer,
                problem,
                photoPaths.join(",")
              );

            const orderId =
              Number(
                result.lastInsertRowid
              );

            const ordersEmail =
              db.prepare(`
                SELECT value
                FROM site_settings
                WHERE key = ?
              `).get("orders_email")?.value?.trim();

            if (ordersEmail) {
              try {
                const mailTextLines = [
                  `Номер заявки: №${orderId}`,
                  "Тип: Ремонт",
                  `Имя: ${name}`,
                  `Телефон: ${phone}`,
                  `Тип оборудования: ${equipmentType}`,
                  `Название оборудования: ${equipmentName}`,
                  `Производитель: ${manufacturer}`,
                  `Описание проблемы: ${problem}`
                ];

                const mailAttachments = [];

                let mailHtml =
                  mailTextLines
                    .map(line => `<p>${escapeHtml(line)}</p>`)
                    .join("");

                if (photoPaths.length > 0) {
                  for (
                    let i = 0;
                    i < photoPaths.length;
                    i++
                  ) {
                    const photoPath =
                      photoPaths[i];

                    const cid =
                      `repair-photo-${orderId}-${i}`;

                    mailAttachments.push({
                      filename:
                        `photo-${i + 1}` +
                        pathModule.extname(photoPath),
                      path:
                        "." + photoPath,
                      cid
                    });

                    mailHtml +=
                      `<img src="cid:${cid}" alt="Фото ${i + 1}" style="max-width:300px; max-height:300px; margin:4px; border:1px solid #ccc;">`;
                  }
                } else {
                  mailTextLines.push("Фото: нет");

                  mailHtml +=
                    "<p>Фото: нет</p>";
                }

                await mailTransporter.sendMail({
                  from: process.env.SMTP_USER,
                  to: ordersEmail,
                  subject: `Новая заявка №${orderId}`,
                  text:
                    mailTextLines.join("\n"),
                  html: mailHtml,
                  attachments:
                    mailAttachments
                });
              } catch (emailError) {
                console.error(
                  "Ошибка отправки email заявки:",
                  emailError?.message || emailError
                );
              }
            }

            return sendHtml(
             res,
             renderPage(
               req,
               "Заявка принята",
               `
                 <h1>
                   Спасибо за заявку!
                 </h1>

                 <p>
                   Номер заявки:
                   <strong>
                     №${orderId}
                   </strong>
                 </p>

                 <p>
                   Мы свяжемся с вами для подтверждения.
                 </p>

                 <p>
                   <a href="/repair-request">
                     Отправить ещё одну заявку
                   </a>
                 </p>
               `
             )
           );
         }

         // ==================================================
         // ЗАЯВКА НА УСЛУГУ / АРЕНДУ ТЕХНИКИ — GET
         // ==================================================

         if (
           req.method === "GET" &&
           path === "/service-request"
         ) {

           return sendHtml(
             res,
             renderPage(
               req,
               "Заявка на услугу / аренду",
               renderServiceRequestForm()
             )
           );
         }

         // ==================================================
         // ЗАЯВКА НА УСЛУГУ / АРЕНДУ ТЕХНИКИ — POST
         // ==================================================

         if (
           req.method === "POST" &&
           path === "/service-request"
         ) {

           const contentType =
             req.headers["content-type"] || "";

            const params =
              await parseMultipartBody(
                req,
                contentType
              );

           const name =
             params.get("name")
               ?.trim() || "";

           const phone =
             params.get("phone")
               ?.trim() || "";

            const serviceType =
              params.get("type")?.trim() || "";

            const serviceName =
              params.get("service_name")
                ?.trim() || "";

            const requestDate =
              params.get("request_date")
                ?.trim() || "";

           const desiredTime =
             params.get("desired_time")
               ?.trim() || "";

           const address =
             params.get("address")
               ?.trim() || "";

           const duration =
             params.get("duration")
               ?.trim() || "";

           const comment =
             params.get("comment")
               ?.trim() || "";

           const validPhone =
             isValidPhone(phone);

            const formValues = {
              name,
              phone,
              request_token: params.get("request_token") || "",
              type: serviceType,
              service_name: serviceName,
              request_date: requestDate,
              desired_time: desiredTime,
              address,
              duration,
              comment,
              agree: params.get("agree") === "1"
            };

           const formErrors = {};

           if (!name) {
             formErrors.name = "Укажите имя.";
           }

           if (!validPhone) {
             formErrors.phone = "Укажите корректный номер телефона.";
           }

            if (!["Услуга", "Аренда техники"].includes(serviceType)) {
              formErrors.type = "Выберите тип заявки.";
            }

            if (!serviceName) {
              formErrors.service_name = "Укажите услугу или технику.";
            }

            if (!requestDate) {
              formErrors.request_date = "Укажите дату.";
            } else {
              const datePattern =
                /^\d{4}-\d{2}-\d{2}$/;

              if (!datePattern.test(requestDate)) {
                formErrors.request_date = "Укажите корректную дату.";
              } else {
                const requestedDate =
                  new Date(
                    `${requestDate}T00:00:00`
                  );

                const today =
                  new Date();

                today.setHours(
                  0,
                  0,
                  0,
                  0
                );

                const maxDate =
                  new Date(
                    today
                  );

                maxDate.setFullYear(
                  maxDate.getFullYear() + 10
                );

                if (
                  Number.isNaN(
                    requestedDate.getTime()
                  )
                ) {
                  formErrors.request_date = "Укажите корректную дату.";
                } else if (
                  requestedDate < today
                ) {
                  formErrors.request_date = "Дата не может быть раньше сегодняшней.";
                } else if (
                  requestedDate > maxDate
                ) {
                  formErrors.request_date = "Дата не может быть позже, чем через 10 лет.";
                }
              }
            }

           if (!desiredTime) {
             formErrors.desired_time = "Укажите желаемое время.";
           }

           if (!address) {
             formErrors.address = "Укажите адрес объекта.";
           }

           if (params.get("agree") !== "1") {
             formErrors.agree = "Необходимо согласиться на обработку персональных данных.";
           }

           if (
             Object.keys(formErrors).length > 0
           ) {
             return sendHtml(
               res,
               renderPage(
                 req,
                 "Заявка на услугу / аренду",
                 renderServiceRequestForm(
                   formValues,
                   formErrors
                 )
               )
             );
           }

             let photoPaths = [];
 
             const photoFiles =
               params.getAllFiles("photos");

             if (photoFiles.length > 10) {
               formErrors.photos = "Можно прикрепить не более 10 фото.";

               return sendHtml(
                 res,
                 renderPage(
                   req,
                   "Заявка на услугу / аренду",
                   renderServiceRequestForm(
                     formValues,
                     formErrors
                   )
                 )
               );
             }

            // Браузеры часто не знают MIME-тип HEIC и отправляют application/octet-stream.
            // Определяем тип по расширению файла, чтобы фото не терялись.
            const photoFilesWithFallbackType =
              photoFiles.map(photoFile => {
                if (
                  photoFile.contentType &&
                  photoFile.contentType !== "application/octet-stream"
                ) {
                  return photoFile;
                }

                const lowerName =
                  (photoFile.filename || "")
                    .toLowerCase();

                if (
                  lowerName.endsWith(".jpg") ||
                  lowerName.endsWith(".jpeg")
                ) {
                  return { ...photoFile, contentType: "image/jpeg" };
                }

                if (lowerName.endsWith(".png")) {
                  return { ...photoFile, contentType: "image/png" };
                }

                if (lowerName.endsWith(".webp")) {
                  return { ...photoFile, contentType: "image/webp" };
                }

                if (
                  lowerName.endsWith(".heic") ||
                  lowerName.endsWith(".heif")
                ) {
                  return { ...photoFile, contentType: "image/heic" };
                }

                return photoFile;
              });
 
            if (photoFilesWithFallbackType.length > 0) {
              try {
                photoPaths = photoFilesWithFallbackType.map(
                  photoFile =>
                    saveUploadedImage(
                      photoFile,
                      {
                        "image/jpeg": ".jpg",
                        "image/png": ".png",
                        "image/webp": ".webp",
                        "image/heic": ".heic",
                        "image/heic-sequence": ".heic"
                      }
                    )
                ).filter(Boolean);
              } catch (uploadError) {
                formErrors.photos =
                  uploadError?.message ||
                  "Не удалось загрузить фото. Разрешены форматы JPG, JPEG, PNG, WEBP, HEIC, размер — до 10 МБ.";

                return sendHtml(
                  res,
                  renderPage(
                    req,
                    "Заявка на услугу / аренду",
                    renderServiceRequestForm(
                      formValues,
                      formErrors
                    )
                  )
                );
              }
             }

            if (!consumeRequestToken(params.get("request_token"))) {
              return sendHtml(
                res,
                renderPage(
                  req,
                  "Заявка уже отправлена",
                  `<h1>Заявка уже отправлена или форма устарела.</h1>`
                ),
                400
              );
            }

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
                  status,
                  comment,
                  type,
                  service_name,
                 request_date,
                 desired_time,
                 duration,
                 photos
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             `).run(
               name,
               phone,
               address,
               0,
               "BYN",
               new Date().toISOString(),
               "Новая",
                comment,
                serviceType,
                serviceName,
               requestDate,
               desiredTime,
               duration,
               photoPaths.join(",")
             );

            const orderId =
              Number(
                result.lastInsertRowid
              );

            const ordersEmail =
              db.prepare(`
                SELECT value
                FROM site_settings
                WHERE key = ?
              `).get("orders_email")?.value?.trim();

             if (ordersEmail) {
              try {
                const mailTextLines = [
                  `Номер заявки: №${orderId}`,
                  `Тип: ${serviceType}`,
                  `Имя: ${name}`,
                  `Телефон: ${phone}`,
                  `Услуга/техника: ${serviceName}`,
                  `Дата: ${requestDate}`,
                  `Желаемое время: ${desiredTime}`,
                  `Адрес объекта: ${address}`,
                  `Длительность: ${duration || "не указана"}`,
                  `Комментарий: ${comment || "нет"}`
                ];

                const mailAttachments = [];

                let mailHtml =
                  mailTextLines
                    .map(line => `<p>${escapeHtml(line)}</p>`)
                    .join("");

                if (photoPaths.length > 0) {
                  for (
                    let i = 0;
                    i < photoPaths.length;
                    i++
                  ) {
                    const photoPath =
                      photoPaths[i];

                    const cid =
                      `service-photo-${orderId}-${i}`;

                    mailAttachments.push({
                      filename:
                        `photo-${i + 1}` +
                        pathModule.extname(photoPath),
                      path:
                        "." + photoPath,
                      cid
                    });

                    mailHtml +=
                      `<img src="cid:${cid}" alt="Фото ${i + 1}" style="max-width:300px; max-height:300px; margin:4px; border:1px solid #ccc;">`;
                  }
                } else {
                  mailTextLines.push("Фото: нет");

                  mailHtml +=
                    "<p>Фото: нет</p>";
                }

                await mailTransporter.sendMail({
                  from: process.env.SMTP_USER,
                  to: ordersEmail,
                  subject: `Новая заявка №${orderId}`,
                  text:
                    mailTextLines.join("\n"),
                  html: mailHtml,
                  attachments:
                    mailAttachments
                });
              } catch (emailError) {
                console.error(
                  "Ошибка отправки email заявки:",
                  emailError?.message || emailError
                );
              }
            }

            return sendHtml(
             res,
             renderPage(
               req,
               "Заявка принята",
               `
                 <h1>
                   Спасибо за заявку!
                 </h1>

                 <p>
                   Номер заявки:
                   <strong>
                     №${orderId}
                   </strong>
                 </p>

                 <p>
                   Мы свяжемся с вами для подтверждения.
                 </p>

                 <p>
                   <a href="/service-request">
                     Отправить ещё одну заявку
                   </a>
                 </p>
               `
             )
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

          const checkoutToken =
            randomBytes(32).toString("hex");

          db.prepare(`
            INSERT INTO one_click_tokens
            (
              token,
              expires_at
            )
            VALUES (?, ?)
          `).run(
            checkoutToken,
            Date.now() + 10 * 60 * 1000
          );

          const checkoutFormCookie =
            parseCookies(req).checkout_form || "";

          let checkoutForm = {
            name: "",
            phone: "",
            email: "",
            address: "",
            comment: "",
            payment: "cash",
            delivery: "delivery",
            agree: false,
            error: ""
          };

          if (checkoutFormCookie) {
            try {
              const parsed = JSON.parse(checkoutFormCookie);

              checkoutForm = {
                ...checkoutForm,
                ...parsed
              };
            } catch {
              // Поврежденное временное состояние формы игнорируем.
            }

            res.setHeader(
              "Set-Cookie",
              "checkout_form=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/checkout"
            );
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Оформление заказа",
              `
                <h1>
                  Оформление заказа
                </h1>

                ${
                  checkoutForm.error
                    ? `<p style="color:red;">${escapeHtml(checkoutForm.error)}</p>`
                    : ""
                }

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

                   <input
                     type="hidden"
                     name="checkout_token"
                     value="${escapeHtml(checkoutToken)}"
                   >


                  <p>
                    Имя:
                    <input
                      name="name"
                      value="${escapeHtml(checkoutForm.name)}"
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
                      value="${escapeHtml(checkoutForm.phone)}"
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
                      value="${escapeHtml(checkoutForm.address)}"
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
                      value="${escapeHtml(checkoutForm.email)}"
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
                    >${escapeHtml(checkoutForm.comment)}</textarea>
                  </p>

                  <p>
                    Вид оплаты:

                    <select
                      name="payment"
                      required
                    >
                      <option
                        value="cash"
                        ${checkoutForm.payment === "cash" ? "selected" : ""}
                      >
                        Наличные
                      </option>

                      <option
                        value="card"
                        ${checkoutForm.payment === "card" ? "selected" : ""}
                      >
                        Карта при получении
                      </option>

                      <option
                        value="installment"
                        ${checkoutForm.payment === "installment" ? "selected" : ""}
                      >
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
                      <option
                        value="delivery"
                        ${checkoutForm.delivery === "delivery" ? "selected" : ""}
                      >
                        Доставка
                      </option>

                      <option
                        value="pickup"
                        ${checkoutForm.delivery === "pickup" ? "selected" : ""}
                      >
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
                        ${checkoutForm.agree ? "checked" : ""}
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

          const checkoutToken =
            params.get("checkout_token") || "";


          if (
            params.get("agree") !==
            "1"
          ) {

            const formState = {
              name: params.get("name")?.trim() || "",
              phone: params.get("phone")?.trim() || "",
              email: params.get("email")?.trim() || "",
              address: params.get("address")?.trim() || "",
              comment: params.get("comment")?.trim() || "",
              payment: params.get("payment") || "cash",
              delivery: params.get("delivery") || "delivery",
              agree: false,
              error: "Необходимо согласиться на обработку персональных данных."
            };

            res.setHeader(
              "Set-Cookie",
              "checkout_form=" +
                encodeURIComponent(JSON.stringify(formState)) +
                "; Max-Age=600; HttpOnly; SameSite=Lax; Path=/checkout"
            );

            return redirect(
              res,
              "/checkout"
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

           const validPhone =
             isValidPhone(phone);

           const address =
             params.get("address")
               ?.trim() || "";

           const email =
             params.get("email")
               ?.trim() || "";

           const validEmail =
             email === "" ||
             /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

           if (
    !name ||
    !validPhone ||
    !validEmail ||
    (
      params.get("delivery") === "delivery" &&
      !address
    )
  ) {

            let errorMessage =
              "Заполните обязательные поля.";

            if (!validPhone) {
              errorMessage = "Укажите корректный номер телефона.";
            } else if (!validEmail) {
              errorMessage = "Укажите корректный email.";
            } else if (
              params.get("delivery") === "delivery" &&
              !address
            ) {
              errorMessage = "Укажите адрес доставки.";
            }

            const formState = {
              name,
              phone,
              email,
              address,
              comment: params.get("comment")?.trim() || "",
              payment: params.get("payment") || "cash",
              delivery: params.get("delivery") || "delivery",
              agree: params.get("agree") === "1",
              error: errorMessage
            };

           res.setHeader(
             "Set-Cookie",
             "checkout_form=" +
               encodeURIComponent(JSON.stringify(formState)) +
               "; Max-Age=600; HttpOnly; SameSite=Lax; Path=/checkout"
           );

           return redirect(
             res,
             "/checkout"
           );
          }


          const tokenResult = db
            .prepare(`
              DELETE FROM one_click_tokens
              WHERE token = ?
                AND expires_at > ?
            `)
            .run(
              checkoutToken,
              Date.now()
            );

          if (tokenResult.changes !== 1) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Заказ уже отправлен или форма устарела.
                  </h1>

                  <p>
                    Обновите страницу оформления и попробуйте снова.
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
                status,
                comment,
                type
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              name,
              phone,
              address,
              total,
              currency,
              new Date().toISOString(),
              "Новый",
              params.get("comment")
                ?.trim() || "",
              "Заказ товара"
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

            const customerEmail =
              params.get("email")?.trim() || "";

            const payment =
              params.get("payment") || "";

            const delivery =
              params.get("delivery") || "";

            const orderComment =
              params.get("comment")?.trim() || "";

            const itemsText =
              items
                .map(item =>
                  `${item.name} — ${item.quantity} шт. × ${item.price_on_request ? "По запросу" : `${item.price} ${item.currency}`}`
                )
                .join("\n");

            const ordersEmail =
              db.prepare(`
                SELECT value
                FROM site_settings
                WHERE key = ?
              `).get("orders_email")?.value?.trim();

            if (ordersEmail) {
              try {
               await mailTransporter.sendMail({
                 from: process.env.SMTP_USER,
                 to: ordersEmail,
                 subject: `Новый заказ №${orderId}`,
                 text: [
                   `Номер заказа: №${orderId}`,
                   "Тип: Заказ товара",
                   `Имя: ${name}`,
                   `Телефон: ${phone}`,
                   ...(customerEmail ? [`Email: ${customerEmail}`] : []),
                   `Адрес: ${address}`,
                    `Способ получения: ${delivery === "delivery" ? "Доставка" : delivery}`,
                    `Способ оплаты: ${payment === "card" ? "Банковская карта" : payment}`,
                   "Товары:",
                   itemsText,
                   `Общая сумма: ${total} ${currency}`,
                   `Комментарий: ${orderComment}`
                 ].join("\n")
               });
             } catch (error) {
               console.error(
                 "Ошибка отправки email заказа:",
                 error?.message || error
               );
             }
            }

            if (customerEmail) {
              try {
                await mailTransporter.sendMail({
                  from: process.env.SMTP_USER,
                  to: customerEmail,
                  subject: `Ваш заказ №${orderId}`,
                  text: [
                    `Номер заказа: №${orderId}`,
                    "Тип: Заказ товара",
                    "Товары:",
                    itemsText,
                    `Общая сумма: ${total} ${currency}`,
                    `Способ получения: ${delivery === "delivery" ? "Доставка" : delivery}`,
                    `Способ оплаты: ${payment === "card" ? "Банковская карта" : payment}`,
                    `Комментарий: ${orderComment || "нет"}`
                  ].join("\n")
                });
              } catch (error) {
                console.error(
                  "Ошибка отправки email клиенту:",
                  error?.message || error
                );
              }
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


          const searchQuery =
            url.searchParams
              .get("search")
              ?.trim() || "";

          const filterDate =
            url.searchParams
              .get("date")
              ?.trim() || "";

          const filterType =
            url.searchParams
              .get("type")
              ?.trim() || "";

          const filterStatus =
            url.searchParams
              .get("status")
              ?.trim() || "";


          const conditions = [];
          const queryParams = [];

          if (searchQuery) {
            conditions.push(
              `(CAST(orders.id AS TEXT) = ? OR orders.name LIKE ? OR orders.phone LIKE ?)`
            );
            queryParams.push(
              searchQuery,
              `%${searchQuery}%`,
              `%${searchQuery}%`
            );
          }

          if (filterDate) {
            conditions.push(
              `date(orders.created_at) = ?`
            );
            queryParams.push(filterDate);
          }

          if (filterType) {
            conditions.push(
              `orders.type = ?`
            );
            queryParams.push(filterType);
          }

          if (filterStatus) {
            conditions.push(
              `orders.status = ?`
            );
            queryParams.push(filterStatus);
          }


          const whereSql =
            conditions.length > 0
              ? `WHERE ${conditions.join(" AND ")}`
              : "";


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
              ${whereSql}
              ORDER BY id DESC
            `).all(...queryParams);


          let content =
            "<h1>Заказы</h1>";

          content += `
            <form method="GET" action="/orders">
              <p>
                <input
                  type="search"
                  name="search"
                  placeholder="Номер, имя или телефон"
                  value="${escapeHtml(searchQuery)}"
                >

                <input
                  type="date"
                  name="date"
                  value="${escapeHtml(filterDate)}"
                >

                <select name="type">
                  <option value="">
                    Все типы
                  </option>

                  <option
                    value="Заказ товара"
                    ${filterType === "Заказ товара" ? "selected" : ""}
                  >
                    Заказ товара
                  </option>

                  <option
                    value="Обратный звонок"
                    ${filterType === "Обратный звонок" ? "selected" : ""}
                  >
                    Обратный звонок
                  </option>

                  <option
                    value="Услуга"
                    ${filterType === "Услуга" ? "selected" : ""}
                  >
                    Услуга
                  </option>

                  <option
                    value="Аренда техники"
                    ${filterType === "Аренда техники" ? "selected" : ""}
                  >
                    Аренда техники
                  </option>
                </select>

                <select name="status">
                  <option value="">
                    Все статусы
                  </option>

                  ${
                    ["Новая", "Новый", "В разработке", "Закрыто"]
                      .map(status => `
                        <option
                          value="${escapeHtml(status)}"
                          ${filterStatus === status ? "selected" : ""}
                        >
                          ${escapeHtml(status)}
                        </option>
                      `)
                      .join("")
                  }
                </select>

                <button type="submit">
                  Найти
                </button>
              </p>
            </form>
          `;


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
                <li
                  ${
                    order.is_viewed === 0
                      ? `style="background:#fff3cd;border:2px solid #e6a700;padding:8px;border-radius:4px;"`
                      : ""
                  }
                >

                  <strong>
                    Заказ №${order.id}
                  </strong>

                  ${
                    order.is_viewed === 0
                      ? `— <strong style="color:#b35c00;">(не просмотрено)</strong>`
                      : ""
                  }

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

                  —
                  Тип:
                  ${escapeHtml(
                    order.type || ""
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


          db.prepare(`
            UPDATE orders
            SET is_viewed = 1
            WHERE id = ?
          `).run(orderId);


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
                  Комментарий:
                  ${escapeHtml(
                    order.comment || "—"
                  )}
                </p>

                 <p>
                   Статус:
                   ${escapeHtml(
                     order.status
                   )}
                 </p>

                  <p>
                    Тип:
                    ${escapeHtml(
                      order.type || ""
                    )}
                  </p>

                  ${
                    ["Услуга", "Аренда техники"].includes(order.type)
                      ? `
                        <p>
                          Услуга/техника:
                          ${escapeHtml(order.service_name || "—")}
                        </p>

                        <p>
                          Дата:
                          ${escapeHtml(order.request_date || "—")}
                        </p>

                        <p>
                          Желаемое время:
                          ${escapeHtml(order.desired_time || "—")}
                        </p>

                        <p>
                          Длительность:
                          ${escapeHtml(order.duration || "—")}
                        </p>

                        ${
                          order.photos
                            ? `
                              <p>
                                Фото:
                              </p>

                              <p>
                                ${
                                  order.photos
                                    .split(",")
                                    .map(photoPath => photoPath.trim())
                                    .filter(Boolean)
                                    .map(photoPath => `
                                      <a
                                        href="${escapeHtml(photoPath)}"
                                        target="_blank"
                                      >
                                        <img
                                          src="${escapeHtml(photoPath)}"
                                          alt="Фото заявки №${orderId}"
                                          style="max-width:200px; max-height:200px; margin:4px; border:1px solid #ccc;"
                                        >
                                      </a>
                                    `)
                                    .join("")
                                }
                              </p>
                            `
                            : ""
                        }
                      `
                      : ""
                  }

                  ${
                    order.type === "Ремонт"
                      ? `
                        <p>
                          Тип оборудования:
                          ${escapeHtml(order.equipment_type || "—")}
                        </p>

                        <p>
                          Название оборудования:
                          ${escapeHtml(order.equipment_name || "—")}
                        </p>

                        <p>
                          Производитель:
                          ${escapeHtml(order.manufacturer || "—")}
                        </p>

                        <p>
                          Описание проблемы:
                          ${escapeHtml(order.problem || "—")}
                        </p>

                        ${
                          order.photos
                            ? `
                              <p>
                                Фото:
                              </p>

                              <p>
                                ${
                                  order.photos
                                    .split(",")
                                    .map(photoPath => photoPath.trim())
                                    .filter(Boolean)
                                    .map(photoPath => `
                                      <a
                                        href="${escapeHtml(photoPath)}"
                                        target="_blank"
                                      >
                                        <img
                                          src="${escapeHtml(photoPath)}"
                                          alt="Фото заявки №${orderId}"
                                          style="max-width:200px; max-height:200px; margin:4px; border:1px solid #ccc;"
                                        >
                                      </a>
                                    `)
                                    .join("")
                                }
                              </p>
                            `
                            : ""
                        }
                      `
                      : ""
                  }

                  <form
                    method="POST"
                    action="/orders/${orderId}/status"
                  >
                    <p>
                      <label>
                        Изменить статус:
                        <select name="status">
                          ${
                            ["Новая", "В разработке", "Закрыто"]
                              .map(status => `
                                <option
                                  value="${escapeHtml(status)}"
                                  ${status === order.status ? "selected" : ""}
                                >
                                  ${escapeHtml(status)}
                                </option>
                              `)
                              .join("")
                          }
                        </select>
                      </label>

                      <button type="submit">
                        Сохранить статус
                      </button>
                    </p>
                  </form>

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
        // ИЗМЕНЕНИЕ СТАТУСА ЗАКАЗА — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/orders\/\d+\/status$/.test(path)
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


          const params =
            await readBody(req);

          const status =
            params.get("status")?.trim() || "";


          const allowedStatuses = [
            "Новая",
            "В разработке",
            "Закрыто"
          ];


          if (
            !allowedStatuses.includes(status)
          ) {

            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `
                  <h1>
                    Некорректный статус.
                  </h1>

                  <p>
                    <a href="/orders/${orderId}">
                      Вернуться к заявке
                    </a>
                  </p>
                `
              ),
              400
            );
          }


          const result =
            db.prepare(`
              UPDATE orders
              SET status = ?
              WHERE id = ?
            `).run(
              status,
              orderId
            );


          if (result.changes === 0) {

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
                      Назад к заявкам
                    </a>
                  </p>
                `
              ),
              404
            );
          }


          return redirect(
            res,
            `/orders/${orderId}`
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

  const videoError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("videoError") || "";

  const documentError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("documentError") || "";

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

  const recommendedValues =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("recommended_ids")
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
                    Галерея изображений:

                    <br>

                    <input
                      type="file"
                      name="gallery"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                    >
                  </p>

                  <p>
                    Видео товара:

                    <br>

                    <input
                      type="file"
                      name="video"
                      accept="video/mp4,video/webm,video/ogg,video/quicktime"
                      multiple
                    >
                  </p>

                  <p style="color:red;">
                    ${videoError || ""}
                  </p>

                  <p>
                    Документы товара:

                    <br>

                    <input
                      type="file"
                      name="document"
                      accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
                      multiple
                    >
                  </p>

                  <p style="color:red;">
                    ${documentError || ""}
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
                      <option value="in_stock" ${(availabilityValue ?? product.availability) === "in_stock" ? "selected" : ""}>В наличии</option>
                      <option value="on_order" ${(availabilityValue ?? product.availability) === "on_order" ? "selected" : ""}>Под заказ</option>
                      <option value="out_of_stock" ${(availabilityValue ?? product.availability) === "out_of_stock" ? "selected" : ""}>Нет в наличии</option>
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

                  <p>
                    Рекомендуемые товары:

                    <br>

                    <select
                      name="recommended_ids"
                      multiple
                      size="6"
                    >

                      ${renderProductRecommendationOptions(
  getProductsForRecommendations(),
  recommendedValues
)}

                    </select>
                  </p>

                  <p>
                    Можно выбрать
                    несколько товаров
                    для рекомендаций.
                  </p>

                  ${renderCharacteristicInputs(
                    categoryCharacteristicRows,
                    characteristicValues
                  )}

                  <button>
                    Сохранить
                  </button>

                  <button
                    name="preview"
                    value="1"
                    formtarget="_blank"
                  >
                    Предпросмотр
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

const params =
  await parseMultipartBody(
    req,
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
`/add-product?name=${encodeURIComponent(params.get("name") || "")}&sku=${encodeURIComponent(params.get("sku") || "")}&brand_id=${encodeURIComponent(params.get("brand_id") || "")}&currency=${encodeURIComponent(params.get("currency") || "")}&availability=${encodeURIComponent(params.get("availability") || "")}&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}&price=&characteristics=${encodeURIComponent(
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

const categoryIds =
            params
              .getAll("category_ids")
              .map(Number)
              .filter(
                Number.isInteger
              );

const recommendedIds =
            params
              .getAll("recommended_ids")
              .map(Number)
              .filter(
                Number.isInteger
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
      `&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}` +
      `&price=${encodeURIComponent(params.get("price") || "")}` +
      `&description=${encodeURIComponent(params.get("description") || "")}` +
      `&discount=${encodeURIComponent(params.get("discount_percent") || "0")}` +
      `&unit=${encodeURIComponent(params.get("unit") || "шт.")}` +
      `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
      `&sortOrderError=${encodeURIComponent("Порядок должен быть больше 0.")}`
  );
}

          

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

          // Видео проверяем до создания товара: иначе при
          // недопустимом файле товар остался бы без видео.
          const videoFiles =
            params.getAllFiles("video");

          const videoError =
            getVideoValidationError(videoFiles);

          if (videoError) {
            return redirect(
              res,
              `/add-product?name=${encodeURIComponent(params.get("name") || "")}` +
                `&sku=${encodeURIComponent(params.get("sku") || "")}` +
                `&brand_id=${encodeURIComponent(params.get("brand_id") || "")}` +
                `&currency=${encodeURIComponent(params.get("currency") || "")}` +
                `&availability=${encodeURIComponent(params.get("availability") || "")}` +
                `&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}` +
                `&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}` +
                `&price=${encodeURIComponent(params.get("price") || "")}` +
                `&description=${encodeURIComponent(params.get("description") || "")}` +
                `&discount=${encodeURIComponent(params.get("discount_percent") || "0")}` +
                `&unit=${encodeURIComponent(params.get("unit") || "шт.")}` +
                `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
                `&is_new=${params.get("is_new") === "1" ? "1" : "0"}` +
                `&is_hit=${params.get("is_hit") === "1" ? "1" : "0"}` +
                `&characteristics=${encodeURIComponent(
                  submittedCharacteristics
                    .map(item => `${item.characteristicId}:${item.value}`)
                    .join("|")
                )}` +
                `&videoError=${encodeURIComponent(videoError)}`
            );
          }

          // Документы проверяем до создания товара: иначе при
          // недопустимом файле товар остался бы без документов.
          const documentFiles =
            params.getAllFiles("document");

          const documentError =
            getDocumentValidationError(documentFiles);

          if (documentError) {
            return redirect(
              res,
              `/add-product?name=${encodeURIComponent(params.get("name") || "")}` +
                `&sku=${encodeURIComponent(params.get("sku") || "")}` +
                `&brand_id=${encodeURIComponent(params.get("brand_id") || "")}` +
                `&currency=${encodeURIComponent(params.get("currency") || "")}` +
                `&availability=${encodeURIComponent(params.get("availability") || "")}` +
                `&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}` +
                `&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}` +
                `&price=${encodeURIComponent(params.get("price") || "")}` +
                `&description=${encodeURIComponent(params.get("description") || "")}` +
                `&discount=${encodeURIComponent(params.get("discount_percent") || "0")}` +
                `&unit=${encodeURIComponent(params.get("unit") || "шт.")}` +
                `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
                `&is_new=${params.get("is_new") === "1" ? "1" : "0"}` +
                `&is_hit=${params.get("is_hit") === "1" ? "1" : "0"}` +
                `&characteristics=${encodeURIComponent(
                  submittedCharacteristics
                    .map(item => `${item.characteristicId}:${item.value}`)
                    .join("|")
                )}` +
                `&documentError=${encodeURIComponent(documentError)}`
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

           saveProductRecommendations(
             productId,
             recommendedIds
           );

           const galleryFiles =
             params.getAllFiles("gallery");

           const galleryAllowedTypes = {
             "image/jpeg": ".jpg",
             "image/png": ".png",
             "image/webp": ".webp"
           };

           let gallerySortOrder =
             db.prepare(`
               SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
               FROM product_images
               WHERE product_id = ?
             `).get(productId).next_sort_order;

           for (const galleryFile of galleryFiles) {
             const galleryImage =
               saveUploadedImage(
                 galleryFile,
                 galleryAllowedTypes
               );

             if (!galleryImage) {
               continue;
             }

             db.prepare(`
               INSERT INTO product_images
               (
                 product_id,
                 image,
                 sort_order
               )
               VALUES (?, ?, ?)
             `).run(
               productId,
               galleryImage,
               gallerySortOrder++
             );
           }

           let videoSortOrder =
             db.prepare(`
               SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
               FROM product_videos
               WHERE product_id = ?
             `).get(productId).next_sort_order;

           for (const videoFile of videoFiles) {
             const videoPath =
               saveUploadedVideo(videoFile);

             if (!videoPath) {
               continue;
             }

             db.prepare(`
               INSERT INTO product_videos
               (
                 product_id,
                 video,
                 sort_order
               )
               VALUES (?, ?, ?)
             `).run(
               productId,
               videoPath,
               videoSortOrder++
             );
           }

           let documentSortOrder =
             db.prepare(`
               SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
               FROM product_documents
               WHERE product_id = ?
             `).get(productId).next_sort_order;

           for (const documentFile of documentFiles) {
             const documentPath =
               saveUploadedDocument(documentFile);

             if (!documentPath) {
               continue;
             }

             db.prepare(`
               INSERT INTO product_documents
               (
                 product_id,
                 document,
                 sort_order
               )
               VALUES (?, ?, ?)
             `).run(
               productId,
               documentPath,
               documentSortOrder++
             );
           }



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
            params.get("preview") === "1"
              ? `/product/${productId}`
              : "/catalog"
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

const queryParams =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  );

          const categoryIdsParam =
  queryParams.get("category_ids");

const selectedIds =
  categoryIdsParam !== null
    ? categoryIdsParam
        .split(",")
        .filter(Boolean)
        .map(Number)
    : getProductCategoryIds(id);

const recommendedIdsParam =
  queryParams.get("recommended_ids");

const selectedRecommendedIds =
  recommendedIdsParam !== null
    ? recommendedIdsParam
        .split(",")
        .filter(Boolean)
        .map(Number)
    : getProductRecommendationIds(id);

          const categoryCharacteristicRows =
            getCategoryCharacteristicRows();

          const productCharacteristics =
  getProductCharacteristics(id);

const valuesByCharacteristicId =
  new Map(
    categoryCharacteristicRows.map(
      characteristic => {
        const queryValue =
          queryParams.get(
            `characteristic_${characteristic.id}`
          );

        const existingCharacteristic =
          productCharacteristics.find(
            item =>
              item.id ===
              characteristic.id
          );

        return [
          characteristic.id,
          queryValue !== null
            ? queryValue
            : existingCharacteristic?.value || ""
        ];
      }
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

          const galleryImages =
            db.prepare(`
              SELECT
                image
              FROM product_images
              WHERE product_id = ?
              ORDER BY
                sort_order,
                image
            `).all(id);

          let galleryHtml = "";

          if (galleryImages.length > 0) {
            galleryHtml += `
              <p>
                Текущие изображения галереи:
              </p>

              <div>
            `;

            for (const galleryImage of galleryImages) {
              galleryHtml += `
                <span
                  style="position:relative; display:inline-block; margin:8px;"
                >
                  <a href="${escapeHtml(galleryImage.image)}">
                    <img
                      src="${escapeHtml(galleryImage.image)}"
                      alt="${escapeHtml(product.name)}"
                      width="120"
                      style="border:1px solid #ccc; display:block;"
                    >
                  </a>

                  <form
                    method="POST"
                    action="/product-images/delete/${id}"
                    style="margin:0;"
                  >
                    <input
                      type="hidden"
                      name="image"
                      value="${escapeHtml(galleryImage.image)}"
                    >

                    <button
                      type="submit"
                      title="Удалить фото"
                      onclick="return confirm('Удалить это фото?')"
                      style="
                        position:absolute;
                        top:-8px;
                        right:-8px;
                        width:22px;
                        height:22px;
                        padding:0;
                        line-height:20px;
                        border:1px solid #ccc;
                        border-radius:50%;
                        background:#fff;
                        color:#c00;
                        font-size:14px;
                        cursor:pointer;
                      "
                    >&times;</button>
                  </form>
                </span>
              `;
            }

            galleryHtml += `
              </div>
            `;
          }

          galleryHtml += `
            <p>
              Добавить новые фото галереи:

              <br>

              <input
                type="file"
                name="gallery"
                accept="image/jpeg,image/png,image/webp"
                multiple
              >
            </p>
          `;

          const productVideos =
            db.prepare(`
              SELECT
                video
              FROM product_videos
              WHERE product_id = ?
              ORDER BY
                sort_order,
                video
            `).all(id);

          let videoListHtml = "";

          if (productVideos.length > 0) {
            videoListHtml += `
              <p>
                Текущие видео товара:
              </p>

              <div>
            `;

            for (const productVideo of productVideos) {
              videoListHtml += `
                <span
                  style="position:relative; display:inline-block; margin:8px;"
                >
                  <video
                    src="${escapeHtml(productVideo.video)}"
                    controls
                    width="240"
                    style="border:1px solid #ccc; display:block;"
                  ></video>

                  <form
                    method="POST"
                    action="/product-videos/delete/${id}"
                    style="margin:0;"
                  >
                    <input
                      type="hidden"
                      name="video"
                      value="${escapeHtml(productVideo.video)}"
                    >

                    <button
                      type="submit"
                      title="Удалить видео"
                      onclick="return confirm('Удалить это видео?')"
                      style="
                        position:absolute;
                        top:-8px;
                        right:-8px;
                        width:22px;
                        height:22px;
                        padding:0;
                        line-height:20px;
                        border:1px solid #ccc;
                        border-radius:50%;
                        background:#fff;
                        color:#c00;
                        font-size:14px;
                        cursor:pointer;
                      "
                    >&times;</button>
                  </form>
                </span>
              `;
            }

            videoListHtml += `
              </div>
            `;
          }

          const videoError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("videoError") || "";

          const videoHtml = `
            <p>
              Добавить видео товара:

              <br>

              <input
                type="file"
                name="video"
                accept="video/mp4,video/webm,video/ogg,video/quicktime"
                multiple
              >
            </p>

            <p style="color:red;">
              ${videoError || ""}
            </p>
          `;

          // Показываем уже загруженные документы товара рядом
          // с полем добавления. Удаление и публичный вывод
          // здесь не реализованы.
          const productDocuments =
            db.prepare(`
              SELECT
                document
              FROM product_documents
              WHERE product_id = ?
              ORDER BY
                sort_order,
                document
            `).all(id);

          let documentListHtml = "";

          if (productDocuments.length > 0) {
            documentListHtml += `
              <p>
                Текущие документы товара:
              </p>

              <ul>
            `;

            for (const productDocument of productDocuments) {
              const documentName =
                productDocument.document
                  .split("/")
                  .pop();

              documentListHtml += `
                <li>
                  <a
                    href="${escapeHtml(productDocument.document)}"
                    target="_blank"
                    rel="noopener"
                  >${escapeHtml(documentName)}</a>

                  <form
                    method="POST"
                    action="/product-documents/delete/${id}"
                    style="display:inline; margin:0;"
                  >
                    <input
                      type="hidden"
                      name="document"
                      value="${escapeHtml(productDocument.document)}"
                    >

                    <button
                      type="submit"
                      title="Удалить документ"
                      onclick="return confirm('Удалить этот документ?')"
                      style="
                        margin-left:8px;
                        width:22px;
                        height:22px;
                        padding:0;
                        line-height:20px;
                        border:1px solid #ccc;
                        border-radius:50%;
                        background:#fff;
                        color:#c00;
                        font-size:14px;
                        cursor:pointer;
                      "
                    >&times;</button>
                  </form>
                </li>
              `;
            }

            documentListHtml += `
              </ul>
            `;
          }

          const documentError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("documentError") || "";

          const documentHtml = `
            <p>
              Добавить документы товара:

              <br>

              <input
                type="file"
                name="document"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
                multiple
              >
            </p>

            <p style="color:red;">
              ${documentError || ""}
            </p>
          `;

            const sortOrderError =
  new URLSearchParams(
    req.url.split("?")[1] || ""
  ).get("sortOrderError") || "";


  const priceValue =
  queryParams.get("price");

const discountValue =
  queryParams.get("discount");

  const sortOrderValue =
  queryParams.get("sort_order");

  const unitValue =
  queryParams.get("unit");

  const skuValue =
  queryParams.get("sku");

  const brandValue =
  queryParams.get("brand_id");

  const currencyValue =
  queryParams.get("currency");

  const availabilityValue =
  queryParams.get("availability");

  const priceOnRequestParam =
  queryParams.get("price_on_request");

  const isNewParam =
  queryParams.get("is_new");

  const isHitParam =
  queryParams.get("is_hit");

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
                      value="${discountValue || product.discount_percent || 0}"                    
                      >
                  </p>

                  <p>
                    Цена по запросу:

                    <input
                      type="checkbox"
                      name="price_on_request"
                      value="1"
                     ${
  priceOnRequestParam !== null
    ? priceOnRequestParam === "1"
      ? "checked"
      : ""
    : product.price_on_request
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
  (unitValue ?? product.unit) === "шт."
    ? "selected"
    : ""
}

                    >
                      шт. — штука
                    </option>

                    <option
                      value="компл."
                      ${
                        (unitValue ?? product.unit) === "компл."
                          ? "selected"
                          : ""
                      }
                    >
                      компл. — комплект
                    </option>

                    <option
                      value="кг"
                      ${
                        (unitValue ?? product.unit) === "кг"
                          ? "selected"
                          : ""
                      }
                    >
                      кг — килограмм
                    </option>

                    <option
                      value="г"
                      ${
                        (unitValue ?? product.unit) === "г"
                          ? "selected"
                          : ""
                      }
                    >
                      г — грамм
                    </option>

                    <option
                      value="т"
                      ${
                        (unitValue ?? product.unit) === "т"
                          ? "selected"
                          : ""
                      }
                    >
                      т — тонна
                    </option>

                    <option
                      value="м"
                      ${
                        (unitValue ?? product.unit) === "м"
                          ? "selected"
                          : ""
                      }
                    >
                      м — метр
                    </option>

                    <option
                      value="см"
                      ${
                        (unitValue ?? product.unit) === "см"
                          ? "selected"
                          : ""
                      }
                    >
                      см — сантиметр
                    </option>

                    <option
                      value="мм"
                      ${
                        (unitValue ?? product.unit) === "мм"
                          ? "selected"
                          : ""
                      }
                    >
                      мм — миллиметр
                    </option>

                    <option
                      value="км"
                      ${
                        (unitValue ?? product.unit) === "км"
                          ? "selected"
                          : ""
                      }
                    >
                      км — километр
                    </option>

                    <option
                      value="м²"
                      ${
                        (unitValue ?? product.unit) === "м²"
                          ? "selected"
                          : ""
                      }
                    >
                      м² — квадратный метр
                    </option>

                    <option
                      value="см²"
                      ${
                        (unitValue ?? product.unit) === "см²"
                          ? "selected"
                          : ""
                      }
                    >
                      см² — квадратный сантиметр
                    </option>

                    <option
                      value="м³"
                      ${
                        (unitValue ?? product.unit) === "м³"
                          ? "selected"
                          : ""
                      }
                    >
                      м³ — кубический метр
                    </option>

                    <option
                      value="л"
                      ${
                        (unitValue ?? product.unit) === "л"
                          ? "selected"
                          : ""
                      }
                    >
                      л — литр
                    </option>

                    <option
                      value="мл"
                      ${
                        (unitValue ?? product.unit) === "мл"
                          ? "selected"
                          : ""
                      }
                    >
                      мл — миллилитр
                    </option>

                    <option
                      value="ч"
                      ${
                        (unitValue ?? product.unit) === "ч"
                          ? "selected"
                          : ""
                      }
                    >
                      ч — час
                    </option>

                    <option
                      value="мин"
                      ${
                        (unitValue ?? product.unit) === "мин"
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
value="${escapeHtml(skuValue ?? product.sku ?? "")}"
                   >
                 </p>

                 <p>
                   Бренд / производитель:

                   <br>

                   <select name="brand_id">
  <option value="">Без бренда</option>
  ${db.prepare("SELECT id, name FROM brands ORDER BY name").all().map(brand => `
<option value="${brand.id}" ${(brandValue ?? product.brand_id) === String(brand.id) ? "selected" : ""}>

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
                          (currencyValue ?? product.currency) === "BYN"
                            ? "selected"
                            : ""
                        }
                      >
                        BYN
                      </option>

                      <option
                        value="USD"
                        ${
                          (currencyValue ?? product.currency) === "USD"
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
                        (availabilityValue ?? product.availability) === "in_stock"
                          ? "selected"
                          : ""
                      }
                    >
                      В наличии
                    </option>

                    <option
                      value="on_order"
                      ${
                        (availabilityValue ?? product.availability) === "on_order"
                          ? "selected"
                          : ""
                      }
                    >
                      Под заказ
                    </option>

                    <option
                      value="out_of_stock"
                      ${
                        (availabilityValue ?? product.availability) === "out_of_stock"
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
                       ${
  isNewParam !== null
    ? isNewParam === "1"
      ? "checked"
      : ""
    : product.is_new
      ? "checked"
      : ""
}
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
${
  isHitParam !== null
    ? isHitParam === "1"
      ? "checked"
      : ""
    : product.is_hit
      ? "checked"
      : ""
}
    >
    Хит
  </label>
</p>

<p>
  Порядок:

  <input
    type="number"
    name="sort_order"
value="${sortOrderValue ?? product.sort_order}"
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

                  ${galleryHtml}

                  ${videoListHtml}

                  ${videoHtml}

                  ${documentListHtml}

                  ${documentHtml}

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

                  <p>
                    Рекомендуемые товары:

                    <br>

                    <select
                      name="recommended_ids"
                      multiple
                      size="6"
                    >

                      ${renderProductRecommendationOptions(
  getProductsForRecommendations(id),
  selectedRecommendedIds
)}

                    </select>
                  </p>

                  <p>
                    Можно выбрать
                    несколько товаров
                    для рекомендаций.
                    Текущий товар
                    недоступен для выбора.
                  </p>

                  <button>
                    Сохранить
                  </button>

                  <button
                    name="preview"
                    value="1"
                    formtarget="_blank"
                  >
                    Предпросмотр
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
  const params = await parseMultipartBody(req, contentType);

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

const categoryIds =
  params
    .getAll("category_ids")
    .map(Number)
    .filter(Number.isInteger);

const recommendedIds =
  params
    .getAll("recommended_ids")
    .map(Number)
    .filter(Number.isInteger)
    .filter(
      recommendedProductId =>
        recommendedProductId !== id
    );
  
  const characteristicParams =
  getCharacteristicsForCategoryIds(
    categoryIds
  )
    .map(characteristic => {
      const value =
        params.get(
          `characteristic_${characteristic.id}`
        ) || "";

      return `&characteristic_${characteristic.id}=${encodeURIComponent(value)}`;
    })
    .join("");

if (sortOrder < 1) {
  return redirect(
    res,
    `/edit-product/${id}?name=${encodeURIComponent(params.get("name") || "")}` +
      `&description=${encodeURIComponent(params.get("description") || "")}` +
      `&price=${encodeURIComponent(params.get("price") || "")}` +
      `&discount=${encodeURIComponent(params.get("discount_percent") || "")}` +
      `&price_on_request=${params.get("price_on_request") === "1" ? "1" : "0"}` + 
      `&unit=${encodeURIComponent(params.get("unit") || "")}` +
      `&sku=${encodeURIComponent(params.get("sku") || "")}` +
      `&brand_id=${encodeURIComponent(params.get("brand_id") || "")}` +
      `&currency=${encodeURIComponent(params.get("currency") || "")}` +
      `&availability=${encodeURIComponent(params.get("availability") || "")}` +
      `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
      `&is_new=${params.get("is_new") === "1" ? "1" : "0"}` +
      `&is_hit=${params.get("is_hit") === "1" ? "1" : "0"}` +
      `&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}` +
      `&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}` +
      `&${characteristicParams.substring(1)}` +
      `&sortOrderError=${encodeURIComponent("Порядок должен быть больше 0.")}`
        );
    }

  // Видео проверяем до обновления товара, чтобы не
  // сохранять изменения частично.
  const videoFiles =
    params.getAllFiles("video");

  const videoError =
    getVideoValidationError(videoFiles);

  if (videoError) {
    return redirect(
      res,
      `/edit-product/${id}?name=${encodeURIComponent(params.get("name") || "")}` +
        `&description=${encodeURIComponent(params.get("description") || "")}` +
        `&price=${encodeURIComponent(params.get("price") || "")}` +
        `&discount=${encodeURIComponent(params.get("discount_percent") || "")}` +
        `&price_on_request=${params.get("price_on_request") === "1" ? "1" : "0"}` +
        `&unit=${encodeURIComponent(params.get("unit") || "")}` +
        `&sku=${encodeURIComponent(params.get("sku") || "")}` +
        `&brand_id=${encodeURIComponent(params.get("brand_id") || "")}` +
        `&currency=${encodeURIComponent(params.get("currency") || "")}` +
        `&availability=${encodeURIComponent(params.get("availability") || "")}` +
        `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
        `&is_new=${params.get("is_new") === "1" ? "1" : "0"}` +
        `&is_hit=${params.get("is_hit") === "1" ? "1" : "0"}` +
      `&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}` +
      `&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}` +
      `&${characteristicParams.substring(1)}` +
      `&videoError=${encodeURIComponent(videoError)}`
    );
  }

  // Документы проверяем до обновления товара, чтобы не
  // сохранять изменения частично.
  const documentFiles =
    params.getAllFiles("document");

  const documentError =
    getDocumentValidationError(documentFiles);

  if (documentError) {
    return redirect(
      res,
      `/edit-product/${id}?name=${encodeURIComponent(params.get("name") || "")}` +
        `&description=${encodeURIComponent(params.get("description") || "")}` +
        `&price=${encodeURIComponent(params.get("price") || "")}` +
        `&discount=${encodeURIComponent(params.get("discount_percent") || "")}` +
        `&price_on_request=${params.get("price_on_request") === "1" ? "1" : "0"}` +
        `&unit=${encodeURIComponent(params.get("unit") || "")}` +
        `&sku=${encodeURIComponent(params.get("sku") || "")}` +
        `&brand_id=${encodeURIComponent(params.get("brand_id") || "")}` +
        `&currency=${encodeURIComponent(params.get("currency") || "")}` +
        `&availability=${encodeURIComponent(params.get("availability") || "")}` +
        `&sort_order=${encodeURIComponent(params.get("sort_order") || "")}` +
        `&is_new=${params.get("is_new") === "1" ? "1" : "0"}` +
        `&is_hit=${params.get("is_hit") === "1" ? "1" : "0"}` +
      `&category_ids=${encodeURIComponent(params.getAll("category_ids").join(","))}` +
      `&recommended_ids=${encodeURIComponent(params.getAll("recommended_ids").join(","))}` +
      `&${characteristicParams.substring(1)}` +
      `&documentError=${encodeURIComponent(documentError)}`
    );
  }


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

  saveProductRecommendations(id, recommendedIds);

  const galleryFiles =
    params.getAllFiles("gallery");

  const galleryAllowedTypes = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
  };

  let gallerySortOrder =
    db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
      FROM product_images
      WHERE product_id = ?
    `).get(id).next_sort_order;

  for (const galleryFile of galleryFiles) {
    const galleryImage =
      saveUploadedImage(
        galleryFile,
        galleryAllowedTypes
      );

    if (!galleryImage) {
      continue;
    }

    db.prepare(`
      INSERT INTO product_images
      (
        product_id,
        image,
        sort_order
      )
      VALUES (?, ?, ?)
    `).run(
      id,
      galleryImage,
      gallerySortOrder++
    );
  }

  let videoSortOrder =
    db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
      FROM product_videos
      WHERE product_id = ?
    `).get(id).next_sort_order;

  for (const videoFile of videoFiles) {
    const videoPath =
      saveUploadedVideo(videoFile);

    if (!videoPath) {
      continue;
    }

    db.prepare(`
      INSERT INTO product_videos
      (
        product_id,
        video,
        sort_order
      )
      VALUES (?, ?, ?)
    `).run(
      id,
      videoPath,
      videoSortOrder++
    );
  }

  let documentSortOrder =
    db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
      FROM product_documents
      WHERE product_id = ?
    `).get(id).next_sort_order;

  for (const documentFile of documentFiles) {
    const documentPath =
      saveUploadedDocument(documentFile);

    if (!documentPath) {
      continue;
    }

    db.prepare(`
      INSERT INTO product_documents
      (
        product_id,
        document,
        sort_order
      )
      VALUES (?, ?, ?)
    `).run(
      id,
      documentPath,
      documentSortOrder++
    );
  }

  return redirect(
    res,
    params.get("preview") === "1"
      ? `/product/${id}`
      : "/catalog"
  );
}

        // ==================================================
        // УДАЛИТЬ ФОТО ГАЛЕРЕИ — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/product-images\/delete\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

          const productId =
            Number(
              path.split("/")[3]
            );

          const params =
            await readBody(req);

          const image =
            params.get("image") || "";

          const galleryRow =
            db.prepare(`
              SELECT product_id
              FROM product_images
              WHERE product_id = ?
                AND image = ?
            `).get(
              productId,
              image
            );

          if (!galleryRow) {
            return redirect(
              res,
              `/edit-product/${productId}`
            );
          }

          db.prepare(`
            DELETE FROM product_images
            WHERE product_id = ?
              AND image = ?
          `).run(
            productId,
            image
          );

          if (image.startsWith("/uploads/")) {
            const uploadPath =
              pathModule.join(
                process.cwd(),
                "uploads",
                pathModule.basename(image)
              );

            try {
              await fs.unlink(
                uploadPath
              );
            } catch (unlinkError) {
              console.error(
                "Не удалось удалить файл галереи:",
                unlinkError?.message || unlinkError
              );
            }
          }

          return redirect(
            res,
            `/edit-product/${productId}`
          );
        }

        // ==================================================
        // УДАЛИТЬ ВИДЕО ТОВАРА — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/product-videos\/delete\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

          const productId =
            Number(
              path.split("/")[3]
            );

          const params =
            await readBody(req);

          const video =
            params.get("video") || "";

          const videoRow =
            db.prepare(`
              SELECT product_id
              FROM product_videos
              WHERE product_id = ?
                AND video = ?
            `).get(
              productId,
              video
            );

          if (!videoRow) {
            return redirect(
              res,
              `/edit-product/${productId}`
            );
          }

          db.prepare(`
            DELETE FROM product_videos
            WHERE product_id = ?
              AND video = ?
          `).run(
            productId,
            video
          );

          if (video.startsWith("/uploads/")) {
            const uploadPath =
              pathModule.join(
                process.cwd(),
                "uploads",
                pathModule.basename(video)
              );

            try {
              await fs.unlink(
                uploadPath
              );
            } catch (unlinkError) {
              console.error(
                "Не удалось удалить файл видео:",
                unlinkError?.message || unlinkError
              );
            }
          }

          return redirect(
            res,
            `/edit-product/${productId}`
          );
        }

        // ==================================================
        // УДАЛИТЬ ДОКУМЕНТ ТОВАРА — ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/product-documents\/delete\/\d+$/.test(path)
        ) {

          if (
            !requireAdmin(
              req,
              res
            )
          ) {
            return;
          }

          const productId =
            Number(
              path.split("/")[3]
            );

          const params =
            await readBody(req);

          const document =
            params.get("document") || "";

          // Ищем запись по товару из маршрута и пути документа
          // из формы: это подтверждает, что документ существует
          // и принадлежит именно этому товару.
          const documentRow =
            db.prepare(`
              SELECT product_id
              FROM product_documents
              WHERE product_id = ?
                AND document = ?
            `).get(
              productId,
              document
            );

          if (!documentRow) {
            return redirect(
              res,
              `/edit-product/${productId}`
            );
          }

          db.prepare(`
            DELETE FROM product_documents
            WHERE product_id = ?
              AND document = ?
          `).run(
            productId,
            document
          );

          // Удаляем физический файл только внутри uploads:
          // basename отбрасывает любые попытки path traversal.
          if (document.startsWith("/uploads/")) {
            const uploadPath =
              pathModule.join(
                process.cwd(),
                "uploads",
                pathModule.basename(document)
              );

            try {
              await fs.unlink(
                uploadPath
              );
            } catch (unlinkError) {
              console.error(
                "Не удалось удалить файл документа:",
                unlinkError?.message || unlinkError
              );
            }
          }

          return redirect(
            res,
            `/edit-product/${productId}`
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
        // УСЛУГИ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/services"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const services = db.prepare(`
            SELECT *
            FROM services
            ORDER BY sort_order, id
          `).all();

          return sendHtml(
            res,
            renderPage(
              req,
              "Услуги",
              `
                <h1>Управление услугами</h1>

                <p>
                  <a href="/admin">← Назад в админ-панель</a>
                </p>

                <h2>Добавить услугу</h2>

                <form method="POST" action="/admin/services" enctype="multipart/form-data">
                  <p>
                    Название:
                    <input type="text" name="name" required>
                  </p>

                  <p>
                    Краткое описание:
                    <textarea name="short_description"></textarea>
                  </p>

                  <p>
                    Полное описание:
                    <textarea name="description"></textarea>
                  </p>

                  <p>
                    Изображение:
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif">
                  </p>

                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="0">
                  </p>

                  <button type="submit">Добавить услугу</button>
                </form>

                <h2>Услуги</h2>

                <ul>
                  ${services.map(service => `
                    <li>
                      <strong>${escapeHtml(service.name)}</strong>
                      — ${service.is_visible ? "показывается" : "скрыта"}
                      — порядок: ${service.sort_order}

                      <a href="/admin/services/edit/${service.id}">
                        Редактировать
                      </a>

                      <a href="/admin/services/toggle/${service.id}">
                        ${service.is_visible ? "Скрыть" : "Показать"}
                      </a>

                      <a
                        href="/admin/services/delete/${service.id}"
                        onclick="return confirm('Удалить услугу?')"
                      >
                        Удалить
                      </a>
                    </li>
                  `).join("")}
                </ul>
              `
            )
          );
        }

        // ==================================================
        // УСЛУГИ — POST CREATE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/services"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const name = params.get("name")?.trim() || "";
          const shortDescription = params.get("short_description")?.trim() || "";
          const description = params.get("description")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);
          const imageFile = params.getFile("image");

          if (
            !name ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0 ||
            !description
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните название, полное описание и корректный порядок.</h1>`
              ),
              400
            );
          }

          let image = "";
          try {
            image = imageFile ? saveUploadedImage(imageFile) : "";
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          db.prepare(`
            INSERT INTO services
            (name, short_description, description, image, sort_order, is_visible)
            VALUES (?, ?, ?, ?, ?, 1)
          `).run(name, shortDescription, description, image, sortOrder);

          return redirect(res, "/admin/services");
        }

        // ==================================================
        // УСЛУГИ — EDIT GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/services\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const service = db.prepare("SELECT * FROM services WHERE id = ?").get(id);

          if (!service) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Услуга не найдена.</h1>`), 404);
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Редактирование услуги",
              `
                <h1>Редактирование услуги</h1>

                <form method="POST" action="/admin/services/edit/${id}" enctype="multipart/form-data">
                  <p>
                    Название:
                    <input type="text" name="name" value="${escapeHtml(service.name)}" required>
                  </p>

                  <p>
                    Краткое описание:
                    <textarea name="short_description">${escapeHtml(service.short_description)}</textarea>
                  </p>

                  <p>
                    Полное описание:
                    <textarea name="description" required>${escapeHtml(service.description)}</textarea>
                  </p>

                  <p>
                    Изображение:
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif">
                    ${service.image ? `<br><img src="${escapeHtml(service.image)}" alt="${escapeHtml(service.name)}" width="150">` : ""}
                  </p>

                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="${service.sort_order}">
                  </p>

                  <button type="submit">Сохранить</button>
                </form>
              `
            )
          );
        }

        // ==================================================
        // УСЛУГИ — EDIT POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/admin\/services\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const service = db.prepare("SELECT * FROM services WHERE id = ?").get(id);

          if (!service) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Услуга не найдена.</h1>`), 404);
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const name = params.get("name")?.trim() || "";
          const shortDescription = params.get("short_description")?.trim() || "";
          const description = params.get("description")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);
          const imageFile = params.getFile("image");

          if (
            !name ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0 ||
            !description
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните название, полное описание и корректный порядок.</h1>`
              ),
              400
            );
          }

          let image = service.image;
          try {
            if (imageFile) {
              image = saveUploadedImage(imageFile);
            }
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          db.prepare(`
            UPDATE services
            SET name = ?, short_description = ?, description = ?, image = ?, sort_order = ?
            WHERE id = ?
          `).run(name, shortDescription, description, image, sortOrder, id);

          return redirect(res, "/admin/services");
        }

        // ==================================================
        // УСЛУГИ — TOGGLE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/services\/toggle\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          db.prepare(`
            UPDATE services
            SET is_visible = CASE is_visible WHEN 1 THEN 0 ELSE 1 END
            WHERE id = ?
          `).run(id);

          return redirect(res, "/admin/services");
        }

        // ==================================================
        // УСЛУГИ — DELETE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/services\/delete\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const service = db.prepare("SELECT image FROM services WHERE id = ?").get(id);

          if (service?.image) {
            await fs.unlink(pathModule.join(UPLOADS_DIR, pathModule.basename(service.image))).catch(() => {});
          }

          db.prepare("DELETE FROM services WHERE id = ?").run(id);
          return redirect(res, "/admin/services");
        }

        // ==================================================
        // ПРОЕКТЫ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/projects"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const projects = db.prepare(`
            SELECT *
            FROM projects
            ORDER BY sort_order, id
          `).all();

          return sendHtml(
            res,
            renderPage(
              req,
              "Проекты",
              `
                <h1>Управление проектами</h1>

                <p><a href="/admin">← Назад в админ-панель</a></p>

                <h2>Добавить проект</h2>

                <form method="POST" action="/admin/projects" enctype="multipart/form-data">
                  <p>
                    Название:
                    <input type="text" name="name" required>
                  </p>

                  <p>
                    Описание:
                    <textarea name="description" required></textarea>
                  </p>

                  <p>
                    Изображение:
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif">
                  </p>

                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="0">
                  </p>

                  <button type="submit">Добавить проект</button>
                </form>

                <h2>Проекты</h2>

                <ul>
                  ${projects.map(project => `
                    <li>
                      <strong>${escapeHtml(project.name)}</strong>
                      — ${project.is_visible ? "показывается" : "скрыт"}
                      — порядок: ${project.sort_order}

                      <a href="/admin/projects/edit/${project.id}">Редактировать</a>
                      <a href="/admin/projects/toggle/${project.id}">
                        ${project.is_visible ? "Скрыть" : "Показать"}
                      </a>
                      <a
                        href="/admin/projects/delete/${project.id}"
                        onclick="return confirm('Удалить проект?')"
                      >
                        Удалить
                      </a>
                    </li>
                  `).join("")}
                </ul>
              `
            )
          );
        }

        // ==================================================
        // ПРОЕКТЫ — POST CREATE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/projects"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const name = params.get("name")?.trim() || "";
          const description = params.get("description")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);
          const imageFile = params.getFile("image");

          if (
            !name ||
            !description ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните название, описание и корректный порядок.</h1>`
              ),
              400
            );
          }

          let image = "";
          try {
            image = imageFile ? saveUploadedImage(imageFile) : "";
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          db.prepare(`
            INSERT INTO projects (name, description, image, sort_order, is_visible)
            VALUES (?, ?, ?, ?, 1)
          `).run(name, description, image, sortOrder);

          return redirect(res, "/admin/projects");
        }

        // ==================================================
        // ПРОЕКТЫ — EDIT GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/projects\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);

          if (!project) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Проект не найден.</h1>`), 404);
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Редактирование проекта",
              `
                <h1>Редактирование проекта</h1>

                <form method="POST" action="/admin/projects/edit/${id}" enctype="multipart/form-data">
                  <p>
                    Название:
                    <input type="text" name="name" value="${escapeHtml(project.name)}" required>
                  </p>

                  <p>
                    Описание:
                    <textarea name="description" required>${escapeHtml(project.description)}</textarea>
                  </p>

                  <p>
                    Изображение:
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif">
                    ${project.image ? `<br><img src="${escapeHtml(project.image)}" alt="${escapeHtml(project.name)}" width="150">` : ""}
                  </p>

                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="${project.sort_order}">
                  </p>

                  <button type="submit">Сохранить</button>
                </form>
              `
            )
          );
        }

        // ==================================================
        // ПРОЕКТЫ — EDIT POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/admin\/projects\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);

          if (!project) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Проект не найден.</h1>`), 404);
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const name = params.get("name")?.trim() || "";
          const description = params.get("description")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);
          const imageFile = params.getFile("image");

          if (
            !name ||
            !description ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните название, описание и корректный порядок.</h1>`
              ),
              400
            );
          }

          let image = project.image;
          try {
            if (imageFile) {
              image = saveUploadedImage(imageFile);
            }
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          db.prepare(`
            UPDATE projects
            SET name = ?, description = ?, image = ?, sort_order = ?
            WHERE id = ?
          `).run(name, description, image, sortOrder, id);

          return redirect(res, "/admin/projects");
        }

        // ==================================================
        // ПРОЕКТЫ — TOGGLE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/projects\/toggle\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          db.prepare(`
            UPDATE projects
            SET is_visible = CASE is_visible WHEN 1 THEN 0 ELSE 1 END
            WHERE id = ?
          `).run(id);

          return redirect(res, "/admin/projects");
        }

        // ==================================================
        // ПРОЕКТЫ — DELETE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/projects\/delete\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const project = db.prepare("SELECT image FROM projects WHERE id = ?").get(id);

          if (project?.image) {
            await fs.unlink(
              pathModule.join(UPLOADS_DIR, pathModule.basename(project.image))
            ).catch(() => {});
          }

          db.prepare("DELETE FROM projects WHERE id = ?").run(id);
          return redirect(res, "/admin/projects");
        }

        // ==================================================
        // НОВОСТИ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/news"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const news = db.prepare(`
            SELECT *
            FROM news
            ORDER BY sort_order, id
          `).all();

          return sendHtml(
            res,
            renderPage(
              req,
              "Новости",
              `
                <h1>Управление новостями</h1>

                <p><a href="/admin">← Назад в админ-панель</a></p>

                <h2>Добавить новость</h2>

                <form method="POST" action="/admin/news" enctype="multipart/form-data">
                  <p>
                    Заголовок:
                    <input type="text" name="title" required>
                  </p>

                  <p>
                    Краткий текст:
                    <textarea name="short_text" required></textarea>
                  </p>

                  <p>
                    Полный текст:
                    <textarea name="full_text" required></textarea>
                  </p>

                  <p>
                    Изображение:
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif">
                  </p>

                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="0">
                  </p>

                  <button type="submit">Добавить новость</button>
                </form>

                <h2>Новости</h2>

                <ul>
                  ${news.map(item => `
                    <li>
                      <strong>${escapeHtml(item.title)}</strong>
                      — ${item.is_visible ? "показывается" : "скрыта"}
                      — порядок: ${item.sort_order}

                      <a href="/admin/news/edit/${item.id}">Редактировать</a>
                      <a href="/admin/news/toggle/${item.id}">
                        ${item.is_visible ? "Скрыть" : "Показать"}
                      </a>
                      <a
                        href="/admin/news/delete/${item.id}"
                        onclick="return confirm('Удалить новость?')"
                      >
                        Удалить
                      </a>
                    </li>
                  `).join("")}
                </ul>
              `
            )
          );
        }

        // ==================================================
        // НОВОСТИ — POST CREATE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/news"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const title = params.get("title")?.trim() || "";
          const shortText = params.get("short_text")?.trim() || "";
          const fullText = params.get("full_text")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);
          const imageFile = params.getFile("image");

          if (
            !title ||
            !shortText ||
            !fullText ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните заголовок, тексты и корректный порядок.</h1>`
              ),
              400
            );
          }

          let image = "";
          try {
            image = imageFile ? saveUploadedImage(imageFile) : "";
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          db.prepare(`
            INSERT INTO news
            (title, short_text, full_text, image, sort_order, is_visible)
            VALUES (?, ?, ?, ?, ?, 1)
          `).run(title, shortText, fullText, image, sortOrder);

          return redirect(res, "/admin/news");
        }

        // ==================================================
        // НОВОСТИ — EDIT GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/news\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const item = db.prepare("SELECT * FROM news WHERE id = ?").get(id);

          if (!item) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Новость не найдена.</h1>`), 404);
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Редактирование новости",
              `
                <h1>Редактирование новости</h1>

                <form method="POST" action="/admin/news/edit/${id}" enctype="multipart/form-data">
                  <p>
                    Заголовок:
                    <input type="text" name="title" value="${escapeHtml(item.title)}" required>
                  </p>

                  <p>
                    Краткий текст:
                    <textarea name="short_text" required>${escapeHtml(item.short_text)}</textarea>
                  </p>

                  <p>
                    Полный текст:
                    <textarea name="full_text" required>${escapeHtml(item.full_text)}</textarea>
                  </p>

                  <p>
                    Изображение:
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif">
                    ${item.image ? `<br><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" width="150">` : ""}
                  </p>

                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="${item.sort_order}">
                  </p>

                  <button type="submit">Сохранить</button>
                </form>
              `
            )
          );
        }

        // ==================================================
        // НОВОСТИ — EDIT POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/admin\/news\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const item = db.prepare("SELECT * FROM news WHERE id = ?").get(id);

          if (!item) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Новость не найдена.</h1>`), 404);
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const title = params.get("title")?.trim() || "";
          const shortText = params.get("short_text")?.trim() || "";
          const fullText = params.get("full_text")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);
          const imageFile = params.getFile("image");

          if (
            !title ||
            !shortText ||
            !fullText ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните заголовок, тексты и корректный порядок.</h1>`
              ),
              400
            );
          }

          let image = item.image;
          try {
            if (imageFile) {
              image = saveUploadedImage(imageFile);
            }
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          db.prepare(`
            UPDATE news
            SET title = ?, short_text = ?, full_text = ?, image = ?, sort_order = ?
            WHERE id = ?
          `).run(title, shortText, fullText, image, sortOrder, id);

          return redirect(res, "/admin/news");
        }

        // ==================================================
        // НОВОСТИ — TOGGLE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/news\/toggle\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          db.prepare(`
            UPDATE news
            SET is_visible = CASE is_visible WHEN 1 THEN 0 ELSE 1 END
            WHERE id = ?
          `).run(id);

          return redirect(res, "/admin/news");
        }

        // ==================================================
        // НОВОСТИ — DELETE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/news\/delete\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const item = db.prepare("SELECT image FROM news WHERE id = ?").get(id);

          if (item?.image) {
            await fs.unlink(
              pathModule.join(UPLOADS_DIR, pathModule.basename(item.image))
            ).catch(() => {});
          }

          db.prepare("DELETE FROM news WHERE id = ?").run(id);
          return redirect(res, "/admin/news");
        }

        // ==================================================
        // ГЛАВНЫЙ БАННЕР — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/main-banner"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const banner = db.prepare(`
            SELECT *
            FROM main_banners
            ORDER BY id
            LIMIT 1
          `).get();

          return sendHtml(
            res,
            renderPage(
              req,
              "Главный баннер",
              `
                <h1>Главный баннер</h1>

                <p><a href="/admin">← Назад в админ-панель</a></p>

                <form method="POST" action="/admin/main-banner" enctype="multipart/form-data">
                  <p>
                    Заголовок:
                    <input
                      type="text"
                      name="title"
                      value="${escapeHtml(banner?.title || "")}"
                      required
                    >
                  </p>

                  <p>
                    Описание:
                    <textarea name="description" required>${escapeHtml(banner?.description || "")}</textarea>
                  </p>

                  <p>
                    Изображение:
                    <input
                      type="file"
                      name="image"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      ${banner?.image ? "" : "required"}
                    >
                    ${banner?.image ? `<br><img src="${escapeHtml(banner.image)}" alt="${escapeHtml(banner.title)}" width="200">` : ""}
                  </p>

                  <p>
                    Текст кнопки:
                    <input
                      type="text"
                      name="button_text"
                      value="${escapeHtml(banner?.button_text || "")}"
                      required
                    >
                  </p>

                  <p>
                    Ссылка кнопки:
                    <input
                      type="text"
                      name="button_url"
                      value="${escapeHtml(banner?.button_url || "")}"
                      required
                    >
                  </p>

                  <p>
                    <label>
                      <input
                        type="checkbox"
                        name="is_visible"
                        value="1"
                        ${!banner || banner.is_visible ? "checked" : ""}
                      >
                      Показывать баннер
                    </label>
                  </p>

                  <button type="submit">
                    ${banner ? "Сохранить" : "Создать"}
                  </button>
                </form>
              `
            )
          );
        }

        // ==================================================
        // ГЛАВНЫЙ БАННЕР — POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/main-banner"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const contentType = req.headers["content-type"] || "";
          const params = await parseMultipartBody(req, contentType);
          const title = params.get("title")?.trim() || "";
          const description = params.get("description")?.trim() || "";
          const buttonText = params.get("button_text")?.trim() || "";
          const buttonUrl = params.get("button_url")?.trim() || "";
          const imageFile = params.getFile("image");
          const isVisible = params.get("is_visible") === "1" ? 1 : 0;
          const existingBanner = db.prepare(`
            SELECT *
            FROM main_banners
            ORDER BY id
            LIMIT 1
          `).get();

          const validButtonUrl =
            /^(https?:\/\/|\/)[^\s]+$/i.test(buttonUrl);

          if (
            !title ||
            !description ||
            !buttonText ||
            !buttonUrl ||
            !validButtonUrl ||
            (!existingBanner && !imageFile)
          ) {
            return sendHtml(
              res,
              renderPage(
                req,
                "Ошибка",
                `<h1>Заполните все поля и укажите корректную ссылку кнопки.</h1>`
              ),
              400
            );
          }

          let image = existingBanner?.image || "";

          try {
            if (imageFile) {
              image = saveUploadedImage(imageFile);
            }
          } catch (error) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>${escapeHtml(error.message)}</h1>`),
              400
            );
          }

          if (existingBanner) {
            db.prepare(`
              UPDATE main_banners
              SET title = ?, description = ?, image = ?, button_text = ?, button_url = ?, is_visible = ?
              WHERE id = ?
            `).run(
              title,
              description,
              image,
              buttonText,
              buttonUrl,
              isVisible,
              existingBanner.id
            );
          } else {
            db.prepare(`
              INSERT INTO main_banners
              (title, description, image, button_text, button_url, is_visible)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              title,
              description,
              image,
              buttonText,
              buttonUrl,
              isVisible
            );
          }

          return redirect(res, "/admin/main-banner");
        }

        // ==================================================
        // СТРАНИЦЫ — GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          path === "/admin/pages"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const pages = db.prepare(`
            SELECT *
            FROM pages
            ORDER BY sort_order, id
          `).all();

          return sendHtml(
            res,
            renderPage(
              req,
              "Страницы",
              `
                <h1>Управление страницами</h1>
                <p><a href="/admin">← Назад в админ-панель</a></p>

                <h2>Создать страницу</h2>
                <form method="POST" action="/admin/pages">
                  <p>
                    Название:
                    <input type="text" name="name" required>
                  </p>
                  <p>
                    URL/slug:
                    <input type="text" name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*">
                  </p>
                  <p>
                    Заголовок:
                    <input type="text" name="title" required>
                  </p>
                  <p>
                    Содержимое:
                    <textarea name="content" required></textarea>
                  </p>
                  <p>
                    Порядок отображения:
                    <input type="number" name="sort_order" value="0">
                  </p>
                  <button type="submit">Создать страницу</button>
                </form>

                <h2>Страницы</h2>
                <ul>
                  ${pages.map(page => `
                    <li>
                      <strong>${escapeHtml(page.name)}</strong>
                      — /${escapeHtml(page.slug)}
                      — ${page.is_visible ? "показывается" : "скрыта"}
                      — порядок: ${page.sort_order}
                      <a href="/admin/pages/edit/${page.id}">Редактировать</a>
                      <a href="/admin/pages/toggle/${page.id}">
                        ${page.is_visible ? "Скрыть" : "Показать"}
                      </a>
                      <a
                        href="/admin/pages/delete/${page.id}"
                        onclick="return confirm('Удалить страницу?')"
                      >Удалить</a>
                    </li>
                  `).join("")}
                </ul>
              `
            )
          );
        }

        // ==================================================
        // СТРАНИЦЫ — POST CREATE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          path === "/admin/pages"
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const params = await readBody(req);
          const name = params.get("name")?.trim() || "";
          const slug = (params.get("slug")?.trim() || "").toLowerCase();
          const title = params.get("title")?.trim() || "";
          const content = params.get("content")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);

          if (
            !name ||
            !title ||
            !content ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0
          ) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>Проверьте поля страницы и формат slug.</h1>`),
              400
            );
          }

          if (db.prepare("SELECT 1 FROM pages WHERE slug = ?").get(slug)) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>Этот slug уже используется.</h1>`),
              400
            );
          }

          db.prepare(`
            INSERT INTO pages (name, slug, title, content, sort_order, is_visible)
            VALUES (?, ?, ?, ?, ?, 1)
          `).run(name, slug, title, content, sortOrder);

          return redirect(res, "/admin/pages");
        }

        // ==================================================
        // СТРАНИЦЫ — EDIT GET
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/pages\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const page = db.prepare("SELECT * FROM pages WHERE id = ?").get(id);

          if (!page) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Страница не найдена.</h1>`), 404);
          }

          return sendHtml(
            res,
            renderPage(
              req,
              "Редактирование страницы",
              `
                <h1>Редактирование страницы</h1>
                <form method="POST" action="/admin/pages/edit/${id}">
                  <p>Название: <input type="text" name="name" value="${escapeHtml(page.name)}" required></p>
                  <p>URL/slug: <input type="text" name="slug" value="${escapeHtml(page.slug)}" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*"></p>
                  <p>Заголовок: <input type="text" name="title" value="${escapeHtml(page.title)}" required></p>
                  <p>Содержимое: <textarea name="content" required>${escapeHtml(page.content)}</textarea></p>
                  <p>Порядок отображения: <input type="number" name="sort_order" value="${page.sort_order}"></p>
                  <button type="submit">Сохранить</button>
                </form>
              `
            )
          );
        }

        // ==================================================
        // СТРАНИЦЫ — EDIT POST
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "POST" &&
          /^\/admin\/pages\/edit\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          const existingPage = db.prepare("SELECT * FROM pages WHERE id = ?").get(id);

          if (!existingPage) {
            return sendHtml(res, renderPage(req, "Ошибка", `<h1>Страница не найдена.</h1>`), 404);
          }

          const params = await readBody(req);
          const name = params.get("name")?.trim() || "";
          const slug = (params.get("slug")?.trim() || "").toLowerCase();
          const title = params.get("title")?.trim() || "";
          const content = params.get("content")?.trim() || "";
          const sortOrder = Number(params.get("sort_order") || 0);

          if (
            !name ||
            !title ||
            !content ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
            !Number.isInteger(sortOrder) ||
            sortOrder < 0
          ) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>Проверьте поля страницы и формат slug.</h1>`),
              400
            );
          }

          if (db.prepare("SELECT 1 FROM pages WHERE slug = ? AND id <> ?").get(slug, id)) {
            return sendHtml(
              res,
              renderPage(req, "Ошибка", `<h1>Этот slug уже используется.</h1>`),
              400
            );
          }

          db.prepare(`
            UPDATE pages
            SET name = ?, slug = ?, title = ?, content = ?, sort_order = ?
            WHERE id = ?
          `).run(name, slug, title, content, sortOrder, id);

          return redirect(res, "/admin/pages");
        }

        // ==================================================
        // СТРАНИЦЫ — TOGGLE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/pages\/toggle\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          db.prepare(`
            UPDATE pages
            SET is_visible = CASE is_visible WHEN 1 THEN 0 ELSE 1 END
            WHERE id = ?
          `).run(id);

          return redirect(res, "/admin/pages");
        }

        // ==================================================
        // СТРАНИЦЫ — DELETE
        // ТОЛЬКО АДМИН
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/admin\/pages\/delete\/\d+$/.test(path)
        ) {
          if (!requireAdmin(req, res)) {
            return;
          }

          const id = Number(path.split("/")[4]);
          db.prepare("DELETE FROM pages WHERE id = ?").run(id);
          return redirect(res, "/admin/pages");
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
        // ПУБЛИЧНАЯ СТРАНИЦА ПО SLUG
        // ==================================================

        if (
          req.method === "GET" &&
          /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)
        ) {
          const slug = path.slice(1);
          const page = db.prepare(`
            SELECT title, content
            FROM pages
            WHERE slug = ?
              AND is_visible = 1
          `).get(slug);

          if (page) {
            return sendHtml(
              res,
              renderPage(
                req,
                page.title,
                `
                  <h1>${escapeHtml(page.title)}</h1>
                  <div>${escapeHtml(page.content).replace(/\n/g, "<br>")}</div>
                `
              )
            );
          }
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
// ЗАПУСК СЕРВЕРА
// ======================================================

server.listen(
  PORT,
  () => {
    console.log(
      `Сервер запущен: http://localhost:${PORT}`
    );
  }
);