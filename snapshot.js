'use strict';

const fs   = require('fs');
const path = require('path');
const { SNAPSHOTS_DIR } = require('./config');

/**
 * Tên file snapshot cho một group
 */
function snapshotPath(groupId) {
  return path.join(SNAPSHOTS_DIR, `${groupId}_snapshot.json`);
}

/**
 * Load snapshot cũ của group
 * Returns Map<postId, {reaction, share, comment, last_crawled}>
 */
function loadSnapshot(groupId) {
  const fp = snapshotPath(groupId);
  if (!fs.existsSync(fp)) return new Map();
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (_) {
    return new Map();
  }
}

/**
 * Save snapshot mới cho group
 * @param {string} groupId
 * @param {Map<string, object>} snapshotMap
 */
function saveSnapshot(groupId, snapshotMap) {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
  const obj = {};
  for (const [k, v] of snapshotMap.entries()) {
    obj[k] = v;
  }
  fs.writeFileSync(snapshotPath(groupId), JSON.stringify(obj, null, 2));
}

/**
 * So sánh post mới với snapshot cũ để xác định có cần crawl comment không
 * @param {object} post - post object mới vừa crawl từ feed
 * @param {Map} oldSnapshot
 * @returns {boolean} true nếu cần crawl/re-crawl comment
 */
function needsCommentCrawl(post, oldSnapshot) {
  const old = oldSnapshot.get(post.post_id);
  if (!old) return true; // post mới, chưa có trong snapshot
  if (!old.comments_crawled) return true; // snapshot cũ/chưa xác nhận crawl comment xong

  // So sánh comment count
  if (Number(post.comment) !== Number(old.comment)) return true;
  // So sánh reaction count (optional — comment count là chỉ số chính)
  if (Number(post.reaction) !== Number(old.reaction)) return true;
  // So sánh share count
  if (Number(post.share) !== Number(old.share)) return true;

  return false;
}

/**
 * Update snapshot với data mới nhất của các posts
 * @param {string} groupId
 * @param {object[]} posts
 * @param {Map} existingSnapshot
 * @returns {Map} updated snapshot
 */
function updateSnapshot(groupId, posts, existingSnapshot) {
  const updated = new Map(existingSnapshot);
  const now = new Date().toISOString();

  for (const post of posts) {
    updated.set(post.post_id, {
      reaction:     post.reaction,
      share:        post.share,
      comment:      post.comment,
      comments_crawled: true,
      last_crawled: now,
    });
  }

  saveSnapshot(groupId, updated);
  return updated;
}

module.exports = {
  loadSnapshot,
  saveSnapshot,
  updateSnapshot,
  needsCommentCrawl,
};
