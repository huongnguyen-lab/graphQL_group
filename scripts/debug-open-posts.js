'use strict';

// Mở riêng 1 Chrome (tách biệt với crawler chính đang chạy) để xem trực tiếp
// 1 vài post cụ thể, dùng lại session đã lưu. Dùng khi cần kiểm tra bằng mắt
// tại sao 1 post bị lỗi/unavailable khi crawl tự động.
// Cách chạy: node scripts/debug-open-posts.js <url1> <url2> ...

const { chromium } = require('playwright');
const config = require('../config');

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.log('Dùng: node scripts/debug-open-posts.js <url1> <url2> ...');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--window-position=900,40',
      '--window-size=1280,900',
    ],
  });

  const context = await browser.newContext({
    storageState: config.SESSION_FILE,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  });

  for (const url of urls) {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log('[Debug] Đã mở:', url);
  }

  console.log('[Debug] Đã mở xong tất cả tab, để browser mở cho tới khi bạn đóng thủ công hoặc Ctrl+C.');
  await new Promise(() => {}); // giữ process sống, không tự đóng browser
}

main().catch(err => {
  console.error('[Debug] FATAL', err);
  process.exit(1);
});
