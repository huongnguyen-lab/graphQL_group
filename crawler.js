'use strict';

const config      = require('./config');
const { crawlGroupFeed, launchBrowser } = require('./phase1-feed');
const { crawlComments }  = require('./phase2-comments');
const { loadSnapshot, updateSnapshot, needsCommentCrawl } = require('./snapshot');
const { writePosts, writeComments, groupIdFromUrl } = require('./writer');

/**
 * Chạy pipeline đầy đủ cho một group
 */
async function processGroup(browser, groupUrl) {
  const groupId = groupIdFromUrl(groupUrl);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`GROUP: ${groupId}`);
  console.log('='.repeat(60));

  // ── Load snapshot cũ ──
  const oldSnapshot = loadSnapshot(groupId);
  console.log(`[snapshot] Đã load ${oldSnapshot.size} posts từ snapshot cũ`);

  // ─────────────────────────────────────────────────────────
  // PHASE 1: Crawl feed
  // ─────────────────────────────────────────────────────────
  const posts = await crawlGroupFeed(browser, groupUrl, {
    dateFrom: config.DATE_FROM,
    dateTo:   config.DATE_TO,
  });

  console.log(`\n[Phase 1] Kết quả: ${posts.length} posts trong date range`);

  if (posts.length === 0) {
    console.log('[Phase 1] Không có post nào, bỏ qua group này');
    return;
  }

  // Ghi posts CSV
  await writePosts(groupUrl, posts);

  // Update snapshot
  const newSnapshot = updateSnapshot(groupId, posts, oldSnapshot);
  console.log(`[snapshot] Đã cập nhật snapshot: ${newSnapshot.size} posts tổng cộng`);

  // ─────────────────────────────────────────────────────────
  // PHASE 2: Crawl comments
  // ─────────────────────────────────────────────────────────

  // Xác định posts nào cần crawl comment
  const postsToUpdate = posts.filter(p => needsCommentCrawl(p, oldSnapshot));
  console.log(`\n[Phase 2] ${postsToUpdate.length}/${posts.length} posts cần crawl/re-crawl comment`);

  if (postsToUpdate.length > 0) {
    const allComments = await crawlComments(browser, postsToUpdate);
    await writeComments(groupUrl, allComments);
  } else {
    console.log('[Phase 2] Tất cả posts không thay đổi, bỏ qua crawl comment');
  }

  console.log(`\n✓ Hoàn thành group: ${groupId}`);
}

/**
 * Main runner — xử lý tất cả groups với concurrency
 */
async function main() {
  const startTime = Date.now();
  console.log('FB Group Crawler bắt đầu chạy');
  console.log(`DATE_FROM : ${config.DATE_FROM.toISOString()}`);
  console.log(`DATE_TO   : ${config.DATE_TO.toISOString()}`);
  console.log(`Groups    : ${config.GROUP_URLS.length}`);
  console.log(`Concurrency: ${config.PAGE_CONCURRENCY}`);

  let browser;
  try {
    browser = await launchBrowser();

    // Xử lý groups theo batch concurrency
    const groups = [...config.GROUP_URLS];
    while (groups.length > 0) {
      const batch = groups.splice(0, config.PAGE_CONCURRENCY);
      await Promise.all(batch.map(url => processGroup(browser, url)));
    }

  } catch (err) {
    console.error('\n[FATAL ERROR]', err);
  } finally {
    if (browser) {
      await browser.close();
    }
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Hoàn thành tất cả groups trong ${elapsed} phút`);
    console.log('='.repeat(60));
  }
}

main();
