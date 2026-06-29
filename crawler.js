'use strict';

const config      = require('./config');
const { crawlGroupFeed, launchBrowser } = require('./phase1-feed');
const { crawlComments }  = require('./phase2-comments');
const { loadSnapshot, updateSnapshot, needsCommentCrawl } = require('./snapshot');
const { writePosts, writeComments, loadPosts, loadComments, groupIdFromUrl } = require('./writer');

async function runCommentPhase(browser, groupUrl, posts, oldSnapshot) {
  const postsToUpdate = config.FORCE_COMMENT_CRAWL
    ? posts
    : posts.filter(p => needsCommentCrawl(p, oldSnapshot));
  const limitedPosts = config.COMMENT_POST_LIMIT > 0
    ? postsToUpdate.slice(0, config.COMMENT_POST_LIMIT)
    : postsToUpdate;
  console.log(`\n[Phase 2] ${postsToUpdate.length}/${posts.length} posts cần crawl/re-crawl comment`);
  if (limitedPosts.length !== postsToUpdate.length) {
    console.log(`[Phase 2] COMMENT_POST_LIMIT=${config.COMMENT_POST_LIMIT}, chỉ crawl ${limitedPosts.length} posts lượt này`);
  }

  if (limitedPosts.length > 0) {
    const existingComments = loadComments(groupUrl);
    console.log(`[Phase 2] Đã load ${existingComments.length} comments cũ từ CSV`);

    const allComments = await crawlComments(browser, limitedPosts, existingComments, {
      onProgressWrite: config.COMMENT_WRITE_EACH_POST
        ? async (comments, post, postComments) => {
            await writeComments(groupUrl, comments);
            console.log(`    [writer] Progress saved sau post ${post.post_id}: ${postComments.length} comments`);
          }
        : null,
    });
    await writeComments(groupUrl, allComments);
  } else {
    console.log('[Phase 2] Tất cả posts không thay đổi, bỏ qua crawl comment');
  }

  if (postsToUpdate.length === 0) return posts;
  if (limitedPosts.length === postsToUpdate.length) return posts;
  return limitedPosts;
}

async function processGroupCommentsOnly(browser, groupUrl) {
  const groupId = groupIdFromUrl(groupUrl);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`GROUP: ${groupId} (comments only)`);
  console.log('='.repeat(60));

  const oldSnapshot = loadSnapshot(groupId);
  console.log(`[snapshot] Đã load ${oldSnapshot.size} posts từ snapshot cũ`);

  const posts = loadPosts(groupUrl);
  console.log(`[Comments Only] Đã load ${posts.length} posts từ CSV`);
  if (posts.length === 0) {
    console.log('[Comments Only] Không có posts CSV, bỏ qua group này');
    return;
  }

  const postsToSnapshot = await runCommentPhase(browser, groupUrl, posts, oldSnapshot);

  const newSnapshot = updateSnapshot(groupId, postsToSnapshot, oldSnapshot);
  console.log(`[snapshot] Đã cập nhật snapshot: ${newSnapshot.size} posts tổng cộng`);
  console.log(`\n✓ Hoàn thành group: ${groupId}`);
}

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

  // ─────────────────────────────────────────────────────────
  // PHASE 2: Crawl comments
  // ─────────────────────────────────────────────────────────

  const postsToSnapshot = await runCommentPhase(browser, groupUrl, posts, oldSnapshot);

  // Update snapshot sau Phase 2 để lần sau không bỏ qua bài khi comment crawl chưa chạy.
  const newSnapshot = updateSnapshot(groupId, postsToSnapshot, oldSnapshot);
  console.log(`[snapshot] Đã cập nhật snapshot: ${newSnapshot.size} posts tổng cộng`);

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
  console.log(`Mode      : ${config.COMMENTS_ONLY ? 'comments only' : 'full'}`);

  let browser;
  try {
    browser = await launchBrowser();

    // Xử lý groups theo batch concurrency
    const groups = [...config.GROUP_URLS];
    while (groups.length > 0) {
      const batch = groups.splice(0, config.PAGE_CONCURRENCY);
      const fn = config.COMMENTS_ONLY ? processGroupCommentsOnly : processGroup;
      await Promise.all(batch.map(url => fn(browser, url)));
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
