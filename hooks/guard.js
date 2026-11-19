// Claude Code 훅(PreToolUse, Bash): 승인과 게시는 사람이 웹 UI에서만 수행해야 하므로,
// Claude가 승인 API나 각 플랫폼의 게시 API를 직접 호출하려는 명령을 차단한다.
// 명령 문자열을 검사하는 방식이므로 완전한 보안 경계가 아니라, 실수로 게시되는 사고를 방지하는 장치이다.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

const command = JSON.parse(raw).tool_input?.command || '';
const BLOCKED = /\/(approve|reject)\b|graph\.instagram\.com|graph\.facebook\.com|graph\.threads\.com|api\.x\.com|upload\.twitter\.com/;

if (BLOCKED.test(command)) {
  console.error('차단됨: 콘텐츠의 승인, 반려, 게시는 사용자가 웹 UI에서 직접 수행해야 합니다. 사용자에게 UI에서 검토하도록 안내하십시오.');
  process.exit(2);
}
