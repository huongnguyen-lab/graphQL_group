'use strict';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safely dig into nested object without throwing
 */
function dig(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function groupIdFromGroupUrl(groupUrl) {
  try {
    const url = new URL(groupUrl, 'https://www.facebook.com');
    const parts = url.pathname.split('/').filter(Boolean);
    const groupIdx = parts.indexOf('groups');
    if (groupIdx >= 0 && parts[groupIdx + 1]) return parts[groupIdx + 1];
  } catch (_) {}
  const fallback = String(groupUrl).split('?')[0].split('/groups/')[1] || '';
  return fallback.replace(/\/$/, '');
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

function numericParts(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const decoded = decodeBase64Id(raw);
  const source = decoded || raw;
  return source.match(/\d+/g) || [];
}

function cleanCommentId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return raw;

  const matches = numericParts(raw);
  return matches && matches.length ? matches[matches.length - 1] : raw;
}

function postIdFromPostUrl(postUrl) {
  try {
    const url = new URL(postUrl, 'https://www.facebook.com');
    const pathMatch = url.pathname.match(/\/posts\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    const storyFbid = url.searchParams.get('story_fbid');
    if (storyFbid && /^\d+$/.test(storyFbid)) return storyFbid;
  } catch (_) {}
  const fallback = String(postUrl || '').match(/\/posts\/(\d+)/);
  return fallback ? fallback[1] : '';
}

function postIdFromPermalink(permalink) {
  try {
    const url = new URL(permalink, 'https://www.facebook.com');
    const pathMatch = url.pathname.match(/\/posts\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    const storyFbid = url.searchParams.get('story_fbid');
    if (storyFbid && /^\d+$/.test(storyFbid)) return storyFbid;
  } catch (_) {}
  const fallback = String(permalink || '').match(/\/posts\/(\d+)/);
  return fallback ? fallback[1] : '';
}

function postIdFromCommentNode(commentNode) {
  const legacyParts = String(commentNode && commentNode.legacy_token || '')
    .split('_')
    .filter(part => /^\d+$/.test(part));
  if (legacyParts.length >= 2) return legacyParts[0];

  for (const value of [
    commentNode && commentNode.id,
    commentNode && commentNode.legacy_fbid,
    dig(commentNode, 'feedback', 'id'),
  ]) {
    const parts = numericParts(value);
    if (parts.length >= 2) return parts[0];
  }

  const permalink = dig(commentNode, 'feedback', 'url')
    || dig(commentNode, 'comment_action_links', 0, 'comment', 'url')
    || '';
  return postIdFromPermalink(permalink);
}

function parentIdFromPermalink(permalink, currentCommentId = '') {
  if (!permalink) return '';
  try {
    const url = new URL(permalink, 'https://www.facebook.com');
    const replyCommentId = cleanCommentId(url.searchParams.get('reply_comment_id') || '');
    const commentId = cleanCommentId(url.searchParams.get('comment_id') || '');
    if (replyCommentId && replyCommentId !== currentCommentId && replyCommentId !== commentId) {
      return replyCommentId;
    }
    return commentId && commentId !== currentCommentId ? commentId : '';
  } catch (_) {
    return '';
  }
}

/**
 * Parse newline-delimited JSON từ GraphQL streaming response
 * Facebook trả về nhiều JSON objects trên nhiều dòng
 */
function parseGraphQLBody(text) {
  const results = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      results.push(obj);
    } catch (_) {
      // ignore non-JSON lines
    }
  }
  return results;
}

function metricNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') {
    if (typeof value.count !== 'undefined') return metricNumber(value.count);
    if (typeof value.total_count !== 'undefined') return metricNumber(value.total_count);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .toLowerCase();
  const match = normalized.match(/([\d.]+)(k|m|tr|n|nghìn|ngan|triệu|trieu)?/i);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  const suffix = match[2] || '';
  if (suffix === 'k' || suffix === 'n' || suffix === 'nghìn' || suffix === 'ngan') {
    return Math.round(base * 1000);
  }
  if (suffix === 'm' || suffix === 'tr' || suffix === 'triệu' || suffix === 'trieu') {
    return Math.round(base * 1000000);
  }
  return Math.round(base);
}

function pushMetricCandidate(candidate, candidates) {
  if (!candidate || typeof candidate !== 'object') return;

  const hasMetric =
    candidate.reaction_count
    || candidate.share_count
    || candidate.comment_count
    || candidate.comment_rendering_instance
    || candidate.comments_count_summary_renderer
    || candidate.i18n_reaction_count
    || candidate.i18n_share_count
    || candidate.i18n_comment_count;

  if (hasMetric) candidates.push(candidate);
}

function collectMetricCandidates(obj, candidates = [], seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return candidates;
  seen.add(obj);

  pushMetricCandidate(obj, candidates);

  if (Array.isArray(obj)) {
    for (const item of obj) collectMetricCandidates(item, candidates, seen);
    return candidates;
  }

  for (const value of Object.values(obj)) {
    collectMetricCandidates(value, candidates, seen);
  }
  return candidates;
}

function maxMetric(values) {
  const nums = values
    .map(metricNumber)
    .filter(v => v != null && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : 0;
}

function extractStoryMetrics(storyNode) {
  const directUfi = dig(
    storyNode,
    'comet_sections', 'feedback', 'story',
    'story_ufi_container', 'story',
    'feedback_context', 'feedback_target_with_context',
    'comet_ufi_summary_and_actions_renderer', 'feedback'
  );

  const targetWithContext = dig(
    storyNode,
    'comet_sections', 'feedback', 'story',
    'story_ufi_container', 'story',
    'feedback_context', 'feedback_target_with_context'
  );

  const candidates = [];
  pushMetricCandidate(directUfi, candidates);
  pushMetricCandidate(dig(directUfi, 'comments_count_summary_renderer', 'feedback'), candidates);
  pushMetricCandidate(targetWithContext, candidates);
  pushMetricCandidate(dig(targetWithContext, 'comet_ufi_summary_and_actions_renderer', 'feedback'), candidates);
  pushMetricCandidate(storyNode.feedback, candidates);
  collectMetricCandidates(storyNode, candidates);

  const reaction = maxMetric(candidates.flatMap(c => [
    c.reaction_count,
    c.i18n_reaction_count,
    dig(c, 'top_reactions', 'edges', 0, 'reaction_count'),
  ]));

  const share = maxMetric(candidates.flatMap(c => [
    c.share_count,
    c.i18n_share_count,
  ]));

  const comment = maxMetric(candidates.flatMap(c => [
    c.comment_count,
    c.i18n_comment_count,
    dig(c, 'comment_rendering_instance', 'comments', 'total_count'),
    dig(c, 'comments_count_summary_renderer', 'feedback', 'comment_rendering_instance', 'comments', 'total_count'),
  ]));

  return { reaction, share, comment };
}

// ─── Post Parser ───────────────────────────────────────────────────────────────

/**
 * Extract tất cả Story nodes từ một GraphQL response object
 * Handles cả batch đầu tiên (edges array) và streaming chunks (label + data)
 */
function extractStoriesFromChunk(chunk) {
  const stories = [];

  // Case 1: batch đầu tiên — data.node.group_feed.edges
  const edges = dig(chunk, 'data', 'node', 'group_feed', 'edges');
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      const node = edge && edge.node;
      if (node && node.__typename === 'Story') {
        stories.push(node);
      }
    }
  }

  // Case 2: streaming chunk — data.node (single story)
  const streamNode = dig(chunk, 'data', 'node');
  if (streamNode && streamNode.__typename === 'Story') {
    stories.push(streamNode);
  }

  return stories;
}

/**
 * Extract pagination cursor từ response chunk
 */
function extractCursor(chunk) {
  // Label-based page_info chunk
  const label = chunk.label || '';
  if (label.includes('page_info')) {
    const pi = dig(chunk, 'data', 'page_info');
    if (pi && pi.has_next_page) return pi.end_cursor;
  }
  // Inline page_info
  const pi = dig(chunk, 'data', 'node', 'group_feed', 'page_info');
  if (pi && pi.has_next_page) return pi.end_cursor;
  return null;
}

/**
 * Parse một Story node thành clean post object
 */
function parseStory(storyNode, groupUrl, groupName) {
  if (!storyNode) return null;

  const postId = storyNode.post_id;
  if (!postId) return null;

  // ── Timestamp ──
  // Tìm creation_time từ nhiều path có thể có
  let creationTime = null;
  const metadataArr = dig(
    storyNode,
    'comet_sections', 'context_layout', 'story', 'comet_sections', 'metadata'
  );
  if (Array.isArray(metadataArr)) {
    for (const m of metadataArr) {
      const t = dig(m, 'story', 'creation_time');
      if (t) { creationTime = t; break; }
    }
  }
  // Fallback: timestamp section
  if (!creationTime) {
    creationTime = dig(storyNode, 'timestamp', 'story', 'creation_time');
  }

  // ── Author ──
  const actors = storyNode.actors || [];
  const actor = actors[0] || {};
  const authorName = actor.name || '';
  const authorUrl  = actor.url  || '';

  // ── Group ──
  const toNode = storyNode.to || {};
  const resolvedGroupName = toNode.name || groupName || '';
  const resolvedGroupUrl  = toNode.url  || groupUrl  || '';

  // ── Content ──
  // Primary: message.text từ content section
  let content = dig(storyNode, 'comet_sections', 'content', 'story', 'message', 'text')
    || dig(storyNode, 'message', 'text')
    || '';

  // ── Post URL ──
  const postUrl = storyNode.permalink_url
    || storyNode.wwwURL
    || dig(storyNode, 'comet_sections', 'context_layout', 'story', 'comet_sections', 'metadata', 0, 'story', 'url')
    || `https://www.facebook.com/groups/${groupIdFromGroupUrl(groupUrl)}/posts/${postId}/`;

  // ── Metrics ──
  // Facebook hay đổi vị trí UFI metrics giữa các GraphQL variant, nên dò rộng
  // trong Story và lấy count tốt nhất thay vì phụ thuộc một path cố định.
  const metrics = extractStoryMetrics(storyNode);

  // ── Images ──
  const imageUrls = [];
  const attachments = storyNode.attachments || [];
  for (const att of attachments) {
    const nodes = dig(att, 'styles', 'attachment', 'all_subattachments', 'nodes') || [];
    for (const n of nodes) {
      const uri = dig(n, 'media', 'image', 'uri');
      if (uri) imageUrls.push(uri);
    }
    // Single image (non-album)
    const singleUri = dig(att, 'media', 'image', 'uri');
    if (singleUri && !imageUrls.includes(singleUri)) imageUrls.push(singleUri);
  }

  // ── Video ──
  let videoUrl = null;
  for (const att of attachments) {
    const typename = dig(att, 'media', '__typename');
    if (typename === 'Video') {
      videoUrl = dig(att, 'media', 'browser_native_sd_url')
        || dig(att, 'media', 'playable_url')
        || dig(att, 'url')
        || null;
    }
  }

  // ── Attached story (shared post) ──
  // Nếu là shared post, content có thể nằm trong attached_story
  if (!content && storyNode.attached_story) {
    content = dig(storyNode, 'attached_story', 'message', 'text') || '';
  }

  return {
    post_id:      postId,
    post_date:    creationTime ? new Date(creationTime * 1000).toISOString() : '',
    content:      content.trim(),
    group_name:   resolvedGroupName,
    group_url:    resolvedGroupUrl,
    author_name:  authorName,
    author_url:   authorUrl,
    reaction:     metrics.reaction,
    share:        metrics.share,
    comment:      metrics.comment,
    post_url:     postUrl,
    image_urls:   imageUrls.join('|'),  // join bằng | để dễ đưa vào CSV
    video_url:    videoUrl || '',
  };
}

/**
 * Parse toàn bộ GraphQL response text thành array of post objects
 * Returns { posts, nextCursor }
 */
function parseGroupFeedResponse(responseText, groupUrl, groupName) {
  const chunks = parseGraphQLBody(responseText);
  const posts = [];
  let nextCursor = null;

  for (const chunk of chunks) {
    // Extract stories
    const stories = extractStoriesFromChunk(chunk);
    for (const story of stories) {
      const post = parseStory(story, groupUrl, groupName);
      if (post) posts.push(post);
    }

    // Extract cursor
    const cursor = extractCursor(chunk);
    if (cursor) nextCursor = cursor;
  }

  return { posts, nextCursor };
}

// ─── Comment Parser ─────────────────────────────────────────────────────────────

/**
 * Parse một comment node thành clean comment object
 */
function parseComment(commentNode, postUrl, parentId = null, targetPostId = '') {
  if (!commentNode) return null;

  const commentId = cleanCommentId(commentNode.legacy_fbid || commentNode.id);
  if (!commentId) return null;
  const commentPostId = postIdFromCommentNode(commentNode);
  if (targetPostId && commentPostId && commentPostId !== targetPostId) return null;

  // ── Timestamp ──
  const createdTime = commentNode.created_time
    || dig(commentNode, 'comment_action_links', 0, 'comment', 'created_time');

  // ── Content ──
  const content = dig(commentNode, 'preferred_body', 'text')
    || dig(commentNode, 'body', 'text')
    || '';

  // ── Author ──
  const author = commentNode.author || {};
  let authorName = author.name || '';
  if (!authorName && author.__typename === 'GroupAnonAuthorProfile') {
    authorName = '[Anonymous]';
  }

  // ── Depth / Level ──
  const depth = commentNode.depth || 0;

  // ── Permalink ──
  let permalink = '';
  // Từ feedback.url (chính xác nhất)
  permalink = dig(commentNode, 'feedback', 'url') || '';
  // Fallback: từ comment_action_links
  if (!permalink) {
    const actionLinks = commentNode.comment_action_links || [];
    for (const link of actionLinks) {
      if (link.__typename === 'XFBCommentTimeStampActionLink') {
        permalink = dig(link, 'comment', 'url') || '';
        break;
      }
    }
  }

  // ── Parent ID ──
  // Parent_ID luôn là numeric legacy comment id. Top-level để trống.
  let resolvedParentId = '';
  if (depth > 0) {
    resolvedParentId = cleanCommentId(parentId)
      || cleanCommentId(dig(commentNode, 'comment_direct_parent', 'legacy_fbid'))
      || cleanCommentId(dig(commentNode, 'comment_direct_parent', 'id'))
      || parentIdFromPermalink(permalink, commentId);

    // legacy_token thường có dạng "post_id_parent_id_reply_id"; parent là số áp cuối.
    if (!resolvedParentId && commentNode.legacy_token) {
      const parts = String(commentNode.legacy_token).split('_').filter(Boolean);
      if (parts.length >= 2) {
        resolvedParentId = cleanCommentId(parts[parts.length - 2]);
      }
    }
  }

  return {
    date:        createdTime ? new Date(createdTime * 1000).toISOString() : '',
    comment_id:  commentId,
    parent_id:   resolvedParentId,
    level:       depth,
    author:      authorName,
    content:     content.trim(),
    permalink:   permalink,
    post_url:    postUrl,
  };
}

function collectCommentEdges(edges, postUrl, parentCommentId, comments, targetPostId = '') {
  if (!Array.isArray(edges)) return;

  for (const edge of edges) {
    const node = edge && edge.node;
    if (!node) continue;

    const c = parseComment(node, postUrl, parentCommentId, targetPostId);
    if (c) comments.push(c);

    // Một số response top-level nhúng sẵn reply ở feedback.replies_connection.
    const nestedReplyEdges = dig(node, 'feedback', 'replies_connection', 'edges');
    collectCommentEdges(nestedReplyEdges, postUrl, c ? c.comment_id : null, comments, targetPostId);
  }
}

/**
 * Parse comment feed response (top-level comments hoặc replies)
 * Returns { comments, nextCursor }
 */
function parseCommentResponse(responseText, postUrl, parentCommentId = null) {
  const chunks = parseGraphQLBody(responseText);
  const comments = [];
  let nextCursor = null;
  const targetPostId = postIdFromPostUrl(postUrl);

  for (const chunk of chunks) {

    // ── Path 1: Top-level comments khi mở trang post ──
    // data.node.comment_rendering_instance_for_feed_location.comments.edges
    const feedLocationEdges = dig(
      chunk, 'data', 'node', 'comment_rendering_instance_for_feed_location', 'comments', 'edges'
    );
    if (Array.isArray(feedLocationEdges)) {
      collectCommentEdges(feedLocationEdges, postUrl, null, comments, targetPostId);
      const pi = dig(
        chunk, 'data', 'node',
        'comment_rendering_instance_for_feed_location', 'comments', 'page_info'
      );
      if (pi && pi.has_next_page) nextCursor = pi.end_cursor;
    }

    // ── Path 2: Top-level comments (path cũ, vẫn giữ để handle variants) ──
    // data.node.comment_rendering_instance.comments.edges
    const commentEdges = dig(
      chunk, 'data', 'node', 'comment_rendering_instance', 'comments', 'edges'
    );
    if (Array.isArray(commentEdges)) {
      collectCommentEdges(commentEdges, postUrl, null, comments, targetPostId);
      const pi = dig(chunk, 'data', 'node', 'comment_rendering_instance', 'comments', 'page_info');
      if (pi && pi.has_next_page) nextCursor = pi.end_cursor;
    }

    // ── Path 3: Replies ──
    // data.node.replies_connection.edges
    const replyEdges = dig(chunk, 'data', 'node', 'replies_connection', 'edges');
    if (Array.isArray(replyEdges)) {
      collectCommentEdges(replyEdges, postUrl, parentCommentId, comments, targetPostId);
      const pi = dig(chunk, 'data', 'node', 'replies_connection', 'page_info');
      if (pi && pi.has_next_page) nextCursor = pi.end_cursor;
    }

    // ── Path 4: Inline comments từ feed response ──
    // (interesting_top_level_comments trong feed GraphQL)
    const inlineComments = dig(
      chunk, 'data', 'node', 'story_ufi_container', 'story',
      'feedback_context', 'feedback_target_with_context', 'interesting_top_level_comments'
    );
    if (Array.isArray(inlineComments)) {
      for (const item of inlineComments) {
        const node = item && item.comment;
        if (node) {
          const c = parseComment(node, postUrl, null, targetPostId);
          if (c) comments.push(c);
        }
      }
    }
  }

  return { comments, nextCursor };
}

module.exports = {
  parseGraphQLBody,
  parseGroupFeedResponse,
  parseCommentResponse,
  parseStory,
  parseComment,
  postIdFromPostUrl,
  postIdFromCommentNode,
  dig,
};
