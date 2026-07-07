'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const { launchBrowser } = require('./phase1-feed');
const { crawlComments } = require('./phase2-comments');
const { loadPosts, loadComments, writeComments, groupIdFromUrl } = require('./writer');

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
  const filePath = path.join(config.DATA_DIR, 'phase2-progress.json');
  const payload = {
    updated_at: new Date().toISOString(),
    total_groups: (config.ALL_GROUP_URLS || config.GROUP_URLS).length,
    done_groups: results.filter(r => r.status === 'done' || r.status === 'partial' || r.status === 'already_ran' || r.status === 'error' || r.status === 'skipped').length,
    active,
    results,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const buffer = fs.readFileSync(filePath);
    let text = buffer.toString('utf8');
    if (text.includes('\u0000')) text = buffer.toString('utf16le');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function ranGroupsPath() {
  return path.join(config.DATA_DIR, 'phase2-ran-groups.json');
}

function loadRanGroups() {
  const payload = readJson(ranGroupsPath(), { groups: [] });
  return new Set(payload.groups || []);
}

function saveRanGroups(ranGroups) {
  writeJson(ranGroupsPath(), {
    updated_at: new Date().toISOString(),
    groups: [...ranGroups].sort(),
  });
}

function rebuildAllComments() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'build-all-comments.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      SKIP_ALL_COMMENTS_BACKUP: '1',
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    console.warn(`[Phase 2] WARN rebuild all_comments.csv failed: ${message}`);
    return false;
  }

  const message = (result.stdout || '').trim();
  if (message) console.log(`[Phase 2] ${message}`);
  return true;
}

function attemptedPostsPath(groupUrl) {
  return path.join(config.DATA_DIR, groupIdFromUrl(groupUrl), 'phase2-attempted-posts.json');
}

function loadAttemptedPosts(groupUrl) {
  const payload = readJson(attemptedPostsPath(groupUrl), { post_ids: [] });
  return new Set(payload.post_ids || []);
}

function saveAttemptedPosts(groupUrl, attemptedPosts) {
  writeJson(attemptedPostsPath(groupUrl), {
    updated_at: new Date().toISOString(),
    post_ids: [...attemptedPosts].sort(),
  });
}

function countCsvRows(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const lines = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean).length;
    return Math.max(0, lines - 1);
  } catch (_) {
    return 0;
  }
}

function crawlProgressLogPath() {
  return path.join(config.DATA_DIR, 'phase2-crawl-progress-log.csv');
}

function crawlProgressStatePath() {
  return path.join(config.DATA_DIR, 'phase2-crawl-progress-state.json');
}

function appendCrawlProgressLog(result, post, batchInfo = {}) {
  ensureDir(config.DATA_DIR);

  const logPath = crawlProgressLogPath();
  const statePath = crawlProgressStatePath();
  const state = readJson(statePath, {
    all_comments_rows: countCsvRows(path.join(__dirname, 'all_comments.csv')),
    group_comments: {},
  });

  const allCommentsRows = countCsvRows(path.join(__dirname, 'all_comments.csv'));
  const previousAllRows = Number(state.all_comments_rows || 0);
  const allCommentsDelta = allCommentsRows - previousAllRows;
  const hasPreviousGroupRows = Object.prototype.hasOwnProperty.call(state.group_comments || {}, result.groupId);
  const previousGroupRows = hasPreviousGroupRows
    ? Number((state.group_comments || {})[result.groupId] || 0)
    : Number(result.comments || 0);
  const groupCommentsDelta = Number(result.comments || 0) - previousGroupRows;
  const concurrency = Math.max(1, Number(config.COMMENT_CONCURRENCY || 1));
  const completedAttempts = Number(batchInfo.completedAttempts || result.currentPostIndex || 0);
  const batchNo = Number(batchInfo.batchNo || Math.ceil(completedAttempts / concurrency));
  const latestFile = result.filePath || path.join(config.DATA_DIR, result.groupId, 'comments.csv');

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, [
      'timestamp',
      'all_comments_rows',
      'all_comments_delta',
      'active_group',
      'group_comments',
      'group_comments_delta',
      'comment_concurrency',
      'batch_no',
      'completed_attempts_in_group',
      'candidate_posts',
      'missing_posts',
      'underfilled_posts',
      'last_attempt_status',
      'current_post_id',
      'latest_file',
    ].join(',') + '\n', 'utf8');
  }

  fs.appendFileSync(logPath, [
    csvEscape(new Date().toISOString()),
    allCommentsRows,
    allCommentsDelta,
    csvEscape(result.groupId),
    Number(result.comments || 0),
    groupCommentsDelta,
    concurrency,
    batchNo,
    completedAttempts,
    Number(result.candidates || 0),
    Number(result.missing_posts || 0),
    Number(result.underfilled_posts || 0),
    csvEscape(String(batchInfo.status || '')),
    csvEscape(String((post && post.post_id) || result.currentPostId || '')),
    csvEscape(latestFile),
  ].join(',') + '\n', 'utf8');

  state.all_comments_rows = allCommentsRows;
  state.group_comments = {
    ...(state.group_comments || {}),
    [result.groupId]: Number(result.comments || 0),
  };
  state.updated_at = new Date().toISOString();
  writeJson(statePath, state);
}

function activeGroupIds(results) {
  return results
    .filter(r => r.status === 'running')
    .map(r => r.groupId);
}

function countCommentsByPost(comments) {
  const counts = new Map();
  for (const comment of comments) {
    if (!comment.post_url) continue;
    counts.set(comment.post_url, (counts.get(comment.post_url) || 0) + 1);
  }
  return counts;
}

function auditPostCoverage(posts, comments) {
  const counts = countCommentsByPost(comments);
  const postsWithCounter = posts.filter(post => Number(post.comment || 0) > 0);
  const expectedComments = postsWithCounter.reduce((sum, post) => sum + Number(post.comment || 0), 0);
  const missingPosts = postsWithCounter.filter(post => (counts.get(post.post_url) || 0) === 0);
  const underfilledPosts = postsWithCounter.filter(post => {
    const expected = Number(post.comment || 0);
    const collected = counts.get(post.post_url) || 0;
    return collected > 0 && collected < expected;
  });

  return {
    postsWithCounter,
    expectedComments,
    missingPosts,
    underfilledPosts,
    collectedPostCount: postsWithCounter.length - missingPosts.length,
  };
}

function pickPostsToCrawl(posts, comments, attemptedPosts = new Set()) {
  const audit = auditPostCoverage(posts, comments);
  let candidates = config.FORCE_COMMENT_CRAWL
    ? audit.missingPosts
    : audit.missingPosts.filter(post => !attemptedPosts.has(String(post.post_id)));

  if (config.COMMENT_POST_IDS && config.COMMENT_POST_IDS.length > 0) {
    const wanted = new Set(config.COMMENT_POST_IDS.map(String));
    candidates = candidates.filter(post => wanted.has(String(post.post_id)));
  }

  if (config.COMMENT_POST_LIMIT > 0) {
    candidates = candidates.slice(0, config.COMMENT_POST_LIMIT);
  }

  return { audit, candidates };
}

function targetGroupIds() {
  return new Set((process.env.PHASE2_GROUP_IDS || '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean));
}

function filterTargetGroupUrls(groupUrls) {
  const targets = targetGroupIds();
  if (targets.size === 0) return groupUrls;
  return groupUrls.filter(groupUrl => targets.has(groupIdFromUrl(groupUrl)));
}

async function processGroup(browser, groupUrl, results) {
  const groupId = groupIdFromUrl(groupUrl);
  const posts = loadPosts(groupUrl);
  const result = {
    groupId,
    groupUrl,
    status: 'running',
    posts: posts.length,
    candidates: 0,
    attempted: 0,
    missing_posts: 0,
    underfilled_posts: 0,
    expected_comments: 0,
    collected_post_count: 0,
    comments: 0,
    currentPostId: '',
    currentPostIndex: 0,
    started_at: new Date().toISOString(),
    finished_at: '',
    filePath: '',
    error: '',
  };
  results.push(result);
  writeProgress(results, activeGroupIds(results));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`GROUP: ${groupId} (phase 2 all comments)`);
  console.log('='.repeat(60));
  console.log(`[Phase 2] Loaded ${posts.length} posts`);

  if (posts.length === 0) {
    result.status = 'skipped';
    result.finished_at = new Date().toISOString();
    writeProgress(results, activeGroupIds(results));
    console.log(`[Phase 2] Skip ${groupId}: no posts.csv data`);
    return;
  }

  try {
    const existingComments = loadComments(groupUrl);
    const attemptedPosts = loadAttemptedPosts(groupUrl);
    result.comments = existingComments.length;
    console.log(`[Phase 2] Loaded ${existingComments.length} existing comments`);
    console.log(`[Phase 2] Loaded ${attemptedPosts.size} attempted posts`);

    const { audit, candidates } = pickPostsToCrawl(posts, existingComments, attemptedPosts);
    result.candidates = candidates.length;
    result.missing_posts = audit.missingPosts.length;
    result.underfilled_posts = audit.underfilledPosts.length;
    result.expected_comments = audit.expectedComments;
    result.collected_post_count = audit.collectedPostCount;
    writeProgress(results, activeGroupIds(results));

    if (candidates.length === 0) {
      result.filePath = await writeComments(groupUrl, existingComments);
      result.status = result.underfilled_posts === 0 ? 'done' : 'partial';
      result.finished_at = new Date().toISOString();
      writeProgress(results, activeGroupIds(results));
      console.log(`[Phase 2] ${result.status} ${groupId}: no missing posts, underfilled=${result.underfilled_posts}`);
      return;
    }

    console.log(`[Phase 2] Crawl ${candidates.length}/${audit.postsWithCounter.length} missing posts first`);

    const allComments = await crawlComments(browser, candidates, existingComments, {
      onPostAttempt: async (post) => {
        attemptedPosts.add(String(post.post_id || ''));
        saveAttemptedPosts(groupUrl, attemptedPosts);
      },
      onProgressWrite: async (comments, post) => {
        result.currentPostId = String(post.post_id || '');
        result.currentPostIndex += 1;
        result.attempted = result.currentPostIndex;
        result.comments = comments.length;
        result.filePath = await writeComments(groupUrl, comments);
        rebuildAllComments();
        const progressAudit = auditPostCoverage(posts, comments);
        result.missing_posts = progressAudit.missingPosts.length;
        result.underfilled_posts = progressAudit.underfilledPosts.length;
        result.collected_post_count = progressAudit.collectedPostCount;
        writeProgress(results, activeGroupIds(results));
      },
      onBatchProgress: async (comments, post, batchInfo) => {
        result.comments = comments.length;
        result.attempted = Number(batchInfo.completedAttempts || result.attempted || 0);
        result.currentPostIndex = Number(batchInfo.completedAttempts || result.currentPostIndex || 0);
        result.currentPostId = String((post && post.post_id) || result.currentPostId || '');
        result.filePath = result.filePath || path.join(config.DATA_DIR, groupId, 'comments.csv');
        const progressAudit = auditPostCoverage(posts, comments);
        result.missing_posts = progressAudit.missingPosts.length;
        result.underfilled_posts = progressAudit.underfilledPosts.length;
        result.collected_post_count = progressAudit.collectedPostCount;
        writeProgress(results, activeGroupIds(results));
        appendCrawlProgressLog(result, post, batchInfo);
      },
    });

    result.comments = allComments.length;
    result.filePath = await writeComments(groupUrl, allComments);
    rebuildAllComments();
    const finalAudit = auditPostCoverage(posts, allComments);
    result.missing_posts = finalAudit.missingPosts.length;
    result.underfilled_posts = finalAudit.underfilledPosts.length;
    result.expected_comments = finalAudit.expectedComments;
    result.collected_post_count = finalAudit.collectedPostCount;
    result.status = result.missing_posts === 0 && result.underfilled_posts === 0 ? 'done' : 'partial';
    result.finished_at = new Date().toISOString();
    writeProgress(results, activeGroupIds(results));
    console.log(`[Phase 2] ${result.status} ${groupId}: ${allComments.length} comments, missing=${result.missing_posts}, underfilled=${result.underfilled_posts}`);
  } catch (err) {
    result.status = 'error';
    result.error = err && err.stack ? err.stack : String(err);
    result.finished_at = new Date().toISOString();
    writeProgress(results, activeGroupIds(results));
    console.error(`[Phase 2] ERROR ${groupId}: ${err.message}`);
  }
}

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeMissingPostsReport(groupUrls) {
  const rows = [[
    'group_id',
    'post_id',
    'post_date',
    'expected_comments',
    'collected_comments',
    'attempted',
    'status',
    'post_url',
    'content',
  ]];

  for (const groupUrl of groupUrls) {
    const groupId = groupIdFromUrl(groupUrl);
    const posts = loadPosts(groupUrl);
    const comments = loadComments(groupUrl);
    const attemptedPosts = loadAttemptedPosts(groupUrl);
    const counts = countCommentsByPost(comments);
    const audit = auditPostCoverage(posts, comments);
    const missing = [...audit.missingPosts, ...audit.underfilledPosts];

    for (const post of missing) {
      const collected = counts.get(post.post_url) || 0;
      rows.push([
        groupId,
        post.post_id,
        post.post_date,
        post.comment,
        collected,
        attemptedPosts.has(String(post.post_id)) ? '1' : '0',
        collected === 0 ? 'missing' : 'underfilled',
        post.post_url,
        post.content,
      ]);
    }
  }

  const filePath = path.join(config.DATA_DIR, 'phase2-missing-posts.csv');
  fs.writeFileSync(filePath, '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n', 'utf8');
  return { filePath, rows: rows.length - 1 };
}

async function main() {
  const start = Date.now();
  const results = [];
  const groupUrls = filterTargetGroupUrls([...(config.ALL_GROUP_URLS || config.GROUP_URLS)]);
  const ranGroups = loadRanGroups();
  const groupConcurrency = Math.max(1, Number(process.env.PHASE2_GROUP_CONCURRENCY || 1));
  let browser;

  console.log('FB Group Crawler - PHASE 2 ALL GROUPS');
  console.log(`Groups: ${groupUrls.length}`);
  console.log(`Group concurrency: ${groupConcurrency}`);
  console.log(`Comment concurrency: ${config.COMMENT_CONCURRENCY}`);
  console.log(`Max comment pages: ${config.MAX_COMMENT_PAGES}`);

  try {
    browser = await launchBrowser();

    let nextGroupIndex = 0;
    async function runGroupWorker() {
      while (true) {
        const groupUrl = groupUrls[nextGroupIndex++];
        if (!groupUrl) return;

        const groupId = groupIdFromUrl(groupUrl);
        if (ranGroups.has(groupId) && process.env.PHASE2_FORCE_RERUN !== '1') {
          const posts = loadPosts(groupUrl);
          const comments = loadComments(groupUrl);
          const audit = auditPostCoverage(posts, comments);
          results.push({
            groupId,
            groupUrl,
            status: 'already_ran',
            posts: posts.length,
            candidates: 0,
            attempted: loadAttemptedPosts(groupUrl).size,
            missing_posts: audit.missingPosts.length,
            underfilled_posts: audit.underfilledPosts.length,
            expected_comments: audit.expectedComments,
            collected_post_count: audit.collectedPostCount,
            comments: comments.length,
            currentPostId: '',
            currentPostIndex: 0,
            started_at: '',
            finished_at: new Date().toISOString(),
            filePath: '',
            error: '',
          });
          writeProgress(results, activeGroupIds(results));
          console.log(`[Phase 2] Skip already ran group ${groupId}`);
          continue;
        }

        await processGroup(browser, groupUrl, results);
        ranGroups.add(groupId);
        saveRanGroups(ranGroups);
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(groupConcurrency, groupUrls.length) },
      () => runGroupWorker()
    ));

    const missingReport = writeMissingPostsReport(groupUrls);
    console.log(`[Phase 2] Missing posts report: ${missingReport.rows} rows -> ${missingReport.filePath}`);
  } catch (err) {
    console.error('\n[FATAL ERROR]', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    writeProgress(results, activeGroupIds(results));
    const minutes = ((Date.now() - start) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PHASE 2 ALL DONE in ${minutes} minutes`);
    for (const r of results) {
      console.log(`${r.groupId}: ${r.status}, posts=${r.posts}, comments=${r.comments}`);
    }
    console.log('='.repeat(60));
  }
}

main();
