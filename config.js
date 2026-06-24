'use strict';

const path = require('path');

// ─── Chrome Profile ────────────────────────────────────────────────────────────
// Trỏ đến Chrome profile đang đăng nhập Facebook tài khoản crawl
// Mac: /Users/yourname/Library/Application Support/Google/Chrome/Profile 2
// Thay "yourname" và "Profile 2" cho đúng với máy bạn
const CHROME_PROFILE_PATH = process.env.CHROME_PROFILE_PATH
  || '/Users/yourname/Library/Application Support/Google/Chrome/Profile 2';

// ─── Date Range ────────────────────────────────────────────────────────────────
// Chỉ lấy bài trong khoảng thời gian này
const DATE_FROM = new Date('2025-01-01T00:00:00+07:00'); // bài từ ngày này
const DATE_TO   = new Date('2025-12-31T23:59:59+07:00'); // đến ngày này

// ─── Group URLs ────────────────────────────────────────────────────────────────
const GROUP_URLS = [
  'http://facebook.com/groups/baohiemprudentialvietnam',
  'https://www.facebook.com/groups/tuvanbaohiemnhanthovn',
  'https://www.facebook.com/groups/hoireviewbaohiem',
  'https://www.facebook.com/groups/1596589817017884',
  // 'https://www.facebook.com/groups/436672700169975', // baohiemvatchat
  'https://www.facebook.com/groups/1365136861495831',
  'https://www.facebook.com/groups/congdongtuvanvienbaohiem',
  'https://www.facebook.com/groups/591670618953174',
  'https://www.facebook.com/groups/742802284045182',
  'https://www.facebook.com/groups/giaidapthacmacbaohiem23242566',
  'https://www.facebook.com/groups/273619486330505',
  'https://www.facebook.com/groups/hoiphuhuynhtinhnamdinh',
];

// ─── Concurrency ───────────────────────────────────────────────────────────────
// Số group crawl song song. Mỗi group tốn ~200-400MB RAM.
// Máy 8GB RAM: dùng 2. Máy 16GB: có thể dùng 3-4.
const PAGE_CONCURRENCY = 1;

// ─── Scroll Settings ───────────────────────────────────────────────────────────
const SCROLL_DELAY_MS     = 2500;  // delay giữa mỗi lần scroll (ms)
const SCROLL_MAX_ATTEMPTS = 50;    // số lần scroll tối đa mỗi group
const POST_LOAD_TIMEOUT   = 15000; // timeout chờ post load (ms)

// ─── Comment Settings ──────────────────────────────────────────────────────────
const COMMENT_DELAY_MS    = 1500;  // delay giữa mỗi post khi crawl comment
const MAX_COMMENT_PAGES   = 10;    // số page comment tối đa mỗi post

// ─── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const GROUPS_DIR    = path.join(DATA_DIR, 'groups');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

module.exports = {
  CHROME_PROFILE_PATH,
  DATE_FROM,
  DATE_TO,
  GROUP_URLS,
  PAGE_CONCURRENCY,
  SCROLL_DELAY_MS,
  SCROLL_MAX_ATTEMPTS,
  POST_LOAD_TIMEOUT,
  COMMENT_DELAY_MS,
  MAX_COMMENT_PAGES,
  DATA_DIR,
  GROUPS_DIR,
  SNAPSHOTS_DIR,
};
