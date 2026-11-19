// 자동화 설정을 data/settings.json에 저장한다. 모든 자동화 기능의 기본값은 꺼짐이다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PLATFORMS } from './publishers.js';

const FILE = path.join(import.meta.dirname, '..', 'data', 'settings.json');
const DEFAULTS = {
  enabled: false, // 예약한 시각에 콘텐츠 제작을 자동으로 시작한다.
  times: ['09:00'],
  days: [0, 1, 2, 3, 4, 5, 6], // 0은 일요일
  topic: '',
  autoPublish: false, // 품질 기준을 통과한 콘텐츠를 사람의 승인 없이 게시한다.
  targets: ['instagram'],
  tunnel: false, // 서버가 Cloudflare 터널을 직접 열고 공개 주소를 반영한다.
  lastFired: null, // 같은 예약 시각에 두 번 실행되지 않도록 마지막으로 실행한 시각을 기록한다.
};

let cache = null;

export function getSettings() {
  if (!cache) cache = { ...DEFAULTS, ...(existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}) };
  return cache;
}

export function saveSettings(patch) {
  const next = { ...getSettings() };
  for (const key of ['enabled', 'autoPublish', 'tunnel']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  if (Array.isArray(patch.times)) {
    const times = [...new Set(patch.times.filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort();
    if (!times.length || times.length > 6) throw new Error('실행 시각은 1개 이상 6개 이하로 설정해야 합니다.');
    next.times = times;
  }
  if (Array.isArray(patch.days)) {
    const days = [...new Set(patch.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
    if (!days.length) throw new Error('요일을 하나 이상 선택해야 합니다.');
    next.days = days;
  }
  if (typeof patch.topic === 'string') next.topic = patch.topic.trim().slice(0, 200);
  if (Array.isArray(patch.targets)) next.targets = patch.targets.filter((key) => PLATFORMS[key]);
  if (typeof patch.lastFired === 'string') next.lastFired = patch.lastFired;
  cache = next;
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}
