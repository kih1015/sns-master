---
name: sns-run
description: 인스타그램, X, 쓰레드, 유튜브와 온라인 커뮤니티의 이슈를 조사하고, 그 내용으로 게시글과 이미지를 생성하여 로컬 웹 UI에 승인 요청을 등록한다. 사용자가 "SNS 콘텐츠 만들어줘", "트렌드 조사해서 게시물 만들어줘"라고 요청하거나 /sns-run을 입력할 때 사용한다.
argument-hint: "[조사할 주제]"
---

# SNS 콘텐츠 생성 실행

조사할 주제: $ARGUMENTS (비어 있으면 주제를 제한하지 않고 전체 트렌드를 조사합니다.)

아래 단계를 순서대로 수행합니다. 각 단계의 진행 상황은 `node cli.js` 명령으로 로컬 서버에 보고하며, 사용자는 웹 UI에서 실시간으로 확인합니다. 모든 명령은 프로젝트 루트에서 실행합니다.

## 지켜야 할 사항

- **승인과 게시는 절대로 직접 수행하지 않습니다.** 승인, 반려, 게시는 사용자가 웹 UI에서 수행합니다. 승인 API나 각 플랫폼의 API를 호출하는 명령은 훅이 차단합니다.
- 어느 단계에서든 진행할 수 없게 되면 `node cli.js fail <run_id> "<사유>"`를 실행하여 실패로 기록한 뒤, 사용자에게 사유를 설명합니다.
- 리서치 결과에 없는 사실을 게시글에 추가하지 않습니다.

## 1. 실행 등록

조사할 주제가 `run_id=<값>`으로 시작한다면, 웹 UI가 이미 실행을 등록한 것입니다. 이 경우에는 이 단계를 건너뛰고 그 `run_id`를 사용하며, `run_id=<값>` 뒤에 이어지는 내용이 조사할 주제입니다.

```sh
node cli.js start "<주제>"
```

출력된 `run_id`와 작업 디렉터리(`data/runs/<run_id>`)를 이후 단계에서 사용합니다. 서버에 연결할 수 없다는 오류가 출력되면, `npm start`를 백그라운드로 실행한 뒤 다시 시도합니다.

## 2. 이슈 리서치

먼저 이미 다룬 이슈를 확인합니다.

```sh
node cli.js history <run_id>
```

그다음 `sns-researcher` 서브에이전트 5개를 **하나의 메시지에서 동시에** 호출합니다. 조사 대상은 아래와 같이 하나씩 담당시키고, 각 프롬프트에 조사 대상, 조사 주제, 오늘 날짜를 명시합니다. 이미 다룬 이슈가 있다면 그 제목 목록도 프롬프트에 포함하여, 같은 이슈를 다시 보고하지 않도록 합니다.

| 조사 대상 | 프롬프트에 명시할 내용 |
| --- | --- |
| 인스타그램 | 플랫폼: 인스타그램 |
| X | 플랫폼: X(트위터) |
| 쓰레드 | 플랫폼: 쓰레드 |
| 유튜브 | 플랫폼: 유튜브 |
| 커뮤니티 | 커뮤니티 묶음: 에펨코리아(펨코), 디시인사이드, 더쿠 |

다섯 서브에이전트의 보고를 모두 받은 뒤 다음과 같이 정리합니다.

- 여러 곳에서 중복으로 보고된 이슈는 하나로 합치고 `platforms`에 해당하는 이름을 모두 기재합니다. SNS와 커뮤니티에서 함께 보고된 이슈는 화제성이 높은 것으로 판단합니다.
- 출처 URL이 없는 이슈는 제외합니다. 커뮤니티에서 보고된 이슈는 **언론 보도나 당사자의 공식 입장으로 확인되는 것만** 남기고, 커뮤니티 게시글에만 근거한 이슈는 제외합니다.
- **이미 다룬 이슈와 같은 이슈는 제외합니다.** 제목의 표현이 다르더라도 같은 사건이나 같은 논란이면 같은 이슈로 판단합니다. 제외한 이슈는 `excluded`에 제목과 사유(어느 날짜에 다룬 어떤 이슈와 겹치는지)를 기록합니다.
- 이미 다룬 이슈라도 그 이후에 결과 발표나 반전과 같은 **새로운 전개**가 있었다면 포함할 수 있습니다. 이 경우에는 `title`과 `summary`를 새로운 전개 중심으로 작성하여 이전 콘텐츠와 구분되도록 합니다.
- 화제성이 높은 순서로 최대 5개를 선정합니다.

정리한 결과를 `data/runs/<run_id>/research.json`에 아래 형식으로 저장하고 제출합니다.

```json
{
  "reported_count": 0,
  "excluded": [{ "title": "제외한 이슈의 제목", "reason": "11월 19일에 다룬 '...'과 같은 이슈" }],
  "issues": [{ "title": "", "summary": "", "why_trending": "", "platforms": [""], "sources": ["https://..."] }]
}
```

`reported_count`에는 다섯 서브에이전트가 보고한 이슈의 전체 개수(합치거나 제외하기 전의 개수)를 숫자로 기재합니다. `platforms`에는 "인스타그램", "X", "쓰레드", "유튜브", "커뮤니티" 가운데 해당하는 이름을 기재합니다.

```sh
node cli.js research <run_id>
```

## 3. 콘텐츠 작성

리서치 결과를 제출한 뒤에 이 단계를 시작합니다. 웹 UI가 제출 시각을 기준으로 단계별 소요 시간을 표시하므로, `content.json`을 리서치 제출보다 먼저 작성해 두지 않습니다.

이 단계의 목표는 두 가지입니다. 넘겨 보고 싶어지는 콘텐츠여야 하고([playbook.md](playbook.md)), **이슈를 처음 듣는 사람이 한 번 보고 이해할 수 있어야 합니다**([copywriting.md](copywriting.md)). 두 문서를 먼저 끝까지 읽습니다.

### 3-1. 이슈 선택

플레이북의 "이슈 선택" 기준에 따라 이슈 하나를 선택합니다.

### 3-2. 초안 작성 (sns-copywriter)

`sns-copywriter` 서브에이전트를 호출하여 문구를 작성하게 합니다. 프롬프트에 `research.json`의 경로, 선택한 이슈의 제목, 작업의 종류가 "초안 작성"임을 명시합니다.

응답으로 받은 JSON에 아래 항목을 더하여 `data/runs/<run_id>/content.json`에 저장합니다.

```json
{
  "selected_issue_title": "선택한 이슈의 제목 (research.json의 title과 동일하게)",
  "reason": "이 이슈와 이 표지 문구를 선택한 이유",
  "sources": ["https://선택한-이슈의-출처"],
  "review": null,

  "explainer": "(sns-copywriter의 응답) 이슈를 모르는 사람에게 설명하듯 정리한 문장",
  "spine": "(sns-copywriter의 응답) 연결하는 말을 넣어서 세운 한 줄 줄거리",
  "hook_candidates": ["(sns-copywriter의 응답) 표지 문구 후보 전체"],
  "kicker": "지금 화제",
  "slides": [{ "title": "", "body": "" }],
  "image_prompt": "표지 배경 그림 (글자 없음)",
  "reel": {
    "style": "모든 그림에 공통으로 적용할 화풍",
    "scenes": [{ "text": "제목\n(2줄 이하)", "sub": "설명 문장\n(2줄 이하)", "highlight": "강조할 어절", "image_prompt": "장면의 그림" }]
  },
  "captions": { "instagram": "", "threads": "", "x": "" }
}
```

### 3-3. 독자 시험, 흐름 검토, 심사 (sns-reader, sns-flow, sns-critic)

세 서브에이전트를 **하나의 메시지에서 동시에** 호출합니다.

- **`sns-reader`**: 이슈를 모르는 시청자의 입장에서 이해되는지를 시험합니다. 프롬프트에는 **화면 문구만** 적습니다. 릴스는 장면 번호와 함께 `text`와 `sub`를, 카드뉴스는 슬라이드 번호와 함께 `title`과 `body`를 적습니다. 이슈의 제목, 요약, 파일 경로, `explainer`와 같은 배경 정보는 **절대로 전달하지 않습니다.** 배경을 알려 주면 시험의 의미가 없어집니다.
- **`sns-flow`**: 장면이 하나의 이야기로 이어지는지를 장면과 장면 사이마다 검토합니다. 프롬프트에 `explainer`, `spine`, 그리고 `sns-reader`에게 전달한 것과 같은 화면 문구를 적습니다.
- **`sns-critic`**: 확산 기준과 사실 정확성을 심사합니다. 프롬프트에 `content.json`과 `research.json`의 경로를 전달합니다.

### 3-4. 수정 (sns-copywriter)

아래 중 하나라도 해당하면 `sns-copywriter`를 다시 호출하여 고치게 합니다. 프롬프트에 `research.json`과 `content.json`의 경로, 작업의 종류가 "수정"임을 명시하고, 지적 사항을 모두 전달합니다.

- `sns-reader`의 릴스 또는 카드뉴스의 `score`가 4점 미만이거나, `unclear` 또는 `unanswered`에 항목이 있는 경우
- `sns-reader`의 `retell`이 `explainer`의 내용과 다르거나, 중요한 내용이 빠져 있는 경우 (이 비교는 직접 수행합니다)
- `sns-flow`의 릴스 또는 카드뉴스의 `score`가 4점 미만이거나, `links`에 `ok`가 `false`인 연결이 있거나, `repeats` 또는 `order`에 지적이 있는 경우
- `sns-critic`의 `pass`가 `false`인 경우

수정할 때의 기준은 다음과 같습니다.

- **이해되지 않는다는 지적과 이어지지 않는다는 지적이 가장 먼저입니다.** 후킹을 위해 이해하기 어렵거나 흐름이 끊기는 문구를 남겨 두지 않습니다.
- 흐름에 대한 지적은 문구 하나를 고치는 것으로 끝나지 않는 경우가 많습니다. 장면의 순서를 바꾸거나 장면을 빼야 한다면 그렇게 합니다.
- `accuracy`와 관련된 지적은 반드시 반영하고, 리서치 결과에 없는 사실은 삭제합니다.
- 수정은 한 번만 요청하고, 수정한 결과로 `content.json`을 갱신합니다.

수정한 뒤에는 `sns-reader`와 `sns-flow`를 **한 번 더 동시에** 호출하여, 고친 화면 문구가 실제로 이해되고 이어지는지 확인합니다. 전달하는 내용은 처음과 같은 방식입니다. 이 결과는 `review.reader_after`와 `review.flow_after`에 기록합니다.

- 다시 확인한 결과에도 `unclear`나 `ok`가 `false`인 연결이 남아 있다면, 그 부분은 `copywriting.md`의 규칙에 따라 직접 고칩니다. 독자 시험, 흐름 검토, 심사는 더 요청하지 않습니다.
- 처음부터 수정할 것이 없었다면 다시 확인하지 않고 `reader_after`와 `flow_after`를 `null`로 둡니다.

### 3-5. 문장 다듬기 (korean-skills)

화면 문구와 게시글의 한국어 문장을 다듬습니다. `korean-skills:humanizer` 스킬을 호출하여 번역투, 어색한 쉼표, 상투적인 표현을 고치고, `korean-skills:grammar-checker` 스킬을 호출하여 맞춤법과 띄어쓰기를 확인합니다. 대상은 `slides`, `reel.scenes`의 `text`와 `sub`, `captions`입니다.

- 뜻과 사실을 바꾸지 않습니다. 분량 제한을 넘지 않는지 다시 확인합니다.
- 줄바꿈(`\n`)의 위치와 `highlight`가 `text`에 그대로 있는지 확인합니다.
- 두 스킬을 사용할 수 없는 환경이라면 이 단계를 건너뛰고, 그 사실을 `review.polish`에 적습니다.

### 3-6. 최종 확인 (sns-critic)

문구를 고치고 다듬은 뒤에는 `sns-critic`을 **한 번 더** 호출하여, 최종 `content.json`의 사실 정확성과 주제의 민감도를 확인합니다. 이 콘텐츠는 사람이 확인하지 않고 자동으로 게시될 수 있으므로, 이 단계를 생략하지 않습니다.

- `accuracy`에 대한 지적이 남아 있으면 해당 문장을 고치거나 삭제합니다. 리서치 결과에 없는 사실은 남기지 않습니다.
- 응답의 `scores`와 `safety`를 `review.final`에 그대로 기록합니다. 다른 기준에 대한 지적은 반영하지 않아도 됩니다.

### 3-7. 기록과 제출

제작 과정을 웹 UI의 흐름도에 표시할 수 있도록, `content.json`의 `review`에 아래 형식으로 기록합니다.

```json
{
  "scores": { "hook": 0, "flow": 0, "share": 0, "accuracy": 0, "caption": 0 },
  "pass": false,
  "safety": { "risk": "low", "reasons": [] },
  "fixes": ["sns-critic이 지적한 내용 그대로"],
  "reader": {
    "reel": { "retell": "", "unclear": [{ "where": "", "what": "" }], "unanswered": [""], "score": 0 },
    "carousel": { "retell": "", "unclear": [], "unanswered": [], "score": 0 }
  },
  "flow": {
    "reel": { "read_through": "", "links": [{ "from": 1, "to": 2, "ok": true, "problem": "", "fix": "" }], "repeats": [""], "order": "", "score": 0 },
    "carousel": { "read_through": "", "links": [], "repeats": [], "order": "", "score": 0 }
  },
  "flow_after": null,
  "reader_after": { "reel": { "retell": "", "unclear": [], "unanswered": [], "score": 0 }, "carousel": { "retell": "", "unclear": [], "unanswered": [], "score": 0 } },
  "final": { "scores": { "hook": 0, "flow": 0, "share": 0, "accuracy": 0, "caption": 0 }, "safety": { "risk": "low", "reasons": [] } },
  "applied": ["실제로 고친 내용을 한 문장씩"],
  "polish": ["문장 다듬기에서 고친 내용을 한 문장씩"]
}
```

`scores`, `pass`, `safety`, `fixes`에는 `sns-critic`의 첫 번째 응답을, `final`에는 최종 확인의 응답을, `reader`와 `flow`에는 `sns-reader`와 `sns-flow`의 첫 번째 응답을, `reader_after`와 `flow_after`에는 수정한 뒤에 다시 확인한 응답을 그대로 넣습니다. 고친 내용이 없으면 `applied`와 `polish`는 빈 배열로 둡니다.

서버는 다음 조건을 검사하며, 조건에 맞지 않으면 제출이 거부됩니다. 거부되면 문장을 압축하지 말고 사실을 줄여서 다시 제출합니다.

- `slides`는 4~8장이며 `title`은 36자 이하, `body`는 표지 40자 이하이고 나머지는 130자 이하이며 6줄 이하입니다.
- `reel.scenes`는 4~8개이며 `text`는 2줄 이하이고 한 줄은 13자 이하, `sub`는 2줄 이하이고 한 줄은 18자 이하입니다. `highlight`에는 `text`에 있는 어절만 사용할 수 있습니다.
- `selected_issue_title`이 이미 다룬 이슈의 제목과 같으면 거부됩니다.

```sh
node cli.js content <run_id>
```

## 4. 이미지 생성

서버가 Codex의 이미지 생성 도구로 표지 배경과 릴스의 장면용 그림을 만든 뒤, 슬라이드 전체를 조판하고 HyperFrames로 릴스를 렌더링합니다. 보통 3~5분 정도 소요됩니다. Bash 도구의 제한 시간을 600000밀리초로 지정하여 실행합니다.

```sh
node cli.js image <run_id>
```

실패하면 같은 명령으로 한 번 더 시도하고, 다시 실패하면 사용자에게 오류 내용을 설명합니다. (이 단계의 실패는 서버가 직접 기록하므로 `fail` 명령을 실행하지 않습니다.)

## 5. 사용자에게 안내

이미지 생성이 완료되면 실행은 승인 대기 상태가 됩니다. 선택한 이슈, 표지 문구, 독자 시험, 흐름 검토, 심사에서 지적되어 수정한 내용을 간략하게 요약하고, 웹 UI(기본 주소 http://localhost:4321)에서 이미지와 게시글을 검토한 뒤 승인하거나 반려하도록 안내하고 작업을 마칩니다.
