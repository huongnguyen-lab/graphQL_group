'use strict';
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const ROOT = '/Users/huongquadeo/Desktop/GraphQL Group/fb-group-crawler';
const { loadPosts } = require(path.join(ROOT, 'writer'));

const TOP20_GROUP_IDS = [
  '183774529022936',
  '6183167068463220',
  '402671786045954',
  '184019427900518',
  '804858320013004',
  'nuoiconbangsuacongthu',
  'riviesuacongthuc',
  '939853694105892',
  'reviewsuacongthuc',
  '355902270087463',
  '114293632527877',
  '2523848674591558',
  'nuoiconkhongxichoet',
  'hoiriviewsua',
  'reviewsuact',
  '414397087816841',
  '7678734688837445',
  '1710547889070752',
  '530571622962102',
  '912404789814271',
];

const OUT_DIR = path.join(ROOT, 'top20-buzz-groups');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const HEADER = [
  { id: 'group_id',    title: 'group_id'    },
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
];

async function writeCsv(filePath, records) {
  const writer = createObjectCsvWriter({ path: filePath, header: HEADER, encoding: 'utf8', append: false });
  await writer.writeRecords(records);
  console.log(`Wrote ${records.length} rows -> ${filePath}`);
}

async function main() {
  let allPosts = [];
  for (const groupId of TOP20_GROUP_IDS) {
    const posts = loadPosts(groupId);
    for (const p of posts) {
      allPosts.push({ group_id: groupId, ...p, comment: Number(p.comment) || 0 });
    }
  }

  // File 1: all posts of top 20 groups, sorted by group then newest first
  const sortedAll = [...allPosts].sort((a, b) => {
    if (a.group_id !== b.group_id) return a.group_id < b.group_id ? -1 : 1;
    return new Date(b.post_date) - new Date(a.post_date);
  });
  await writeCsv(path.join(OUT_DIR, '1_all_posts_top20_groups.csv'), sortedAll);

  // File 2: comment > 500, sorted by comment desc
  const over500 = allPosts.filter(p => p.comment > 500).sort((a, b) => b.comment - a.comment);
  await writeCsv(path.join(OUT_DIR, '2_posts_over_500_comments.csv'), over500);

  // File 3: comment between 50 and 500 (inclusive), sorted by comment desc
  const between50and500 = allPosts.filter(p => p.comment >= 50 && p.comment <= 500).sort((a, b) => b.comment - a.comment);
  await writeCsv(path.join(OUT_DIR, '3_posts_50_to_500_comments.csv'), between50and500);

  console.log('\nSummary:');
  console.log('Total posts (top 20 groups):', allPosts.length);
  console.log('Posts >500 comments:', over500.length);
  console.log('Posts 50-500 comments:', between50and500.length);
  console.log('Posts <50 comments:', allPosts.length - over500.length - between50and500.length);
}

main().catch(err => { console.error(err); process.exit(1); });
