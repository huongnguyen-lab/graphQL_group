'use strict';

const path = require('path');

// ─── Session ───────────────────────────────────────────────────────────────────
// Lần đầu chạy: chưa có file này, script sẽ mở Chrome và chờ bạn đăng nhập tay
// rồi tự lưu cookie/login vào đây. Các lần chạy sau dùng lại session này luôn.
const SESSION_FILE = path.join(__dirname, 'session.json');
const BROWSER_HEADLESS = process.env.BROWSER_HEADLESS === '1';

// ─── Date Range ────────────────────────────────────────────────────────────────
// Chỉ lấy bài trong khoảng thời gian này
const DATE_FROM = new Date('2025-01-01T00:00:00+07:00'); // bài từ ngày này
const DATE_TO   = new Date('2026-06-30T23:59:59+07:00'); // đến ngày này

// ─── Group URLs ────────────────────────────────────────────────────────────────
const ALL_GROUP_URLS = [
  'https://www.facebook.com/groups/363194459162467/',
  'https://www.facebook.com/groups/355902270087463/',
  'https://www.facebook.com/groups/299861353823440/',
  'https://www.facebook.com/groups/7678734688837445/',
  'https://www.facebook.com/groups/1113753773143912/',
  'https://www.facebook.com/groups/530571622962102/',
  'https://www.facebook.com/groups/599578094494824/',
  'https://www.facebook.com/groups/183774529022936/',
  'https://www.facebook.com/groups/134165786790512/',
  'https://www.facebook.com/groups/suacongthucchobe/',
  'https://www.facebook.com/groups/804858320013004/',
  'https://www.facebook.com/groups/718413711114590/',
  'https://www.facebook.com/groups/1710547889070752/',
  'https://www.facebook.com/groups/642632105751319/',
  'https://www.facebook.com/groups/hoiriviewsua/',
  'https://www.facebook.com/groups/riviesuacongthuc/',
  'https://www.facebook.com/groups/nuoiconbangsuacongthu/',
  'https://www.facebook.com/groups/271915735836488/',
  'https://www.facebook.com/groups/reviewsuacongthuc/',
  'https://www.facebook.com/groups/1415222655456809/',
  'https://www.facebook.com/groups/hoimebimgiupdonhau/',
  'https://www.facebook.com/groups/nuoiconkhongxichoet/',
  'https://www.facebook.com/groups/184019427900518/',
  'https://www.facebook.com/groups/6183167068463220/',
  'https://www.facebook.com/groups/402671786045954/',
  'https://www.facebook.com/groups/hireviewssinhsacngthcchoccmom/',
  'https://www.facebook.com/groups/reviewsuact/',
  'https://www.facebook.com/groups/939853694105892/',
  'https://www.facebook.com/groups/939557116930502/',
  'https://www.facebook.com/groups/796084822574354/',
  'https://www.facebook.com/groups/414397087816841/',
  'https://www.facebook.com/groups/912404789814271/',
  'https://www.facebook.com/groups/1208237980150295/',
  'https://www.facebook.com/groups/2523848674591558/',
  'https://www.facebook.com/groups/114293632527877/',
];

// Groups da crawl du/gan du moc dau 2025, tam tat de tap trung chay nhom con thieu.
const DISABLED_GROUP_URLS = new Set([
  'https://www.facebook.com/groups/1113753773143912/',
  'https://www.facebook.com/groups/599578094494824/',
  'https://www.facebook.com/groups/suacongthucchobe/',
  'https://www.facebook.com/groups/1710547889070752/',
  'https://www.facebook.com/groups/271915735836488/',
  'https://www.facebook.com/groups/reviewsuact/',
]);

const GROUP_URLS = ALL_GROUP_URLS.filter(url => !DISABLED_GROUP_URLS.has(url));

// ─── Concurrency ───────────────────────────────────────────────────────────────
// Số group crawl song song. Mỗi group tốn ~200-400MB RAM.
// Máy 8GB RAM: dùng 2. Máy 16GB: có thể dùng 3-4.
const PAGE_CONCURRENCY = 2;

// ─── Scroll Settings ───────────────────────────────────────────────────────────
const SCROLL_DELAY_MS     = Number(process.env.SCROLL_DELAY_MS || 2500);      // delay giữa mỗi lần scroll (ms)
const SCROLL_MAX_ATTEMPTS = Number(process.env.SCROLL_MAX_ATTEMPTS || 500000); // số lần scroll tối đa mỗi group
const POST_LOAD_TIMEOUT   = Number(process.env.POST_LOAD_TIMEOUT || 60000); // timeout chờ post load (ms)
const STOP_AFTER_OLD_POSTS = Number(process.env.STOP_AFTER_OLD_POSTS || 10);   // 0 = không dừng sớm theo bài cũ
const STOP_AFTER_NO_NEW_SCROLLS = Number(process.env.STOP_AFTER_NO_NEW_SCROLLS || 0); // 0 = không dừng khi đứng post
const STOP_AT_PAGE_BOTTOM = process.env.STOP_AT_PAGE_BOTTOM === '1';

// ─── Comment Settings ──────────────────────────────────────────────────────────
const COMMENT_DELAY_MS       = Number(process.env.COMMENT_DELAY_MS || 4000);  // delay giữa mỗi post khi crawl comment
const MAX_COMMENT_PAGES      = Number(process.env.MAX_COMMENT_PAGES || 40);  // số vòng load/scroll comment tối đa mỗi post
const COMMENT_CONCURRENCY    = Number(process.env.COMMENT_CONCURRENCY || 6); // số post crawl comment song song
const COMMENT_INITIAL_WAIT_MS = Number(process.env.COMMENT_INITIAL_WAIT_MS || 5000);
const COMMENT_CLICK_WAIT_MS   = Number(process.env.COMMENT_CLICK_WAIT_MS || 3000);
const COMMENT_FINAL_WAIT_MS   = Number(process.env.COMMENT_FINAL_WAIT_MS || 3000);
const COMMENT_STABLE_ROUNDS   = Number(process.env.COMMENT_STABLE_ROUNDS || 5);
const COMMENT_REPLY_ROUNDS    = Number(process.env.COMMENT_REPLY_ROUNDS || 12);
const COMMENT_SELECT_ALL      = process.env.COMMENT_SELECT_ALL === '1';
const COMMENT_WRITE_EACH_POST = process.env.COMMENT_WRITE_EACH_POST !== '0';
const COMMENTS_ONLY           = process.env.COMMENTS_ONLY === '1';
const FORCE_COMMENT_CRAWL     = process.env.FORCE_COMMENT_CRAWL === '1';
const COMMENT_POST_LIMIT      = Number(process.env.COMMENT_POST_LIMIT || 0); // 0 = không giới hạn
const COMMENT_POST_IDS        = (process.env.COMMENT_POST_IDS || '')
  .split(/[,\s]+/)
  .map(s => s.trim())
  .filter(Boolean);

// ─── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const POSTS_DIR     = path.join(DATA_DIR, 'posts');
const COMMENTS_DIR  = path.join(DATA_DIR, 'comments');
const GROUPS_DIR    = path.join(DATA_DIR, 'groups'); // legacy path, chỉ để đọc/migrate data cũ
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

module.exports = {
  SESSION_FILE,
  BROWSER_HEADLESS,
  DATE_FROM,
  DATE_TO,
  ALL_GROUP_URLS,
  DISABLED_GROUP_URLS,
  GROUP_URLS,
  PAGE_CONCURRENCY,
  SCROLL_DELAY_MS,
  SCROLL_MAX_ATTEMPTS,
  POST_LOAD_TIMEOUT,
  STOP_AFTER_OLD_POSTS,
  STOP_AFTER_NO_NEW_SCROLLS,
  STOP_AT_PAGE_BOTTOM,
  COMMENT_DELAY_MS,
  MAX_COMMENT_PAGES,
  COMMENT_CONCURRENCY,
  COMMENT_INITIAL_WAIT_MS,
  COMMENT_CLICK_WAIT_MS,
  COMMENT_FINAL_WAIT_MS,
  COMMENT_STABLE_ROUNDS,
  COMMENT_REPLY_ROUNDS,
  COMMENT_SELECT_ALL,
  COMMENT_WRITE_EACH_POST,
  COMMENTS_ONLY,
  FORCE_COMMENT_CRAWL,
  COMMENT_POST_LIMIT,
  COMMENT_POST_IDS,
  DATA_DIR,
  POSTS_DIR,
  COMMENTS_DIR,
  GROUPS_DIR,
  SNAPSHOTS_DIR,
};
