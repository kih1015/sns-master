// 릴스 대본(content.reel)으로 HyperFrames 프로젝트를 생성하고 세로형(1080x1920) 영상으로 렌더링한다.
// 장면의 모션은 이 파일의 템플릿이 결정하고, Claude는 대본만 작성한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const TEMPLATE = path.join(import.meta.dirname, '..', 'reel-template');
const WIDTH = 1080;
const HEIGHT = 1920;
const OVERLAP = 0.45; // 다음 장면이 이전 장면 위로 덮이며 들어오는 시간
const MAX_SECONDS = 29; // 가장 짧은 배경음악(30초)보다 길어지지 않도록 한다.

const THEMES = {
  cover: { bg: '#10141c', ink: '#ffffff', sub: 'rgba(255,255,255,.9)', accent: '#ffd43b', track: 'rgba(255,255,255,.3)', fill: '#ffffff' },
  light: { bg: '#f2f4f6', ink: '#191f28', sub: '#4e5968', accent: '#1b64da', track: 'rgba(25,31,40,.14)', fill: '#191f28' },
  blue: { bg: '#1b64da', ink: '#ffffff', sub: 'rgba(255,255,255,.88)', accent: '#ffd43b', track: 'rgba(255,255,255,.3)', fill: '#ffffff' },
  dark: { bg: '#12151c', ink: '#ffffff', sub: '#b0b8c1', accent: '#4f9bff', track: 'rgba(255,255,255,.22)', fill: '#ffffff' },
};
const WIPES = ['inset(100% 0% 0% 0%)', 'inset(0% 0% 0% 100%)', 'inset(0% 0% 100% 0%)'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const round = (n) => Math.round(n * 100) / 100;
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

// 그림이 있는 장면의 배치를 정한다. 카드 배치(card)와 화면을 가득 채우는 배치(full)를 번갈아 사용한다.
// 그림을 생성하기 전에 배치를 알아야 그림의 방향(가로, 세로)을 맞출 수 있으므로, image_prompt의 유무만으로 결정한다.
export function sceneLayouts(scenes) {
  let pictured = 0;
  return scenes.map((scene, i) => (i > 0 && scene.image_prompt ? (pictured++ % 2 ? 'full' : 'card') : null));
}

function hyperframesCli() {
  if (process.env.HYPERFRAMES_CLI) return process.env.HYPERFRAMES_CLI;
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'hyperframes', 'hyperframes');
  const versions = existsSync(base) ? readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const launcher = versions.length ? path.join(base, versions.at(-1), 'skills', 'hyperframes', 'scripts', 'plugin-cli.mjs') : '';
  if (!existsSync(launcher)) throw new Error('HyperFrames 플러그인을 찾을 수 없습니다. HYPERFRAMES_CLI에 plugin-cli.mjs의 경로를 지정하십시오.');
  return launcher;
}

// 읽는 데 필요한 시간만큼 장면을 유지한다. (기본 유지 시간 + 어절당 시간)
function plan(scenes) {
  let seconds = scenes.map((scene, i) => {
    const hold = 1.5 + 0.36 * wordCount(`${scene.text} ${scene.sub}`);
    return Math.min(5.4, Math.max(i === 0 ? 2.4 : 2.9, hold)) + (i === scenes.length - 1 ? 1.2 : 0);
  });
  const total = (list) => list.reduce((sum, s) => sum + s, 0) - OVERLAP * (list.length - 1);
  if (total(seconds) > MAX_SECONDS) seconds = seconds.map((s) => (s * MAX_SECONDS) / total(seconds));
  let cursor = 0;
  return seconds.map((duration, i) => {
    const start = cursor;
    cursor += duration - OVERLAP;
    return { start: round(start), duration: round(i === seconds.length - 1 ? duration : duration) };
  });
}

function sceneHtml(scene, index, scenes, timing, theme, brand) {
  const id = `s${index + 1}`;
  const t = THEMES[theme];
  const last = index === scenes.length - 1;
  // 그림이 있는 장면은 화면을 가득 채우는 배치(full)와 카드 안에 넣는 배치(card)를 번갈아 사용하여 화면에 변화를 준다.
  const photo = index === 0 ? scene.cover : scene.image;
  const layout = !photo ? 'flat' : index === 0 || scene.layout === 'full' ? 'full' : 'card';
  const lines = scene.text.split('\n');
  // 글자 폭을 한글 0.92em, 공백 0.28em, 그 외 0.58em으로 어림하여, 가장 긴 줄이 화면 폭에 맞는 가장 큰 크기를 정한다.
  const units = (line) => [...line].reduce((sum, ch) => sum + (ch === ' ' ? 0.28 : /[가-힣]/.test(ch) ? 0.92 : 0.58), 0);
  const size = Math.min(layout === 'card' ? 104 : 150, Math.floor(860 / Math.max(...lines.map(units))));
  // 설명 문장은 두 줄까지 들어가므로, 가장 긴 줄이 화면 폭에 맞도록 크기를 정한다.
  const subLines = scene.sub ? scene.sub.split('\n') : [];
  const subSize = subLines.length ? Math.min(layout === 'card' ? 50 : 56, Math.floor(860 / Math.max(...subLines.map(units)))) : 0;
  const marks = new Set(scene.highlight.split(/\s+/).filter(Boolean));
  let wordIndex = 0;
  const headline = lines.map((line) => `<div class="${id}-line">${line.split(/\s+/).filter(Boolean).map((word) =>
    `<span id="${id}-w${wordIndex++}" class="${id}-word${marks.has(word) ? ` ${id}-mark` : ''}">${esc(word)}</span>`).join(' ')}</div>`).join('');
  const hud = scenes.map((_, i) => `<i><b id="${id}-seg${i}" style="transform:scaleX(${i < index ? 1 : 0})"></b></i>`).join('');
  const enter = index === 0 ? 0 : layout === 'card' ? 0.5 : 0.28; // 표지는 첫 프레임부터 문구가 보여야 한다.
  // 장면마다 그림이 움직이는 방식을 바꾼다. (멀어지기, 다가가기, 옆으로 이동)
  const move = layout === 'card'
    ? [['{ scale: 1.07 }', '{ scale: 1'], ['{ scale: 1 }', '{ scale: 1.07'], ['{ scale: 1.06, x: -18 }', '{ scale: 1.06, x: 18']][index % 3]
    : [['{ scale: 1.14 }', '{ scale: 1'], ['{ scale: 1 }', '{ scale: 1.12'], ['{ scale: 1.12, x: -36 }', '{ scale: 1.12, x: 36']][index % 3];
  const words = wordIndex;
  const headEnd = enter + (index === 0 ? 0 : 0.13 + 0.067 * words);
  const variant = index % 3;

  const wordTween = index === 0 ? '' : variant === 2
    ? `tl.fromTo("#${id}-head", { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.2, ease: "power4.out" }, ${enter});`
    : variant === 1
      ? `tl.fromTo(".${id}-word", { opacity: 0.16 }, { opacity: 1, duration: 0.12, ease: "power2.out", stagger: 0.085 }, ${enter});`
      : `tl.fromTo(".${id}-word", { opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.13, ease: "power4.out", stagger: 0.067 }, ${enter});`;

  return `<template>
  <style>
    #root { position: absolute; inset: 0; overflow: hidden; font-family: "Pretendard"; letter-spacing: -0.03em; word-break: keep-all; }
    #${id}-wrap { position: absolute; inset: 0; background: ${t.bg}; color: ${t.ink}; }
        #${id}-photo { position: absolute; inset: 0; background: center / cover no-repeat; }
    #${id}-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8,11,18,.55) 0%, rgba(8,11,18,.2) 26%, rgba(8,11,18,.9) 62%); }
    #${id}-hud { position: absolute; left: 84px; right: 84px; top: 196px; }
    #${id}-bars { display: flex; gap: 8px; }
    #${id}-bars i { flex: 1; height: 8px; border-radius: 4px; overflow: hidden; background: ${t.track}; }
    #${id}-bars b { display: block; width: 100%; height: 100%; background: ${t.fill}; transform-origin: 0 50%; }
    #${id}-brand { margin-top: 26px; font-size: 34px; font-weight: 800; opacity: .92; }
    #${id}-card { position: absolute; left: 84px; right: 84px; top: 296px; height: 570px; border-radius: 40px; overflow: hidden; }
    #${id}-zoom { position: absolute; inset: 0; }
    #${id}-body { position: absolute; left: 84px; right: 116px; display: flex; flex-direction: column; ${layout === 'card' ? 'top: 906px; height: 424px; justify-content: flex-start;' : `top: 380px; height: 960px; justify-content: ${layout === 'full' ? 'flex-end' : 'center'};`} }
    #${id}-tag { align-self: flex-start; margin-bottom: 36px; padding: 14px 30px; border-radius: 999px; background: ${t.accent}; color: ${theme === 'light' || theme === 'dark' ? '#ffffff' : '#191f28'}; font-size: 38px; font-weight: 800; }
    #${id}-head { font-size: ${size}px; font-weight: 800; line-height: 1.22; }
    .${id}-mark { color: ${t.accent}; }
    #${id}-sub { margin-top: ${layout === 'card' ? 22 : 40}px; font-size: ${subSize}px; font-weight: 600; line-height: 1.45; color: ${t.sub}; white-space: pre-line; }
    #${id}-num { position: absolute; left: 56px; bottom: 120px; font-size: 560px; font-weight: 800; line-height: 1; color: ${t.ink}; opacity: .07; }
    #${id}-rule { width: 120px; height: 10px; margin-bottom: 40px; border-radius: 5px; background: ${t.accent}; transform-origin: 0 50%; }
    #${id}-follow { display: flex; align-items: center; gap: 24px; margin-top: 64px; font-size: 50px; font-weight: 800; }
    #${id}-follow img { width: 124px; height: 124px; border-radius: 50%; }
    #${id}-follow small { display: block; font-size: 36px; font-weight: 600; color: ${t.sub}; }
  </style>
  <div id="root" data-composition-id="${id}" data-width="${WIDTH}" data-height="${HEIGHT}">
    <div id="${id}-wrap">
      ${layout === 'full' ? `<div id="${id}-zoom"><div id="${id}-photo" style="background-image:url('${photo}')"></div></div><div id="${id}-shade"></div>` : ''}
      ${layout === 'card' ? `<div id="${id}-card"><div id="${id}-zoom"><div id="${id}-photo" style="background-image:url('${photo}')"></div></div></div>` : ''}
      <div id="${id}-hud"><div id="${id}-bars">${hud}</div><div id="${id}-brand" data-layout-allow-overlap>${esc(brand)}</div></div>
      ${index > 0 && !last && layout === 'flat' ? `<div id="${id}-num" data-layout-ignore><div id="${id}-numin">${String(index).padStart(2, '0')}</div></div>` : ''}
      <div id="${id}-body">
        ${index === 0 ? `<div id="${id}-tag">${esc(scene.kicker)}</div>` : last ? `<div id="${id}-tag">여러분의 생각은?</div>` : layout === 'card' ? '' : `<div id="${id}-rule"></div>`}
        <div id="${id}-head">${headline}</div>
        ${scene.sub ? `<div id="${id}-sub">${esc(scene.sub)}</div>` : ''}
        ${last ? `<div id="${id}-follow"><img src="assets/avatar.png" alt=""><div>${esc(brand)}<small>팔로우하고 매일 이슈 받아 보기</small></div></div>` : ''}
      </div>
    </div>
    <script>
      {
        const tl = gsap.timeline({ paused: true });
        ${index === 0 ? '' : `tl.fromTo("#${id}-wrap", { clipPath: "${WIPES[index % WIPES.length]}" }, { clipPath: "inset(0% 0% 0% 0%)", duration: ${OVERLAP}, ease: "power3.inOut" }, 0);`}
        ${photo ? `tl.fromTo("#${id}-zoom", ${move[0]}, ${move[1]}, duration: ${timing.duration}, ease: "none" }, 0);` : ''}
        ${layout === 'card' ? `tl.fromTo("#${id}-card", { clipPath: "inset(0% 0% 100% 0% round 40px)" }, { clipPath: "inset(0% 0% 0% 0% round 40px)", duration: 0.55, ease: "expo.out" }, 0.16);` : ''}
        tl.fromTo("#${id}-seg${index}", { scaleX: 0 }, { scaleX: 1, duration: ${round(timing.duration - (last ? 0 : OVERLAP))}, ease: "none" }, 0);
        ${wordTween}
        ${index === 0 ? `tl.fromTo("#${id}-tag", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.6)" }, 0.12);` : ''}
        ${index > 0 && !last && layout !== 'card' ? `tl.fromTo("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "expo.out" }, ${round(enter - 0.1)});` : ''}
        ${index > 0 && !last && layout === 'flat' ? `tl.fromTo("#${id}-numin", { x: -140 }, { x: 0, duration: 0.9, ease: "expo.out" }, 0.1);` : ''}
        ${last ? `tl.fromTo("#${id}-tag", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.6)" }, ${round(enter - 0.1)});` : ''}
        ${scene.sub ? `tl.fromTo("#${id}-sub", { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.2, ease: "power4.out" }, ${round(headEnd + 0.25)});` : ''}
        ${last ? `tl.fromTo("#${id}-follow", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.55, ease: "expo.out" }, ${round(headEnd + 0.7)});` : ''}
        window.__timelines["${id}"] = tl;
      }
    </script>
  </div>
</template>
`;
}

function indexHtml(timings, total, bgm, hasSfx) {
  const hosts = timings.map((timing, i) => `<div id="s${i + 1}" data-composition-id="s${i + 1}" data-composition-src="compositions/s${i + 1}.html"
        data-start="${timing.start}" data-duration="${timing.duration}" data-track-index="${i + 1}" data-track-kind="graphics"
        data-width="${WIDTH}" data-height="${HEIGHT}" style="z-index:${i + 1}"></div>`).join('\n      ');
  // 장면이 바뀌는 순간에만 효과음을 넣고, 같은 소리가 반복되지 않도록 두 가지를 번갈아 사용한다.
  const whooshes = !hasSfx ? '' : timings.slice(1).map((timing, i) => `<audio id="sfx${i + 1}" class="clip" src="assets/sfx/${i % 2 ? 'whoosh' : 'whoosh-short'}.mp3"
        data-start="${timing.start}" data-duration="0.57" data-track-index="${20 + (i % 2)}" data-volume="0.3"></audio>`).join('\n      ');
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${WIDTH}, height=${HEIGHT}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Pretendard"; font-weight: 800; src: url("assets/fonts/Pretendard-ExtraBold.otf"); }
      @font-face { font-family: "Pretendard"; font-weight: 600; src: url("assets/fonts/Pretendard-SemiBold.otf"); }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #10141c; }
      #root { position: relative; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${WIDTH}" data-height="${HEIGHT}">
      ${hosts}
      ${bgm ? `<audio id="bgm" class="clip" src="assets/bgm/${bgm}" data-start="0" data-duration="${total}" data-track-index="19"
        data-volume="0.8" data-fade-out="1"></audio>` : ''}
      ${whooshes}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

// cwd(실행 디렉터리) 아래에 reel 프로젝트를 만들고 reel.mp4를 렌더링하여 파일 이름을 반환한다.
export async function renderReel(runDir, content, seed) {
  const cwd = path.resolve(runDir); // 렌더링 명령을 다른 작업 디렉터리에서 실행하므로 절대 경로로 바꾼다.
  const project = path.join(cwd, 'reel');
  rmSync(project, { recursive: true, force: true });
  cpSync(TEMPLATE, project, { recursive: true });
  mkdirSync(path.join(project, 'compositions'), { recursive: true });
  writeFileSync(path.join(project, 'meta.json'), JSON.stringify({ id: `reel-${seed}`, name: 'reel', createdAt: new Date().toISOString() }));
  const place = (source, asset) => {
    copyFileSync(source, path.join(project, asset));
    return asset;
  };
  const coverSource = path.join(cwd, 'image.png');
  const cover = existsSync(coverSource) ? place(coverSource, 'assets/cover.png') : null;

  // 장면용 그림(scene-img/<번호>/image.png)이 생성되어 있으면 프로젝트에 복사하여 사용한다.
  const layouts = sceneLayouts(content.reel.scenes);
  const scenes = content.reel.scenes.map((scene, i) => {
    const source = path.join(cwd, 'scene-img', String(i + 1), 'image.png');
    const image = layouts[i] && existsSync(source) ? place(source, `assets/scene-${i + 1}.png`) : null;
    return { ...scene, kicker: content.kicker, cover, image, layout: layouts[i] };
  });
  const timings = plan(scenes);
  const total = round(timings.at(-1).start + timings.at(-1).duration);
  // 표지는 사진, 마지막 장면은 파란색으로 고정하고, 그 사이는 밝은색과 어두운색을 번갈아 사용한다.
  const themeOf = (i) => (i === 0 ? 'cover' : i === scenes.length - 1 ? 'blue' : scenes[i].image && scenes[i].layout === 'full' ? 'cover' : i % 2 ? 'light' : 'dark');
  const brand = process.env.BRAND_NAME || '이슈브리핑';
  scenes.forEach((scene, i) => {
    writeFileSync(path.join(project, 'compositions', `s${i + 1}.html`), sceneHtml(scene, i, scenes, timings[i], themeOf(i), brand));
  });
  // 음원은 저장소에 포함되어 있지 않다. 배경음악이 없으면 음악 없이 만들고, 효과음이 없으면 HyperFrames 플러그인에 들어 있는 파일을 가져온다.
  const bgmDir = path.join(project, 'assets', 'bgm');
  const tracks = existsSync(bgmDir) ? readdirSync(bgmDir).filter((name) => /\.(wav|mp3)$/.test(name)).sort() : [];
  const pick = [...String(seed)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % (tracks.length || 1);
  const sfxDir = path.join(project, 'assets', 'sfx');
  const bundledSfx = path.join(hyperframesCli(), '..', '..', '..', 'media-use', 'audio', 'assets', 'sfx');
  for (const name of ['whoosh.mp3', 'whoosh-short.mp3']) {
    if (!existsSync(path.join(sfxDir, name)) && existsSync(path.join(bundledSfx, name))) {
      mkdirSync(sfxDir, { recursive: true });
      copyFileSync(path.join(bundledSfx, name), path.join(sfxDir, name));
    }
  }
  const hasSfx = existsSync(path.join(sfxDir, 'whoosh.mp3')) && existsSync(path.join(sfxDir, 'whoosh-short.mp3'));
  writeFileSync(path.join(project, 'index.html'), indexHtml(timings, total, tracks[pick] || null, hasSfx));

  await exec('node', [hyperframesCli(), 'render', '--output', path.join(cwd, 'reel.mp4'), '--quiet'], {
    cwd: project, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  if (!existsSync(path.join(cwd, 'reel.mp4'))) throw new Error('HyperFrames가 reel.mp4 파일을 만들지 않았습니다.');
  return { file: 'reel.mp4', seconds: total };
}
