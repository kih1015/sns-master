import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runCodex } from './codex.js';
import { PLATFORMS } from './publishers.js';
import { renderSlides } from './render.js';
import { renderReel, sceneLayouts } from './reel.js';
import { getSettings, saveSettings } from './settings.js';

export const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'runs');
export const events = new EventEmitter();
export const runs = new Map();

// 리서치와 콘텐츠 작성은 Claude Code(/sns-run 스킬)가 수행하고, 이미지 생성과 게시는 이 서버가 수행한다.
const STAGES = [
  ['research', '이슈 리서치'],
  ['content', '콘텐츠 작성'],
  ['image', '이미지 생성'],
  ['approval', '승인'],
  ['publish', '게시'],
];
const CAPTION_KEYS = ['instagram', 'threads', 'x'];

// 표지의 제목은 서버가 이미지 위에 직접 조판하므로, 생성하는 이미지에는 글자를 넣지 않는다.
const imagePrompt = (prompt) => `내장 이미지 생성 도구를 사용하여 아래 프롬프트에 해당하는 세로(4:5 비율) 이미지를 한 장 생성하고, 현재 디렉터리에 image.png라는 이름으로 저장하십시오.
- 이미지 안에 글자, 숫자, 로고, 워터마크를 절대로 넣지 마십시오.
- 핵심 피사체는 화면의 위쪽 절반에 배치하고, 아래쪽 절반은 제목이 올라갈 수 있도록 단순하게 구성하십시오.
- 현재 디렉터리의 다른 파일은 수정하지 마십시오.

프롬프트: ${prompt}`;

// 릴스의 장면마다 넣는 그림이다. 카드 배치에는 가로 그림을, 화면을 가득 채우는 배치에는 세로 그림을 사용한다.
const sceneImagePrompt = (prompt, style, layout) => `내장 이미지 생성 도구를 사용하여 아래 프롬프트에 해당하는 ${layout === 'card' ? '가로(3:2 비율)' : '세로(2:3 비율)'} 이미지를 한 장 생성하고, 현재 디렉터리에 image.png라는 이름으로 저장하십시오.
- 이미지 안에 글자, 숫자, 로고, 워터마크를 절대로 넣지 마십시오.
- 핵심 피사체는 화면의 중앙에 배치하고, 피사체 전체가 가장자리에서 잘리지 않도록 둘레에 여백을 두십시오.
- 현재 디렉터리의 다른 파일은 수정하지 마십시오.

프롬프트: ${prompt}${style ? `\n화풍: ${style}` : ''}`;

// 한 번에 limit개까지만 동시에 실행한다.
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const runDir = (id) => path.join(DATA_DIR, id);
const now = () => new Date().toISOString();
const stageOf = (run, key) => run.stages.find((stage) => stage.key === key);

function getRun(id) {
  const run = runs.get(id);
  if (!run) throw new Error('실행을 찾을 수 없습니다.');
  return run;
}

function save(run) {
  writeFileSync(path.join(runDir(run.id), 'run.json'), JSON.stringify(run, null, 2));
  events.emit('run', run);
}

function addLog(run, stage, msg) {
  run.logs.push({ t: now(), stage, msg: String(msg).slice(0, 1000) });
  if (run.logs.length > 300) run.logs.shift();
  save(run);
}

function setStage(run, key, status, error = null) {
  const stage = stageOf(run, key);
  if (status === 'running') Object.assign(stage, { status, startedAt: now(), endedAt: null, error: null });
  else Object.assign(stage, { status, endedAt: now(), error });
}

function requireRunningStage(run, key) {
  const stage = stageOf(run, key);
  if (run.status !== 'running' || stage.status !== 'running') {
    throw new Error(`'${stage.label}' 단계가 진행 중인 실행이 아닙니다.`);
  }
}

async function runStage(run, key, fn) {
  setStage(run, key, 'running');
  save(run);
  try {
    await fn((msg) => addLog(run, key, msg));
    setStage(run, key, 'done');
  } catch (error) {
    setStage(run, key, 'failed', error.message);
    run.status = 'failed';
    addLog(run, key, `실패: ${error.message}`);
    throw error;
  } finally {
    save(run);
  }
}

// auto는 예약 실행으로 시작된 실행인지를 나타낸다.
export function createRun(topic, auto = false) {
  const run = {
    id: randomUUID(),
    topic,
    auto,
    createdAt: now(),
    status: 'running',
    stages: STAGES.map(([key, label]) => ({ key, label, status: 'pending' })),
    logs: [],
    research: null,
    content: null,
    image: null,
    publish: {},
  };
  mkdirSync(runDir(run.id), { recursive: true });
  runs.set(run.id, run);
  setStage(run, 'research', 'running');
  save(run);
  return run;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const textList = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);

// 이미 콘텐츠로 만든 이슈의 목록이다. 리서치 단계에서 같은 이슈를 다시 고르지 않도록 스킬에 전달한다.
// 반려한 이슈도 다시 제안되지 않도록 포함하고, 콘텐츠가 만들어지기 전에 실패한 실행은 포함하지 않는다.
export function coveredIssues(exceptId) {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return [...runs.values()]
    .filter((run) => run.id !== exceptId && run.content && run.status !== 'failed' && new Date(run.createdAt) >= since)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 40)
    .map((run) => ({
      title: run.content.selected_issue_title,
      summary: run.research?.issues.find((issue) => issue.title === run.content.selected_issue_title)?.summary || '',
      date: run.createdAt.slice(0, 10),
      state: { done: '게시함', rejected: '반려함' }[run.status] || '승인 대기 중',
    }));
}

export function submitResearch(id, body) {
  const run = getRun(id);
  requireRunningStage(run, 'research');
  const issues = (Array.isArray(body.issues) ? body.issues : []).map((issue) => ({
    title: text(issue.title),
    summary: text(issue.summary),
    why_trending: text(issue.why_trending),
    platforms: textList(issue.platforms),
    sources: textList(issue.sources),
  }));
  if (!issues.length || issues.some((issue) => !issue.title || !issue.summary)) {
    throw new Error('issues 배열의 각 항목에는 title과 summary가 있어야 합니다.');
  }
  // reported_count는 리서처들이 보고한 이슈의 전체 개수이며, 흐름도에서 몇 개 중에 추렸는지를 보여 주는 데 사용한다.
  // excluded는 이미 다룬 이슈와 겹쳐서 제외한 이슈의 기록이며, 흐름도에 표시한다.
  const excluded = (Array.isArray(body.excluded) ? body.excluded : [])
    .map((item) => ({ title: text(item.title), reason: text(item.reason) }))
    .filter((item) => item.title)
    .slice(0, 20);
  run.research = { issues, excluded, reported_count: Number.isInteger(body.reported_count) ? body.reported_count : null };
  setStage(run, 'research', 'done');
  setStage(run, 'content', 'running');
  save(run);
  return run;
}

const readerResult = (reader) => Object.fromEntries(['reel', 'carousel'].map((kind) => {
  const result = reader?.[kind];
  return [kind, result ? {
    retell: text(result.retell).slice(0, 600),
    unclear: (Array.isArray(result.unclear) ? result.unclear : []).map((item) => ({ where: text(item.where), what: text(item.what) })).slice(0, 10),
    unanswered: textList(result.unanswered).slice(0, 5),
    score: Number(result.score) || 0,
  } : null];
}));

const safetyResult = (safety) => (safety ? { risk: safety.risk === 'low' ? 'low' : 'high', reasons: textList(safety.reasons).slice(0, 6) } : null);

// 장면과 장면 사이가 이어지는지를 검토한 결과이다.
const flowResult = (flow) => Object.fromEntries(['reel', 'carousel'].map((kind) => {
  const result = flow?.[kind];
  return [kind, result ? {
    read_through: text(result.read_through).slice(0, 400),
    links: (Array.isArray(result.links) ? result.links : []).map((link) => ({
      from: Number(link.from) || 0, to: Number(link.to) || 0, ok: link.ok === true, problem: text(link.problem).slice(0, 300), fix: text(link.fix).slice(0, 300),
    })).slice(0, 10),
    repeats: textList(result.repeats).slice(0, 6),
    order: text(result.order).slice(0, 300),
    score: Number(result.score) || 0,
  } : null];
}));

export function submitContent(id, body) {
  const run = getRun(id);
  requireRunningStage(run, 'content');
  const hosts = textList(body.sources).map((url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  });
  const content = {
    selected_issue_title: text(body.selected_issue_title),
    reason: text(body.reason),
    kicker: text(body.kicker) || '지금 화제',
    slides: (Array.isArray(body.slides) ? body.slides : []).map((slide) => ({ title: text(slide.title), body: text(slide.body) })),
    sources: [...new Set(hosts.filter(Boolean))].slice(0, 3),
    image_prompt: text(body.image_prompt),
    captions: Object.fromEntries(CAPTION_KEYS.map((key) => [key, text(body.captions?.[key])])),
    // 릴스 대본이다. 없으면 카드뉴스만 만든다.
    reel: Array.isArray(body.reel?.scenes) ? {
      style: text(body.reel.style).slice(0, 200),
      scenes: body.reel.scenes.map((scene) => ({
        text: text(scene.text), sub: text(scene.sub), highlight: text(scene.highlight), image_prompt: text(scene.image_prompt).slice(0, 500),
      })),
    } : null,
    // 아래 두 항목은 제작 과정을 흐름도로 보여 주기 위한 기록이며, 없어도 제출할 수 있다.
    explainer: text(body.explainer).slice(0, 1000),
    spine: text(body.spine).slice(0, 600),
    hook_candidates: textList(body.hook_candidates).slice(0, 10),
    review: body.review && typeof body.review === 'object' ? {
      scores: Object.fromEntries(['hook', 'flow', 'share', 'accuracy', 'caption'].map((key) => [key, Number(body.review.scores?.[key]) || 0])),
      pass: body.review.pass === true,
      fixes: textList(body.review.fixes).slice(0, 10),
      applied: textList(body.review.applied).slice(0, 10),
      polish: textList(body.review.polish).slice(0, 10),
      // 사람의 검토 없이 게시해도 되는 주제인지에 대한 심사 결과이다. 판정이 없으면 자동 게시하지 않는다.
      safety: safetyResult(body.review.safety),
      // 문구를 모두 고친 뒤에 다시 심사한 결과이다. 자동 게시의 기준은 이 결과를 우선하여 사용한다.
      final: body.review.final ? {
        accuracy: Number(body.review.final.scores?.accuracy) || 0,
        safety: safetyResult(body.review.final.safety),
      } : null,
      // 이슈를 모르는 독자에게 화면 문구만 보여 주고 이해한 내용을 확인한 결과이다. (수정하기 전과 수정한 뒤)
      reader: readerResult(body.review.reader),
      reader_after: body.review.reader_after ? readerResult(body.review.reader_after) : null,
      flow: body.review.flow ? flowResult(body.review.flow) : null,
      flow_after: body.review.flow_after ? flowResult(body.review.flow_after) : null,
    } : null,
  };
  if (!content.selected_issue_title || !content.image_prompt || Object.values(content.captions).some((caption) => !caption)) {
    throw new Error('selected_issue_title, image_prompt, captions.instagram, captions.threads, captions.x는 필수입니다.');
  }
  // 슬라이드의 글자가 화면 밖으로 넘치지 않도록 분량을 제한한다.
  const { slides } = content;
  if (slides.length < 4 || slides.length > 8) throw new Error('slides는 4장 이상 8장 이하여야 합니다.');
  if (content.kicker.length > 12) throw new Error('kicker는 12자 이하여야 합니다.');
  slides.forEach((slide, index) => {
    const isCover = index === 0;
    if (!slide.title || (!isCover && !slide.body)) throw new Error(`${index + 1}번 슬라이드에 title 또는 body가 없습니다.`);
    if (slide.title.length > 36) throw new Error(`${index + 1}번 슬라이드의 title은 36자 이하여야 합니다. (현재 ${slide.title.length}자)`);
    if (slide.body.length > (isCover ? 40 : 130)) throw new Error(`${index + 1}번 슬라이드의 body가 너무 깁니다. 표지는 40자, 나머지는 130자 이하여야 합니다. (현재 ${slide.body.length}자)`);
    if (slide.body.split('\n').length > 6) throw new Error(`${index + 1}번 슬라이드의 body는 6줄 이하여야 합니다.`);
  });
  // 의미가 같은 이슈인지는 스킬이 판단하고, 여기에서는 제목이 완전히 같은 경우만 마지막으로 걸러 낸다.
  const duplicate = coveredIssues(run.id).find((issue) => issue.title === content.selected_issue_title);
  if (duplicate) throw new Error(`'${duplicate.title}'은(는) ${duplicate.date}에 이미 다룬 이슈입니다. 다른 이슈를 선택하십시오.`);
  // 릴스의 글자는 화면에 크게 표시되므로 한 줄의 길이를 엄격하게 제한한다.
  if (content.reel) {
    const { scenes } = content.reel;
    if (scenes.length < 4 || scenes.length > 8) throw new Error('reel.scenes는 4개 이상 8개 이하여야 합니다.');
    scenes.forEach((scene, index) => {
      const lines = scene.text.split('\n');
      if (!scene.text || lines.length > 2 || lines.some((line) => line.length > 13)) {
        throw new Error(`릴스 ${index + 1}번 장면의 text는 2줄 이하이고, 한 줄은 13자 이하여야 합니다.`);
      }
      const subLines = scene.sub.split('\n');
      if (subLines.length > 2 || subLines.some((line) => line.length > 18)) {
        throw new Error(`릴스 ${index + 1}번 장면의 sub는 2줄 이하이고, 한 줄은 18자 이하여야 합니다.`);
      }
      const words = scene.text.split(/\s+/);
      if (scene.highlight.split(/\s+/).filter(Boolean).some((word) => !words.includes(word))) {
        throw new Error(`릴스 ${index + 1}번 장면의 highlight는 text에 있는 어절을 그대로 사용해야 합니다.`);
      }
    });
  }
  run.content = content;
  setStage(run, 'content', 'done');
  save(run);
  return run;
}

// 이미지 생성 단계는 실패한 경우에 다시 요청할 수 있다.
export async function generateImage(id) {
  const run = getRun(id);
  const stage = stageOf(run, 'image');
  if (!run.content || !['pending', 'failed'].includes(stage.status)) {
    throw new Error('이미지를 생성할 수 있는 상태가 아닙니다. 콘텐츠를 먼저 제출해야 합니다.');
  }
  const cwd = runDir(run.id);
  run.status = 'running';
  await runStage(run, 'image', async (onLog) => {
    // 표지 그림과 릴스의 장면용 그림을 동시에 생성한다.
    // 장면용 그림은 만들지 못하더라도 그림이 없는 장면으로 대체되므로, 실패 사유만 기록하고 계속 진행한다.
    const { reel } = run.content;
    const layouts = sceneLayouts(reel?.scenes || []);
    const sceneJobs = (reel?.scenes || []).map((scene, i) => ({ scene, number: i + 1, layout: layouts[i] })).filter((job) => job.layout);
    rmSync(path.join(cwd, 'scene-img'), { recursive: true, force: true });
    if (sceneJobs.length) onLog(`릴스에 넣을 그림 ${sceneJobs.length}장을 함께 만들고 있습니다.`);
    const sceneImages = pool(sceneJobs, 3, async ({ scene, number, layout }) => {
      const dir = path.join(cwd, 'scene-img', String(number));
      mkdirSync(dir, { recursive: true });
      try {
        await runCodex({ cwd: dir, prompt: sceneImagePrompt(scene.image_prompt, reel.style, layout), onLog: () => {} });
        if (!existsSync(path.join(dir, 'image.png'))) throw new Error('image.png 파일이 생성되지 않았습니다.');
        onLog(`릴스 ${number}번 장면의 그림을 만들었습니다.`);
      } catch (error) {
        onLog(`릴스 ${number}번 장면의 그림을 만들지 못해서 그림 없이 진행합니다. ${error.message.slice(0, 200)}`);
      }
    });
    await runCodex({ cwd, prompt: imagePrompt(run.content.image_prompt), onLog });
    await sceneImages;
    if (!existsSync(path.join(cwd, 'image.png'))) throw new Error('Codex가 image.png 파일을 생성하지 않았습니다.');
    onLog('슬라이드를 조판하고 있습니다.');
    run.images = await renderSlides(cwd, run.content);
    run.image = run.images[0];
    // 릴스 제작에 실패하더라도 카드뉴스는 게시할 수 있도록, 실패 사유만 기록하고 계속 진행한다.
    if (run.content.reel) {
      onLog('릴스를 렌더링하고 있습니다.');
      try {
        run.reel = await renderReel(cwd, run.content, run.id);
        run.reelError = null;
      } catch (error) {
        run.reel = null;
        run.reelError = error.message.slice(0, 500);
        onLog(`릴스를 만들지 못했습니다. ${run.reelError}`);
      }
    }
  });
  setStage(run, 'approval', 'running');
  run.status = 'awaiting_approval';
  save(run);
  if (run.auto) autoDecide(run);
  return run;
}

// 자동 게시의 기준이다. 사람이 검토하던 자리를 대신하므로, 하나라도 통과하지 못하면 게시하지 않고 승인 대기로 남긴다.
export const GATES = [
  '사실 정확성 심사가 4점 이상일 것',
  '주제의 민감도가 낮다고 판정되었을 것 (실존 인물의 의혹, 사망, 범죄, 혐오, 정치적 대립과 같은 주제는 보류)',
  '장면의 흐름이 3점 이상일 것',
  '처음 보는 독자의 이해도가 3점 이상일 것',
];

export function gateProblems(run) {
  const { review } = run.content;
  if (!review) return ['심사 기록이 없습니다.'];
  const problems = [];
  // 최종 확인의 결과가 있으면 그 결과를 사용한다. 최종 확인이 없으면 문구를 고치기 전의 심사 결과로 판단한다.
  const accuracy = review.final?.accuracy || review.scores.accuracy;
  const safety = review.final?.safety || review.safety;
  if (accuracy < 4) problems.push(`사실 정확성이 ${accuracy}점입니다. (기준: 4점 이상)`);
  if (!safety) problems.push('주제의 민감도 판정이 없습니다.');
  else if (safety.risk !== 'low') problems.push(`사람의 확인이 필요한 주제입니다. ${safety.reasons.join(' ')}`.trim());
  // 고친 뒤에 다시 확인한 결과가 있으면 그 결과를, 없으면 처음 결과를 기준으로 한다.
  const lowest = (result) => Math.min(...['reel', 'carousel'].map((kind) => result?.[kind]?.score).filter((score) => score > 0));
  const flow = lowest(review.flow_after || review.flow);
  const reader = lowest(review.reader_after || review.reader);
  if (!(flow >= 3)) problems.push(Number.isFinite(flow) ? `장면의 흐름이 ${flow}점입니다. (기준: 3점 이상)` : '흐름 검토 기록이 없습니다.');
  if (!(reader >= 3)) problems.push(Number.isFinite(reader) ? `독자의 이해도가 ${reader}점입니다. (기준: 3점 이상)` : '독자 시험 기록이 없습니다.');
  return problems;
}

// 예약 실행으로 만든 콘텐츠를 사람의 승인 없이 게시할지 결정한다.
function autoDecide(run) {
  const settings = getSettings();
  if (!settings.autoPublish) return;
  const problems = gateProblems(run);
  if (problems.length) {
    run.hold = problems;
    addLog(run, 'approval', `자동 게시를 보류하고 승인 대기로 남겼습니다. ${problems.join(' / ')}`);
    return;
  }
  run.autoApproved = true;
  addLog(run, 'approval', '자동 게시의 기준을 모두 통과하여, 사람의 승인 없이 게시합니다.');
  approve(run.id, undefined, settings.targets);
}

const pad = (n) => String(n).padStart(2, '0');
const slotOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

// 예약한 요일과 시각이 되면 콘텐츠 제작을 시작한다. 서버가 꺼져 있던 동안의 예약은 건너뛴다.
export function startScheduler() {
  setInterval(() => {
    const settings = getSettings();
    const date = new Date();
    const slot = slotOf(date);
    if (!settings.enabled || !settings.days.includes(date.getDay()) || !settings.times.includes(slot.slice(11)) || settings.lastFired === slot) return;
    saveSettings({ lastFired: slot });
    try {
      generate(settings.topic, true);
      console.log(`예약 실행을 시작했습니다. (${slot})`);
    } catch (error) {
      console.error(`예약 실행을 시작하지 못했습니다. (${slot}) ${error.message}`);
    }
  }, 20000);
}

// 다음 예약 실행의 시각을 반환한다. 예약이 꺼져 있으면 null을 반환한다.
export function nextScheduledAt() {
  const settings = getSettings();
  if (!settings.enabled) return null;
  const now = new Date();
  for (let offset = 0; offset < 8; offset++) {
    for (const time of settings.times) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, Number(time.slice(0, 2)), Number(time.slice(3)));
      if (date > now && settings.days.includes(date.getDay())) return date.toISOString();
    }
  }
  return null;
}

export function failRun(id, error) {
  const run = getRun(id);
  const stage = run.stages.find((s) => s.status === 'running') || run.stages.find((s) => s.status === 'pending');
  if (run.status !== 'running' || !stage) throw new Error('진행 중인 실행이 아닙니다.');
  setStage(run, stage.key, 'failed', text(error) || '알 수 없는 오류');
  run.status = 'failed';
  addLog(run, stage.key, `실패: ${stage.error}`);
  return run;
}

let session = null;

// 웹 UI의 요청으로 Claude Code를 비대화형으로 실행하여 /sns-run 스킬을 수행한다.
// 훅의 진행 로그가 가장 최근 실행에 기록되므로, 한 번에 한 건만 실행한다.
export function generate(topic, auto = false) {
  if (session) throw new Error('이미 만들고 있는 콘텐츠가 있어요. 끝난 뒤에 다시 시도해 주세요.');
  const run = createRun(topic, auto);
  // 비대화형 세션에서는 프로젝트 설정의 허용 규칙이 적용되지 않을 수 있으므로, 동일한 규칙을 옵션으로 전달한다.
  const child = spawn('claude', [
    '-p', `/sns-run run_id=${run.id} ${topic}`,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(node cli.js:*)', 'WebSearch', 'Skill(korean-skills:humanizer)', 'Skill(korean-skills:grammar-checker)',
  ], { cwd: path.join(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  session = child;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
  const finish = (reason) => {
    if (session !== child) return;
    session = null;
    if (run.status === 'running') failRun(run.id, reason);
  };
  child.on('error', (error) => finish(`Claude Code를 실행하지 못했습니다. ${error.message}`));
  child.on('close', (code) => finish(`Claude Code 세션이 작업을 마치지 못하고 종료되었습니다. (종료 코드 ${code}) ${stderr.trim()}`));
  return run;
}

// 훅이 전송한 진행 메시지를, 현재 Claude Code가 수행 중인 실행의 로그에 기록한다.
// event에는 웹 UI의 제작 과정 흐름도에 사용하는 구조화된 정보(검색어, 서브에이전트의 시작과 종료)가 들어 있다.
export function logFromHook(msg, event) {
  const active = [...runs.values()]
    .filter((run) => run.status === 'running')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const stage = active?.stages.find((s) => s.status === 'running' && ['research', 'content'].includes(s.key));
  if (!stage || !text(msg)) return;
  const flow = active.flow ||= { searches: [], agents: [] };
  const agent = text(event?.agent_id);
  if (event?.kind === 'search' && flow.searches.length < 300) flow.searches.push({ agent, query: text(event.query).slice(0, 200) });
  if (event?.kind === 'agent_start') flow.agents.push({ id: agent, type: text(event.agent_type), startedAt: now(), endedAt: null });
  if (event?.kind === 'agent_stop') {
    const started = flow.agents.find((a) => a.id === agent && !a.endedAt);
    if (started) started.endedAt = now();
  }
  addLog(active, stage.key, msg);
}

// 인스타그램과 쓰레드는 공개 주소에서 파일을 가져가므로, 게시하기 전에 그 주소가 실제로 열리는지 확인한다.
// 터널이 꺼져 있으면 플랫폼이 원인을 알기 어려운 오류를 돌려주기 때문이다.
async function publicUrlProblem(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15000) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch {
    return '연결할 수 없음';
  }
}

async function publish(run) {
  const images = run.images || [run.image]; // 카드뉴스 형식 이전에 만든 실행에는 이미지가 한 장만 있다.
  const imagePaths = images.map((name) => path.join(runDir(run.id), name));
  const imageUrls = images.map((name) => `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, '')}/media/${run.id}/${name}`);
  const videoUrl = run.reel ? `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, '')}/media/${run.id}/${run.reel.file}` : null;
  await runStage(run, 'publish', async (onLog) => {
    const urlProblem = await publicUrlProblem(imageUrls[0]);
    if (urlProblem) onLog(`공개 주소로 이미지를 열 수 없습니다. (${urlProblem}) ${imageUrls[0]}`);
    await Promise.all(Object.entries(PLATFORMS).map(async ([key, platform]) => {
      const previous = run.publish[key]?.status;
      // 이미 게시되었거나 결과를 확인하지 못한 플랫폼에는 중복 게시를 방지하기 위해 다시 요청하지 않는다.
      if (previous === 'done' || previous === 'unknown') return;
      const reason = !run.targets.includes(key) ? '게시할 곳으로 선택하지 않았습니다.'
        : platform.needsVideo && !run.reel ? '이 실행에는 릴스 영상이 없습니다.'
          : platform.unavailable();
      if (reason) {
        run.publish[key] = { status: 'skipped', error: reason };
        return;
      }
      if (platform.needsPublicUrl && urlProblem) {
        run.publish[key] = { status: 'failed', error: `공개 주소(PUBLIC_BASE_URL)로 파일을 열 수 없습니다. (${urlProblem}) 터널이 실행 중인지, .env의 주소가 현재 터널의 주소와 같은지 확인하십시오.` };
        return;
      }
      run.publish[key] = { status: 'running' };
      save(run);
      try {
        const url = await platform.publish({ caption: run.content.captions[platform.caption || key], imagePaths, imageUrls, videoUrl });
        run.publish[key] = { status: 'done', url };
        onLog(`${platform.label}에 게시했습니다. ${url}`);
      } catch (error) {
        run.publish[key] = { status: 'failed', error: error.message };
        onLog(`${platform.label} 게시에 실패했습니다. ${error.message}`);
      }
    }));
    if (Object.values(run.publish).some((result) => result.status === 'failed')) {
      throw new Error('일부 플랫폼에 게시하지 못했습니다.');
    }
  });
  run.status = 'done';
  save(run);
}

const publishFailed = (run) => run.status === 'failed' && stageOf(run, 'publish').status === 'failed';

// 승인 대기 중인 실행을 승인하거나, 게시 단계에서 실패한 실행을 다시 시도한다.
// platforms를 전달하면 그 플랫폼에만 게시하고, 전달하지 않으면 이전에 선택한 대상(없으면 전체)을 유지한다.
export function approve(id, captions = {}, platforms) {
  const run = getRun(id);
  if (run.status !== 'awaiting_approval' && !publishFailed(run)) {
    throw new Error('승인하거나 재시도할 수 있는 상태가 아닙니다.');
  }
  if (Array.isArray(platforms)) run.targets = platforms.filter((key) => PLATFORMS[key]);
  run.targets ||= Object.keys(PLATFORMS);
  for (const key of CAPTION_KEYS) {
    if (text(captions[key])) run.content.captions[key] = text(captions[key]);
  }
  if (run.status === 'awaiting_approval') setStage(run, 'approval', 'done');
  run.status = 'publishing';
  save(run);
  publish(run).catch(() => {}); // 실패 내용은 runStage에서 기록한다.
  return run;
}

export function reject(id) {
  const run = getRun(id);
  if (run.status !== 'awaiting_approval') throw new Error('승인 대기 상태가 아닙니다.');
  setStage(run, 'approval', 'failed', '사용자가 반려했습니다.');
  run.status = 'rejected';
  save(run);
  return run;
}

export function loadRuns() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const id of readdirSync(DATA_DIR)) {
    const file = path.join(runDir(id), 'run.json');
    if (!existsSync(file)) continue;
    const run = JSON.parse(readFileSync(file, 'utf8'));
    // 서버가 수행하던 이미지 생성과 게시는 재시작 이후에 이어서 수행할 수 없으므로 실패로 표시한다.
    const interrupted = run.stages.filter((s) => s.status === 'running' && ['image', 'publish'].includes(s.key));
    if (interrupted.length) {
      for (const stage of interrupted) setStage(run, stage.key, 'failed', '서버가 재시작되어 중단되었습니다.');
      for (const result of Object.values(run.publish)) {
        if (result.status === 'running') Object.assign(result, { status: 'unknown', error: '게시 요청 도중에 서버가 종료되었습니다. 계정에서 게시 여부를 직접 확인하십시오.' });
      }
      run.status = 'failed';
      writeFileSync(file, JSON.stringify(run, null, 2));
    }
    runs.set(run.id, run);
  }
}
