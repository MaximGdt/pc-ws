// server.js
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import basicAuth from 'basic-auth';
import axios from 'axios';
import crypto from 'crypto';
import { ensureFolder, shareFolder } from './pcloud.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// --- Парсинг тела запроса (JSON и form-data) ---
app.use(
  express.json({
    type: ['application/json', 'application/*+json', 'text/json'],
  })
);
app.use(
  express.urlencoded({
    extended: true,
  })
);

// --- Простейший логгер в файл ws.log ---
function logLine(line) {
  try {
    fs.appendFileSync('ws.log', `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    // если даже лог упал, не мешаем основной логике
    console.error('LOG ERROR:', e.message);
  }
}

// --- Basic Auth для защиты вебхука ---
function checkBasicAuth(req, res, next) {
  const expectedUser = process.env.WEBHOOK_USER;
  const expectedPass = process.env.WEBHOOK_PASS;

  if (!expectedUser || !expectedPass) {
    console.warn(
      '[WARN] WEBHOOK_USER / WEBHOOK_PASS не заданы, Basic Auth фактически выключен'
    );
    return next();
  }

  const user = basicAuth(req);

  if (!user || user.name !== expectedUser || user.pass !== expectedPass) {
    res.set('WWW-Authenticate', 'Basic realm="Webhook"');
    return res.status(401).send('Access denied');
  }

  return next();
}

// --- Основной маршрут для Worksection webhook ---
app.post('/ws-pcloud-hook', checkBasicAuth, async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  logLine(`Incoming webhook: ${rawBody}`);

  // Worksection ожидает быстрый ответ {"status":"OK"}
  res.status(200).json({ status: 'OK' });

  // Всё остальное делаем асинхронно, чтобы не блокировать ответ
  try {
    await handleWebhook(req.body);
  } catch (err) {
    logLine(`Error in handleWebhook: ${err.stack || err.message}`);
  }
});

// --- Основная логика обработки webhook ---
async function handleWebhook(payload) {
  // Определяем тип события
  const event = payload.event || payload.action || null;

  if (event !== 'post_project') {
    logLine(`Skip event: ${event}`);
    return;
  }

  // Берём ID проекта
  const projectId = payload.project_id || (payload.project && payload.project.id);

  if (!projectId) {
    logLine('No project_id in payload');
    return;
  }

  logLine(`Processing project_id=${projectId}`);

  // 1. Тянем проект из Worksection API
  const project = await fetchWorksectionProject(projectId);

  // ВАЖНО: структура зависит от реального ответа Worksection.
  // Здесь предполагаем, что нужные поля лежат в project.data.*
  const projectName =
    (project?.data?.name && String(project.data.name).trim()) ||
    `project-${projectId}`;

  // members — строка "user1@mail.com,user2@mail.com,..."
  const membersRaw = project?.data?.members || '';
  const memberEmails = membersRaw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  logLine(
    `Project "${projectName}", members: ${JSON.stringify(memberEmails)}`
  );

  // 2. Строим структуру папок в pCloud
  const baseRoot = '/WorksectionProjects';
  const projectFolderSafe = sanitizeName(projectName);

  // Корневая папка для всех проектов
  await ensureFolder(baseRoot);

  // Папка проекта
  const projectPath = `${baseRoot}/${projectFolderSafe}`;
  await ensureFolder(projectPath);

  // Папка Final_render
  const finalRenderPath = `${projectPath}/Final_render`;
  await ensureFolder(finalRenderPath);

  // Папка Preview
  const previewPath = `${projectPath}/Preview`;
  await ensureFolder(previewPath);

  // Внутри Preview — подпапка с текущей датой YYYY-MM-DD
  const today = new Date().toISOString().slice(0, 10); // "2025-11-29"
  const previewDatePath = `${previewPath}/${today}`;
  await ensureFolder(previewDatePath);

  logLine(
    `Created structure: ${projectPath}, ${finalRenderPath}, ${previewDatePath}`
  );

  // 3. Раздаём доступ всем участникам проекта по email
  if (memberEmails.length === 0) {
    logLine('No members found, skip sharing');
    return;
  }

  // Шарим КОРНЕВУЮ папку проекта, чтобы они видели всё внутри
  for (const mail of memberEmails) {
    try {
      const shareRes = await shareFolder(projectPath, mail, 3); // 3 = create+modify
      logLine(
        `Shared ${projectPath} with ${mail}: ${JSON.stringify(shareRes)}`
      );
    } catch (err) {
      const errBody = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      logLine(`Error sharing ${projectPath} with ${mail}: ${errBody}`);
    }
  }

  logLine(`Done for project_id=${projectId}`);
}

// --- Нормализация имени папки (убираем запрещённые символы) ---
async function fetchWorksectionProject(projectId) {
  const baseUrl = process.env.WS_BASE_URL;
  const apiKey = process.env.WS_ADMIN_TOKEN;

  if (!baseUrl || !apiKey) {
    throw new Error('WS_BASE_URL или WS_ADMIN_TOKEN не настроены в .env');
  }

  // параметры запроса к admin v2 API:
  // ?action=get_project&id_project=PROJECT_ID&extra=users
  const paramsObj = {
    action: 'get_project',
    id_project: projectId,
    extra: 'users', // чтобы сразу получить команду проекта
  };

  // строка для hash
  const queryParams = new URLSearchParams(paramsObj).toString();
  const hash = crypto
    .createHash('md5')
    .update(queryParams + apiKey)
    .digest('hex');

  const finalParams = {
    ...paramsObj,
    hash,
  };

  const url = `${baseUrl.replace(/\/$/, '')}/api/admin/v2/`;

  let response;
  try {
    response = await axios.get(url, { params: finalParams });
  } catch (err) {
    const errBody = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    throw new Error(
      `Error fetching Worksection project ${projectId}: ${errBody}`
    );
  }

  if (!response.data) {
    throw new Error(`Empty response from Worksection for project ${projectId}`);
  }

  // лог на всякий случай
  console.log('WS get_project raw:', JSON.stringify(response.data, null, 2));

  if (response.data.status !== 'ok') {
    throw new Error(
      `Worksection API error: ${JSON.stringify(response.data)}`
    );
  }

  return response.data; // структура, как в доке: { status: "ok", data: { ... } }
}

// --- Старт сервера ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  logLine(`Server started on port ${PORT}`);
});

export default app;
