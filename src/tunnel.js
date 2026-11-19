// Cloudflare 임시 터널을 서버가 직접 열고, 발급된 주소를 PUBLIC_BASE_URL에 반영한다.
// 임시 터널은 열 때마다 주소가 바뀌므로, .env 파일을 고치지 않고 실행 중인 프로세스의 환경 변수만 바꾼다.
import { spawn } from 'node:child_process';

const original = process.env.PUBLIC_BASE_URL || '';
export const tunnel = { wanted: false, url: null, error: null };
let child = null;
let retry = null;

export function startTunnel(port) {
  tunnel.wanted = true;
  if (child) return;
  tunnel.error = null;
  child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk) => {
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && tunnel.url !== match[0]) {
      tunnel.url = match[0];
      process.env.PUBLIC_BASE_URL = match[0];
      console.log(`터널이 연결되었습니다. ${match[0]}`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (error) => {
    tunnel.error = error.code === 'ENOENT' ? 'cloudflared가 설치되어 있지 않습니다. (brew install cloudflared)' : error.message;
    child = null;
  });
  child.on('close', () => {
    child = null;
    tunnel.url = null;
    process.env.PUBLIC_BASE_URL = original;
    // 터널이 끊기면 30초 뒤에 다시 연결한다.
    if (tunnel.wanted && !tunnel.error) retry = setTimeout(() => startTunnel(port), 30000);
  });
}

export function stopTunnel() {
  tunnel.wanted = false;
  clearTimeout(retry);
  child?.kill();
}

process.on('exit', () => child?.kill());
