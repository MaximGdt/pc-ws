// pcloud.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const PCLOUD_API = process.env.PCLOUD_API || 'https://eapi.pcloud.com';

// Вариант 1: сразу задан auth-токен (или OAuth access_token)
const STATIC_AUTH = process.env.PCLOUD_AUTH || null;

// Вариант 2: логин по логину/паролю
const PCLOUD_USERNAME = process.env.PCLOUD_USERNAME || null;
const PCLOUD_PASSWORD = process.env.PCLOUD_PASSWORD || null;

// Кэш токена в памяти процесса
let cachedAuth = STATIC_AUTH || null;
let isLoggingIn = false;

/**
 * Логин в pCloud по username/password через userinfo?getauth=1
 * и возврат auth-токена.
 * Документация: метод userinfo + глобальный параметр getauth. :contentReference[oaicite:2]{index=2}
 */
async function loginAndGetAuth() {
  if (STATIC_AUTH) {
    // Если явно задан токен в переменной окружения — ничего не логиним, просто используем его
    return STATIC_AUTH;
  }

  if (!PCLOUD_USERNAME || !PCLOUD_PASSWORD) {
    throw new Error(
      'pCloud auth: ни PCLOUD_AUTH, ни пара PCLOUD_USERNAME/PCLOUD_PASSWORD не заданы'
    );
  }

  // Простейшая защита от одновременного login из нескольких запросов
  if (isLoggingIn) {
    // ждём, пока другой запрос закончит логин (очень простая реализация)
    await new Promise(resolve => setTimeout(resolve, 500));
    if (cachedAuth) return cachedAuth;
  }

  isLoggingIn = true;
  try {
    const url = `${PCLOUD_API.replace(/\/$/, '')}/userinfo`;

    const response = await axios.get(url, {
      params: {
        getauth: 1,
        username: PCLOUD_USERNAME,
        password: PCLOUD_PASSWORD,
        device: 'ws-pcloud-bridge', // по доке можно указывать device :contentReference[oaicite:3]{index=3}
      },
    });

    const data = response.data;

    if (data.result !== 0 || !data.auth) {
      throw new Error(
        `pCloud login failed: result=${data.result}, message=${data.error || ''}`
      );
    }

    cachedAuth = data.auth;
    return cachedAuth;
  } finally {
    isLoggingIn = false;
  }
}

/**
 * Получить актуальный auth-токен (из кэша или залогиниться).
 */
async function getAuthToken() {
  if (cachedAuth) return cachedAuth;
  return loginAndGetAuth();
}

/**
 * Универсальный вызов pCloud API (GET).
 * Если получили ошибку "логин нужен/логин не удался", пробуем залогиниться и повторить ОДИН раз.
 */
export async function pcloudCall(method, params = {}) {
  const url = `${PCLOUD_API.replace(/\/$/, '')}/${method}`;

  // 1. берём токен (логин, если нужно)
  let auth = await getAuthToken();

  let firstTry = true;

  while (true) {
    const finalParams = {
      ...params,
      auth,
    };

    let response;
    try {
      response = await axios.get(url, { params: finalParams });
    } catch (err) {
      // сетевые/HTTP-ошибки
      throw new Error(
        `pCloud network error calling ${method}: ${
          err.response?.status
            ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}`
            : err.message
        }`
      );
    }

    const data = response.data;

    // всё ок
    if (data && data.result === 0) {
      return data;
    }

    // 1000 — логин нужен, 2000 — логин не удался (плохой токен и т.п.) :contentReference[oaicite:4]{index=4}
    if (
      firstTry &&
      (data.result === 1000 || data.result === 2000)
    ) {
      // Сбрасываем токен и пробуем залогиниться заново
      firstTry = false;
      cachedAuth = null;
      auth = await loginAndGetAuth();
      continue; // повторяем запрос ОДИН раз
    }

    // Другие ошибки выкидываем наверх
    throw new Error(
      `pCloud API error calling ${method}: ${JSON.stringify(data)}`
    );
  }
}

/**
 * Создать папку, если её нет, и вернуть ответ pCloud (metadata внутри).
 */
export async function ensureFolder(path) {
  return pcloudCall('createfolderifnotexists', { path });
}

/**
 * Расшарить папку пользователю по email.
 * permissions — битовая маска прав (1=create, 2=modify, 4=delete).
 */
export async function shareFolder(path, mail, permissions = 3) {
  return pcloudCall('sharefolder', {
    path,
    mail,
    permissions,
  });
}
