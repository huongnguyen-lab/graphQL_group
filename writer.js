'use strict';

const fs   = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const { DATA_DIR, POSTS_DIR, COMMENTS_DIR, GROUPS_DIR } = require('./config');

/**
 * Đảm bảo thư mục output tồn tại
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Lấy groupId từ URL (phần cuối của path)
 * vd: https://www.facebook.com/groups/baohiemprudentialvietnam → baohiemprudentialvietnam
 */
function groupIdFromUrl(groupUrl) {
  try {
    const url = new URL(groupUrl, 'https://www.facebook.com');
    const parts = url.pathname.split('/').filter(Boolean);
    const groupIdx = parts.indexOf('groups');
    if (groupIdx >= 0 && parts[groupIdx + 1]) return parts[groupIdx + 1];
    return parts[parts.length - 1] || 'unknown';
  } catch (_) {
    const clean = groupUrl.split('?')[0].replace(/\/$/, '');
    return clean.split('/').pop();
  }
}

function oneLine(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return value;
  return value
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function oneLineRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = oneLine(value);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'parent_id')) {
    out.parent_id = cleanCommentId(out.parent_id);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'comment_id')) {
    out.comment_id = cleanCommentId(out.comment_id);
  }
  return out;
}

function decodeBase64Id(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^[A-Za-z0-9+/=_-]+$/.test(raw)) return '';

  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function cleanCommentId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return raw;

  const decoded = decodeBase64Id(raw);
  const source = decoded || raw;
  const matches = source.match(/\d+/g);
  return matches && matches.length ? matches[matches.length - 1] : raw;
}

function groupDir(groupUrlOrId) {
  return path.join(DATA_DIR, groupIdFromUrl(groupUrlOrId));
}

function groupCommentsDir(groupUrlOrId) {
  return path.join(groupDir(groupUrlOrId), 'comments');
}

function postIdFromComment(comment) {
  const url = comment.post_url || comment.Post_URL || '';
  const match = String(url).match(/\/posts\/([^/?#]+)/);
  return match ? match[1] : '';
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      value += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      values.push(value);
      value = '';
    } else {
      value += ch;
    }
  }

  values.push(value);
  return values;
}

function parseCsv(text) {
  const rows = [];
  let line = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      line += ch + next;
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      line += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      rows.push(parseCsvLine(line));
      line = '';
    } else {
      line += ch;
    }
  }

  if (line) rows.push(parseCsvLine(line));
  return rows;
}

function csvRowsToObjects(rows) {
  if (rows.length === 0) return [];

  const headers = rows[0].map(h => h.replace(/^\uFEFF/, ''));
  return rows.slice(1)
    .filter(row => row.some(value => value !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] || '';
      });
      return obj;
    });
}

/**
 * Ghi posts ra CSV — ghi đè file cũ mỗi lần chạy
 * @param {string} groupUrl
 * @param {object[]} posts
 * @returns {string} đường dẫn file CSV
 */
async function writePosts(groupUrl, posts) {
  const groupId  = groupIdFromUrl(groupUrl);
  const outputDir = groupDir(groupUrl);
  ensureDir(outputDir);
  const filePath = path.join(outputDir, 'posts.csv');

  if (posts.length === 0) {
    console.log(`  [writer] Không có post nào để ghi cho ${groupId}`);
    return filePath;
  }

  const writer = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'post_id',     title: 'post_id'     },
      { id: 'post_date',   title: 'post_date'   },
      { id: 'content',     title: 'content'     },
      { id: 'group_name',  title: 'group_name'  },
      { id: 'group_url',   title: 'group_url'   },
      { id: 'author_name', title: 'author_name' },
      { id: 'author_url',  title: 'author_url'  },
      { id: 'reaction',    title: 'reaction'    },
      { id: 'share',       title: 'share'       },
      { id: 'comment',     title: 'comment'     },
      { id: 'post_url',    title: 'post_url'    },
      { id: 'image_urls',  title: 'image_urls'  },
      { id: 'video_url',   title: 'video_url'   },
    ],
    // encoding UTF-8 with BOM để Excel mở tiếng Việt không bị lỗi
    encoding: 'utf8',
    append: false,
  });

  // Sắp xếp post mới nhất lên trên để đọc CSV không bị nhảy lộn xộn
  const sortedPosts = [...posts].sort(
    (a, b) => new Date(b.post_date) - new Date(a.post_date)
  ).map(oneLineRecord);

  await writer.writeRecords(sortedPosts);
  console.log(`  [writer] Đã ghi ${posts.length} posts → ${filePath}`);
  return filePath;
}

/**
 * Load comments CSV cũ để giữ comment của những post không cần crawl lại.
 * @param {string} groupUrl
 * @returns {object[]} comments
 */
function loadComments(groupUrl) {
  const groupId  = groupIdFromUrl(groupUrl);
  const filePath = [
    path.join(groupDir(groupUrl), 'comments.csv'),
    path.join(COMMENTS_DIR, `${groupId}_comments.csv`),
    path.join(GROUPS_DIR, `${groupId}_comments.csv`),
  ].find(fp => fs.existsSync(fp));

  if (!filePath) return [];

  try {
    const rows = parseCsv(fs.readFileSync(filePath, 'utf-8'));
    return csvRowsToObjects(rows).map(row => ({
      date:       row.Date || row.date || '',
      comment_id: row.Comment_ID || row.comment_id || '',
      parent_id:  row.Parent_ID || row.parent_id || '',
      level:      row.Level || row.level || '',
      author:     row.Author || row.author || '',
      content:    row.Content || row.content || '',
      permalink:  row.Permalink || row.permalink || '',
      post_url:   row.Post_URL || row.post_url || '',
    })).filter(c => c.comment_id && c.post_url);
  } catch (err) {
    console.warn(`  [writer] Không đọc được comments cũ cho ${groupId}: ${err.message}`);
    return [];
  }
}

function loadPosts(groupUrl) {
  const groupId  = groupIdFromUrl(groupUrl);
  const filePath = [
    path.join(groupDir(groupUrl), 'posts.csv'),
    path.join(POSTS_DIR, `${groupId}_posts.csv`),
    path.join(GROUPS_DIR, `${groupId}_posts.csv`),
  ].find(fp => fs.existsSync(fp));

  if (!filePath) return [];

  try {
    const rows = parseCsv(fs.readFileSync(filePath, 'utf-8'));
    return csvRowsToObjects(rows).map(row => ({
      post_id:     row.post_id || '',
      post_date:   row.post_date || '',
      content:     row.content || '',
      group_name:  row.group_name || '',
      group_url:   row.group_url || '',
      author_name: row.author_name || '',
      author_url:  row.author_url || '',
      reaction:    row.reaction || 0,
      share:       row.share || 0,
      comment:     row.comment || 0,
      post_url:    row.post_url || '',
      image_urls:  row.image_urls || '',
      video_url:   row.video_url || '',
    })).filter(p => p.post_id && p.post_url);
  } catch (err) {
    console.warn(`  [writer] Không đọc được posts cũ cho ${groupId}: ${err.message}`);
    return [];
  }
}

/**
 * Ghi comments ra CSV — ghi đè file cũ mỗi lần chạy
 * @param {string} groupUrl
 * @param {object[]} comments
 * @returns {string} đường dẫn file CSV
 */
async function writeComments(groupUrl, comments) {
  const groupId  = groupIdFromUrl(groupUrl);
  const outputDir = groupDir(groupUrl);
  const perPostDir = groupCommentsDir(groupUrl);
  ensureDir(outputDir);
  ensureDir(perPostDir);
  const filePath = path.join(outputDir, 'comments.csv');

  if (comments.length === 0) {
    console.log(`  [writer] Không có comment nào để ghi cho ${groupId}`);
    return filePath;
  }

  const writer = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'date',       title: 'Date'       },
      { id: 'comment_id', title: 'Comment_ID' },
      { id: 'parent_id',  title: 'Parent_ID'  },
      { id: 'level',      title: 'Level'      },
      { id: 'author',     title: 'Author'     },
      { id: 'content',    title: 'Content'    },
      { id: 'permalink',  title: 'Permalink'  },
      { id: 'post_url',   title: 'Post_URL'   },
    ],
    encoding: 'utf8',
    append: false,
  });

  // Nhóm comment theo từng post, trong mỗi post sắp theo thời gian tăng dần
  // (giúp đọc theo thứ tự trò chuyện, tránh nhảy lộn xộn giữa các post)
  const sortedComments = [...comments].sort((a, b) => {
    if (a.post_url !== b.post_url) return a.post_url < b.post_url ? -1 : 1;
    return new Date(a.date) - new Date(b.date);
  }).map(oneLineRecord);

  await writer.writeRecords(sortedComments);
  const commentsByPost = new Map();
  for (const comment of sortedComments) {
    const postId = postIdFromComment(comment);
    if (!postId) continue;
    if (!commentsByPost.has(postId)) commentsByPost.set(postId, []);
    commentsByPost.get(postId).push(comment);
  }

  await Promise.all([...commentsByPost.entries()].map(async ([postId, postComments]) => {
    const postWriter = createObjectCsvWriter({
      path: path.join(perPostDir, `${postId}.csv`),
      header: [
        { id: 'date',       title: 'Date'       },
        { id: 'comment_id', title: 'Comment_ID' },
        { id: 'parent_id',  title: 'Parent_ID'  },
        { id: 'level',      title: 'Level'      },
        { id: 'author',     title: 'Author'     },
        { id: 'content',    title: 'Content'    },
        { id: 'permalink',  title: 'Permalink'  },
        { id: 'post_url',   title: 'Post_URL'   },
      ],
      encoding: 'utf8',
      append: false,
    });
    await postWriter.writeRecords(postComments);
  }));

  console.log(`  [writer] Đã ghi ${comments.length} comments → ${filePath}`);
  console.log(`  [writer] Đã ghi ${commentsByPost.size} file comment theo post → ${perPostDir}`);
  return filePath;
}

module.exports = {
  writePosts,
  writeComments,
  loadPosts,
  loadComments,
  groupIdFromUrl,
  groupDir,
  groupCommentsDir,
};
