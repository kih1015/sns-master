// Claude Code 훅: 리서치 중에 발생하는 웹 검색과 서브에이전트 이벤트를 로컬 웹 UI의 진행 로그로 전송한다.
// 서버가 꺼져 있거나 진행 중인 실행이 없으면 아무 일도 하지 않으며, Claude의 작업을 방해하지 않도록 항상 0으로 종료한다.
import path from 'node:path';

try { process.loadEnvFile(path.join(import.meta.dirname, '..', '.env')); } catch { /* 기본 포트를 사용한다. */ }

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  const agent = input.agent_type ? ` (${input.agent_type})` : '';
  const msg = {
    PostToolUse: input.tool_name === 'WebSearch' ? `웹 검색${agent}: ${input.tool_input?.query}` : null,
    SubagentStart: `서브에이전트 시작${agent}`,
    SubagentStop: `서브에이전트 종료${agent}`,
  }[input.hook_event_name];
  // 웹 UI가 제작 과정을 흐름도로 그릴 수 있도록, 문장으로 된 로그와 함께 구조화된 정보도 전송한다.
  const event = {
    kind: { PostToolUse: 'search', SubagentStart: 'agent_start', SubagentStop: 'agent_stop' }[input.hook_event_name],
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    query: input.tool_input?.query,
  };
  if (msg) {
    await fetch(`http://localhost:${process.env.PORT || 4321}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg, event }),
      signal: AbortSignal.timeout(1500),
    });
  }
} catch { /* 진행 로그 전송에 실패해도 작업은 계속한다. */ }
