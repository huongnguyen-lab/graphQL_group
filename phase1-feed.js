'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { parseGroupFeedResponse } = require('./parser');
const { groupIdFromUrl } = require('./writer');

/**
 * Blocked resource types để tăng tốc crawl
 * GraphQL responses vẫn đi qua vì đây là XHR/fetch, không phải media
 */
const BLOCKED_TYPES = new Set(['image', 'media']);

/**
 * Check xem URL có phải GraphQL endpoint không
 */
function isGraphQL(url) {
  return url.includes('/api/graphql') || url.includes('/graphql');
}

function chronologicalGroupUrl(groupUrl) {
  const url = new URL(groupUrl, 'https://www.facebook.com');
  url.protocol = 'https:';
  url.hostname = 'www.facebook.com';
  url.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
  return url.toString();
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
function metricScore(post) {
  return ['reaction', 'share', 'comment']
    .reduce((sum, key) => sum + (Number(post[key]) > 0 ? 1 : 0), 0);
}

function hasValue(value) {
  return value !== '' && value !== 0 && value != null;
}

function mergePostRecord(oldPost, newPost) {
  const merged = { ...oldPost };
  for (const [key, value] of Object.entries(newPost)) {
    if (!hasValue(value)) continue;
    if (['reaction', 'share', 'comment'].includes(key) || !hasValue(merged[key])) {
      merged[key] = value;
    }
  }
  return merged;
}

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
      // Ưu tiên bản có metrics vì GraphQL feed có thể trả cùng post ở nhiều variant.
      const oldMetricScore = metricScore(old);
      const newMetricScore = metricScore(p);
      if (newMetricScore > oldMetricScore) {
        map.set(p.post_id, mergePostRecord(old, p));
        continue;
      }

      if (newMetricScore < oldMetricScore) {
        continue;
      }

      // Nếu metrics tương đương, giữ bản có nhiều field non-empty hơn.
      const oldScore  = Object.values(old).filter(v => v !== '' && v !== 0).length;
      const newScore  = Object.values(p).filter(v => v !== '' && v !== 0).length;
      if (newScore > oldScore) map.set(p.post_id, p);
    }
  }

  return Array.from(map.values());
}

function oldestPostDate(posts) {
  const dates = posts
    .map(p => p.post_date)
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => !Number.isNaN(d.getTime()));

  if (dates.length === 0) return '';
  return new Date(Math.min(...dates)).toISOString();
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
  const feedUrl = chronologicalGroupUrl(groupUrl);
  console.log(`\n[Phase 1] Bắt đầu crawl group: ${groupId}`);
  console.log(`  URL: ${feedUrl}`);

  const page = await browser.newPage();
  let allPosts = [];
  let scrollCount = 0;
  let consecutiveOldPosts = 0;
  let lastPostCount = 0;
  let scrollsWithoutNewPosts = 0;
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
    await page.goto(feedUrl, {
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
      if (
        dateFrom
        && config.STOP_AFTER_OLD_POSTS > 0
        && consecutiveOldPosts >= config.STOP_AFTER_OLD_POSTS
      ) {
        console.log(`  → Thấy ${consecutiveOldPosts} bài cũ hơn DATE_FROM, dừng scroll sớm`);
        break;
      }

      // Scroll xuống
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      scrollCount++;

      // Delay để tránh rate limit và chờ content load
      await page.waitForTimeout(config.SCROLL_DELAY_MS);

      if (allPosts.length > lastPostCount) {
        lastPostCount = allPosts.length;
        scrollsWithoutNewPosts = 0;
      } else {
        scrollsWithoutNewPosts++;
      }

      // Log progress mỗi 5 lần scroll
      if (scrollCount % 5 === 0) {
        const oldest = oldestPostDate(allPosts);
        const oldestText = oldest ? ` — Cũ nhất: ${oldest}` : '';
        console.log(`  Scroll ${scrollCount}/${config.SCROLL_MAX_ATTEMPTS} — Tổng posts: ${allPosts.length}${oldestText}`);
      }

      if (
        config.STOP_AFTER_NO_NEW_SCROLLS > 0
        && scrollsWithoutNewPosts >= config.STOP_AFTER_NO_NEW_SCROLLS
      ) {
        console.log(`  → Không có post mới sau ${scrollsWithoutNewPosts} lần scroll, dừng`);
        break;
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
 * Launch browser, đăng nhập Facebook bằng session đã lưu (session.json).
 * Nếu chưa có session hoặc đã hết hạn, chờ người dùng đăng nhập tay trong
 * Chrome vừa mở, rồi tự lưu lại session để dùng cho các lần chạy sau.
 */
async function launchBrowser() {
  console.log('[Browser] Khởi động Chrome...');

  const browser = await chromium.launch({
    headless: false, // Phải dùng headed để tránh bot detection
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      // Đẩy cửa sổ ra ngoài vùng nhìn thấy của màn hình chính (vẫn "headed" thật,
      // chỉ là không che màn hình khi crawl chạy lâu/nhiều tab)
      '--window-position=2500,0',
      '--window-size=1280,900',
    ],
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(config.SESSION_FILE) ? config.SESSION_FILE : undefined,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // c_user là cookie Facebook chỉ set khi đăng nhập thật, đáng tin hơn việc dò DOM
  // (DOM "Log In" vẫn hiện trên trang xem công khai dù đã hết phiên đăng nhập)
  async function hasLoginCookie() {
    const cookies = await context.cookies('https://www.facebook.com');
    return cookies.some(c => c.name === 'c_user' && c.value);
  }

  const loggedIn = await hasLoginCookie();

  if (!loggedIn) {
    console.log('[Browser] Chưa đăng nhập. Hãy đăng nhập vào Chrome vừa mở.');
    console.log('           Script sẽ tự phát hiện khi đăng nhập xong (chờ tối đa 5 phút)...');

    const deadline = Date.now() + 5 * 60 * 1000;
    let confirmed = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      const ok = await hasLoginCookie().catch(() => false);
      if (ok) { confirmed = true; break; }
    }

    if (confirmed) {
      await context.storageState({ path: config.SESSION_FILE });
      console.log('[Browser] Đăng nhập thành công, đã lưu session vào ' + config.SESSION_FILE);
    } else {
      console.log('[Browser] Hết thời gian chờ, vẫn chưa phát hiện đăng nhập thành công.');
    }
  } else {
    console.log('[Browser] Đã đăng nhập sẵn (dùng session.json)');
  }

  await page.close().catch(() => {});

  // Đóng context cũng phải đóng luôn process browser bên dưới
  const closeContext = context.close.bind(context);
  context.close = async () => {
    await closeContext();
    await browser.close();
  };

  return context;
}

module.exports = { crawlGroupFeed, launchBrowser, mergePosts };
