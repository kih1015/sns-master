// 카드뉴스 슬라이드를 HTML로 조판한 뒤 Chrome의 헤드리스 모드로 촬영하여 JPEG 파일로 저장한다.
// 이미지 생성 모델이 한글을 틀리게 그리는 문제를 피하기 위해, 글자는 모두 여기에서 조판한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// 인스타그램 피드에서 가장 넓은 면적을 차지하는 4:5 비율이다.
const WIDTH = 1080;
const HEIGHT = 1350;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const titleSize = (title, sizes) => sizes[title.length <= 14 ? 0 : title.length <= 26 ? 1 : 2];

const CSS = `
* { box-sizing: border-box; margin: 0; }
html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
body { position: relative; overflow: hidden; font-family: Pretendard, "Apple SD Gothic Neo", sans-serif; letter-spacing: -.025em; word-break: keep-all; overflow-wrap: anywhere; color: #191f28; }
.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(10,14,22,.25) 0%, rgba(10,14,22,.1) 30%, rgba(10,14,22,.88) 78%); }
/* 인스타그램 화면의 상단과 하단 표시 요소에 글자가 가려지지 않도록 여백을 둔다. */
.pad { position: absolute; inset: 130px 84px 170px; display: flex; flex-direction: column; }
.page { position: absolute; top: 60px; right: 84px; font-size: 30px; font-weight: 700; opacity: .6; }
.bar { position: absolute; left: 84px; right: 84px; bottom: 96px; height: 8px; border-radius: 4px; background: rgba(128,140,156,.28); }
.bar i { display: block; height: 100%; border-radius: 4px; background: currentColor; }
h1 { font-weight: 800; line-height: 1.24; }
p { white-space: pre-line; line-height: 1.58; }
.kicker { align-self: flex-start; padding: 12px 26px; border-radius: 999px; font-size: 34px; font-weight: 700; }

.cover { color: #fff; background: #1b2b4b; }
.cover .pad { justify-content: flex-end; }
.cover .kicker { background: #3182f6; margin-bottom: 34px; }
.cover p { margin-top: 30px; font-size: 46px; font-weight: 500; opacity: .9; }
.cover .next { margin-top: 44px; font-size: 34px; font-weight: 700; opacity: .85; }

.body { background: #f2f4f6; }
.body .pad { justify-content: center; }
.body .num { font-size: 44px; font-weight: 800; color: #3182f6; margin-bottom: 26px; }
.body h1 { padding-bottom: 44px; margin-bottom: 44px; border-bottom: 4px solid #d1d6db; }
.body p { font-size: 50px; font-weight: 500; color: #333d4b; }
.body .bar { color: #3182f6; }

.outro { color: #fff; background: #1b64da; }
.outro .pad { justify-content: center; }
.outro .kicker { background: rgba(255,255,255,.18); margin-bottom: 40px; }
.outro p { margin-top: 36px; font-size: 48px; font-weight: 500; opacity: .92; }
.outro .foot { position: absolute; left: 0; right: 0; bottom: 0; font-size: 27px; line-height: 1.6; opacity: .78; }
`;

function slideHtml(slide, index, total, { kicker, sources, hasImage }) {
  const page = `<div class="page">${index + 1} / ${total}</div>`;
  const bar = `<div class="bar"><i style="width:${((index + 1) / total) * 100}%"></i></div>`;
  let kind;
  let inner;
  if (index === 0) {
    kind = 'cover';
    inner = `${hasImage ? '<img class="bg" src="image.png">' : ''}<div class="shade"></div>${page}
      <div class="pad"><span class="kicker">${esc(kicker)}</span>
        <h1 style="font-size:${titleSize(slide.title, [124, 104, 86])}px">${esc(slide.title)}</h1>
        ${slide.body ? `<p>${esc(slide.body)}</p>` : ''}<div class="next">넘겨서 보기 →</div></div>${bar}`;
  } else if (index === total - 1) {
    kind = 'outro';
    inner = `${page}<div class="pad"><span class="kicker">여러분의 생각은?</span>
        <h1 style="font-size:${titleSize(slide.title, [100, 86, 72])}px">${esc(slide.title)}</h1><p>${esc(slide.body)}</p>
        <div class="foot">${sources.length ? `출처 · ${esc(sources.join(', '))}<br>` : ''}표지 이미지는 AI로 만들었어요</div></div>${bar}`;
  } else {
    kind = 'body';
    inner = `${page}<div class="pad"><div class="num">${String(index).padStart(2, '0')}</div>
        <h1 style="font-size:${titleSize(slide.title, [88, 76, 64])}px">${esc(slide.title)}</h1><p>${esc(slide.body)}</p></div>${bar}`;
  }
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${CSS}</style></head><body class="${kind}">${inner}</body></html>`;
}

// content.slides를 slide-1.jpg, slide-2.jpg, ... 로 저장하고 파일 이름 목록을 반환한다.
export async function renderSlides(cwd, content) {
  if (!existsSync(CHROME)) throw new Error(`Chrome을 찾을 수 없습니다. CHROME_PATH에 실행 파일의 경로를 지정하십시오. (${CHROME})`);
  const context = { kicker: content.kicker, sources: content.sources, hasImage: existsSync(path.join(cwd, 'image.png')) };
  const files = [];
  for (const [index, slide] of content.slides.entries()) {
    const name = `slide-${index + 1}`;
    writeFileSync(path.join(cwd, `${name}.html`), slideHtml(slide, index, content.slides.length, context));
    await exec(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${WIDTH},${HEIGHT}`, `--screenshot=${path.join(cwd, `${name}.png`)}`,
      `file://${path.join(cwd, `${name}.html`)}`,
    ], { timeout: 60000 });
    // 인스타그램은 JPEG 형식만 허용하므로 macOS에 내장된 sips로 변환한다.
    await exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', `${name}.png`, '--out', `${name}.jpg`], { cwd });
    files.push(`${name}.jpg`);
  }
  return files;
}
