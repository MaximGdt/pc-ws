// server.js
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import { pcloudCall, ensureFolder, shareFolder } from './pcloud.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Парсим JSON-тело
app.use(express.json());

// ========================================
// УЛУЧШЕННОЕ ЛОГИРОВАНИЕ
// ========================================
function log(level, ...args) {
  const timestamp = new Date().toISOString();
  const prefix = `[${level.padEnd(5)}] [${timestamp}]`;
  console.log(prefix, ...args);
}

const logInfo = (...args) => log('INFO', ...args);
const logWarn = (...args) => log('WARN', ...args);
const logError = (...args) => log('ERROR', ...args);
const logDebug = (...args) => log('DEBUG', ...args);

// ========================================
// CONFIG CHECKS
// ========================================
logInfo('=== Server Starting ===');
logInfo('Environment variables check:');
logInfo('- PORT:', PORT);
logInfo('- WS_BASE_URL:', process.env.WS_BASE_URL ? 'SET' : 'NOT SET');
logInfo('- WS_ADMIN_TOKEN:', process.env.WS_ADMIN_TOKEN ? 'SET (hidden)' : 'NOT SET');
logInfo('- PCLOUD_API:', process.env.PCLOUD_API || 'https://eapi.pcloud.com (default)');
logInfo('- PCLOUD_AUTH:', process.env.PCLOUD_AUTH ? 'SET (hidden)' : 'NOT SET');
logInfo('- PCLOUD_USERNAME:', process.env.PCLOUD_USERNAME ? 'SET' : 'NOT SET');
logInfo('- PCLOUD_PASSWORD:', process.env.PCLOUD_PASSWORD ? 'SET (hidden)' : 'NOT SET');
logInfo('- WEBHOOK_USER:', process.env.WEBHOOK_USER ? 'SET' : 'NOT SET');
logInfo('- WEBHOOK_PASS:', process.env.WEBHOOK_PASS ? 'SET (hidden)' : 'NOT SET');

if (!process.env.WS_BASE_URL || !process.env.WS_ADMIN_TOKEN) {
  logWarn('WS_BASE_URL / WS_ADMIN_TOKEN не заданы — Worksection API работать не будет');
}

if (!process.env.WEBHOOK_USER || !process.env.WEBHOOK_PASS) {
  logWarn('WEBHOOK_USER / WEBHOOK_PASS не заданы, Basic Auth фактически выключен');
}

// ========================================
// BASIC AUTH ДЛЯ ВЕБХУКА
// ========================================
function checkBasicAuth(req) {
  const user = process.env.WEBHOOK_USER;
  const pass = process.env.WEBHOOK_PASS;

  if (!user || !pass) {
    logWarn('Basic Auth disabled (credentials not set)');
    return true;
  }

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    logWarn('Basic Auth failed: no Authorization header or wrong format');
    return false;
  }

  const decoded = Buffer.from(auth.split(' ')[1] || '', 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  
  if (u === user && p === pass) {
    logDebug('Basic Auth OK');
    return true;
  } else {
    logWarn('Basic Auth failed: wrong credentials');
    return false;
  }
}

// ========================================
// WORKSECTION API
// ========================================
async function fetchWorksectionProject(projectId) {
  logDebug(`Fetching Worksection project ${projectId}...`);
  
  const baseUrl = process.env.WS_BASE_URL;
  const apiKey = process.env.WS_ADMIN_TOKEN;

  if (!baseUrl || !apiKey) {
    throw new Error('WS_BASE_URL / WS_ADMIN_TOKEN не заданы');
  }

  const paramsObj = {
    action: 'get_project',
    id_project: projectId,
    extra: 'users',
  };

  const queryString = new URLSearchParams(paramsObj).toString();
  const hash = crypto.createHash('md5').update(queryString + apiKey).digest('hex');

  const finalParams = {
    ...paramsObj,
    hash,
  };

  const url = `${baseUrl.replace(/\/$/, '')}/api/admin/v2/`;
  
  logDebug('WS API request:', { url, params: { ...finalParams, hash: 'hidden' } });

  let response;
  try {
    response = await axios.get(url, { params: finalParams });
    logDebug('WS API response status:', response.status);
  } catch (err) {
    const errorDetails = {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    };
    logError('WS API request failed:', JSON.stringify(errorDetails));
    throw new Error(`Worksection get_project error for id=${projectId}: ${JSON.stringify(errorDetails)}`);
  }

  if (response.data.status !== 'ok') {
    logError('WS API returned error:', response.data);
    throw new Error(`Worksection get_project returned error: ${JSON.stringify(response.data)}`);
  }

  logInfo(`WS project ${projectId} fetched successfully`);
  return response.data;
}

// ========================================
// PCLOUD FOLDER OPERATIONS
// ========================================
async function createProjectFolders(projectName, emails) {
  logInfo(`Creating pCloud folders for project "${projectName}"...`);
  
  const rootPath = '/WorksectionProjects';
  const projectPath = `${rootPath}/${projectName}`;
  
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const previewBasePath = `${projectPath}/Preview`;
  const previewPath = `${previewBasePath}/${dateStr}`;
  const finalRenderPath = `${projectPath}/Final_render`;

  try {
    // Создаём папки последовательно
    logDebug('Creating root folder:', rootPath);
    const rootResult = await ensureFolder(rootPath);
    logDebug('Root folder result:', JSON.stringify(rootResult));

    logDebug('Creating project folder:', projectPath);
    const projectResult = await ensureFolder(projectPath);
    logDebug('Project folder result:', JSON.stringify(projectResult));

    logDebug('Creating preview base folder:', previewBasePath);
    const previewBaseResult = await ensureFolder(previewBasePath);
    logDebug('Preview base folder result:', JSON.stringify(previewBaseResult));

    logDebug('Creating preview folder:', previewPath);
    const previewResult = await ensureFolder(previewPath);
    logDebug('Preview folder result:', JSON.stringify(previewResult));

    logDebug('Creating final render folder:', finalRenderPath);
    const finalResult = await ensureFolder(finalRenderPath);
    logDebug('Final render folder result:', JSON.stringify(finalResult));

    logInfo('All folders created successfully');

    // Шарим главную папку проекта
    if (emails && emails.length > 0) {
      logInfo(`Sharing project folder with ${emails.length} users...`);
      for (const email of emails) {
        try {
          logDebug(`Sharing with ${email}...`);
          const shareResult = await shareFolder(projectPath, email, 7); // permissions: 7 = rwx
          logDebug(`Share result for ${email}:`, JSON.stringify(shareResult));
          logInfo(`Folder shared with ${email}`);
        } catch (err) {
          logError(`Failed to share with ${email}:`, err.message);
        }
      }
    } else {
      logWarn('No emails to share folder with');
    }

    return {
      rootPath,
      projectPath,
      previewBasePath,
      previewPath,
      finalRenderPath,
    };
  } catch (err) {
    logError('Error creating pCloud folders:', err.message);
    logError('Error details:', err.stack);
    throw err;
  }
}

// ========================================
// WEBHOOK EVENT HANDLER
// ========================================
async function handleWebhookEvent(event) {
  const action = event?.action || null;
  const objType = event?.object?.type || null;

  logInfo('Processing webhook event:', { action, objType });
  logDebug('Full event data:', JSON.stringify(event));

  // Нас интересует только создание проекта
  if (!(action === 'post' && objType === 'project')) {
    logInfo('Skipping event (not project creation)');
    return;
  }

  const projectId = event.object.id;
  const projectTitleFromWebhook = event.new?.title || null;

  logInfo(`📊 New project detected: id=${projectId}, title="${projectTitleFromWebhook}"`);

  try {
    // 1. Получаем данные проекта из Worksection
    const wsProjectResponse = await fetchWorksectionProject(projectId);
    const projectData = wsProjectResponse.data || {};

    const projectName = projectData.name || projectTitleFromWebhook || `project_${projectId}`;
    const users = Array.isArray(projectData.users) ? projectData.users : [];

    const emails = users
      .map((u) => u.email)
      .filter((e) => !!e);

    logInfo(`Project team: ${users.length} users, ${emails.length} with emails`);
    logDebug('Team emails:', emails);

    // 2. Создаём папки в pCloud
    const folders = await createProjectFolders(projectName, emails);
    
    logInfo('✅ Project processing completed successfully');
    logInfo('Created folders:', folders);
    
  } catch (err) {
    logError('❌ Error processing project:', err.message);
    logError('Error stack:', err.stack);
    throw err;
  }
}

// ========================================
// HTTP ENDPOINTS
// ========================================

// Health check endpoint
app.get('/health', (req, res) => {
  logDebug('Health check requested');
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Main webhook endpoint
app.post('/ws-pcloud-hook', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  logInfo(`[${requestId}] ========================================`);
  logInfo(`[${requestId}] Incoming webhook request`);
  logInfo(`[${requestId}] Headers:`, JSON.stringify(req.headers));
  
  // Сразу отвечаем OK (требование Worksection)
  res.status(200).json({ status: 'OK' });

  // Проверка авторизации
  if (!checkBasicAuth(req)) {
    logWarn(`[${requestId}] Unauthorized request rejected`);
    return;
  }

  const body = req.body;
  logInfo(`[${requestId}] Request body:`, JSON.stringify(body, null, 2));

  // Worksection шлёт массив событий
  const events = Array.isArray(body) ? body : [body];
  logInfo(`[${requestId}] Processing ${events.length} event(s)...`);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    logInfo(`[${requestId}] --- Event ${i + 1}/${events.length} ---`);
    try {
      await handleWebhookEvent(ev);
    } catch (err) {
      logError(`[${requestId}] Event ${i + 1} failed:`, err.message);
    }
  }

  logInfo(`[${requestId}] Request processing completed`);
  logInfo(`[${requestId}] ========================================`);
});

// Catch-all для неизвестных роутов
app.use((req, res) => {
  logWarn(`Unknown route accessed: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found' });
});

// ========================================
// SERVER START
// ========================================
app.listen(PORT, () => {
  logInfo('===========================================');
  logInfo(`🚀 Server is running on port ${PORT}`);
  logInfo('===========================================');
  logInfo('Available endpoints:');
  logInfo(`  GET  /health           - Health check`);
  logInfo(`  POST /ws-pcloud-hook   - Webhook handler`);
  logInfo('===========================================');
});

// Обработка необработанных ошибок
process.on('uncaughtException', (err) => {
  logError('Uncaught Exception:', err);
  logError('Stack:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('Unhandled Rejection at:', promise);
  logError('Reason:', reason);
});


