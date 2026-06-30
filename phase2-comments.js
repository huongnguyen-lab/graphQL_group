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
      const node = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'))
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
      const opener = page.locator([
        'div[role="button"]:has-text("Most relevant")',
        'div[role="button"]:has-text("Newest")',
        'div[role="button"]:has-text("Phù hợp nhất")',
        'div[role="button"]:has-text("Mới nhất")',
        'span[role="button"]:has-text("Most relevant")',
        'span[role="button"]:has-text("Newest")',
        'span[role="button"]:has-text("Phù hợp nhất")',
        'span[role="button"]:has-text("Mới nhất")',
      ].join(', ')).first();

      if (await opener.isVisible().catch(() => false)) {
        await opener.scrollIntoViewIfNeeded().catch(() => {});
        await opener.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(Math.max(1200, config.COMMENT_CLICK_WAIT_MS));
      } else {
        await page.mouse.wheel(0, 450);
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

        await button.click({ force: true, timeout: 3000 });
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

    const findFallbackRoot = () =>
      Array.from(document.querySelectorAll('div, main, section'))
        .filter(el => {
          const style = getComputedStyle(el);
          return visible(el)
            && el.scrollHeight > el.clientHeight + 50
            && el.clientHeight > 100
            && ['auto', 'scroll'].includes(style.overflowY);
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      || document.scrollingElement
      || document.documentElement;

    const dialog = document.querySelector('div[role="dialog"]:not([aria-label])');
    const firstDivContainsHtmlDiv = dialog ? findFirstDivContainingHtmlDiv(dialog) : null;
    const dialogRoot = firstDivContainsHtmlDiv ? getDivChildren(firstDivContainsHtmlDiv)[1] || null : null;
    const root = dialogRoot || findFallbackRoot();
    const scope = dialogRoot && dialog ? dialog : root || document;

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

    const findFallbackRoot = () =>
      Array.from(document.querySelectorAll('div, main, section'))
        .filter(el => {
          const style = getComputedStyle(el);
          return visible(el)
            && el.scrollHeight > el.clientHeight + 50
            && el.clientHeight > 100
            && ['auto', 'scroll'].includes(style.overflowY);
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      || document.scrollingElement
      || document.documentElement;

    const dialog = document.querySelector('div[role="dialog"]:not([aria-label])');
    const firstDivContainsHtmlDiv = dialog ? findFirstDivContainingHtmlDiv(dialog) : null;
    const root = firstDivContainsHtmlDiv
      ? getDivChildren(firstDivContainsHtmlDiv)[1] || findFallbackRoot()
      : findFallbackRoot();

    const before = root.scrollTop || window.scrollY;
    root.scrollBy(0, 2500);
    root.scrollBy(0, 2500);
    root.scrollTo(0, root.scrollHeight);
    root.dispatchEvent(new Event('scroll', { bubbles: true }));

    return {
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

async function scrollAndLoadAllComments(page, expectedCommentCount = 0, getCollectedCount = () => 0) {
  let stableRounds = 0;
  let stagnantDataRounds = 0;
  let unproductiveClickRounds = 0;
  const maxSteps =
    expectedCommentCount > 0 && expectedCommentCount <= 20
      ? Math.max(24, config.MAX_COMMENT_PAGES)
      : Math.max(48, config.MAX_COMMENT_PAGES);

  for (let step = 0; step < maxSteps; step++) {
    const before = await getCommentAreaStats(page);
    const gqlBefore = getCollectedCount();

    if (!before.found) {
      console.log('    ⚠️ Không tìm thấy vùng comment dialog');
      break;
    }

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

    await scrollAndLoadAllComments(page, Number(post.comment || 0), () => allComments.length);

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
async function crawlComments(browser, postsToUpdate, existingComments = [], options = {}) {
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
  let writeQueue = Promise.resolve();

  async function worker(workerId) {
    while (nextIndex < postsToUpdate.length) {
      const i = nextIndex++;
      const post = postsToUpdate[i];
      console.log(`  [${i + 1}/${postsToUpdate.length}] [W${workerId}] Post ${post.post_id} (${post.comment} comments expected)`);

      const newComments = await crawlPostComments(browser, post);
      console.log(`    [W${workerId}] → Thu thập được ${newComments.length} comments`);

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

  console.log(`[Phase 2] Hoàn thành. Tổng comments: ${allComments.length} (${totalNew} mới/updated)`);
  return allComments;
}

module.exports = { crawlComments, crawlPostComments };
