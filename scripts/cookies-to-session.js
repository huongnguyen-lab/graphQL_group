'use strict';

// Chuyển cookie export từ extension Cookie-Editor (JSON array) thành
// storageState format mà Playwright cần cho session.json.
// Dùng: node scripts/cookies-to-session.js data/exported-cookies.json

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Dùng: node scripts/cookies-to-session.js <đường-dẫn-file-cookie-export.json>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
const cookieList = Array.isArray(raw) ? raw : (raw.cookies || []);

function mapSameSite(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  return 'None';
}

const cookies = cookieList
  .filter(c => /facebook\.com$/.test(String(c.domain || '').replace(/^\./, '')))
  .map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate || c.expires || -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: mapSameSite(c.sameSite),
  }));

const hasLoginCookie = cookies.some(c => c.name === 'c_user' && c.value);
if (!hasLoginCookie) {
  console.error('CẢNH BÁO: không thấy cookie "c_user" (cookie xác nhận đã đăng nhập). Kiểm tra lại đã export đúng lúc đang login chưa.');
}

const outPath = path.join(__dirname, '..', 'session.json');
fs.writeFileSync(outPath, JSON.stringify({ cookies, origins: [] }, null, 2), 'utf8');
console.log(`Đã ghi ${cookies.length} cookie facebook.com -> ${outPath}`);
console.log(hasLoginCookie ? 'Có cookie đăng nhập (c_user) hợp lệ.' : 'THIẾU cookie đăng nhập, cần export lại.');
