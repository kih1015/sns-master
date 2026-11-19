import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, GATES, approve, coveredIssues, createRun, nextScheduledAt, startScheduler, events, failRun, generate, generateImage, loadRuns, logFromHook, reject, runs,
  submitContent, submitResearch,
} from './src/pipeline.js';
import { PLATFORMS } from './src/publishers.js';
import { getSettings, saveSettings } from './src/settings.js';
import { startTunnel, stopTunnel, tunnel } from './src/tunnel.js';

const PORT = Number(process.env.PORT) || 4321;
const INDEX = path.join(import.meta.dirname, 'public', 'index.html');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('요청 본문이 너무 큽니다.');
  }
  return raw ? JSON.parse(raw) : {};
}

// 설정 화면에 표시할 내용이다. 플랫폼의 연결 상태는 터널 주소에 따라 달라지므로 요청할 때마다 계산한다.
function settingsView() {
  return {
    settings: getSettings(),
    next: nextScheduledAt(),
    gates: GATES,
    tunnel: { url: tunnel.url, error: tunnel.error, publicBaseUrl: process.env.PUBLIC_BASE_URL || '' },
    platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([key, p]) => [key, { label: p.label, unavailable: p.unavailable() }])),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const media = url.pathname.match(/^\/media\/([0-9a-f-]{36})\/((?:image|slide-\d{1,2})\.jpg|reel\.mp4)$/);

  // 인스타그램과 쓰레드가 이미지를 가져갈 수 있도록 이미지 경로만 외부(터널)에 공개한다.
  if (req.method === 'GET' && media) {
    const file = path.join(DATA_DIR, media[1], media[2]);
    if (!existsSync(file)) return json(res, 404, { error: '이미지를 찾을 수 없습니다.' });
    // 브라우저가 영상을 탐색할 수 있도록 부분 요청(Range)을 지원한다.
    const { size } = statSync(file);
    const headers = { 'Content-Type': file.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range && Number(range[1]) < size) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return createReadStream(file).pipe(res);
  }

  // 그 외의 UI와 API는 localhost로 접속한 요청에만 응답한다.
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host || '')) {
    return json(res, 403, { error: 'localhost에서만 접근할 수 있습니다.' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return createReadStream(INDEX).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, 200, settingsView());
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      return json(res, 200, coveredIssues(url.searchParams.get('except')));
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const platforms = Object.fromEntries(
        Object.entries(PLATFORMS).map(([key, p]) => [key, { label: p.label, unavailable: p.unavailable() }]),
      );
      send('init', { runs: [...runs.values()], platforms });
      const onRun = (run) => send('run', run);
      events.on('run', onRun);
      req.on('close', () => events.off('run', onRun));
      return;
    }

    if (req.method === 'POST') {
      // 다른 웹사이트가 브라우저를 통해 이 API를 호출하지 못하도록 JSON 요청만 허용한다.
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return json(res, 415, { error: 'Content-Type은 application/json이어야 합니다.' });
      }
      const body = await readBody(req);
      if (url.pathname === '/api/runs') {
        return json(res, 201, createRun(String(body.topic || '').trim().slice(0, 200)));
      }
      if (url.pathname === '/api/settings') {
        const saved = saveSettings(body);
        if (saved.tunnel) startTunnel(PORT);
        else stopTunnel();
        return json(res, 200, settingsView());
      }
      if (url.pathname === '/api/generate') {
        return json(res, 201, generate(String(body.topic || '').trim().slice(0, 200)));
      }
      if (url.pathname === '/api/log') {
        logFromHook(body.msg, body.event);
        return json(res, 200, {});
      }
      const action = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/(research|content|image|fail|approve|reject)$/);
      if (action) {
        const [, id, name] = action;
        const handlers = {
          research: () => submitResearch(id, body),
          content: () => submitContent(id, body),
          image: () => generateImage(id),
          fail: () => failRun(id, body.error),
          approve: () => approve(id, body.captions, body.platforms),
          reject: () => reject(id),
        };
        return json(res, 200, await handlers[name]());
      }
    }

    json(res, 404, { error: '찾을 수 없는 경로입니다.' });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});

loadRuns();
if (getSettings().tunnel) startTunnel(PORT);
startScheduler();
server.listen(PORT, '127.0.0.1', () => console.log(`SNS Master: http://localhost:${PORT}`));
