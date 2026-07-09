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

function flattenCommentsMap(commentsByPost) {
  const allComments = [];
  for (const comments of commentsByPost.values()) {
    allComments.push(...comments);
  }
  return allComments;
}

async function isUnavailablePostPage(page) {
  try {
    return page.evaluate(() => {
      const text = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
      return /This page isn't available right now/i.test(text)
        || /This content isn't available right now/i.test(text)
        || /Trang này hiện không khả dụng/i.test(text)
        || /Nội dung này hiện không khả dụng/i.test(text)
        || /This page isn't available/i.test(text)
        || /Go to Feed\s+Go back\s+Visit Help Center/i.test(text);
    });
  } catch (_) {
    return false;
  }
}

async function recoverUnavailablePostPage(page, post) {
  const maxReloads = Number(process.env.UNAVAILABLE_RELOAD_ATTEMPTS || 2);

  for (let attempt = 1; attempt <= maxReloads; attempt++) {
    if (!(await isUnavailablePostPage(page))) return true;

    console.log(`    ↻ Post ${post.post_id} hiện page unavailable, reload lần ${attempt}/${maxReloads}`);
    try {
      await page.reload({
        waitUntil: 'commit',
        timeout: config.POST_LOAD_TIMEOUT,
      });
    } catch (err) {
      console.log(`    ↻ Reload post ${post.post_id} lỗi: ${err.message}`);
    }

    await page.waitForSelector('body', { timeout: Math.min(config.POST_LOAD_TIMEOUT, 15000) }).catch(() => {});
    await page.waitForTimeout(Math.max(3000, config.COMMENT_CLICK_WAIT_MS));
  }

  return !(await isUnavailablePostPage(page));
}

async function selectAllComments(page) {
  try {
    const readSortLabel = async () => page.evaluate(() => {
      const labels = [
        'Most relevant',
        'Newest',
        'All comments',
        'Phù hợp nhất',
        'Mới nhất',
        'Tất cả bình luận',
      ];
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const root = document.querySelector('div[role="dialog"]:not([aria-label])') || document;
      const node = Array.from(root.querySelectorAll('div[role="button"], span[role="button"]'))
        .find(el => visible(el) && labels.some(label => textOf(el) === label || textOf(el).includes(label)));
      return node ? textOf(node) : '';
    });

    const isAllComments = text =>
      /^(All comments|Tất cả bình luận)\b/i.test(String(text || '').trim());

    const initialLabel = await readSortLabel();
    if (isAllComments(initialLabel)) {
      console.log(`    → All comments đã bật (${initialLabel})`);
      await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
      return;
    }

    let selected = '';
    for (let attempt = 0; attempt < 5 && !selected; attempt++) {
      const opened = await page.evaluate(() => {
        const labels = [
          'Most relevant',
          'Newest',
          'Phù hợp nhất',
          'Mới nhất',
        ];
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const root = document.querySelector('div[role="dialog"]:not([aria-label])');
        if (!root) return false;

        const opener = Array.from(root.querySelectorAll('div[role="button"], span[role="button"]'))
          .find(el => visible(el) && labels.some(label => textOf(el) === label || textOf(el).includes(label)));
        if (!opener) return false;

        opener.scrollIntoView({ block: 'center', inline: 'nearest' });
        opener.click();
        return true;
      });

      if (opened) {
        await page.waitForTimeout(Math.max(1200, config.COMMENT_CLICK_WAIT_MS));
      } else {
        await scrollCommentAreaToBottom(page);
        await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
        continue;
      }

      selected = await page.evaluate(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const menuScopes = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'))
          .filter(visible);
        const scope = menuScopes[menuScopes.length - 1] || document;
        const options = Array.from(scope.querySelectorAll('[role="menuitem"], [role="option"]'))
          .filter(visible)
          .filter(el => textOf(el));

        const allCommentsOption = options.find(el =>
          /^(All comments|Tất cả bình luận)\b/i.test(textOf(el))
        );
        const target = allCommentsOption || options[2];
        if (!target) return '';

        target.click();
        await sleep(1000);
        return allCommentsOption ? textOf(target) : `third-option:${textOf(target)}`;
      });

      if (!selected) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
      }
    }

    await page.waitForTimeout(Math.max(2500, config.COMMENT_CLICK_WAIT_MS * 2));

    const finalLabel = await readSortLabel();
    if (isAllComments(finalLabel)) {
      console.log(`    → Đã chọn All comments (${finalLabel})`);
    } else if (selected) {
      console.log(`    ⚠️ Đã click ${selected} nhưng chưa verify được label All comments`);
    } else {
      console.log('    ⚠️ Không tìm thấy/chưa đổi được nút All comments');
    }
  } catch (_) {}
}

async function clickCommentControls(page) {
  return page.evaluate(() => {
    const targets = [
      'View more comments',
      'View previous comments',
      'View all comments',
      'View more replies',
      'View 1 reply',
      'View previous replies',
      'Xem thêm bình luận',
      'Xem bình luận trước',
      'Xem tất cả bình luận',
      'Xem 1 phản hồi',
      'Xem thêm phản hồi',
      'Xem phản hồi trước',
      'phản hồi',
      'replies',
    ];
    const skipTexts = [
      'Reply',
      'Trả lời',
      'Like',
      'Thích',
      'Share',
      'Chia sẻ',
    ];
    const visible = el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = el => (el.textContent || '').replace(/\s+/g, ' ').trim();

    let clicked = 0;
    const buttons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a[role="link"]'))
      .filter(visible);

    for (const btn of buttons) {
      const text = textOf(btn);
      const lower = text.toLowerCase();
      if (!text) continue;
      if (skipTexts.some(skip => text === skip)) continue;
      if (!targets.some(target => lower.includes(target.toLowerCase()))) continue;
      if ((lower.includes('reply') || lower.includes('phản hồi')) && !/\d/.test(lower)) continue;

      btn.click();
      clicked++;
    }
    return clicked;
  });
}

async function clickAll(page, selectors, waitTime = 700) {
  let totalClicked = 0;

  for (const selector of selectors) {
    const buttons = await page.locator(selector).all();

    for (const button of buttons) {
      try {
        const visible = await button.isVisible().catch(() => false);
        if (!visible) continue;

        await button.click({ timeout: 3000 });
        totalClicked += 1;
        await page.waitForTimeout(waitTime);
      } catch (_) {}
    }
  }

  return totalClicked;
}

async function getCommentAreaStats(page) {
  return page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const getDivChildren = node =>
      Array.from(node.children).filter(el => el.tagName === 'DIV');

    const findFirstDivContainingHtmlDiv = node => {
      const divChildren = getDivChildren(node);

      for (const child of divChildren) {
        if (child.classList.contains('html-div')) return child;
      }

      for (const child of divChildren) {
        const found = findFirstDivContainingHtmlDiv(child);
        if (found) return found;
      }

      return null;
    };

    const dialog = document.querySelector('div[role="dialog"]:not([aria-label])');
    const firstDivContainsHtmlDiv = dialog ? findFirstDivContainingHtmlDiv(dialog) : null;
    const dialogRoot = firstDivContainsHtmlDiv ? getDivChildren(firstDivContainsHtmlDiv)[1] || null : null;
    const root = dialogRoot;
    const scope = dialogRoot && dialog ? dialog : null;

    if (!root || !scope) {
      return {
        found: false,
        commentCount: 0,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        moreButtons: 0,
      };
    }

    const clickableNodes = Array.from(
      scope.querySelectorAll ? scope.querySelectorAll('div[role="button"], span, div') : []
    );
    const moreButtons = clickableNodes.filter(node => {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      return (
        /Xem thêm bình luận/i.test(text) ||
        /View more comments/i.test(text) ||
        /Xem các bình luận trước/i.test(text) ||
        /View previous comments/i.test(text) ||
        /Xem thêm phản hồi/i.test(text) ||
        /View more replies/i.test(text) ||
        /Xem phản hồi trước/i.test(text) ||
        /View previous replies/i.test(text) ||
        /Xem tất cả \d+ phản hồi/i.test(text) ||
        /View all \d+ replies/i.test(text)
      );
    }).length;

    return {
      found: true,
      commentCount: scope.querySelectorAll ? scope.querySelectorAll('div[role="article"]').length : 0,
      scrollTop: root.scrollTop || window.scrollY,
      scrollHeight: root.scrollHeight || document.body.scrollHeight,
      clientHeight: root.clientHeight || window.innerHeight,
      moreButtons,
    };
  });
}

async function scrollCommentAreaToBottom(page) {
  return page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const getDivChildren = node =>
      Array.from(node.children).filter(el => el.tagName === 'DIV');

    const findFirstDivContainingHtmlDiv = node => {
      const divChildren = getDivChildren(node);

      for (const child of divChildren) {
        if (child.classList.contains('html-div')) return child;
      }

      for (const child of divChildren) {
        const found = findFirstDivContainingHtmlDiv(child);
        if (found) return found;
      }

      return null;
    };

    const dialog = document.querySelector('div[role="dialog"]:not([aria-label])');
    const firstDivContainsHtmlDiv = dialog ? findFirstDivContainingHtmlDiv(dialog) : null;
    const root = firstDivContainsHtmlDiv
      ? getDivChildren(firstDivContainsHtmlDiv)[1] || null
      : null;

    if (!root) {
      return {
        found: false,
        moved: 0,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
      };
    }

    const before = root.scrollTop || window.scrollY;
    root.scrollBy(0, 2500);
    root.scrollBy(0, 2500);
    root.scrollTo(0, root.scrollHeight);
    root.dispatchEvent(new Event('scroll', { bubbles: true }));

    return {
      found: true,
      moved: (root.scrollTop || window.scrollY) - before,
      scrollTop: root.scrollTop || window.scrollY,
      scrollHeight: root.scrollHeight || document.body.scrollHeight,
      clientHeight: root.clientHeight || window.innerHeight,
    };
  });
}

async function expandAllReplies(page, maxRounds = 8) {
  for (let round = 0; round < maxRounds; round++) {
    const clicked = await clickAll(page, [
      'text=/Xem tất cả\\s+\\d+\\s+phản hồi/i',
      'text=/View all\\s+\\d+\\s+replies/i',
      'text=/Xem\\s+\\d+\\s+phản hồi/i',
      'text=/View\\s+\\d+\\s+repl(?:y|ies)/i',
      'text="Xem thêm phản hồi"',
      'text="View more replies"',
      'text="Xem phản hồi trước"',
      'text="View previous replies"',
    ], 700);

    if (clicked === 0) break;
    await page.waitForTimeout(config.COMMENT_CLICK_WAIT_MS);
  }
}

async function scrollAndLoadAllComments(page, expectedCommentCount = 0, getCollectedCount = () => 0, shouldStop = () => false) {
  let stableRounds = 0;
  let stagnantDataRounds = 0;
  let unproductiveClickRounds = 0;
  let everFoundDialog = false;
  const maxSteps =
    expectedCommentCount > 0 && expectedCommentCount <= 20
      ? Math.max(24, config.MAX_COMMENT_PAGES)
      : Math.max(48, config.MAX_COMMENT_PAGES);

  for (let step = 0; step < maxSteps; step++) {
    if (shouldStop()) {
      console.log(`    ↳ dừng sớm: nhận tín hiệu dừng, giữ lại ${getCollectedCount()} comment đã thu thập`);
      break;
    }
    const before = await getCommentAreaStats(page);
    const gqlBefore = getCollectedCount();

    if (!before.found) {
      if (everFoundDialog) {
        // Dialog từng load được rồi (đã có comment qua GraphQL), giờ Facebook re-render
        // mất dialog giữa chừng -> dừng lại nhưng GIỮ comment đã thu thập, không huỷ.
        console.log(`    ⚠️ Mất vùng comment dialog giữa chừng (đã có ${gqlBefore} comment qua GraphQL), dừng vòng lặp nhưng giữ lại dữ liệu`);
        return true;
      }
      console.log('    ⚠️ Không tìm thấy vùng comment dialog');
      return false;
    }
    everFoundDialog = true;

    await scrollCommentAreaToBottom(page);
    await page.waitForTimeout(Math.max(1400, config.COMMENT_CLICK_WAIT_MS));

    const clickedComments = await clickAll(page, [
      'text="Xem thêm bình luận"',
      'text="View more comments"',
      'text="Xem các bình luận trước"',
      'text="View previous comments"',
    ], 700);

    const clickedReplies = await clickAll(page, [
      'text="Xem thêm phản hồi"',
      'text="View more replies"',
      'text="Xem phản hồi trước"',
      'text="View previous replies"',
      'text=/Xem tất cả\\s+\\d+\\s+phản hồi/i',
      'text=/View all\\s+\\d+\\s+replies/i',
      'text=/Xem\\s+\\d+\\s+phản hồi/i',
      'text=/View\\s+\\d+\\s+repl(?:y|ies)/i',
    ], 700);

    await expandAllReplies(
      page,
      expectedCommentCount > 0 && expectedCommentCount <= 20 ? 8 : config.COMMENT_REPLY_ROUNDS
    );

    await page.waitForTimeout(clickedComments + clickedReplies > 0 ? config.COMMENT_CLICK_WAIT_MS : 700);

    const after = await getCommentAreaStats(page);
    const gqlAfter = getCollectedCount();

    console.log(
      `    ↳ load step ${step + 1}: articles ${before.commentCount}->${after.commentCount}, gql ${gqlBefore}->${gqlAfter}, buttons ${before.moreButtons}->${after.moreButtons}, height ${before.scrollHeight}->${after.scrollHeight}, clicked ${clickedComments + clickedReplies}`
    );

    const noNewArticles = after.commentCount <= before.commentCount;
    const noNewGraphQL = gqlAfter <= gqlBefore;
    const noHeightGrowth = after.scrollHeight <= before.scrollHeight;
    const noButtonReduction = after.moreButtons >= before.moreButtons;
    const noClicks = clickedComments + clickedReplies === 0;

    if (noNewArticles && noNewGraphQL && noHeightGrowth && noButtonReduction && noClicks) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    if (noNewArticles && noNewGraphQL && noClicks) {
      stagnantDataRounds += 1;
    } else {
      stagnantDataRounds = 0;
    }

    if (noNewGraphQL && clickedComments + clickedReplies > 0 && after.moreButtons === 0) {
      unproductiveClickRounds += 1;
    } else {
      unproductiveClickRounds = 0;
    }

    const nearExpected =
      expectedCommentCount > 0 &&
      Math.max(after.commentCount, gqlAfter) >= Math.max(1, expectedCommentCount - 1);

    if (nearExpected && after.moreButtons === 0) break;
    if (stableRounds >= Math.min(config.COMMENT_STABLE_ROUNDS, 4)) break;
    if (stagnantDataRounds >= config.COMMENT_STABLE_ROUNDS) {
      console.log(`    ↳ dừng sớm: dữ liệu không tăng trong ${stagnantDataRounds} vòng`);
      break;
    }
    if (unproductiveClickRounds >= config.COMMENT_STABLE_ROUNDS) {
      console.log(`    ↳ dừng sớm: click không tạo thêm GraphQL trong ${unproductiveClickRounds} vòng`);
      break;
    }
  }

  for (let i = 0; i < 3; i++) {
    await clickAll(page, [
      'text="View more comments"',
      'text="Xem thêm bình luận"',
      'text="View more replies"',
      'text="Xem thêm phản hồi"',
      'text=/View all\\s+\\d+\\s+replies/i',
      'text=/Xem tất cả\\s+\\d+\\s+phản hồi/i',
      'text=/View\\s+\\d+\\s+repl(?:y|ies)/i',
      'text=/Xem\\s+\\d+\\s+phản hồi/i',
    ], 700);
    await scrollCommentAreaToBottom(page);
    await page.waitForTimeout(900);
  }
  return true;
}

async function scrollComments(page) {
  return page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const scrollables = Array.from(document.querySelectorAll('div, main, section'))
      .filter(el => {
        const style = getComputedStyle(el);
        const canScroll = el.scrollHeight > el.clientHeight + 50;
        return visible(el)
          && canScroll
          && ['auto', 'scroll'].includes(style.overflowY);
      })
      .sort((a, b) => {
        const aDelta = a.scrollHeight - a.clientHeight;
        const bDelta = b.scrollHeight - b.clientHeight;
        return bDelta - aDelta;
      });

    const target = scrollables[0] || document.scrollingElement || document.documentElement;
    const before = target.scrollTop || window.scrollY;
    const amount = Math.max(window.innerHeight * 0.85, 650);

    if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollBy(0, amount);
    } else {
      target.scrollTop += amount;
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    return {
      moved: (target.scrollTop || window.scrollY) - before,
      scrollTop: target.scrollTop || window.scrollY,
      scrollHeight: target.scrollHeight || document.body.scrollHeight,
      clientHeight: target.clientHeight || window.innerHeight,
    };
  });
}

/**
 * Crawl toàn bộ comments của một post
 * @param {object} browser - Playwright browser/context
 * @param {object} post - post object từ Phase 1
 * @returns {object[]} array of comment objects
 */
async function crawlPostComments(browser, post, shouldStop = () => false) {
  if (Number(post.comment || 0) <= 0) {
    return [];
  }

  const page = await browser.newPage();
  let allComments = [];
  let failed = false;

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
      waitUntil: 'commit',
      timeout: config.POST_LOAD_TIMEOUT,
    });
    await page.waitForSelector('body', { timeout: Math.min(config.POST_LOAD_TIMEOUT, 15000) }).catch(() => {});

    await page.waitForTimeout(config.COMMENT_INITIAL_WAIT_MS);

    if (!(await recoverUnavailablePostPage(page, post))) {
      console.log(`    → Post ${post.post_id} vẫn unavailable sau reload, bỏ qua`);
      return [];
    }

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

    if (config.COMMENT_SELECT_ALL) {
      await selectAllComments(page);
      if (await isUnavailablePostPage(page)) {
        console.log(`    ↻ Post ${post.post_id} bị unavailable sau khi chọn All comments, reload và dùng filter mặc định`);
        if (!(await recoverUnavailablePostPage(page, post))) {
          console.log(`    → Post ${post.post_id} vẫn unavailable sau reload All comments, bỏ qua`);
          return [];
        }
      }
    } else {
      console.log('    → Bỏ qua đổi filter All comments để tránh lỗi unavailable');
    }

    const foundCommentArea = await scrollAndLoadAllComments(page, Number(post.comment || 0), () => allComments.length, shouldStop);
    if (!foundCommentArea && Number(post.comment || 0) > 0) {
      failed = true;
    }

    // Chờ lần cuối để bắt hết responses
    await page.waitForTimeout(config.COMMENT_FINAL_WAIT_MS);

  } catch (err) {
    failed = true;
    console.error(`  [ERROR] crawlPostComments (${post.post_id}): ${err.message}`);
  } finally {
    await page.close();
  }

  if (failed) return null;
  return allComments;
}

/**
 * Crawl comments cho danh sách posts cần update
 * @param {object} browser
 * @param {object[]} postsToUpdate - posts cần crawl comment
 * @param {object[]} existingComments - comments đã có (từ lần crawl trước nếu có)
 * @returns {object[]} tất cả comments (mới + cũ merged)
 */
async function crawlComments(browser, postsToUpdate, existingComments = [], options = {}) {
  if (postsToUpdate.length === 0) {
    console.log('\n[Phase 2] Không có post nào cần crawl comment');
    return existingComments;
  }

  const concurrency = Math.max(1, Number(options.concurrency || config.COMMENT_CONCURRENCY || 1));
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
  let completedAttempts = 0;
  let writeQueue = Promise.resolve();
  const crawledPostIds = new Set();
  const failedPostIds = new Set();
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;

  async function maybeReportBatch(post, status) {
    completedAttempts += 1;
    if (typeof options.onBatchProgress !== 'function') return;
    if (completedAttempts % concurrency !== 0 && completedAttempts !== postsToUpdate.length) return;
    const snapshotComments = flattenCommentsMap(commentsByPost);
    await options.onBatchProgress(snapshotComments, post, {
      status,
      completedAttempts,
      totalPosts: postsToUpdate.length,
      concurrency,
      batchNo: Math.ceil(completedAttempts / concurrency),
    });
  }

  async function worker(workerId) {
    while (nextIndex < postsToUpdate.length) {
      if (shouldStop()) {
        console.log(`  [W${workerId}] Nhận tín hiệu dừng, không nhận post mới`);
        break;
      }
      const i = nextIndex++;
      const post = postsToUpdate[i];

      if (typeof options.beforePost === 'function') {
        await options.beforePost(post);
      }

      console.log(`  [${i + 1}/${postsToUpdate.length}] [W${workerId}] Post ${post.post_id} (${post.comment} comments expected)`);

      const newComments = await crawlPostComments(browser, post, shouldStop);
      if (newComments === null) {
        console.log(`    [W${workerId}] Bỏ qua post ${post.post_id} vì lỗi load, chưa đánh dấu crawl xong`);
        failedPostIds.add(String(post.post_id));
        if (typeof options.onPostAttempt === 'function') {
          await options.onPostAttempt(post, 'failed');
        }
        await maybeReportBatch(post, 'failed');
        continue;
      }
      console.log(`    [W${workerId}] → Thu thập được ${newComments.length} comments`);
      crawledPostIds.add(String(post.post_id));
      if (typeof options.onPostAttempt === 'function') {
        await options.onPostAttempt(post, 'done');
      }

      const oldComments = commentsByPost.get(post.post_url) || [];
      if (newComments.length < oldComments.length) {
        console.log(`    [W${workerId}] Giữ bản cũ ${oldComments.length} comments vì retry chỉ lấy ${newComments.length}`);
      } else {
        commentsByPost.set(post.post_url, newComments);
        totalNew += newComments.length;
      }

      if (typeof options.onProgressWrite === 'function') {
        const snapshotComments = flattenCommentsMap(commentsByPost);
        writeQueue = writeQueue
          .catch(() => {})
          .then(() => options.onProgressWrite(snapshotComments, post, newComments));
        await writeQueue;
      }

      await maybeReportBatch(post, 'done');

      if (config.COMMENT_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, config.COMMENT_DELAY_MS));
      }
    }
  }

  const workerCount = Math.min(concurrency, postsToUpdate.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
  await writeQueue.catch(() => {});

  // Gộp tất cả comments lại
  const allComments = flattenCommentsMap(commentsByPost);
  allComments.crawledPostIds = Array.from(crawledPostIds);
  allComments.failedPostIds = Array.from(failedPostIds);

  console.log(`[Phase 2] Hoàn thành. Tổng comments: ${allComments.length} (${totalNew} mới/updated)`);
  return allComments;
}

module.exports = { crawlComments, crawlPostComments };
