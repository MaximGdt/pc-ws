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

// ========================================
// ЛОГИРОВАНИЕ
// ========================================
function plog(level, ...args) {
  const timestamp = new Date().toISOString();
  const prefix = `[PCLOUD] [${level.padEnd(5)}] [${timestamp}]`;
  console.log(prefix, ...args);
}

const plogInfo = (...args) => plog('INFO', ...args);
const plogWarn = (...args) => plog('WARN', ...args);
const plogError = (...args) => plog('ERROR', ...args);
const plogDebug = (...args) => plog('DEBUG', ...args);

// ========================================
// АВТОРИЗАЦИЯ
// ========================================

/**
 * Логин в pCloud по username/password через userinfo?getauth=1
 * и возврат auth-токена.
 */
async function loginAndGetAuth() {
  if (STATIC_AUTH) {
    plogInfo('Using static auth token from PCLOUD_AUTH');
    return STATIC_AUTH;
  }

  if (!PCLOUD_USERNAME || !PCLOUD_PASSWORD) {
    throw new Error(
      'pCloud auth: ни PCLOUD_AUTH, ни пара PCLOUD_USERNAME/PCLOUD_PASSWORD не заданы'
    );
  }

  // Простейшая защита от одновременного login из нескольких запросов
  if (isLoggingIn) {
    plogDebug('Login already in progress, waiting...');
    await new Promise(resolve => setTimeout(resolve, 500));
    if (cachedAuth) {
      plogDebug('Auth token obtained from parallel login');
      return cachedAuth;
    }
  }

  isLoggingIn = true;
  plogInfo('Attempting pCloud login...');
  
  try {
    const url = `${PCLOUD_API.replace(/\/$/, '')}/userinfo`;
    
    const params = {
      getauth: 1,
      username: PCLOUD_USERNAME,
      password: PCLOUD_PASSWORD,
      device: 'ws-pcloud-bridge',
    };

    plogDebug('Login request:', { 
      url, 
      username: PCLOUD_USERNAME,
      password: '***MASKED***'
    });

    const response = await axios.get(url, { params });

    plogDebug('Login response status:', response.status);
    plogDebug('Login response data:', JSON.stringify(response.data));

    const data = response.data;

    if (data.result !== 0 || !data.auth) {
      plogError('Login failed:', {
        result: data.result,
        error: data.error,
        message: data.message
      });
      throw new Error(
        `pCloud login failed: result=${data.result}, error=${data.error || data.message || 'unknown'}`
      );
    }

    cachedAuth = data.auth;
    plogInfo('Login successful, auth token cached');
    plogDebug('Auth token:', cachedAuth.substring(0, 10) + '...');
    
    return cachedAuth;
  } catch (err) {
    plogError('Login exception:', err.message);
    if (err.response) {
      plogError('HTTP status:', err.response.status);
      plogError('Response data:', JSON.stringify(err.response.data));
    }
    throw err;
  } finally {
    isLoggingIn = false;
  }
}

/**
 * Получить актуальный auth-токен (из кэша или залогиниться).
 */
async function getAuthToken() {
  if (cachedAuth) {
    plogDebug('Using cached auth token');
    return cachedAuth;
  }
  return loginAndGetAuth();
}

// ========================================
// API CALLS
// ========================================

/**
 * Универсальный вызов pCloud API (GET).
 * Если получили ошибку "логин нужен/логин не удался", пробуем залогиниться и повторить ОДИН раз.
 */
export async function pcloudCall(method, params = {}) {
  const url = `${PCLOUD_API.replace(/\/$/, '')}/${method}`;

  plogDebug(`Calling pCloud method: ${method}`, params);

  // 1. берём токен (логин, если нужно)
  let auth = await getAuthToken();

  let firstTry = true;

  while (true) {
    const finalParams = {
      ...params,
      auth,
    };

    plogDebug(`API call: ${method}`, { 
      ...finalParams, 
      auth: auth ? auth.substring(0, 10) + '...' : 'none' 
    });

    let response;
    try {
      response = await axios.get(url, { params: finalParams });
      plogDebug(`API response status: ${response.status}`);
    } catch (err) {
      // сетевые/HTTP-ошибки
      const errorMsg = err.response?.status
        ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}`
        : err.message;
      
      plogError(`Network error calling ${method}:`, errorMsg);
      throw new Error(`pCloud network error calling ${method}: ${errorMsg}`);
    }

    const data = response.data;
    plogDebug(`API response data for ${method}:`, JSON.stringify(data));

    // всё ок
    if (data && data.result === 0) {
      plogInfo(`API call ${method} successful`);
      return data;
    }

    // 1000 — логин нужен, 2000 — логин не удался (плохой токен и т.п.)
    if (firstTry && (data.result === 1000 || data.result === 2000)) {
      plogWarn(`Auth error (result=${data.result}), will retry after re-login`);
      // Сбрасываем токен и пробуем залогиниться заново
      firstTry = false;
      cachedAuth = null;
      auth = await loginAndGetAuth();
      continue; // повторяем запрос ОДИН раз
    }

    // Другие ошибки выкидываем наверх
    plogError(`API error calling ${method}:`, {
      result: data.result,
      error: data.error,
      message: data.message,
      data: data
    });
    
    throw new Error(
      `pCloud API error calling ${method}: result=${data.result}, error=${data.error || data.message || 'unknown'}`
    );
  }
}

// ========================================
// FOLDER OPERATIONS
// ========================================

/**
 * Создать папку, если её нет, и вернуть ответ pCloud (metadata внутри).
 */
export async function ensureFolder(path) {
  plogInfo(`Ensuring folder exists: ${path}`);
  
  try {
    const result = await pcloudCall('createfolderifnotexists', { path });
    
    if (result.metadata) {
      plogInfo(`Folder ready: ${path} (folderid: ${result.metadata.folderid})`);
    } else {
      plogWarn(`Folder created but no metadata returned for: ${path}`);
    }
    
    return result;
  } catch (err) {
    plogError(`Failed to ensure folder ${path}:`, err.message);
    throw err;
  }
}

/**
 * Расшарить папку пользователю по email.
 * permissions — битовая маска прав (1=create, 2=modify, 4=delete).
 */
export async function shareFolder(path, mail, permissions = 7) {
  plogInfo(`Sharing folder ${path} with ${mail} (permissions: ${permissions})`);
  
  try {
    // Сначала получаем folderid
    const folderResult = await pcloudCall('listfolder', { path });
    
    if (!folderResult.metadata || !folderResult.metadata.folderid) {
      throw new Error(`Cannot get folderid for path: ${path}`);
    }
    
    const folderId = folderResult.metadata.folderid;
    plogDebug(`Folder ${path} has folderid: ${folderId}`);
    
    // Теперь шарим по folderid
    const result = await pcloudCall('sharefolder', {
      folderid: folderId,
      mail,
      permissions,
    });
    
    plogInfo(`Folder ${path} shared successfully with ${mail}`);
    return result;
  } catch (err) {
    plogError(`Failed to share folder ${path} with ${mail}:`, err.message);
    throw err;
  }
}
