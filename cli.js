// /sns-run 스킬이 진행 상황과 산출물을 로컬 서버에 보고할 때 사용하는 명령이다.
// 승인과 게시는 사람이 웹 UI에서만 수행하므로, 이 명령에는 해당 기능을 두지 않는다.
import { readFileSync } from 'node:fs';
import path from 'node:path';

try { process.loadEnvFile(path.join(import.meta.dirname, '.env')); } catch { /* .env 파일이 없으면 기본값을 사용한다. */ }
const BASE = `http://localhost:${process.env.PORT || 4321}`;
const [command, arg, extra] = process.argv.slice(2);

async function post(pathname, body = {}) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`${BASE}에 연결할 수 없습니다. 'npm start'로 서버를 먼저 실행하십시오.`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

const readJson = (id, name) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'data', 'runs', id, name), 'utf8'));

const commands = {
  async start() {
    const run = await post('/api/runs', { topic: arg || '' });
    console.log(`run_id: ${run.id}\n작업 디렉터리: data/runs/${run.id}\nUI: ${BASE}`);
  },
  // 최근 30일 동안 이미 다룬 이슈를 출력한다. 인자로 현재 실행의 run_id를 주면 그 실행은 제외한다.
  async history() {
    let issues;
    try {
      issues = await (await fetch(`${BASE}/api/history?except=${arg || ''}`)).json();
    } catch {
      throw new Error(`${BASE}에 연결할 수 없습니다. 'npm start'로 서버를 먼저 실행하십시오.`);
    }
    if (!issues.length) return console.log('최근 30일 동안 다룬 이슈가 없습니다.');
    console.log(`최근 30일 동안 이미 다룬 이슈 ${issues.length}개:`);
    for (const issue of issues) console.log(`- [${issue.date}, ${issue.state}] ${issue.title}${issue.summary ? `\n  ${issue.summary}` : ''}`);
  },
  async research() {
    await post(`/api/runs/${arg}/research`, readJson(arg, 'research.json'));
    console.log('리서치 결과를 제출했습니다. 다음 단계는 콘텐츠 작성입니다.');
  },
  async content() {
    await post(`/api/runs/${arg}/content`, readJson(arg, 'content.json'));
    console.log('콘텐츠를 제출했습니다. 다음 단계는 이미지 생성입니다.');
  },
  async image() {
    await post(`/api/runs/${arg}/image`);
    console.log(`이미지를 생성했습니다. 사용자가 ${BASE} 에서 검토하고 승인하면 게시됩니다.`);
  },
  async fail() {
    await post(`/api/runs/${arg}/fail`, { error: extra });
    console.log('실행을 실패로 기록했습니다.');
  },
};

if (!commands[command]) {
  console.error('사용법: node cli.js <start [주제] | history [run_id] | research <run_id> | content <run_id> | image <run_id> | fail <run_id> <사유>>');
  process.exit(1);
}
commands[command]().catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exit(1);
});
