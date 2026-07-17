'use strict';

// Crawl comment theo đúng thứ tự ưu tiên trong data/phase2-recrawl-posts.csv
// (đã sắp theo shortage_comments giảm dần), bỏ qua post đã đạt >=80% expected.
// Ghi liên tục vào comments.csv của từng group + rebuild all_comments.csv sau
// mỗi post. Có nhịp làm việc/nghỉ (mặc định 30 phút chạy / 5 phút nghỉ) và tự
// lưu tiến độ để chạy lại không bị crawl trùng.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { launchBrowser } = require('../phase1-feed');
const { crawlComments } = require('../phase2-comments');
const { loadComments, writeComments, groupIdFromUrl } = require('../writer');

const ROOT_DIR = path.join(__dirname, '..');
const RECRAWL_FILE = process.env.PRIORITY_RECRAWL_FILE
  ? path.resolve(process.env.PRIORITY_RECRAWL_FILE)
  : path.join(ROOT_DIR, 'data', 'phase2-recrawl-posts.csv');
const STATE_FILE = path.join(ROOT_DIR, 'data', 'priority-recrawl-state.json');

const WORK_MINUTES = Number(process.env.PRIORITY_WORK_MINUTES || 30);
const REST_MINUTES = Number(process.env.PRIORITY_REST_MINUTES || 5);
const WORK_MS = WORK_MINUTES * 60 * 1000;
const REST_MS = REST_MINUTES * 60 * 1000;
const SKIP_RATIO = Number(process.env.PRIORITY_SKIP_RATIO || 0.8);
const MAX_FAIL_ATTEMPTS = Number(process.env.PRIORITY_MAX_FAIL_ATTEMPTS || 3);
const LIMIT = Number(process.env.PRIORITY_LIMIT || 0); // 0 = không giới hạn, dùng để test nhanh
const BIG_POST_THRESHOLD = Number(process.env.PRIORITY_BIG_POST_THRESHOLD || 500); // >500 comment kỳ vọng = post "khủng"
const BIG_POST_CONCURRENCY = Number(process.env.PRIORITY_BIG_POST_CONCURRENCY || 2);
const SMALL_POST_CONCURRENCY = Number(process.env.PRIORITY_SMALL_POST_CONCURRENCY || 6);
const SMALL_FIRST = process.env.PRIORITY_SMALL_FIRST === '1'; // 1 = crawl post ít comment trước, nhiều comment sau

process.stdout.on('error', err => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', err => { if (err.code !== 'EPIPE') throw err; });

// ─── Dừng êm (graceful stop) ────────────────────────────────────────────────
// Nhận SIGINT/SIGTERM lần đầu: không nhận post mới, các post đang crawl dở sẽ
// cắt sớm vòng lặp scroll và ghi lại đúng số comment đã thu thập (không mất dữ
// liệu, dù mới lấy được 30-40%). Nhận tín hiệu lần 2: thoát ngay, phòng khi
// một page bị treo không thoát nổi.
let stopRequested = false;
function requestStop(signal) {
  if (stopRequested) {
    console.log(`\n[Priority recrawl] Nhận thêm tín hiệu ${signal}, thoát ngay.`);
    process.exit(1);
  }
  stopRequested = true;
  console.log(`\n[Priority recrawl] Nhận tín hiệu ${signal}, đang dừng êm (ghi lại dữ liệu dở dang, có thể mất vài giây)...\n`);
}
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

function interruptibleSleep(ms) {
  return new Promise(resolve => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (stopRequested || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });
}

// ─── CSV helpers (giống các script khác trong repo) ────────────────────────
function parseCsvLine(line) {
  const values = [];
  let value = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') { value += '"'; i++; }
    else if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { values.push(value); value = ''; }
    else { value += ch; }
  }
  values.push(value);
  return values;
}

function parseCsv(text) {
  const rows = [];
  let line = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') { line += ch + next; i++; }
    else if (ch === '"') { inQuotes = !inQuotes; line += ch; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      rows.push(parseCsvLine(line));
      line = '';
    } else { line += ch; }
  }
  if (line) rows.push(parseCsvLine(line));
  return rows;
}

function csvRowsToObjects(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.replace(/^﻿/, ''));
  return rows.slice(1)
    .filter(row => row.some(value => value !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((header, i) => { obj[header] = row[i] || ''; });
      return obj;
    });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadState() {
  return readJson(STATE_FILE, { done_post_ids: [], fail_counts: {}, updated_at: '' });
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  writeJson(STATE_FILE, state);
}

const REBUILD_ALL_COMMENTS_EVERY = Number(process.env.PRIORITY_REBUILD_ALL_COMMENTS_EVERY || 15);
let rebuildAllCommentsCounter = 0;

function rebuildAllComments(force = false) {
  rebuildAllCommentsCounter += 1;
  if (!force && rebuildAllCommentsCounter % REBUILD_ALL_COMMENTS_EVERY !== 0) return;
  const result = spawnSync(process.execPath, ['--max-old-space-size=6144', path.join(__dirname, 'build-all-comments.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, SKIP_ALL_COMMENTS_BACKUP: '1' },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.warn(`[Priority recrawl] WARN rebuild all_comments.csv failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function loadRecrawlRows() {
  const text = fs.readFileSync(RECRAWL_FILE, 'utf8');
  return csvRowsToObjects(parseCsv(text));
}

async function main() {
  const rows = loadRecrawlRows();
  const state = loadState();
  const done = new Set(state.done_post_ids || []);
  const failCounts = { ...(state.fail_counts || {}) };

  let posts = rows
    .filter(row => {
      const expected = Number(row.expected_comments || 0);
      const collected = Number(row.collected_comments || 0);
      if (expected > 0 && collected / expected >= SKIP_RATIO) return false; // đã đủ ~80%+, bỏ qua
      if (done.has(String(row.post_id))) return false; // đã crawl xong ở lần chạy trước
      if ((failCounts[row.post_id] || 0) >= MAX_FAIL_ATTEMPTS) return false; // fail quá nhiều lần, bỏ qua
      return true;
    })
    .map(row => ({
      post_id: row.post_id,
      post_url: row.post_url,
      comment: Number(row.expected_comments || 0),
      post_date: row.post_date,
      content: row.content,
      group_id: row.group_id,
    }));

  if (LIMIT > 0) posts = posts.slice(0, LIMIT);

  console.log('[Priority recrawl] File nguồn:', RECRAWL_FILE);
  console.log(`[Priority recrawl] Tổng ${rows.length} post trong file, còn ${posts.length} post cần crawl (giữ nguyên thứ tự ưu tiên đã sort theo shortage_comments)`);
  console.log(`[Priority recrawl] Nhịp làm việc: ${WORK_MINUTES} phút chạy / ${REST_MINUTES} phút nghỉ`);

  if (posts.length === 0) {
    console.log('[Priority recrawl] Không còn post nào cần crawl. Dừng.');
    return;
  }

  const groupIds = [...new Set(posts.map(p => p.group_id))];
  function preloadExisting() {
    let comments = [];
    for (const gid of groupIds) {
      comments = comments.concat(loadComments(`https://www.facebook.com/groups/${gid}/`));
    }
    return comments;
  }

  // Post comment "khủng" load rất nặng (nhiều DOM/scroll) -> crawl với ít tab song song
  // để đỡ lag máy, post nhỏ thì crawl song song nhiều như bình thường.
  const bigPosts = posts.filter(p => p.comment > BIG_POST_THRESHOLD);
  const smallPosts = posts.filter(p => p.comment <= BIG_POST_THRESHOLD);
  if (SMALL_FIRST) {
    bigPosts.sort((a, b) => a.comment - b.comment);
    smallPosts.sort((a, b) => a.comment - b.comment);
  }
  console.log(`[Priority recrawl] Chia lane: ${bigPosts.length} post >${BIG_POST_THRESHOLD} comment (concurrency ${BIG_POST_CONCURRENCY}), ${smallPosts.length} post <=${BIG_POST_THRESHOLD} comment (concurrency ${SMALL_POST_CONCURRENCY})`);
  if (SMALL_FIRST) {
    console.log('[Priority recrawl] SMALL_FIRST bật: crawl post ít comment trước, nhiều comment sau');
  }

  const browser = await launchBrowser();

  let workEndsAt = Date.now() + WORK_MS;
  let restPromise = null;
  async function maybeRest() {
    if (stopRequested) return;
    if (restPromise) { await restPromise; return; }
    if (Date.now() >= workEndsAt) {
      const untilStr = new Date(Date.now() + REST_MS).toLocaleTimeString('vi-VN');
      console.log(`\n[Nhịp nghỉ] Đã crawl liên tục ${WORK_MINUTES} phút, nghỉ ${REST_MINUTES} phút (tới ${untilStr})...\n`);
      restPromise = interruptibleSleep(REST_MS);
      await restPromise;
      restPromise = null;
      workEndsAt = Date.now() + WORK_MS;
      if (!stopRequested) console.log('\n[Nhịp nghỉ] Nghỉ xong, crawl tiếp.\n');
    }
  }

  let processed = 0;
  const total = posts.length;

  // Nghỉ theo SỐ POST đã crawl (riêng với nhịp nghỉ theo thời gian ở trên):
  // cứ crawl xong N post thì nghỉ M phút rồi crawl tiếp, để tài khoản đỡ bị
  // hoạt động liên tục quá lâu.
  function makeCountRest(everyN, minutes, label) {
    let count = 0;
    let restPromise = null;
    return {
      async beforePost() {
        if (restPromise) await restPromise;
      },
      async afterPost() {
        if (stopRequested) return;
        count += 1;
        if (count < everyN) return;
        count = 0;
        const ms = minutes * 60 * 1000;
        const untilStr = new Date(Date.now() + ms).toLocaleTimeString('vi-VN');
        console.log(`\n[Nhịp nghỉ theo post] Đã crawl xong ${everyN} post ${label}, nghỉ ${minutes} phút (tới ${untilStr})...\n`);
        restPromise = interruptibleSleep(ms);
        await restPromise;
        restPromise = null;
        if (!stopRequested) console.log(`\n[Nhịp nghỉ theo post] Nghỉ xong, crawl tiếp post ${label}.\n`);
      },
    };
  }

  const BIG_REST_EVERY = Number(process.env.PRIORITY_BIG_REST_EVERY || 2);
  const BIG_REST_MINUTES = Number(process.env.PRIORITY_BIG_REST_MINUTES || 15);
  const SMALL_REST_EVERY = Number(process.env.PRIORITY_SMALL_REST_EVERY || 6);
  const SMALL_REST_MINUTES = Number(process.env.PRIORITY_SMALL_REST_MINUTES || 15);
  const bigCountRest = makeCountRest(BIG_REST_EVERY, BIG_REST_MINUTES, 'lớn');
  const smallCountRest = makeCountRest(SMALL_REST_EVERY, SMALL_REST_MINUTES, 'nhỏ');

  function makeOptions(concurrency, countRest) {
    return {
      concurrency,
      beforePost: async post => {
        await maybeRest();
        await countRest.beforePost();
      },
      shouldStop: () => stopRequested,
      onPostAttempt: async (post, status) => {
        processed += 1;
        if (status === 'failed') {
          failCounts[post.post_id] = (failCounts[post.post_id] || 0) + 1;
          saveState({ done_post_ids: [...done], fail_counts: failCounts });
        }
        console.log(`[Priority recrawl] Tiến độ: ${processed}/${total} (post ${post.post_id}: ${status})`);
        await countRest.afterPost();
      },
      onProgressWrite: async (allSnapshotComments, post, newComments) => {
        const groupId = groupIdFromUrl(post.post_url);
        const groupComments = allSnapshotComments.filter(c => groupIdFromUrl(c.post_url) === groupId);
        await writeComments(post.post_url, groupComments);
        rebuildAllComments();

        // Chỉ đánh dấu "done" (không crawl lại nữa) khi thực sự đạt ngưỡng SKIP_RATIO.
        // Nếu chưa đủ (vd. do bị chặn/giới hạn giữa chừng), để nguyên post trong hàng chờ
        // cho lần chạy sau, không cần danh sách riêng.
        const expected = Number(post.comment || 0);
        const collected = (newComments || []).length;
        const reachedThreshold = expected === 0 || collected / expected >= SKIP_RATIO;
        if (reachedThreshold) {
          done.add(String(post.post_id));
          delete failCounts[post.post_id];
        } else {
          console.log(`[Priority recrawl] Post ${post.post_id} mới lấy ${collected}/${expected} (~${expected ? Math.round((collected / expected) * 100) : 0}%), sẽ crawl lại ở lần chạy sau`);
        }
        saveState({ done_post_ids: [...done], fail_counts: failCounts });
      },
    };
  }

  async function runBigLane() {
    if (bigPosts.length === 0 || stopRequested) return;
    console.log(`\n[Priority recrawl] === Lane POST LỚN (concurrency ${BIG_POST_CONCURRENCY}) ===`);
    await crawlComments(browser, bigPosts, preloadExisting(), makeOptions(BIG_POST_CONCURRENCY, bigCountRest));
  }

  async function runSmallLane() {
    if (smallPosts.length === 0 || stopRequested) return;
    console.log(`\n[Priority recrawl] === Lane POST NHỎ (concurrency ${SMALL_POST_CONCURRENCY}) ===`);
    // reload từ disk để lấy luôn comment vừa ghi ở lane kia, tránh writeComments ghi đè mất dữ liệu
    await crawlComments(browser, smallPosts, preloadExisting(), makeOptions(SMALL_POST_CONCURRENCY, smallCountRest));
  }

  try {
    if (SMALL_FIRST) {
      await runSmallLane();
      await runBigLane();
    } else {
      await runBigLane();
      await runSmallLane();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  rebuildAllComments(true); // đảm bảo all_comments.csv luôn khớp dữ liệu mới nhất khi dừng/xong

  console.log(stopRequested ? '[Priority recrawl] Đã dừng êm theo yêu cầu, dữ liệu dở dang đã được ghi lại.' : '[Priority recrawl] HOÀN THÀNH batch này.');
}

main().catch(err => {
  console.error('[Priority recrawl] FATAL', err);
  process.exitCode = 1;
});
