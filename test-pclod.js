// test-pcloud.js
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const PCLOUD_API = process.env.PCLOUD_API || 'https://api.pcloud.com/';
const PCLOUD_USERNAME = process.env.PCLOUD_USERNAME;
const PCLOUD_PASSWORD = process.env.PCLOUD_PASSWORD;

async function main() {
  if (!PCLOUD_USERNAME || !PCLOUD_PASSWORD) {
    console.error('Нет PCLOUD_USERNAME или PCLOUD_PASSWORD в .env');
    process.exit(1);
  }

  const url = `${PCLOUD_API.replace(/\/$/, '')}/userinfo`;

  const params = {
    getauth: 1,
    username: PCLOUD_USERNAME,
    password: PCLOUD_PASSWORD,
    device: 'ws-test-login',
  };

  // ==== 👇 ВЫВОДИМ ВСЁ В ТЕРМИНАЛ ====
  console.log('-------------------------------------');
  console.log('📤 REQUEST: pCloud login (userinfo?getauth=1)');
  console.log('URL:', url);
  console.log('Query params (password masked):', {
    ...params,
    password: '***MASKED***',
  });
  console.log('-------------------------------------\n');

  try {
    const response = await axios.get(url, { params });

    console.log('-------------------------------------');
    console.log('📥 RESPONSE HEADERS:');
    console.log(response.headers);
    console.log('-------------------------------------');

    console.log('📥 RESPONSE BODY:');
    console.dir(response.data, { depth: null });
    console.log('-------------------------------------');

    if (response.data.result === 0) {
      console.log('✅ AUTH TOKEN:', response.data.auth);
    } else {
      console.log(
        `❌ Login failed. result=${response.data.result}, message="${response.data.error}"`
      );
    }
  } catch (err) {
    console.log('-------------------------------------');
    console.error('❌ AXIOS ERROR:', err.message);
    if (err.response) {
      console.error('HTTP status:', err.response.status);
      console.error('Response body:', err.response.data);
    }
    console.log('-------------------------------------');
  }
}

main();
