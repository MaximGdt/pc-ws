// test-ws.js
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';

dotenv.config();

async function main() {
  const baseUrl = process.env.WS_BASE_URL;
  const apiKey = process.env.WS_ADMIN_TOKEN;

  if (!baseUrl || !apiKey) {
    console.error('WS_BASE_URL или WS_ADMIN_TOKEN не заданы в .env');
    process.exit(1);
  }

  // --- параметры запроса к admin v2 API ---
  // документация: get_projects :contentReference[oaicite:2]{index=2}
  const paramsObj = {
    action: 'get_projects',
    // если хочешь только активные:
    // filter: 'active',
    // если хочешь видеть команду:
    extra: 'users', // опционально
  };

  // Строим строку query_params БЕЗ hash
  // Важно: порядок параметров в строке ДОЛЖЕН совпадать с тем, как ты их отправляешь
  const queryParams = new URLSearchParams(paramsObj).toString(); 
  // например: "action=get_projects&extra=users"

  const hash = crypto
    .createHash('md5')
    .update(queryParams + apiKey)
    .digest('hex');

  const finalParams = {
    ...paramsObj,
    hash,
  };

  const url = `${baseUrl.replace(/\/$/, '')}/api/admin/v2/`;

  console.log('-------------------------------------');
  console.log('📤 REQUEST get_projects');
  console.log('URL:', url);
  console.log('Query string (for hash):', queryParams);
  console.log('Hash:', hash);
  console.log('Final params:', finalParams);
  console.log('-------------------------------------\n');

  try {
    const res = await axios.get(url, { params: finalParams });

    console.log('Status:', res.status);
    console.log('Headers:', res.headers);

    console.log('-------------------------------------');
    console.log('📥 RESPONSE BODY:');
    console.dir(res.data, { depth: null });
    console.log('-------------------------------------');

    if (res.data.status !== 'ok') {
      console.error('❌ API status != ok:', res.data);
    } else {
      console.log(
        `✅ Projects count: ${Array.isArray(res.data.data) ? res.data.data.length : 'N/A'}`
      );
    }
  } catch (err) {
    console.error('❌ AXIOS ERROR:', err.message);
    if (err.response) {
      console.error('HTTP status:', err.response.status);
      console.error('Response body:', err.response.data);
    }
  }
}

main();
