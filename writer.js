'use strict';

const fs   = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const { GROUPS_DIR } = require('./config');

/**
 * Đảm bảo thư mục output tồn tại
 */
function ensureDir() {
  if (!fs.existsSync(GROUPS_DIR)) {
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
  }
}

/**
 * Lấy groupId từ URL (phần cuối của path)
 * vd: https://www.facebook.com/groups/baohiemprudentialvietnam → baohiemprudentialvietnam
 */
function groupIdFromUrl(groupUrl) {
  const clean = groupUrl.replace(/\/$/, '');
  return clean.split('/').pop();
}

/**
 * Ghi posts ra CSV — ghi đè file cũ mỗi lần chạy
 * @param {string} groupUrl
 * @param {object[]} posts
 * @returns {string} đường dẫn file CSV
 */
async function writePosts(groupUrl, posts) {
  ensureDir();
  const groupId  = groupIdFromUrl(groupUrl);
  const filePath = path.join(GROUPS_DIR, `${groupId}_posts.csv`);

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

  await writer.writeRecords(posts);
  console.log(`  [writer] Đã ghi ${posts.length} posts → ${filePath}`);
  return filePath;
}

/**
 * Ghi comments ra CSV — ghi đè file cũ mỗi lần chạy
 * @param {string} groupUrl
 * @param {object[]} comments
 * @returns {string} đường dẫn file CSV
 */
async function writeComments(groupUrl, comments) {
  ensureDir();
  const groupId  = groupIdFromUrl(groupUrl);
  const filePath = path.join(GROUPS_DIR, `${groupId}_comments.csv`);

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

  await writer.writeRecords(comments);
  console.log(`  [writer] Đã ghi ${comments.length} comments → ${filePath}`);
  return filePath;
}

module.exports = { writePosts, writeComments, groupIdFromUrl };
