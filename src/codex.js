import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function describe(event) {
  if (event.type === 'error') return `오류: ${event.message}`;
  if (event.type === 'turn.failed') return `오류: ${event.error?.message}`;
  if (event.type !== 'item.completed') return null;
  const item = event.item;
  if (item.type === 'agent_message') return item.text.trim();
  if (item.type === 'command_execution') return `명령 실행: ${item.command}`;
  return null;
}

// cwd 안에서만 파일을 쓸 수 있는 샌드박스로 codex exec를 실행한다.
export async function runCodex({ cwd, prompt, onLog }) {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-s', 'workspace-write', '-C', cwd, prompt];
  const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const message = describe(event);
    if (message) onLog(message);
  });

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`codex exec가 코드 ${code}로 종료되었습니다. ${stderr.trim()}`);
}
