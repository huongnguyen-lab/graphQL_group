'use strict';

const { chromium } = require('playwright');
const config = require('./config');
const { parseGroupFeedResponse } = require('./parser');
const { groupIdFromUrl } = require('./writer');

/**
 * Blocked resource types để tăng tốc crawl
 * GraphQL responses vẫn đi qua vì đây là XHR/fetch, không phải media
 */
const BLOCKED_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

/**
 * Check xem URL có phải GraphQL endpoint không
 */
function isGraphQL(url) {
  return url.includes('/api/graphql') || url.includes('/graphql');
}

/**
 * Filter post theo date range
 */
function inDateRange(post, dateFrom, dateTo) {
  if (!post.post_date) return false;
  const d = new Date(post.post_date);
  return d >= dateFrom && d <= dateTo;
}

/**
 * Merge posts, giữ bản có nhiều data nhất khi trùng post_id
 */
function mergePosts(existing, incoming) {
  const map = new Map();

  for (const p of existing) {
    map.set(p.post_id, p);
  }

  for (const p of incoming) {
    const old = map.get(p.post_id);
    if (!old) {
      map.set(p.post_id, p);
    } else {
      // Giữ bản có nhiều field non-empty hơn
      const oldScore  = Object.values(old).filter(v => v !== '' && v !== 0).length;
      const newScore  = Object.values(p).filter(v => v !== '' && v !== 0).length;
      if (newScore > oldScore) map.set(p.post_id, p);
    }
  }

  return Array.from(map.values());
}

/**
 * Crawl feed của một group
 * @param {object} browser - Playwright browser instance
 * @param {string} groupUrl
 * @param {object} options - { dateFrom, dateTo }
 * @returns {object[]} array of post objects
 */
async function crawlGroupFeed(browser, groupUrl, options = {}) {
  const { dateFrom, dateTo } = options;
  const groupId = groupIdFromUrl(groupUrl);
  console.log(`\n[Phase 1] Bắt đầu crawl group: ${groupId}`);
  console.log(`  URL: ${groupUrl}`);

  const page = await browser.newPage();
  let allPosts = [];
  let scrollCount = 0;
  let consecutiveOldPosts = 0;
  let groupName = '';

  try {
    // ── Block media resources ──
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (BLOCKED_TYPES.has(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // ── Intercept GraphQL responses ──
    page.on('response', async (response) => {
      const url = response.url();
      if (!isGraphQL(url)) return;

      try {
        const text = await response.text();
        if (!text || text.length < 100) return;

        const { posts } = parseGroupFeedResponse(text, groupUrl, groupName);
        if (posts.length === 0) return;

        // Extract group name từ post đầu tiên nếu chưa có
        if (!groupName && posts[0].group_name) {
          groupName = posts[0].group_name;
          console.log(`  Group name: ${groupName}`);
        }

        // Filter và merge
        const filtered = dateFrom && dateTo
          ? posts.filter(p => inDateRange(p, dateFrom, dateTo))
          : posts;

        if (filtered.length > 0) {
          console.log(`  [intercept] Bắt được ${filtered.length} posts từ GraphQL`);
          allPosts = mergePosts(allPosts, filtered);
        }

        // Check nếu có bài cũ hơn DATE_FROM → có thể dừng scroll sớm
        if (dateFrom) {
          const oldOnes = posts.filter(p => p.post_date && new Date(p.post_date) < dateFrom);
          if (oldOnes.length > 0) {
            consecutiveOldPosts += oldOnes.length;
          }
        }
      } catch (_) {
        // ignore parse errors
      }
    });

    // ── Navigate đến group ──
    console.log(`  Đang mở trang...`);
    await page.goto(groupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.POST_LOAD_TIMEOUT,
    });

    // Chờ feed load
    await page.waitForTimeout(3000);

    // Extract group name từ title nếu chưa có
    if (!groupName) {
      try {
        groupName = await page.title();
        groupName = groupName.replace(' | Facebook', '').trim();
      } catch (_) {}
    }

    // ── Scroll loop ──
    console.log(`  Bắt đầu scroll (tối đa ${config.SCROLL_MAX_ATTEMPTS} lần)...`);

    while (scrollCount < config.SCROLL_MAX_ATTEMPTS) {
      // Dừng sớm nếu thấy nhiều bài cũ hơn date range
      if (dateFrom && consecutiveOldPosts >= 5) {
        console.log(`  → Thấy ${consecutiveOldPosts} bài cũ hơn DATE_FROM, dừng scroll sớm`);
        break;
      }

      // Scroll xuống
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      scrollCount++;

      // Delay để tránh rate limit và chờ content load
      await page.waitForTimeout(config.SCROLL_DELAY_MS);

      // Log progress mỗi 5 lần scroll
      if (scrollCount % 5 === 0) {
        console.log(`  Scroll ${scrollCount}/${config.SCROLL_MAX_ATTEMPTS} — Tổng posts: ${allPosts.length}`);
      }

      // Check nếu đã đến cuối trang
      const isAtBottom = await page.evaluate(() => {
        return window.scrollY + window.innerHeight >= document.body.scrollHeight - 200;
      });
      if (isAtBottom && scrollCount > 5) {
        console.log(`  → Đã đến cuối trang sau ${scrollCount} lần scroll`);
        break;
      }
    }

    console.log(`  Hoàn thành scroll. Tổng posts thu thập: ${allPosts.length}`);

  } catch (err) {
    console.error(`  [ERROR] crawlGroupFeed: ${err.message}`);
  } finally {
    await page.close();
  }

  return allPosts;
}

/**
 * Launch browser với Chrome profile
 */
async function launchBrowser() {
  console.log('[Browser] Khởi động Chrome với profile sẵn...');
  console.log(`  Profile: ${config.CHROME_PROFILE_PATH}`);

  const browser = await chromium.launchPersistentContext(config.CHROME_PROFILE_PATH, {
    headless: false,               // Phải dùng headed để tránh bot detection
    channel: 'chrome',             // Dùng Chrome thật, không phải Chromium
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    // Không block permissions để Facebook hoạt động bình thường
  });

  return browser;
}

module.exports = { crawlGroupFeed, launchBrowser, mergePosts };
