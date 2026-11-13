// 지에프아이(493330) 공시·뉴스·블로그 일일 요약 → 텔레그램 전송
// GitHub Actions(.github/workflows/gfi-alert.yml)에서 매일 아침 9시(KST)쯤 실행된다.
// 모든 데이터 출처는 API 키가 필요 없는 무료 공개 엔드포인트.
//
// 시간 구간 대신 "이미 보낸 항목" 목록(STATE_FILE)으로 중복을 거른다.
// → 예약 실행이 몇 시간 늦거나, 검색 색인이 늦게 반영돼도 누락·중복 없이 다음 알림에 포함된다.
//
// 환경변수:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (없으면 콘솔 출력만 하는 dry-run)
//   STATE_FILE      (기본 state.json) — 보낸 항목·마지막 예약 실행일 저장 파일
//   LOOKBACK_HOURS  (기본 72) — 이 시간 안에 올라온 것 중 아직 안 보낸 것을 보냄
//   SCHEDULED       ('true'면 예약 실행 — 오늘 이미 예약 실행으로 보냈으면 건너뜀)
//   SEND_EMPTY      ('true'면 새 소식이 없어도 "없음" 메시지 전송)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STOCK_NAME = '지에프아이';
const STOCK_CODE = '493330';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KST = 9 * 3600 * 1000;
const HOUR = 3600 * 1000;
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const LOOKBACK = Number(process.env.LOOKBACK_HOURS || 72) * HOUR;
const SEEN_KEEP = 30 * 24 * HOUR; // 보낸 기록은 30일간 보관

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const decode = (s = '') => s
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();

// "2026-10-22T06:53:13" (KST, 타임존 표기 없음) → epoch ms
const kstIso = s => Date.parse(s + '+09:00');
// "202610080936" (KST) → epoch ms
const kstCompact = s => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`);
const kstDate = (ms = Date.now()) => new Date(ms + KST).toISOString().slice(0, 10);

async function fetchDisclosures() {
  const j = JSON.parse(await getText(`https://m.stock.naver.com/api/stock/${STOCK_CODE}/disclosure?pageSize=30&page=1`));
  return j.map(d => ({
    key: `d:${d.disclosureId}`,
    title: decode(d.title).replace(/^\(주\)지에프아이\s*/, ''),
    url: `https://m.stock.naver.com/domestic/stock/${STOCK_CODE}/notice/${d.disclosureId}`,
    time: kstIso(d.datetime),
    source: d.author || '',
  }));
}

// 네이버 증권 종목 뉴스 (네이버가 종목에 직접 연결한 기사만 — 수가 적음)
async function fetchNaverStockNews() {
  const j = JSON.parse(await getText(`https://m.stock.naver.com/api/news/stock/${STOCK_CODE}?pageSize=30&page=1`));
  return j.flatMap(g => g.items || []).map(n => ({
    title: decode(n.titleFull || n.title),
    url: `https://n.news.naver.com/mnews/article/${n.officeId}/${n.articleId}`,
    time: kstCompact(n.datetime),
    source: n.officeName || '',
  }));
}

// 네이버 뉴스 검색 (최신순) — 군소 언론사 기사까지 가장 넓게 잡힘.
// 게시 시각이 "16시간 전", "2일 전", "2026.11.03." 같은 상대·날짜 표기라 대략적인 시각으로 환산한다.
function parseNaverTime(s, now) {
  let m;
  if ((m = s.match(/(\d+)분 전/))) return { time: now - m[1] * 60e3, approx: false };
  if ((m = s.match(/(\d+)시간 전/))) return { time: now - m[1] * HOUR, approx: false };
  if ((m = s.match(/(\d+)일 전/))) return { time: now - m[1] * 24 * HOUR, approx: true };
  if ((m = s.match(/(\d+)주 전/))) return { time: now - m[1] * 7 * 24 * HOUR, approx: true };
  if ((m = s.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\./))) {
    return { time: Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T12:00:00+09:00`), approx: true };
  }
  return null;
}

async function fetchNaverNewsSearch() {
  const q = encodeURIComponent(`"${STOCK_NAME}"`);
  const now = Date.now();
  const out = [];
  for (const start of [1, 11, 21]) {
    const j = JSON.parse(await getText(
      `https://s.search.naver.com/p/newssearch/3/api/tab/more?query=${q}&sort=1&start=${start}&ssc=tab.news.all`,
      { Referer: 'https://search.naver.com/' },
    ));
    const html = (j.collection || []).map(c => c.html || '').join('');
    const re = /<a [^>]*href="([^"]+)"[^>]*data-heatmap-target="\.tit"[^>]*>([\s\S]*?)<\/a>/g;
    let m, prev = 0, found = 0;
    while ((m = re.exec(html))) {
      // 제목 앞 구간에 [언론사, 게시시각]이 들어 있다
      const texts = [...html.slice(prev, m.index).matchAll(/>([^<>]+)</g)]
        .map(x => decode(x[1])).filter(t => t && t !== '새 창 열림');
      prev = m.index;
      let ti = -1, t = null;
      for (let i = texts.length - 1; i >= 0; i--) if ((t = parseNaverTime(texts[i], now))) { ti = i; break; }
      if (!t) continue;
      found++;
      out.push({
        title: decode(m[2]).replace(/새 창 열림$/, '').trim(),
        url: decode(m[1]),
        time: t.time, approx: t.approx,
        source: texts[ti - 1] || '',
      });
    }
    // 마지막 기사가 조회 구간보다 오래됐으면 다음 페이지는 안 봄
    if (!found || out[out.length - 1].time < now - LOOKBACK) break;
  }
  return out;
}

async function fetchGoogleNews() {
  const q = encodeURIComponent(`"${STOCK_NAME}"`);
  const xml = await getText(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const tag = t => (it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const source = decode(tag('source'));
    let title = decode(tag('title'));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, url: decode(tag('link')), time: Date.parse(tag('pubDate')), source };
  });
}

async function fetchBlogs() {
  const q = encodeURIComponent(STOCK_NAME);
  const raw = await getText(
    `https://section.blog.naver.com/ajax/SearchList.naver?countPerPage=30&currentPage=1&keyword=${q}&orderBy=recentdate&type=post`,
    { Referer: 'https://section.blog.naver.com/Search/Post.naver' },
  );
  const j = JSON.parse(raw.replace(/^\)\]\}',?\s*/, ''));
  return (j.result?.searchList || []).map(b => ({
    key: `b:${b.postUrl}`,
    title: decode(b.noTagTitle || b.title),
    url: b.postUrl,
    time: b.addDate,
    source: decode(b.blogName || b.nickName || ''),
  }));
}

async function safe(name, fn) {
  try { return await fn(); } catch (e) { console.error(`[${name}] 실패:`, e.message); return null; }
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTime = (ms, approx) => {
  const d = new Date(ms + KST);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return approx ? md : `${md} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const line = it => `• <a href="${esc(it.url)}">${esc(it.title)}</a>\n   <i>${esc(it.source)} · ${fmtTime(it.time, it.approx)}</i>`;

// 같은 기사가 여러 출처에서 오므로 제목으로 묶는다
const normTitle = s => s.replace(/[^0-9A-Za-z가-힣]/g, '').slice(0, 25);
// 제목에 종목명이 있으면 지에프아이 중심 기사·글, 아니면 시황 모음 등에서 언급된 것
const focused = it => it.title.includes(STOCK_NAME);

async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
  if (!token || !chatId) { console.log('--- (dry-run: 텔레그램 설정 없음) ---\n' + text); return; }
  // 텔레그램 메시지 한도 4096자 → 줄 단위로 나눠 전송
  const chunks = [];
  let cur = '';
  for (const l of text.split('\n')) {
    if ((cur + '\n' + l).length > 3800) { chunks.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l;
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`텔레그램 전송 실패 ${res.status}: ${await res.text()}`);
  }
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return { seen: s.seen || {}, lastScheduledDate: s.lastScheduledDate || '' };
    }
  } catch (e) { console.error('상태 파일 읽기 실패, 새로 시작:', e.message); }
  return { seen: {}, lastScheduledDate: '' };
}

async function main() {
  const now = Date.now();
  const today = kstDate(now);
  const state = loadState();
  const scheduled = process.env.SCHEDULED === 'true';

  // 예약 실행을 여러 번 걸어 두었으므로(지연·누락 대비) 오늘 이미 보냈으면 나머지는 종료
  if (scheduled && state.lastScheduledDate === today) {
    console.log(`오늘(${today}) 예약 알림은 이미 처리됨 — 건너뜀`);
    return;
  }

  const [disc, stockNews, searchNews, gNews, blogs] = await Promise.all([
    safe('공시', fetchDisclosures), safe('네이버 종목뉴스', fetchNaverStockNews),
    safe('네이버 뉴스검색', fetchNaverNewsSearch), safe('구글뉴스', fetchGoogleNews),
    safe('블로그', fetchBlogs),
  ]);

  const recent = it => it.time >= now - LOOKBACK && it.time <= now + HOUR;
  const fresh = it => !state.seen[it.key];
  const byTime = (a, b) => b.time - a.time;
  const byFocus = (a, b) => (focused(b) - focused(a)) || byTime(a, b);

  const disclosures = (disc || []).filter(recent).filter(fresh).sort(byTime);

  // 뉴스: 원문 링크를 주는 네이버 출처를 앞에 둬서 제목 중복 시 그쪽이 남게 함 (구글은 우회 링크)
  const dup = new Set();
  const news = [...(stockNews || []), ...(searchNews || []), ...(gNews || [])]
    .map(n => ({ ...n, key: `n:${normTitle(n.title)}` }))
    .filter(recent)
    .filter(n => (dup.has(n.key) ? false : dup.add(n.key)))
    .filter(fresh)
    .sort(byFocus);

  const blogList = (blogs || []).filter(recent).filter(fresh).sort(byFocus).slice(0, 15);

  const failed = [['공시', disc], ['네이버 종목뉴스', stockNews], ['네이버 뉴스검색', searchNews],
    ['구글뉴스', gNews], ['블로그', blogs]].filter(([, v]) => v === null).map(([n]) => n);
  const total = disclosures.length + news.length + blogList.length;

  if (total || failed.length || process.env.SEND_EMPTY === 'true') {
    const parts = [`📊 <b>${STOCK_NAME} 소식</b>  (${fmtTime(now)} 기준, 새 소식만)`];
    if (disclosures.length) parts.push('', `📢 <b>공시 ${disclosures.length}건</b>`, ...disclosures.map(line));
    if (news.length) parts.push('', `📰 <b>뉴스 ${news.length}건</b>`, ...news.map(line));
    if (blogList.length) parts.push('', `✍️ <b>블로그 ${blogList.length}건</b>`, ...blogList.map(line));
    if (!total) parts.push('', '새로운 공시·뉴스·블로그가 없습니다.');
    if (failed.length) parts.push('', `⚠️ 조회 실패: ${failed.join(', ')}`);
    await sendTelegram(parts.join('\n'));
    console.log(`전송 완료: 공시 ${disclosures.length}, 뉴스 ${news.length}, 블로그 ${blogList.length}`);
  } else {
    console.log('새 소식 없음 — 전송 생략');
  }

  // 전송에 성공한 뒤에만 상태 기록 (실패 시 다음 실행에서 다시 시도)
  for (const it of [...disclosures, ...news, ...blogList]) state.seen[it.key] = now;
  for (const [k, t] of Object.entries(state.seen)) if (t < now - SEEN_KEEP) delete state.seen[k];
  if (scheduled) state.lastScheduledDate = today;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

main().catch(e => { console.error(e); process.exit(1); });
