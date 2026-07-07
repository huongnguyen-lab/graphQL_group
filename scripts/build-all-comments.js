'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const OUTPUT_FILE = path.join(ROOT_DIR, 'all_comments.csv');

const HEADER = [
  'group_id',
  'Date',
  'Comment_ID',
  'Parent_ID',
  'Level',
  'Author',
  'Content',
  'Permalink',
  'Post_URL',
];

const EXCLUDED_GROUP_IDS = new Set([
  'baohiemprudentialvietnam',
  'hoireviewbaohiem',
  'tuvanbaohiemnhanthovn',
]);

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

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function csvRowsToObjects(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map(header => header.replace(/^\uFEFF/, ''));

  return rows.slice(1)
    .filter(row => row.some(value => value !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });
}

function readCommentsFile(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  return csvRowsToObjects(rows);
}

function commentRow(groupId, comment) {
  return [
    groupId,
    comment.Date || comment.date || '',
    comment.Comment_ID || comment.comment_id || '',
    comment.Parent_ID || comment.parent_id || '',
    comment.Level || comment.level || '',
    comment.Author || comment.author || '',
    comment.Content || comment.content || '',
    comment.Permalink || comment.permalink || '',
    comment.Post_URL || comment.post_url || '',
  ];
}

function rowKey(row) {
  const groupId = row[0] || '';
  const commentId = row[2] || '';
  const postUrl = row[8] || '';
  if (groupId || commentId || postUrl) return [groupId, commentId, postUrl].join('\u001f');
  return row.join('\u001f');
}

function addRow(rows, seen, row) {
  const key = rowKey(row);
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

function main() {
  const rows = [HEADER];
  const seen = new Set();

  if (fs.existsSync(OUTPUT_FILE) && process.env.FULL_REBUILD_ALL_COMMENTS !== '1') {
    const existingRows = parseCsv(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    for (const row of existingRows.slice(1)) {
      if (!row.some(value => value !== '')) continue;
      addRow(rows, seen, row);
    }
  }

  const groupDirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  let groupCount = 0;
  for (const groupId of groupDirs) {
    if (EXCLUDED_GROUP_IDS.has(groupId)) continue;

    const commentsFile = path.join(DATA_DIR, groupId, 'comments.csv');
    if (!fs.existsSync(commentsFile)) continue;

    const comments = readCommentsFile(commentsFile);
    if (comments.length === 0) continue;

    groupCount++;
    for (const comment of comments) {
      addRow(rows, seen, commentRow(groupId, comment));
    }
  }

  if (fs.existsSync(OUTPUT_FILE) && process.env.SKIP_ALL_COMMENTS_BACKUP !== '1') {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(OUTPUT_FILE, path.join(ROOT_DIR, `all_comments.backup-${stamp}.csv`));
  }

  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  fs.writeFileSync(OUTPUT_FILE, csv, 'utf8');
  console.log(`Wrote ${rows.length - 1} comments from ${groupCount} groups -> ${OUTPUT_FILE}`);
}

main();
