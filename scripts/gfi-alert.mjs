// 지에프아이(493330) 공시·뉴스·블로그 일일 요약 → 텔레그램 전송
// GitHub Actions(.github/workflows/gfi-alert.yml)에서 매일 09:00 KST에 실행된다.
// 모든 데이터 출처는 API 키가 필요 없는 무료 공개 엔드포인트.
//
// 환경변수:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (필수 — 없으면 콘솔 출력만 하는 dry-run)
//   WINDOW_HOURS  (선택, 기본 24) — 수집 구간 길이
//   SEND_EMPTY    (선택, 'true'면 새 소식이 없어도 "없음" 메시지 전송)

const STOCK_NAME = '지에프아이';
const STOCK_CODE = '493330';
const UA = 'Mozilla/5.0 (compatible; portfolio-alert/1.0)';
const KST = 9 * 3600 * 1000;

// 수집 구간: 직전 09:00 KST 경계까지 (실행이 몇 분 늦어도 중복·누락 없이 고정된 구간)
function computeWindow() {
  const hours = Number(process.env.WINDOW_HOURS || 24);
  const nowKst = new Date(Date.now() + KST);
  const end = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate(), 9) - KST);
  if (end.getTime() > Date.now()) end.setTime(end.getTime() - 24 * 3600 * 1000);
  // 수동 실행(workflow_dispatch) 시엔 지금 시각까지 포함
  const endMs = process.env.MANUAL_RUN === 'true' ? Date.now() : end.getTime();
  return { start: endMs - hours * 3600 * 1000, end: endMs };
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const decode = (s = '') => s
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').trim();

// "2026-10-22T06:53:13" (KST, 타임존 표기 없음) → epoch ms
const kstIso = s => Date.parse(s + '+09:00');
// "202610080936" (KST) → epoch ms
const kstCompact = s => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`);

async function fetchDisclosures() {
  const j = JSON.parse(await getText(`https://m.stock.naver.com/api/stock/${STOCK_CODE}/disclosure?pageSize=30&page=1`));
  return j.map(d => ({
    title: decode(d.title).replace(/^\(주\)지에프아이\s*/, ''),
    url: `https://m.stock.naver.com/domestic/stock/${STOCK_CODE}/notice/${d.disclosureId}`,
    time: kstIso(d.datetime),
    source: d.author || '',
  }));
}

async function fetchNaverNews() {
  const j = JSON.parse(await getText(`https://m.stock.naver.com/api/news/stock/${STOCK_CODE}?pageSize=30&page=1`));
  return j.flatMap(g => g.items || []).map(n => ({
    title: decode(n.titleFull || n.title),
    url: `https://n.news.naver.com/mnews/article/${n.officeId}/${n.articleId}`,
    time: kstCompact(n.datetime),
    source: n.officeName || '',
  }));
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
    title: decode(b.noTagTitle || b.title),
    url: b.postUrl,
    time: b.addDate,
    source: decode(b.blogName || b.nickName || ''),
    // 제목에 종목명이 있으면 지에프아이 중심 글, 아니면 시황 모음 글에서 언급된 것
    focused: decode(b.title).includes(STOCK_NAME),
  }));
}

async function safe(name, fn) {
  try { return await fn(); } catch (e) { console.error(`[${name}] 실패:`, e.message); return null; }
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTime = ms => {
  const d = new Date(ms + KST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const line = it => `• <a href="${esc(it.url)}">${esc(it.title)}</a>\n   <i>${esc(it.source)} · ${fmtTime(it.time)}</i>`;

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

async function main() {
  const { start, end } = computeWindow();
  const inWin = it => it.time >= start && it.time < end;
  const byTime = (a, b) => b.time - a.time;

  const [disc, nNews, gNews, blogs] = await Promise.all([
    safe('공시', fetchDisclosures), safe('네이버뉴스', fetchNaverNews),
    safe('구글뉴스', fetchGoogleNews), safe('블로그', fetchBlogs),
  ]);

  const disclosures = (disc || []).filter(inWin).sort(byTime);

  // 네이버·구글 뉴스 병합, 제목 기준 중복 제거 (네이버 링크 우선)
  const norm = s => s.replace(/[\s"'“”‘’.…·,\[\]()]/g, '').slice(0, 30);
  const seen = new Set();
  const news = [...(nNews || []), ...(gNews || [])].filter(inWin).filter(n => {
    const k = norm(n.title);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort(byTime);

  const blogList = (blogs || []).filter(inWin)
    .sort((a, b) => (b.focused - a.focused) || byTime(a, b)).slice(0, 10);

  const failed = [['공시', disc], ['네이버뉴스', nNews], ['구글뉴스', gNews], ['블로그', blogs]]
    .filter(([, v]) => v === null).map(([n]) => n);
  const total = disclosures.length + news.length + blogList.length;

  if (!total && !failed.length && process.env.SEND_EMPTY !== 'true') {
    console.log(`새 소식 없음 (${fmtTime(start)} ~ ${fmtTime(end)}) — 전송 생략`);
    return;
  }

  const parts = [`📊 <b>${STOCK_NAME} 일일 소식</b>  (${fmtTime(start)} ~ ${fmtTime(end)})`];
  if (disclosures.length) parts.push('', `📢 <b>공시 ${disclosures.length}건</b>`, ...disclosures.map(line));
  if (news.length) parts.push('', `📰 <b>뉴스 ${news.length}건</b>`, ...news.map(line));
  if (blogList.length) parts.push('', `✍️ <b>블로그 ${blogList.length}건</b>`, ...blogList.map(line));
  if (!total) parts.push('', '새로운 공시·뉴스·블로그가 없습니다.');
  if (failed.length) parts.push('', `⚠️ 조회 실패: ${failed.join(', ')}`);

  await sendTelegram(parts.join('\n'));
  console.log(`전송 완료: 공시 ${disclosures.length}, 뉴스 ${news.length}, 블로그 ${blogList.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
