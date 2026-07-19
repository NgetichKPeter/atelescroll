// ============================================================
// TELESCROLL — index.html (feed) logic
// ============================================================

let currentUser = null;
let likedPostIds = new Set();
let sharedPostIds = new Set();

const feedEl = document.getElementById('feed');
const postTpl = document.getElementById('post-template');
const commentTpl = document.getElementById('comment-template');

init();

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'auth.html';
    return;
  }
  currentUser = session.user;

  document.getElementById('signout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'auth.html';
  });

  setupCompose();
  await loadMyReactionsAndShares();
  await loadFeed();
}

// ---------- Compose ----------
const CHAR_LIMIT = 160;
const MAX_VIDEO_SECONDS = 60;
const MAX_FILE_MB = 50;
let selectedMediaFile = null; // { file, type: 'image'|'video' }

function setupCompose() {
  const textarea = document.getElementById('compose-text');
  const submitBtn = document.getElementById('compose-submit');
  const charCount = document.getElementById('char-count');
  const attachBtn = document.getElementById('attach-btn');
  const mediaInput = document.getElementById('media-input');
  const mediaPreview = document.getElementById('media-preview');
  const previewImg = document.getElementById('media-preview-img');
  const previewVideo = document.getElementById('media-preview-video');
  const removeMediaBtn = document.getElementById('remove-media');

  function updateSubmitState() {
    submitBtn.disabled = textarea.value.trim().length === 0 && !selectedMediaFile;
  }

  textarea.addEventListener('input', () => {
    const remaining = CHAR_LIMIT - textarea.value.length;
    charCount.textContent = `${remaining} remaining`;
    updateSubmitState();
  });

  attachBtn.addEventListener('click', () => mediaInput.click());

  mediaInput.addEventListener('change', async () => {
    const file = mediaInput.files[0];
    if (!file) return;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');

    if (!isImage && !isVideo) {
      alert('Please choose a photo or a video.');
      mediaInput.value = '';
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(`File is too large. Keep it under ${MAX_FILE_MB}MB.`);
      mediaInput.value = '';
      return;
    }

    if (isVideo) {
      const duration = await getVideoDuration(file);
      if (duration > MAX_VIDEO_SECONDS) {
        alert(`Videos must be under ${MAX_VIDEO_SECONDS} seconds. This one is ${Math.round(duration)}s.`);
        mediaInput.value = '';
        return;
      }
    }

    selectedMediaFile = { file, type: isImage ? 'image' : 'video' };
    const url = URL.createObjectURL(file);

    previewImg.hidden = !isImage;
    previewVideo.hidden = !isVideo;
    if (isImage) { previewImg.src = url; } else { previewVideo.src = url; }
    mediaPreview.hidden = false;
    updateSubmitState();
  });

  removeMediaBtn.addEventListener('click', () => {
    selectedMediaFile = null;
    mediaInput.value = '';
    mediaPreview.hidden = true;
    previewImg.src = '';
    previewVideo.src = '';
    updateSubmitState();
  });

  submitBtn.addEventListener('click', async () => {
    const content = textarea.value.trim();
    if (!content && !selectedMediaFile) return;
    submitBtn.disabled = true;

    let media_url = null;
    let media_type = null;

    if (selectedMediaFile) {
      try {
        media_url = await uploadMedia(selectedMediaFile.file);
        media_type = selectedMediaFile.type;
      } catch (err) {
        alert('Could not upload media: ' + err.message);
        submitBtn.disabled = false;
        return;
      }
    }

    const { error } = await supabase.from('posts').insert({
      author_id: currentUser.id,
      content: content || ' ',
      media_url,
      media_type
    });

    if (error) {
      alert('Could not inscribe your scroll: ' + error.message);
      submitBtn.disabled = false;
      return;
    }

    textarea.value = '';
    charCount.textContent = `${CHAR_LIMIT} remaining`;
    removeMediaBtn.click();
    await loadFeed();
  });
}

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration);
    };
    video.onerror = () => reject(new Error('Could not read video file.'));
    video.src = URL.createObjectURL(file);
  });
}

async function uploadMedia(file) {
  const ext = file.name.split('.').pop();
  const path = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from('media').upload(path, file, {
    cacheControl: '3600',
    upsert: false
  });
  if (error) throw error;

  const { data } = supabase.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}

// ---------- Load current user's likes/shares (for active-state styling) ----------
async function loadMyReactionsAndShares() {
  const [{ data: reactions }, { data: shares }] = await Promise.all([
    supabase.from('reactions').select('post_id').eq('user_id', currentUser.id),
    supabase.from('shares').select('post_id').eq('user_id', currentUser.id)
  ]);
  likedPostIds = new Set((reactions || []).map(r => r.post_id));
  sharedPostIds = new Set((shares || []).map(s => s.post_id));
}

// ---------- Feed ----------
async function loadFeed() {
  const [{ data: posts, error: postsErr }, { data: shares, error: sharesErr }] = await Promise.all([
    supabase
      .from('posts')
      .select('id, content, media_url, media_type, likes_count, comments_count, shares_count, created_at, author:profiles(id, username, display_name, avatar_url)')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('shares')
      .select('id, created_at, sharer:profiles(id, username, display_name), post:posts(id, content, media_url, media_type, likes_count, comments_count, shares_count, created_at, author:profiles(id, username, display_name, avatar_url))')
      .order('created_at', { ascending: false })
      .limit(50)
  ]);

  if (postsErr || sharesErr) {
    feedEl.innerHTML = `<p class="empty-state">The archive would not open. ${((postsErr || sharesErr).message)}</p>`;
    return;
  }

  const entries = [
    ...(posts || []).map(p => ({ type: 'post', time: p.created_at, post: p })),
    ...(shares || []).filter(s => s.post).map(s => ({ type: 'share', time: s.created_at, post: s.post, sharer: s.sharer }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time));

  feedEl.innerHTML = '';

  if (entries.length === 0) {
    feedEl.innerHTML = '<p class="empty-state">No scrolls yet. Be the first to write one.</p>';
    return;
  }

  entries.forEach(entry => feedEl.appendChild(renderPost(entry)));
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd';
  return new Date(iso).toLocaleDateString();
}

function renderPost(entry) {
  const post = entry.post;
  const node = postTpl.content.firstElementChild.cloneNode(true);
  node.dataset.postId = post.id;

  if (entry.type === 'share') {
    const banner = node.querySelector('.reshare-banner');
    banner.hidden = false;
    banner.querySelector('.reshare-label').textContent =
      `${entry.sharer?.display_name || 'A reader'} shared this`;
  }

  const author = post.author || {};
  node.querySelector('.avatar').textContent = initials(author.display_name);
  node.querySelector('.display-name').textContent = author.display_name || 'Unknown Scribe';
  node.querySelector('.username-time').textContent =
    `@${author.username || 'unknown'} · ${timeAgo(post.created_at)}`;
  node.querySelector('.post-content').textContent = post.content;

  if (post.media_url) {
    if (post.media_type === 'video') {
      const vid = node.querySelector('.post-video');
      vid.src = post.media_url;
      vid.hidden = false;
    } else {
      const img = node.querySelector('.post-image');
      img.src = post.media_url;
      img.hidden = false;
    }
  }

  // Like
  const likeBtn = node.querySelector('.like');
  const likeCount = node.querySelector('.like-count');
  likeCount.textContent = post.likes_count;
  if (likedPostIds.has(post.id)) likeBtn.classList.add('active');

  likeBtn.addEventListener('click', async () => {
    const isLiked = likedPostIds.has(post.id);
    likeBtn.classList.toggle('active', !isLiked);
    likeCount.textContent = Number(likeCount.textContent) + (isLiked ? -1 : 1);

    if (isLiked) {
      likedPostIds.delete(post.id);
      const { error } = await supabase.from('reactions').delete()
        .eq('post_id', post.id).eq('user_id', currentUser.id);
      if (error) revertLike(true);
    } else {
      likedPostIds.add(post.id);
      const { error } = await supabase.from('reactions').insert({
        post_id: post.id, user_id: currentUser.id, type: 'like'
      });
      if (error) revertLike(false);
    }

    function revertLike(wasLiked) {
      likeBtn.classList.toggle('active', wasLiked);
      likeCount.textContent = Number(likeCount.textContent) + (wasLiked ? 1 : -1);
      if (wasLiked) likedPostIds.add(post.id); else likedPostIds.delete(post.id);
    }
  });

  // Share (functions as repost)
  const shareBtn = node.querySelector('.share');
  const shareCount = node.querySelector('.share-count');
  shareCount.textContent = post.shares_count;
  if (sharedPostIds.has(post.id)) shareBtn.classList.add('active');

  shareBtn.addEventListener('click', async () => {
    const isShared = sharedPostIds.has(post.id);
    shareBtn.classList.toggle('active', !isShared);
    shareCount.textContent = Number(shareCount.textContent) + (isShared ? -1 : 1);

    if (isShared) {
      sharedPostIds.delete(post.id);
      const { error } = await supabase.from('shares').delete()
        .eq('post_id', post.id).eq('user_id', currentUser.id);
      if (error) revertShare(true); else await loadFeed();
    } else {
      sharedPostIds.add(post.id);
      const { error } = await supabase.from('shares').insert({
        post_id: post.id, user_id: currentUser.id
      });
      if (error) revertShare(false); else await loadFeed();
    }

    function revertShare(wasShared) {
      shareBtn.classList.toggle('active', wasShared);
      shareCount.textContent = Number(shareCount.textContent) + (wasShared ? 1 : -1);
      if (wasShared) sharedPostIds.add(post.id); else sharedPostIds.delete(post.id);
    }
  });

  // Comments
  const commentToggle = node.querySelector('.comment-toggle');
  const commentCount = node.querySelector('.comment-count');
  commentCount.textContent = post.comments_count;
  const commentsSection = node.querySelector('.comments-section');
  const commentsList = node.querySelector('.comments-list');
  let commentsLoaded = false;

  commentToggle.addEventListener('click', async () => {
    commentsSection.classList.toggle('open');
    if (commentsSection.classList.contains('open') && !commentsLoaded) {
      commentsLoaded = true;
      await loadComments(post.id, commentsList);
    }
  });

  const commentForm = node.querySelector('.comment-form');
  commentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = commentForm.querySelector('input');
    const content = input.value.trim();
    if (!content) return;

    const { error } = await supabase.from('comments').insert({
      post_id: post.id, author_id: currentUser.id, content
    });
    if (error) {
      alert('Could not add note: ' + error.message);
      return;
    }
    input.value = '';
    commentCount.textContent = Number(commentCount.textContent) + 1;
    await loadComments(post.id, commentsList);
  });

  return node;
}

async function loadComments(postId, container) {
  const { data, error } = await supabase
    .from('comments')
    .select('id, content, created_at, author:profiles(display_name, username)')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });

  if (error) {
    container.innerHTML = `<p class="meta">Could not load notes.</p>`;
    return;
  }

  container.innerHTML = '';
  data.forEach(c => {
    const node = commentTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.avatar').textContent = initials(c.author?.display_name);
    node.querySelector('.display-name').textContent = c.author?.display_name || 'Unknown';
    node.querySelector('.comment-text').textContent = ' ' + c.content;
    container.appendChild(node);
  });
      }
    
