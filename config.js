'use strict';

const path = require('path');

// ─── Session ───────────────────────────────────────────────────────────────────
// Lần đầu chạy: chưa có file này, script sẽ mở Chrome và chờ bạn đăng nhập tay
// rồi tự lưu cookie/login vào đây. Các lần chạy sau dùng lại session này luôn.
const SESSION_FILE = path.join(__dirname, 'session.json');

// ─── Date Range ────────────────────────────────────────────────────────────────
// Chỉ lấy bài trong khoảng thời gian này
const DATE_FROM = new Date('2026-06-01T00:00:00+07:00'); // bài từ ngày này
const DATE_TO   = new Date('2026-06-29T23:59:59+07:00'); // đến ngày này

// ─── Group URLs ────────────────────────────────────────────────────────────────
const GROUP_URLS = [
  // 'http://facebook.com/groups/baohiemprudentialvietnam',
  // 'https://www.facebook.com/groups/tuvanbaohiemnhanthovn',
  'https://www.facebook.com/groups/hoireviewbaohiem',
  // 'https://www.facebook.com/groups/1596589817017884',
  // 'https://www.facebook.com/groups/436672700169975', // baohiemvatchat
  // 'https://www.facebook.com/groups/1365136861495831',
  // 'https://www.facebook.com/groups/congdongtuvanvienbaohiem',
  // 'https://www.facebook.com/groups/591670618953174',
  // 'https://www.facebook.com/groups/742802284045182',
  // 'https://www.facebook.com/groups/giaidapthacmacbaohiem23242566',
  // 'https://www.facebook.com/groups/273619486330505',
  // 'https://www.facebook.com/groups/hoiphuhuynhtinhnamdinh',
];

// ─── Concurrency ───────────────────────────────────────────────────────────────
// Số group crawl song song. Mỗi group tốn ~200-400MB RAM.
// Máy 8GB RAM: dùng 2. Máy 16GB: có thể dùng 3-4.
const PAGE_CONCURRENCY = 1;

// ─── Scroll Settings ───────────────────────────────────────────────────────────
const SCROLL_DELAY_MS     = Number(process.env.SCROLL_DELAY_MS || 2500);      // delay giữa mỗi lần scroll (ms)
const SCROLL_MAX_ATTEMPTS = Number(process.env.SCROLL_MAX_ATTEMPTS || 250);   // số lần scroll tối đa mỗi group
const POST_LOAD_TIMEOUT   = 15000; // timeout chờ post load (ms)
const STOP_AFTER_OLD_POSTS = Number(process.env.STOP_AFTER_OLD_POSTS || 0);   // 0 = không dừng sớm theo bài cũ
const STOP_AFTER_NO_NEW_SCROLLS = Number(process.env.STOP_AFTER_NO_NEW_SCROLLS || 60); // 0 = không dừng khi đứng post

// ─── Comment Settings ──────────────────────────────────────────────────────────
const COMMENT_DELAY_MS       = Number(process.env.COMMENT_DELAY_MS || 800);  // delay giữa mỗi post khi crawl comment
const MAX_COMMENT_PAGES      = Number(process.env.MAX_COMMENT_PAGES || 40);  // số vòng load/scroll comment tối đa mỗi post
const COMMENT_CONCURRENCY    = Number(process.env.COMMENT_CONCURRENCY || 6); // số post crawl comment song song
const COMMENT_INITIAL_WAIT_MS = Number(process.env.COMMENT_INITIAL_WAIT_MS || 2500);
const COMMENT_CLICK_WAIT_MS   = Number(process.env.COMMENT_CLICK_WAIT_MS || 1800);
const COMMENT_FINAL_WAIT_MS   = Number(process.env.COMMENT_FINAL_WAIT_MS || 2000);
const COMMENT_STABLE_ROUNDS   = Number(process.env.COMMENT_STABLE_ROUNDS || 5);
const COMMENT_REPLY_ROUNDS    = Number(process.env.COMMENT_REPLY_ROUNDS || 12);
const COMMENT_WRITE_EACH_POST = process.env.COMMENT_WRITE_EACH_POST !== '0';
const COMMENTS_ONLY           = process.env.COMMENTS_ONLY === '1';
const FORCE_COMMENT_CRAWL     = process.env.FORCE_COMMENT_CRAWL === '1';
const COMMENT_POST_LIMIT      = Number(process.env.COMMENT_POST_LIMIT || 0); // 0 = không giới hạn

// ─── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const POSTS_DIR     = path.join(DATA_DIR, 'posts');
const COMMENTS_DIR  = path.join(DATA_DIR, 'comments');
const GROUPS_DIR    = path.join(DATA_DIR, 'groups'); // legacy path, chỉ để đọc/migrate data cũ
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

module.exports = {
  SESSION_FILE,
  DATE_FROM,
  DATE_TO,
  GROUP_URLS,
  PAGE_CONCURRENCY,
  SCROLL_DELAY_MS,
  SCROLL_MAX_ATTEMPTS,
  POST_LOAD_TIMEOUT,
  STOP_AFTER_OLD_POSTS,
  STOP_AFTER_NO_NEW_SCROLLS,
  COMMENT_DELAY_MS,
  MAX_COMMENT_PAGES,
  COMMENT_CONCURRENCY,
  COMMENT_INITIAL_WAIT_MS,
  COMMENT_CLICK_WAIT_MS,
  COMMENT_FINAL_WAIT_MS,
  COMMENT_STABLE_ROUNDS,
  COMMENT_REPLY_ROUNDS,
  COMMENT_WRITE_EACH_POST,
  COMMENTS_ONLY,
  FORCE_COMMENT_CRAWL,
  COMMENT_POST_LIMIT,
  DATA_DIR,
  POSTS_DIR,
  COMMENTS_DIR,
  GROUPS_DIR,
  SNAPSHOTS_DIR,
};
