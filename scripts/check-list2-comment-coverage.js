'use strict';
// Đối sánh list 2 (posts_over_500_comments.csv) với dữ liệu comment đã crawl trong data/<group>/comments/<post_id>.csv
const fs = require('fs');
const path = require('path');
const ROOT = __dirname.replace(/\/scripts$/, '');
const { loadPosts } = require(path.join(ROOT, 'writer'));

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadCsvObjects(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter(r => r.length === header.length && r.some(v => v !== ''))
    .map(r => { const o = {}; header.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

const list2Path = path.join(ROOT, 'top20-buzz-groups', '2_posts_over_500_comments.csv');
const list2 = loadCsvObjects(list2Path);

const byGroup = new Map();
for (const p of list2) {
  if (!byGroup.has(p.group_id)) byGroup.set(p.group_id, []);
  byGroup.get(p.group_id).push(p);
}

const results = [];
let totalCrawled = 0;
let totalCommentsCrawledSum = 0;
let totalCommentsTargetSum = 0;

for (const [groupId, posts] of byGroup) {
  const attemptedPath = path.join(ROOT, 'data', groupId, 'phase2-attempted-posts.json');
  let attemptedSet = new Set();
  if (fs.existsSync(attemptedPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(attemptedPath, 'utf8'));
      attemptedSet = new Set(j.post_ids || []);
    } catch (_) {}
  }

  for (const p of posts) {
    const commentFile = path.join(ROOT, 'data', groupId, 'comments', `${p.post_id}.csv`);
    const crawledRows = loadCsvObjects(commentFile);
    const hasFile = crawledRows.length > 0;
    const attempted = attemptedSet.has(p.post_id);
    const targetComments = Number(p.comment) || 0;
    const crawledComments = crawledRows.length;

    const status = hasFile ? 'CRAWLED' : (attempted ? 'ATTEMPTED_NO_DATA' : 'NOT_CRAWLED');
    if (hasFile) {
      totalCrawled++;
      totalCommentsCrawledSum += crawledComments;
      totalCommentsTargetSum += targetComments;
    }

    results.push({
      group_id: groupId,
      post_id: p.post_id,
      group_name: p.group_name,
      target_comments: targetComments,
      crawled_comments: crawledComments,
      status,
    });
  }
}

// In theo group
console.log('=== Theo group ===');
console.log('Group ID'.padEnd(25), 'Posts'.padEnd(7), 'Crawled'.padEnd(9), 'Not crawled'.padEnd(12), '%');
const byGroupStat = new Map();
for (const r of results) {
  if (!byGroupStat.has(r.group_id)) byGroupStat.set(r.group_id, { total: 0, crawled: 0 });
  const s = byGroupStat.get(r.group_id);
  s.total++;
  if (r.status === 'CRAWLED') s.crawled++;
}
for (const [g, s] of [...byGroupStat.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(
    g.padEnd(25),
    String(s.total).padEnd(7),
    String(s.crawled).padEnd(9),
    String(s.total - s.crawled).padEnd(12),
    (s.crawled / s.total * 100).toFixed(1) + '%'
  );
}

console.log('\n=== Tổng ===');
console.log('Tổng số post trong list 2:', list2.length);
console.log('Đã crawl comment:', totalCrawled);
console.log('Chưa crawl:', list2.length - totalCrawled);
console.log('Tỉ lệ đã crawl:', (totalCrawled / list2.length * 100).toFixed(2) + '%');

// Chưa crawl - liệt kê ra file để dùng lại cho việc crawl tiếp
const notCrawled = results.filter(r => r.status !== 'CRAWLED');
const outPath = path.join(ROOT, 'top20-buzz-groups', '2_posts_over_500_comments_not_crawled.json');
fs.writeFileSync(outPath, JSON.stringify(notCrawled, null, 2));
console.log('\nDa ghi danh sach chua crawl ->', outPath);

const detailPath = path.join(ROOT, 'top20-buzz-groups', '2_posts_over_500_comments_crawl_status.json');
fs.writeFileSync(detailPath, JSON.stringify(results, null, 2));
console.log('Da ghi chi tiet trang thai ->', detailPath);
