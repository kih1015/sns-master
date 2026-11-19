import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function missingEnv(...keys) {
  const missing = keys.filter((key) => !env[key]);
  return missing.length ? `.env에 ${missing.join(', ')} 값이 없습니다.` : null;
}

async function graph(base, token, method, pathname, params = {}) {
  const url = new URL(base + pathname);
  const all = { ...params, access_token: token };
  const init = { method };
  if (method === 'GET') url.search = new URLSearchParams(all);
  else init.body = new URLSearchParams(all);
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

// 인스타그램과 쓰레드는 컨테이너 생성 → 처리 완료 대기 → 게시의 동일한 절차를 따른다.
// 이미지가 여러 장이면 이미지마다 항목 컨테이너를 만든 뒤, 이를 묶는 캐러셀 컨테이너를 게시한다.
// postParams에는 게시글과 AI 생성 표시처럼 게시물 전체에 적용되는 값을 전달한다.
async function publishContainer({ base, token, userId, createPath, publishPath, statusField, imageUrls, itemParams, postParams }) {
  const call = (method, pathname, p) => graph(base, token, method, pathname, p);
  const create = async (params) => {
    const container = await call('POST', `/${userId}/${createPath}`, params);
    for (let attempt = 0; ; attempt++) {
      const status = (await call('GET', `/${container.id}`, { fields: statusField }))[statusField];
      if (status === 'FINISHED') return container.id;
      if (status !== 'IN_PROGRESS') throw new Error(`미디어 컨테이너 상태가 ${status}입니다.`);
      if (attempt >= 60) throw new Error('미디어 컨테이너 처리 시간이 초과되었습니다.');
      await sleep(5000);
    }
  };
  let containerId;
  if (imageUrls.length === 1) {
    containerId = await create({ ...itemParams(imageUrls[0]), ...postParams });
  } else {
    const children = [];
    for (const url of imageUrls) children.push(await create({ ...itemParams(url), is_carousel_item: 'true' }));
    containerId = await create({ media_type: 'CAROUSEL', children: children.join(','), ...postParams });
  }
  const published = await call('POST', `/${userId}/${publishPath}`, { creation_id: containerId });
  const media = await call('GET', `/${published.id}`, { fields: 'permalink' });
  return media.permalink;
}

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// JSON과 multipart 본문은 OAuth 1.0a 서명 대상에 포함되지 않으므로 oauth_* 파라미터만 서명한다.
function xAuthHeader(method, url) {
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(oauth).sort().map((k) => `${pct(k)}=${pct(oauth[k])}`).join('&');
  const baseString = [method, pct(url), pct(paramString)].join('&');
  const signingKey = `${pct(env.X_API_SECRET)}&${pct(env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  return `OAuth ${Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(', ')}`;
}

async function xRequest(url, init) {
  const res = await fetch(url, {
    method: 'POST',
    ...init,
    headers: { ...init.headers, Authorization: xAuthHeader('POST', url) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.detail || json.title || json.errors?.[0]?.message || `HTTP ${res.status}`);
  return json.data;
}

export const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    needsPublicUrl: true,
    unavailable: () => missingEnv('IG_USER_ID', 'IG_ACCESS_TOKEN', 'PUBLIC_BASE_URL'),
    publish: ({ caption, imageUrls }) => publishContainer({
      // EAA로 시작하는 토큰은 Facebook 로그인으로 발급된 것이어서 graph.facebook.com에서만 인식된다.
      base: `https://graph.${env.IG_ACCESS_TOKEN.startsWith('EAA') ? 'facebook' : 'instagram'}.com/v27.0`,
      token: env.IG_ACCESS_TOKEN,
      userId: env.IG_USER_ID,
      createPath: 'media',
      publishPath: 'media_publish',
      statusField: 'status_code',
      imageUrls,
      itemParams: (url) => ({ image_url: url }),
      // 표지 이미지를 AI로 생성하므로 인스타그램의 AI 생성 콘텐츠 표시를 설정한다.
      postParams: { caption, is_ai_generated: 'true' },
    }),
  },
  instagram_reels: {
    label: 'Instagram 릴스',
    needsPublicUrl: true,
    needsVideo: true,
    caption: 'instagram', // 카드뉴스와 같은 게시글을 사용한다.
    unavailable: () => missingEnv('IG_USER_ID', 'IG_ACCESS_TOKEN', 'PUBLIC_BASE_URL'),
    publish: ({ caption, videoUrl }) => publishContainer({
      base: `https://graph.${env.IG_ACCESS_TOKEN.startsWith('EAA') ? 'facebook' : 'instagram'}.com/v27.0`,
      token: env.IG_ACCESS_TOKEN,
      userId: env.IG_USER_ID,
      createPath: 'media',
      publishPath: 'media_publish',
      statusField: 'status_code',
      imageUrls: [videoUrl],
      itemParams: (url) => ({ media_type: 'REELS', video_url: url, share_to_feed: 'true' }),
      postParams: { caption, is_ai_generated: 'true' },
    }),
  },
  threads: {
    label: 'Threads',
    needsPublicUrl: true,
    unavailable: () => missingEnv('THREADS_USER_ID', 'THREADS_ACCESS_TOKEN', 'PUBLIC_BASE_URL'),
    publish: ({ caption, imageUrls }) => publishContainer({
      base: 'https://graph.threads.com/v1.0',
      token: env.THREADS_ACCESS_TOKEN,
      userId: env.THREADS_USER_ID,
      createPath: 'threads',
      publishPath: 'threads_publish',
      statusField: 'status',
      imageUrls,
      itemParams: (url) => ({ media_type: 'IMAGE', image_url: url }),
      postParams: { text: caption, is_made_with_ai: 'true' },
    }),
  },
  x: {
    label: 'X',
    unavailable: () => missingEnv('X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'),
    publish: async ({ caption, imagePaths }) => {
      const mediaIds = [];
      // X는 게시물 하나에 이미지를 4장까지만 첨부할 수 있으므로 앞의 4장만 올린다.
      for (const imagePath of imagePaths.slice(0, 4)) {
        const form = new FormData();
        form.set('media', new Blob([await readFile(imagePath)], { type: 'image/jpeg' }), 'image.jpg');
        form.set('media_category', 'tweet_image');
        mediaIds.push((await xRequest('https://api.x.com/2/media/upload', { body: form })).id);
      }
      const post = await xRequest('https://api.x.com/2/tweets', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: caption, media: { media_ids: mediaIds } }),
      });
      return `https://x.com/i/status/${post.id}`;
    },
  },
  youtube: {
    label: 'YouTube',
    unavailable: () => '유튜브에 게시할 형태가 아직 결정되지 않아서 리서치 대상으로만 사용합니다.',
  },
};
