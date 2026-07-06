'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { crawlGroupFeed, launchBrowser } = require('./phase1-feed');
const { mergePosts } = require('./phase1-feed');
const { writePosts, loadPosts, groupIdFromUrl } = require('./writer');

process.stdout.on('error', err => {
  if (err.code !== 'EPIPE') throw err;
});
process.stderr.on('error', err => {
  if (err.code !== 'EPIPE') throw err;
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeProgress(results, active = []) {
  ensureDir(config.DATA_DIR);
  const filePath = path.join(config.DATA_DIR, 'phase1-progress.json');
  const payload = {
    updated_at: new Date().toISOString(),
    date_from: config.DATE_FROM.toISOString(),
    date_to: config.DATE_TO.toISOString(),
    total_groups: config.GROUP_URLS.length,
    done_groups: results.filter(r => r.status === 'done' || r.status === 'error').length,
    active,
    results,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function activeGroupIds(results) {
  return results
    .filter(r => r.status === 'running')
    .map(r => r.groupId);
}

async function processGroup(browser, groupUrl, results) {
  const groupId = groupIdFromUrl(groupUrl);
  let savedPosts = loadPosts(groupUrl);
  const oldestSavedPostDate = () => savedPosts
    .map(p => p.post_date)
    .filter(Boolean)
    .sort()[0] || '';
  const result = {
    groupId,
    groupUrl,
    status: 'running',
    posts: savedPosts.length,
    scrollCount: 0,
    oldestPostDate: oldestSavedPostDate(),
    scrollsWithoutNewPosts: 0,
    started_at: new Date().toISOString(),
    finished_at: '',
    filePath: '',
    error: '',
  };
  results.push(result);
  writeProgress(results, activeGroupIds(results));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`GROUP: ${groupId} (phase 1 only)`);
  console.log('='.repeat(60));

  try {
    let lastSavedCount = -1;
    const posts = await crawlGroupFeed(browser, groupUrl, {
      dateFrom: config.DATE_FROM,
      dateTo: config.DATE_TO,
      onProgressPosts: async (partialPosts) => {
        savedPosts = mergePosts(savedPosts, partialPosts);
        if (savedPosts.length === lastSavedCount) return;
        lastSavedCount = savedPosts.length;
        result.posts = savedPosts.length;
        result.oldestPostDate = oldestSavedPostDate();
        result.filePath = await writePosts(groupUrl, savedPosts);
        writeProgress(results, activeGroupIds(results));
      },
      onProgressScroll: async (state) => {
        result.scrollCount = state.scrollCount;
        result.oldestPostDate = state.oldestPostDate;
        result.scrollsWithoutNewPosts = state.scrollsWithoutNewPosts;
        writeProgress(results, activeGroupIds(results));
      },
    });

    savedPosts = mergePosts(savedPosts, posts);
    result.posts = savedPosts.length;
    result.oldestPostDate = oldestSavedPostDate();
    result.filePath = await writePosts(groupUrl, savedPosts);
    result.status = 'done';
    result.finished_at = new Date().toISOString();
    writeProgress(results, activeGroupIds(results));
    console.log(`\n[Phase 1] Ket qua ${groupId}: ${posts.length} posts trong date range`);
  } catch (err) {
    result.status = 'error';
    result.error = err && err.stack ? err.stack : String(err);
    result.finished_at = new Date().toISOString();
    writeProgress(results, activeGroupIds(results));
    console.error(`[Phase 1] ERROR ${groupId}: ${err.message}`);
  }
}

async function main() {
  const start = Date.now();
  const results = [];
  let browser;

  console.log('FB Group Crawler - PHASE 1 ONLY');
  console.log(`DATE_FROM : ${config.DATE_FROM.toISOString()}`);
  console.log(`DATE_TO   : ${config.DATE_TO.toISOString()}`);
  console.log(`Groups    : ${config.GROUP_URLS.length}`);
  console.log(`Concurrency: ${config.PAGE_CONCURRENCY}`);
  console.log(`SCROLL_MAX_ATTEMPTS: ${config.SCROLL_MAX_ATTEMPTS}`);
  console.log(`STOP_AFTER_OLD_POSTS: ${config.STOP_AFTER_OLD_POSTS}`);
  console.log(`STOP_AFTER_NO_NEW_SCROLLS: ${config.STOP_AFTER_NO_NEW_SCROLLS}`);

  try {
    browser = await launchBrowser();
    const queue = [...config.GROUP_URLS];
    const workers = Array.from(
      { length: Math.max(1, config.PAGE_CONCURRENCY) },
      async () => {
        while (queue.length > 0) {
          const groupUrl = queue.shift();
          if (groupUrl) await processGroup(browser, groupUrl, results);
        }
      }
    );
    await Promise.all(workers);
  } catch (err) {
    console.error('\n[FATAL ERROR]', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    writeProgress(results);

    const minutes = ((Date.now() - start) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PHASE 1 DONE in ${minutes} minutes`);
    for (const r of results) {
      console.log(`${r.groupId}: ${r.status}, ${r.posts} posts`);
    }
    console.log('='.repeat(60));
  }
}

main();
