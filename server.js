// server.js
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Парсим JSON-тело
app.use(express.json());

// Простой логгер в stdout (Render его и показывает)
function log(...args) {
  console.log('[WEBHOOK]', new Date().toISOString(), ...args);
}

// ==== CONFIG CHECKS ====

if (!process.env.WS_BASE_URL || !process.env.WS_API_KEY) {
  console.warn('[WARN] WS_BASE_URL / WS_API_KEY не заданы — Worksection API работать не будет');
}

if (!process.env.PCLOUD_BASE_URL) {
  console.warn('[WARN] PCLOUD_BASE_URL не задан, использую https://eapi.pcloud.com по умолчанию');
}

if (!process.env.WEBHOOK_USER || !process.env.WEBHOOK_PASS) {
  console.warn('[WARN] WEBHOOK_USER / WEBHOOK_PASS не заданы, Basic Auth фактически выключен');
}

// ==== BASIC AUTH ДЛЯ ВЕБХУКА ====

function checkBasicAuth(req) {
  const user = process.env.WEBHOOK_USER;
  const pass = process.env.WEBHOOK_PASS;

  if (!user || !pass) {
    // защита выключена
    return true;
  }

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) return false;

  const decoded = Buffer.from(auth.split(' ')[1] || '', 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  return u === user && p === pass;
}

// ==== PCloud: авторизация и операции с папками ====

const PCLOUD_BASE = (process.env.PCLOUD_BASE_URL || 'https://eapi.pcloud.com').replace(/\/$/, '');

// пример: мы логинимся логин/пароль + getauth, забираем token и дальше используем auth=<token>
async function pcloudLoginOnce() {
  if (process.env.PCLOUD_AUTH) {
    // если ты заранее положил токен в .env
    return process.env.PCLOUD_AUTH;
  }

  const username = process.env.PCLOUD_USERNAME;
  const password = process.env.PCLOUD_PASSWORD;

  if (!username || !password) {
    throw new Error('PCLOUD_USERNAME / PCLOUD_PASSWORD не заданы и нет PCLOUD_AUTH_TOKEN');
  }

  const params = {
    getauth: 1,
    username,
    password,
  };

  const url = `${PCLOUD_BASE}/userinfo`;

  const res = await axios.get(url, { params });
  if (res.data.result !== 0) {
    throw new Error(`pCloud login failed: result=${res.data.result}, message=${res.data.error || res.data.message}`);
  }

  const token = res.data.auth;
  if (!token) {
    throw new Error('pCloud: не получили auth token в userinfo');
  }

  log('pCloud login OK, token obtained');
  return token;
}

// Создание/получение папки по path через createfolderifnotexists
async function ensurePcloudFolder(authToken, path) {
  const url = `${PCLOUD_BASE}/createfolderifnotexists`;
  const res = await axios.get(url, {
    params: {
      auth: authToken,
      path,
    },
  });

  if (res.data.result !== 0) {
    throw new Error(`pCloud createfolderifnotexists error: ${JSON.stringify(res.data)}`);
  }

  const folder = res.data.metadata || res.data;
  return folder;
}

// Шарим папку по email’ам (sharefolder)
async function sharePcloudFolder(authToken, folderPath, emails) {
  if (!emails.length) {
    log('sharePcloudFolder: нет ни одного email, шарить некого — пропускаю');
    return;
  }

  // сначала получим папку, чтобы у неё был folderid
  const ensureRes = await axios.get(`${PCLOUD_BASE}/createfolderifnotexists`, {
    params: {
      auth: authToken,
      path: folderPath,
    },
  });

  if (ensureRes.data.result !== 0) {
    throw new Error(`pCloud ensure folder before share error: ${JSON.stringify(ensureRes.data)}`);
  }

  const folderMeta = ensureRes.data.metadata || ensureRes.data;
  const folderId = folderMeta.folderid;
  if (!folderId) {
    throw new Error('pCloud: не нашли folderid в ответе');
  }

  // sharefolder работает по одному email за вызов
  for (const email of emails) {
    try {
      const resp = await axios.get(`${PCLOUD_BASE}/sharefolder`, {
        params: {
          auth: authToken,
          folderid: folderId,
          mail: email,
          permissions: 7, // rwx, см. доку
        },
      });

      if (resp.data.result !== 0) {
        log(`pCloud sharefolder error for ${email}:`, resp.data);
      } else {
        log(`pCloud shared folder ${folderPath} with ${email}`);
      }
    } catch (err) {
      log(`pCloud sharefolder axios error for ${email}:`, err.message);
    }
  }
}

// ==== Worksection: запрос проекта по API (get_project) ====

async function fetchWorksectionProject(projectId) {
  const baseUrl = process.env.WS_BASE_URL;
  const apiKey = process.env.WS_ADMIN_TOKEN;

  if (!baseUrl || !apiKey) {
    throw new Error('WS_BASE_URL / WS_API_KEY не заданы');
  }

  const paramsObj = {
    action: 'get_project',
    id_project: projectId,
    extra: 'users', // чтобы вернуть список участников проекта
  };

  const queryString = new URLSearchParams(paramsObj).toString();
  const hash = crypto.createHash('md5').update(queryString + apiKey).digest('hex');

  const finalParams = {
    ...paramsObj,
    hash,
  };

  const url = `${baseUrl.replace(/\/$/, '')}/api/admin/v2/`;

  let response;
  try {
    response = await axios.get(url, { params: finalParams });
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Worksection get_project error for id=${projectId}: ${body}`);
  }

  if (response.data.status !== 'ok') {
    throw new Error(`Worksection get_project returned error: ${JSON.stringify(response.data)}`);
  }

  return response.data; // { status: 'ok', data: { ... } }
}

// ==== Обработка ОДНОГО события вебхука ====

async function handleWebhookEvent(event) {
  const action = event?.action || null;
  const objType = event?.object?.type || null;

  log('Handle event:', { action, objType });

  // Нас интересует только создание проекта
  if (!(action === 'post' && objType === 'project')) {
    log('Skip event (not project post):', action, objType);
    return;
  }

  const projectId = event.object.id;
  const projectTitleFromWebhook = event.new?.title || null;

  log(`Project created in Worksection: id=${projectId}, title="${projectTitleFromWebhook}"`);

  // 1) Забираем проект по API, включая команду (users)
  const wsProjectResponse = await fetchWorksectionProject(projectId);
  const projectData = wsProjectResponse.data || {};

  const projectName = projectData.name || projectTitleFromWebhook || `project_${projectId}`;
  const users = Array.isArray(projectData.users) ? projectData.users : [];

  const emails = users
    .map((u) => u.email)
    .filter((e) => !!e);

  log(`Worksection project ${projectId} team emails:`, emails);

  // 2) Авторизуемся в pCloud
  const authToken = await pcloudLoginOnce();

  // 3) Создаём структуру папок:
  // /WorksectionProjects/<ProjectName>/
  //   Preview/<YYYY-MM-DD>/
  //   Final_render/
  const rootPath = '/WorksectionProjects';
  const projectPath = `${rootPath}/${projectName}`;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const previewPath = `${projectPath}/Preview/${dateStr}`;
  const finalRenderPath = `${projectPath}/Final_render`;

  await ensurePcloudFolder(authToken, rootPath);
  await ensurePcloudFolder(authToken, projectPath);
  await ensurePcloudFolder(authToken, previewPath);
  await ensurePcloudFolder(authToken, finalRenderPath);

  log(`pCloud folders ensured for project "${projectName}":`, {
    projectPath,
    previewPath,
    finalRenderPath,
  });

  // 4) Шарим projectPath (или обе папки — как хочешь; пока шарим projectPath)
  await sharePcloudFolder(authToken, projectPath, emails);

  log(`Done handling project ${projectId}`);
}

// ==== HTTP endpoint для Worksection ====

app.post('/ws-pcloud-hook', async (req, res) => {
  // Сначала сразу отвечаем OK, как требует Worksection
  res.status(200).json({ status: 'OK' });

  if (!checkBasicAuth(req)) {
    log('Basic Auth failed');
    return;
  }

  const body = req.body;
  log('Incoming webhook:', JSON.stringify(body));

  // Worksection всегда шлёт МАССИВ событий
  const events = Array.isArray(body) ? body : [body];

  for (const ev of events) {
    try {
      await handleWebhookEvent(ev);
    } catch (err) {
      log('Error while handling event:', err.message);
    }
  }
});

// ==== Запуск сервера ====

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
