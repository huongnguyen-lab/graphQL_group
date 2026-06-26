'use strict';

const config = require('./config');
const { parseCommentResponse } = require('./parser');
const { groupIdFromUrl } = require('./writer');

/**
 * Check xem URL có phải GraphQL endpoint không
 */
function isGraphQL(url) {
  return url.includes('/api/graphql') || url.includes('/graphql');
}

const BLOCKED_TYPES = new Set(['image', 'media']);

/**
 * Merge comments, dedup theo comment_id
 */
function mergeComments(existing, incoming) {
  const map = new Map();
  for (const c of existing) map.set(c.comment_id, c);
  for (const c of incoming) {
    if (!map.has(c.comment_id)) map.set(c.comment_id, c);
  }
  return Array.from(map.values());
}

async function selectAllComments(page) {
  try {
    const selected = await page.evaluate(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const buttonSelector = 'div[role="button"], span[role="button"], [aria-haspopup="menu"]';
      const optionSelector = '[role="menuitem"], [role="option"], div[role="button"], span[role="button"]';
      const sortTexts = [
        'Most relevant',
        'Newest',
        'All comments',
        'Phù hợp nhất',
        'Mới nhất',
        'Tất cả bình luận',
      ];
      const allTexts = ['All comments', 'Tất cả bình luận'];

      const textOf = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const directOption = Array.from(document.querySelectorAll(optionSelector))
        .find(el => visible(el) && allTexts.some(text => textOf(el).includes(text)));
      if (directOption) {
        directOption.click();
        await sleep(500);
        return 'direct-all-comments';
      }

      const sortButton = Array.from(document.querySelectorAll(buttonSelector))
        .find(el => visible(el) && sortTexts.some(text => textOf(el).includes(text)));
      if (!sortButton) return '';

      sortButton.click();
      await sleep(600);

      const options = Array.from(document.querySelectorAll(optionSelector)).filter(visible);
      const allOption = options.find(el => allTexts.some(text => textOf(el).includes(text)));
      if (allOption) {
        allOption.click();
        await sleep(500);
        return 'all-comments';
      }

      // Facebook thường để All comments là lựa chọn thứ 3 trong menu sort.
      if (options[2]) {
        options[2].click();
        await sleep(500);
        return 'third-option';
      }

      return '';
    });

    if (selected) {
      console.log(`    → Đã chọn All comments (${selected})`);
      await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
    }
  } catch (_) {}
}

/**
 * Crawl toàn bộ comments của một post
 * @param {object} browser - Playwright browser/context
 * @param {object} post - post object từ Phase 1
 * @returns {object[]} array of comment objects
 */
async function crawlPostComments(browser, post) {
  const page = await browser.newPage();
  let allComments = [];

  try {
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (BLOCKED_TYPES.has(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // ── Intercept GraphQL để bắt comment responses ──
    page.on('response', async (response) => {
      const url = response.url();
      if (!isGraphQL(url)) return;

      try {
        const text = await response.text();
        if (!text || text.length < 50) return;

        const { comments } = parseCommentResponse(text, post.post_url, null);
        if (comments.length > 0) {
          allComments = mergeComments(allComments, comments);
        }
      } catch (_) {}
    });

    // ── Mở trang post ──
    await page.goto(post.post_url, {
      waitUntil: 'domcontentloaded',
      timeout: config.POST_LOAD_TIMEOUT,
    });

    await page.waitForTimeout(config.COMMENT_INITIAL_WAIT_MS);

    // ── Click "View all X comments" nếu có ──
    try {
      // Facebook có thể hiển thị button này với nhiều text khác nhau
      const viewAllSelectors = [
        'text=View all',
        'text=Xem tất cả',
        '[data-testid="UFI2CommentsCount/root_depth_0"]',
      ];
      for (const sel of viewAllSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
          break;
        }
      }
    } catch (_) {}

    await selectAllComments(page);

    // ── Scroll để load thêm comments ──
    let loadMoreAttempts = 0;
    while (loadMoreAttempts < config.MAX_COMMENT_PAGES) {
      // Tìm nút "View more comments" / "Xem thêm bình luận"
      const loadMoreClicked = await page.evaluate(() => {
        const texts = [
          'View more comments',
          'Xem thêm bình luận',
          'View previous comments',
          'Xem bình luận trước',
        ];
        for (const text of texts) {
          const el = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'))
            .find(e => e.textContent.trim().startsWith(text));
          if (el) { el.click(); return true; }
        }
        return false;
      });

      if (!loadMoreClicked) break;

      await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
      loadMoreAttempts++;
    }

    // Scroll để load replies
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);

    // ── Expand replies ──
    // Click tất cả "X replies" buttons để load replies
    let replyAttempts = 0;
    while (replyAttempts < 5) {
      const expanded = await page.evaluate(() => {
        const texts = [
          'replies',
          'phản hồi',
          'Trả lời',
        ];
        let clicked = 0;
        const buttons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
        for (const btn of buttons) {
          const t = btn.textContent.trim().toLowerCase();
          if (texts.some(text => t.includes(text)) && t.match(/\d/)) {
            btn.click();
            clicked++;
          }
        }
        return clicked;
      });

      if (expanded === 0) break;
      await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
      replyAttempts++;
    }

    // Chờ lần cuối để bắt hết responses
    await page.waitForTimeout(config.COMMENT_FINAL_WAIT_MS);

  } catch (err) {
    console.error(`  [ERROR] crawlPostComments (${post.post_id}): ${err.message}`);
  } finally {
    await page.close();
  }

  return allComments;
}

/**
 * Crawl comments cho danh sách posts cần update
 * @param {object} browser
 * @param {object[]} postsToUpdate - posts cần crawl comment
 * @param {object[]} existingComments - comments đã có (từ lần crawl trước nếu có)
 * @returns {object[]} tất cả comments (mới + cũ merged)
 */
async function crawlComments(browser, postsToUpdate, existingComments = []) {
  if (postsToUpdate.length === 0) {
    console.log('\n[Phase 2] Không có post nào cần crawl comment');
    return existingComments;
  }

  const concurrency = Math.max(1, Number(config.COMMENT_CONCURRENCY || 1));
  console.log(`\n[Phase 2] Crawl comment cho ${postsToUpdate.length} posts...`);
  console.log(`[Phase 2] Comment concurrency: ${concurrency}`);

  // Tách comments theo post_url để rebuild sau
  const commentsByPost = new Map();
  for (const c of existingComments) {
    const key = c.post_url;
    if (!commentsByPost.has(key)) commentsByPost.set(key, []);
    commentsByPost.get(key).push(c);
  }

  let totalNew = 0;
  let nextIndex = 0;

  async function worker(workerId) {
    while (nextIndex < postsToUpdate.length) {
      const i = nextIndex++;
      const post = postsToUpdate[i];
      console.log(`  [${i + 1}/${postsToUpdate.length}] [W${workerId}] Post ${post.post_id} (${post.comment} comments expected)`);

      const newComments = await crawlPostComments(browser, post);
      console.log(`    [W${workerId}] → Thu thập được ${newComments.length} comments`);

      commentsByPost.set(post.post_url, newComments);
      totalNew += newComments.length;

      if (config.COMMENT_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, config.COMMENT_DELAY_MS));
      }
    }
  }

  const workerCount = Math.min(concurrency, postsToUpdate.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));

  // Gộp tất cả comments lại
  const allComments = [];
  for (const comments of commentsByPost.values()) {
    allComments.push(...comments);
  }

  console.log(`[Phase 2] Hoàn thành. Tổng comments: ${allComments.length} (${totalNew} mới/updated)`);
  return allComments;
}

module.exports = { crawlComments, crawlPostComments };
