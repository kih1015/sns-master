# SNS Master

인스타그램, X, 쓰레드, 유튜브에서 화제가 되는 이슈를 조사하고, 그 내용으로 이미지와 게시글을 생성한 뒤, 승인을 받아 각 플랫폼에 게시하는 Claude Code 하네스입니다.

## 실행

```sh
cp .env.example .env   # 게시할 플랫폼의 자격 증명을 입력합니다.
npm start              # 웹 UI: http://localhost:4321
```

그다음 웹 UI의 왼쪽 위에 주제를 입력하고 "만들기"를 누르면, 서버가 Claude Code를 비대화형으로 실행하여 `/sns-run` 스킬을 수행합니다. 한 번에 한 건만 실행할 수 있습니다.

이 폴더에서 Claude Code를 열고 `/sns-run [주제]`를 직접 입력해도 됩니다. 처음 여는 경우에는 폴더 신뢰 여부를 묻는 창에서 수락해야 `.claude/settings.json`의 허용 규칙과 훅이 적용됩니다.

Node.js 22 이상과 로그인된 Codex CLI가 필요하며, 별도로 설치할 패키지는 없습니다. 이미지 변환에는 macOS에 내장된 `sips`를 사용합니다.

## 릴스 음원 준비

릴스에 사용하는 음원은 재배포할 수 없어서 저장소에 포함되어 있지 않습니다.

- **배경음악**: `reel-template/assets/bgm/` 폴더에 `.wav` 또는 `.mp3` 파일을 넣으면, 실행할 때마다 그중 하나를 번갈아 사용합니다. 길이는 30초 이상이어야 합니다. 폴더가 비어 있으면 배경음악 없이 릴스를 만듭니다. HyperFrames에 로그인되어 있다면 `hyperframes media-use resolve --type bgm --intent "<분위기>"` 명령으로 음악을 받을 수 있습니다.
- **효과음**: 장면이 바뀔 때 사용하는 효과음은 HyperFrames 플러그인에 들어 있는 파일을 렌더링할 때 자동으로 가져옵니다.

글꼴은 Pretendard를 사용하며, 라이선스(SIL OFL 1.1)는 `reel-template/assets/fonts/LICENSE.txt`에 있습니다.

## 구성

| 구성 요소 | 위치 | 역할 |
| --- | --- | --- |
| 스킬 | `.claude/skills/sns-run/` | 전체 절차를 지휘하고, 리서치 결과를 정리하여 게시글을 작성합니다. |
| 리서처 서브에이전트 | `.claude/agents/sns-researcher.md` | 인스타그램, X, 쓰레드, 유튜브, 커뮤니티(에펨코리아, 디시인사이드, 더쿠)를 하나씩 맡아 병렬로 조사합니다. |
| 플레이북 | `.claude/skills/sns-run/playbook.md` | 인스타그램에서 확산되는 카드뉴스의 작성 기준입니다. 성과를 보면서 이 파일을 수정하면 이후의 콘텐츠에 반영됩니다. |
| 문구 작성 가이드 | `.claude/skills/sns-run/copywriting.md` | 이슈를 처음 듣는 사람도 이해하도록 화면 문구를 쓰는 기준입니다. |
| 카피라이터 서브에이전트 | `.claude/agents/sns-copywriter.md` | 카드뉴스, 릴스 대본, 게시글의 문구를 작성하고 지적 사항을 반영하여 고칩니다. |
| 독자 시험 서브에이전트 | `.claude/agents/sns-reader.md` | 배경 정보 없이 화면 문구만 읽고, 이해한 내용과 이해되지 않는 부분을 보고합니다. |
| 흐름 검토 서브에이전트 | `.claude/agents/sns-flow.md` | 이웃한 장면 사이를 하나씩 보면서, 장면들이 하나의 이야기로 이어지는지 검토합니다. |
| 심사 서브에이전트 | `.claude/agents/sns-critic.md` | 초안을 플레이북 기준으로 채점하고 수정할 점을 지적합니다. |
| 릴스 템플릿 | `reel-template/`, `src/reel.js` | 릴스의 화면 구성과 모션, 배경음악, 글꼴입니다. 장면의 모션은 `src/reel.js`가 생성합니다. |
| 진행 훅 | `hooks/progress.js` | 웹 검색과 서브에이전트의 시작 및 종료를 웹 UI의 진행 로그로 전송합니다. |
| 차단 훅 | `hooks/guard.js` | Claude가 승인 API나 플랫폼 API를 직접 호출하려는 명령을 차단합니다. |
| 보고 명령 | `cli.js` | 스킬이 단계별 산출물을 서버에 제출할 때 사용합니다. |
| 서버 | `server.js`, `src/` | 웹 UI, 상태 저장, Codex 이미지 생성, 승인 이후의 게시를 담당합니다. |

## 동작 순서

1. 이슈 리서치: `sns-researcher` 서브에이전트 5개가 SNS 플랫폼 네 곳과 커뮤니티를 조사합니다.
2. 콘텐츠 작성: 이슈 하나를 선택한 뒤 `sns-copywriter`가 카드뉴스, 릴스 대본, 게시글을 작성합니다. `sns-reader`의 독자 시험, `sns-flow`의 흐름 검토, `sns-critic`의 심사를 받아 고치고, `korean-skills` 플러그인의 스킬로 문장을 다듬습니다.
3. 이미지 생성: 서버가 Codex로 표지 배경 이미지를 만든 뒤, 슬라이드의 글자를 HTML로 조판하여 Chrome으로 촬영합니다. (`src/render.js`, Chrome 필요)
   이어서 릴스 대본으로 HyperFrames 프로젝트를 생성하여 세로형 영상(`reel.mp4`)을 렌더링합니다. (`src/reel.js`, HyperFrames 플러그인 필요)
4. 승인: 사용자가 웹 UI에서 이미지와 게시글을 확인하고, 필요하면 게시글을 수정한 뒤 승인하거나 반려합니다.
5. 게시: 서버가 자격 증명이 설정된 플랫폼에만 공식 API로 게시하고, 설정되지 않은 플랫폼은 건너뜁니다.

실행 기록과 생성된 이미지는 `data/runs/<실행 ID>/`에 저장됩니다.

## 인스타그램과 쓰레드에 게시할 때

두 플랫폼은 공개 URL에서 이미지를 가져가므로, 터널로 이 서버를 외부에 연결하고 그 주소를 `PUBLIC_BASE_URL`에 입력해야 합니다.

```sh
cloudflared tunnel --url http://localhost:4321
```

터널로 들어온 요청에는 `/media/` 경로의 이미지만 응답하며, UI와 API는 localhost에서만 접근할 수 있습니다.

## 유튜브

유튜브는 현재 리서치 대상으로만 사용하며, 게시 형태는 아직 결정되지 않았습니다.
