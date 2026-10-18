import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const viewports = [
    { name: '360px', width: 360, height: 640 },
    { name: '390px', width: 390, height: 844 },
    { name: '768px', width: 768, height: 1024 },
    { name: '1366px', width: 1366, height: 768 },
    { name: '1920px', width: 1920, height: 1080 }
  ];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle' });

    // Fill sample values to check alignment & password toggle button
    await page.fill('#login-email', 'user@company.com');
    await page.fill('#login-password', 'secret123');

    // Screenshot initial view
    await page.screenshot({ path: `screenshot_login_${vp.name}.png`, fullPage: false });
    console.log(`Saved screenshot_login_${vp.name}.png`);
  }

  // Also capture error state on mobile (390px)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#login-submit-btn');
  await page.waitForTimeout(500); // give time for failed auth state/message
  await page.screenshot({ path: 'screenshot_login_390px_error.png', fullPage: false });
  console.log('Saved screenshot_login_390px_error.png');

  await browser.close();
})();
