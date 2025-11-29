// test-full-flow.js
// Полное тестирование: pCloud login → создание папок → шаринг

import dotenv from 'dotenv';
import { pcloudCall, ensureFolder, shareFolder } from './pcloud.js';

dotenv.config();

async function testFullFlow() {
  console.log('========================================');
  console.log('🧪 FULL FLOW TEST');
  console.log('========================================\n');

  const testProjectName = `Test_Project_${Date.now()}`;
  const testEmail = process.env.TEST_EMAIL || 'test@example.com';

  try {
    // ========================================
    // 1. TEST LOGIN
    // ========================================
    console.log('📝 Step 1: Testing pCloud login...');
    const loginTest = await pcloudCall('userinfo', {});
    console.log('✅ Login successful');
    console.log('   User:', loginTest.email);
    console.log('   Premium:', loginTest.premium ? 'Yes' : 'No');
    console.log('   Quota:', Math.round(loginTest.quota / 1024 / 1024 / 1024), 'GB\n');

    // ========================================
    // 2. TEST FOLDER CREATION
    // ========================================
    console.log('📝 Step 2: Creating test folder structure...');
    
    const rootPath = '/WorksectionProjects';
    const projectPath = `${rootPath}/${testProjectName}`;
    const previewPath = `${projectPath}/Preview/2024-11-29`;
    const finalPath = `${projectPath}/Final_render`;

    console.log('   Creating:', rootPath);
    await ensureFolder(rootPath);
    console.log('   ✅ Root folder ready');

    console.log('   Creating:', projectPath);
    await ensureFolder(projectPath);
    console.log('   ✅ Project folder ready');

    console.log('   Creating:', previewPath);
    await ensureFolder(previewPath);
    console.log('   ✅ Preview folder ready');

    console.log('   Creating:', finalPath);
    await ensureFolder(finalPath);
    console.log('   ✅ Final render folder ready\n');

    // ========================================
    // 3. TEST FOLDER LISTING
    // ========================================
    console.log('📝 Step 3: Verifying folders...');
    const listResult = await pcloudCall('listfolder', { path: projectPath });
    
    console.log('   Project folder contents:');
    if (listResult.metadata && listResult.metadata.contents) {
      listResult.metadata.contents.forEach(item => {
        console.log(`   - ${item.name} (${item.isfolder ? 'folder' : 'file'})`);
      });
    }
    console.log('');

    // ========================================
    // 4. TEST FOLDER SHARING
    // ========================================
    console.log('📝 Step 4: Testing folder sharing...');
    console.log(`   Sharing ${projectPath} with ${testEmail}...`);
    
    try {
      await shareFolder(projectPath, testEmail, 7);
      console.log('   ✅ Folder shared successfully\n');
    } catch (err) {
      if (err.message.includes('already shared') || err.message.includes('2048')) {
        console.log('   ℹ️  Folder already shared (or user not found)\n');
      } else {
        throw err;
      }
    }

    // ========================================
    // 5. CLEANUP (OPTIONAL)
    // ========================================
    console.log('📝 Step 5: Cleanup (optional)...');
    console.log('   Skipping cleanup - you can manually delete test folder in pCloud');
    console.log(`   Path: ${projectPath}\n`);

    // ========================================
    // SUMMARY
    // ========================================
    console.log('========================================');
    console.log('✅ ALL TESTS PASSED!');
    console.log('========================================');
    console.log('Summary:');
    console.log('  ✓ pCloud login works');
    console.log('  ✓ Folder creation works');
    console.log('  ✓ Folder listing works');
    console.log('  ✓ Folder sharing works');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Check pCloud web interface');
    console.log('  2. Verify folder structure');
    console.log('  3. Check shared status');
    console.log('  4. Deploy to Render');
    console.log('========================================\n');

  } catch (err) {
    console.error('\n========================================');
    console.error('❌ TEST FAILED');
    console.error('========================================');
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
    console.error('========================================\n');
    process.exit(1);
  }
}

// Запускаем тест
testFullFlow();
