// 内容脚本：① 识别当前登录账号 ② 代后台读一页列表（抓取层在 fetcher.js）③ 在用户名旁注入排名标签 ④ 记下 X 读「回复」栏的请求地址
// ⑤ 在用户名旁标出他和我的关注关系，通知列表里再标出这条回复是在谁的帖子下（数据来自 rel.js）。
// 标签只读 chrome.storage.local 里的本地快照和页面已经加载的数据，渲染过程不发任何网络请求。
/* global XIRFetcher, XIRRel */

(() => {
  // 页面结构相关的选择器集中在这里，X 改版时只改这一处
  const SEL = {
    profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
    tweet: 'article[data-testid="tweet"]',
    userName: '[data-testid="User-Name"]',
    statusLink: 'a[href*="/status/"]', // 帖子里带时间的那个链接，从它拿帖子 ID
  };
  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings', 'compose', 'hashtag']);

  let account = null; // 当前账号（小写 handle）
  let users = {}; // 快照：handle -> { rank, count, color, last }
  let windowDays = 7; // 快照按几天的窗口算的
  let show = { rank: true, rel: true, place: true }; // 三种标签各自显不显示（设置页的开关，随快照下发）
  let alive = true; // 插件被重载后旧脚本失效，停止一切动作

  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch(() => {
      alive = false;
      return null;
    });

  // ---------- 账号识别 ----------

  function detectHandle() {
    const href = document.querySelector(SEL.profileLink)?.getAttribute('href') || '';
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    return m ? m[1] : null;
  }

  let currentSession = null;
  function sendForSession(msg) {
    const session = XIRRel.session();
    return session ? send({ ...msg, userId: session.userId, activation: session.activation }) : Promise.resolve(null);
  }

  async function useSession(next) {
    currentSession = next;
    lastTpl = {};
    reported = null;
    account = next?.account || null;
    asking = new Set();
    clearTimeout(askTimer);
    askTimer = null;
    useSnap(null);
    if (!next) return;
    const key = `snap:${next.account}`;
    const stored = await chrome.storage.local.get(key);
    if (XIRRel.session() !== next) return;
    useSnap(stored[key]);
    sendForSession({ type: 'xir:hello', handle: detectHandle() });
    for (const url of XIRRel.tpls) noteTpl(url);
    for (const evidence of XIRRel.mentionsEvidence.splice(0)) XIRRel.onMentionsEvidence(evidence);
  }

  function useSnap(snap) {
    users = snap?.users || {};
    places.clear(); // 本机数据更新了，之前问不出来的可以再问一次
    windowDays = snap?.windowDays || 7;
    show = snap ? { rank: true, out: true, rel: true, place: true, ...snap.show } : {};
    hideTip(); // 数据变了，开着的提示可能已经过时
    rescan();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (XIRRel.session() && account && changes[`snap:${account}`]) useSnap(changes[`snap:${account}`].newValue);
  });

  // ---------- 代后台抓取 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 后台问：这个页面连着插件吗、是哪一版、见过哪些接口请求（认不出「回复」列表时拿来诊断）
    if (msg?.type === 'xir:ping') {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version, userId: XIRFetcher.sessionUserId(), handle: detectHandle() });
      return false;
    }
    if (msg?.type !== 'xir:fetch') return false;
    const session = XIRRel.session();
    if (!session || session.userId !== msg.userId || session.activation !== msg.activation) {
      sendResponse({ ok: false, error: 'no_session' });
      return false;
    }
    const run = msg.kind === 'out'
      ? XIRFetcher.fetchMyReplies(msg.tpl, msg.cursor)
      : msg.kind === 'scheduled'
        ? XIRFetcher.fetchScheduled(msg.tpl)
        : XIRFetcher.fetchMentions(msg.cursor, msg.tpl);
    run.then((result) => sendResponse(XIRRel.session() === session && result.userId === session.userId
      ? result : { ok: false, error: 'no_session' }), () => sendResponse({ ok: false, error: 'no_session' }));
    return true;
  });

  // ---------- 记下 X 自己读「回复」栏、读通知的请求地址 ----------
  // 这两个接口的参数随 X 发版变化。tap.js 看到 X 页面自己发的这两种请求，把地址报过来（不含请求头和返回内容），
  // 这里交给后台存成模板，读的时候照着发。浏览器的资源计时记录在 x.com 上是空的（2026-11-19 实测），不能靠它。
  let lastTpl = {};
  function noteTpl(url) {
    if (!alive || XIRFetcher.isOwn(url)) return;
    const kind = XIRFetcher.tplKind(url);
    if (!kind || lastTpl[kind] === url) return;
    lastTpl[kind] = url;
    sendForSession({ type: 'xir:tpl', url, kind });
  }
  XIRRel.onTpl = noteTpl;
  XIRRel.onMentionsEvidence = ({ url, status, metadata, text }) => {
    if (alive && !XIRFetcher.isOwn(url)) sendForSession({ type: 'xir:mentions:evidence', url, status, metadata, text });
  };
  XIRRel.onScheduledTap = (text) => { if (alive) sendForSession({ type: 'xir:scheduled:tap', text }); };
  XIRRel.onPostEvent = (ev) => { if (alive) sendForSession({ type: 'xir:postEvent', ...ev }); };

  // ---------- 内联标签 ----------

  const fmtDate = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  function handleOf(nameEl) {
    for (const a of nameEl.querySelectorAll('a[href^="/"]')) {
      const m = a.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && !RESERVED.has(m[1].toLowerCase())) return m[1].toLowerCase();
    }
    return null;
  }

  // 标签格式：[名次图标]名次 [回复图标]他回我的次数 [发出图标]我回他的次数（最后一段在「我回别人」读过之后才有）
  const ICON_RANK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 14h3.5V8H1.5zM6.25 14h3.5V2.5h-3.5zM11 14h3.5V10H11z"/></svg>';
  const ICON_REPLY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.5L5 15v-3H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/></svg>';

  const ICON_OUT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2 15 8 1.5 14l2.2-6z"/></svg>';

  function mark(nameEl) {
    const handle = handleOf(nameEl);
    const u = show.rank && handle && users[handle];
    let badge = nameEl.querySelector('.xir-badge');
    markRel(nameEl, handle);
    if (!u) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'xir-badge';
      badge.innerHTML = `${ICON_RANK}<span class="xir-rank"></span>${ICON_REPLY}<span class="xir-count"></span><span class="xir-out" hidden>${ICON_OUT}<span></span></span>`;
      badge.addEventListener('mouseenter', showTip);
      badge.addEventListener('mouseleave', hideTip);
    }
    // 标签放进用户名区域的最后一行里（@handle · 时间 那一行），不直接挂在用户名区域下面：
    // 别的插件（实测 FeedSieve）会把「用户名区域的最后一个子节点」当成那一行，往里塞自己的标记；
    // 我们要是成了最后一个子节点，它的标记就会塞进我们的标签里，把标签撑长。
    const host = nameEl.lastElementChild || nameEl;
    // 名次标签排在关系标签前面
    const next = host.querySelector(':scope > .xir-chip');
    if (badge.parentElement !== host || (next && badge.nextElementSibling !== next)) host.insertBefore(badge, next);
    // X 的列表会复用节点，同一个节点可能换成另一个人，每次都按当前 handle 重写
    const [rank, count] = [badge.children[1], badge.children[3]];
    if (rank.textContent !== String(u.rank)) rank.textContent = u.rank;
    if (count.textContent !== String(u.count)) count.textContent = u.count;
    const out = badge.children[4];
    const replied = show.out && u.replied != null ? String(u.replied) : null;
    if (out.hidden !== (replied == null)) out.hidden = replied == null;
    if (replied != null && out.lastChild.textContent !== replied) out.lastChild.textContent = replied;
    badge.dataset.handle = handle;
    // 颜色由统计层按回复次数和用户设置算好，放在快照里；色值在 badge.css 的 [data-xir-c]
    badge.dataset.xirC = u.color || 'gray';
  }

  // ---------- 关系标签和帖子归属标签 ----------
  // 用户名旁的单字小标，两个各自独立（负责人定：只要这三种，别的情况都不标）：
  //   关系：互（互关）、粉（他关注我、我没关注他）；通知列表里回复我的那条：M（这条回复在我的帖子下）。
  const REL = { mutual: '互', fan: '粉' };
  const REL_TIP = { mutual: '互关：你们互相关注', fan: '粉丝：他关注了你，你没有关注他' };
  const PLACE = { me: 'M' };
  const PLACE_TIP = { me: 'M：这条回复在我的帖子下' };
  const places = new Map(); // 帖子 ID -> 'me' | 'him' | 'other' | null（问过后台、本机数据也看不出来）
  let asking = new Set();
  let askTimer = null;

  function askPlaces() {
    askTimer = null;
    const ids = [...asking];
    asking = new Set();
    const session = currentSession;
    sendForSession({ type: 'xir:where', ids }).then((res) => {
      if (!session || XIRRel.session() !== session) return;
      for (const id of ids) places.set(id, res?.places?.[id] ?? null);
      if (ids.some((id) => places.get(id))) rescan();
    });
  }

  /** 通知列表里，这个用户名所在的那条帖子是在谁的帖子下；不在通知列表或看不出来返回 null。 */
  function placeFor(nameEl) {
    if (!location.pathname.startsWith('/notifications')) return null;
    const article = nameEl.closest(SEL.tweet);
    if (!article || article.querySelector(SEL.userName) !== nameEl) return null; // 只标这条帖子的作者，不标被引用的帖子
    const link = [...article.querySelectorAll(SEL.statusLink)].find((a) => a.querySelector('time'));
    const id = link?.getAttribute('href').match(/\/status\/(\d+)/)?.[1];
    if (!id) return null;
    const known = XIRRel.placeOf(id, XIRFetcher.sessionUserId(), XIRRel.tweets);
    if (known) return known;
    if (places.has(id)) return places.get(id);
    if (account && alive) {
      asking.add(id);
      askTimer ??= setTimeout(askPlaces, 300);
    }
    return null;
  }

  /** 在用户名那一行放一个单字小标（cls 区分是哪种）；text 为空就去掉。before：要排在它前面的那个节点。 */
  function chip(nameEl, cls, text, kind, title, before) {
    let el = nameEl.querySelector(`.${cls}`);
    if (!text) {
      el?.remove();
      return null;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = `xir-chip ${cls}`;
    }
    const host = nameEl.lastElementChild || nameEl;
    if (el.parentElement !== host || (before && el.nextElementSibling !== before)) host.insertBefore(el, before?.parentElement === host ? before : null);
    if (el.textContent !== text) el.textContent = text;
    el.dataset.xirK = kind;
    el.title = title;
    return el;
  }

  // 一行里的顺序：名次标签、关系、帖子归属
  function markRel(nameEl, handle) {
    const other = handle && handle !== (detectHandle() || currentSession?.handle)?.toLowerCase();
    const place = other && show.place ? placeFor(nameEl) : null;
    const rel = other && show.rel ? XIRRel.rel.get(handle) : null;
    const placeEl = chip(nameEl, 'xir-place', PLACE[place], place, PLACE_TIP[place], null);
    chip(nameEl, 'xir-rel', REL[rel], rel, REL_TIP[rel], placeEl);
  }

  let tip;
  function showTip(e) {
    const u = users[e.currentTarget.dataset.handle];
    if (!u) return;
    tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'xir-tip' }));
    tip.textContent =
      `最近 ${windowDays} 天在我帖子下回复我，第 ${u.rank} 名，共 ${u.count} 次\n` +
      (u.replied != null ? `我直接评论他的帖子 ${u.replied} 次\n` : '') +
      `最近一次：${fmtDate(u.last)}`;
    const r = e.currentTarget.getBoundingClientRect();
    tip.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    tip.style.top = `${r.bottom + 6}px`;
    tip.hidden = false;
  }
  function hideTip() {
    if (tip) tip.hidden = true;
  }

  function rescan() {
    document.querySelectorAll(SEL.userName).forEach(mark);
  }

  let scheduled = false;
  function scheduleScan() {
    if (scheduled || !alive || !XIRRel.session()) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      rescan();
    });
  }
  // 我们自己插、改标签也会触发这个监听；只动了自家节点的变化不用再扫一遍
  const OURS = '.xir-badge, .xir-chip, .xir-tip, .xir-sched';
  const isOurs = (n) => n.nodeType === 1 && n.matches(OURS);
  const onlyOurs = (r) => r.target.closest?.(OURS) || ([...r.addedNodes].every(isOurs) && [...r.removedNodes].every(isOurs));
  new MutationObserver((records) => {
    if (!records.every(onlyOurs)) scheduleScan();
  }).observe(document.body, { childList: true, subtree: true });
  XIRRel.onChange = scheduleScan; // 页面又加载了一批数据，关系可能有新的

  // ---------- 页面结构自检 ----------
  // 页面上有帖子却一个用户名节点都找不到，说明 X 改了结构，告诉后台在界面上提示。
  let reported = null;
  setInterval(() => {
    if (!alive || document.hidden || !XIRRel.session()) return;
    const tweets = document.querySelectorAll(SEL.tweet).length;
    if (!tweets) return;
    const broken = document.querySelectorAll(`${SEL.tweet} ${SEL.userName}`).length === 0;
    if (broken !== reported) {
      reported = broken;
      sendForSession({ type: 'xir:dom', broken });
    }
  }, 15000);

  const session = XIRRel.session();
  XIRRel.onSession(useSession);
  useSession(session);
})();
