// 内容脚本：① 识别当前登录账号 ② 代后台读一页列表（抓取层在 fetcher.js）③ 在用户名旁注入排名标签 ④ 记下 X 读「回复」栏的请求地址。
// 标签只读 chrome.storage.local 里的本地快照，渲染过程不发任何网络请求。
/* global XIRFetcher */

(() => {
  // 页面结构相关的选择器集中在这里，X 改版时只改这一处
  const SEL = {
    profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
    tweet: 'article[data-testid="tweet"]',
    userName: '[data-testid="User-Name"]',
  };
  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings', 'compose', 'hashtag']);

  let account = null; // 当前账号（小写 handle）
  let users = {}; // 快照：handle -> { rank, count, color, last }
  let windowDays = 7; // 快照按几天的窗口算的
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

  async function hello(retries = 20) {
    let handle = detectHandle();
    for (let i = 0; !handle && i < retries; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      handle = detectHandle();
    }
    const userId = XIRFetcher.sessionUserId();
    if (!handle && !userId) return; // 未登录
    const res = await send({ type: 'xir:hello', handle, userId });
    if (res?.account) await useAccount(res.account);
  }

  async function useAccount(next) {
    account = next;
    const key = `snap:${account}`;
    useSnap((await chrome.storage.local.get(key))[key]);
  }

  function useSnap(snap) {
    users = snap?.users || {};
    windowDays = snap?.windowDays || 7;
    rescan();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.current) {
      // 手动绑定账号、或换号登录后由后台更新
      if (changes.current.newValue) useAccount(changes.current.newValue);
      else {
        account = null;
        useSnap(null);
      }
    }
    if (account && changes[`snap:${account}`]) useSnap(changes[`snap:${account}`].newValue);
  });

  // ---------- 代后台抓取 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'xir:fetch') return false;
    (msg.kind === 'out' ? XIRFetcher.fetchMyReplies(msg.tpl, msg.cursor) : XIRFetcher.fetchMentions(msg.cursor)).then(sendResponse);
    return true;
  });

  // ---------- 记下 X 自己读「回复」栏的请求地址 ----------
  // 「我回他多少次」要读我自己的回复列表，那个接口的参数随 X 发版变化。这里不拦截也不改页面的请求，
  // 只从浏览器的资源计时记录里看到地址（不含请求头和返回内容），交给后台存成模板。
  let lastTpl = null;
  function noteTpl(url) {
    if (!alive || url === lastTpl || XIRFetcher.isOwn(url)) return;
    try {
      const u = new URL(url);
      if (u.origin !== location.origin || !XIRFetcher.REPLIES_RE.test(u.pathname + '?')) return;
    } catch {
      return;
    }
    lastTpl = url;
    send({ type: 'xir:tpl', url });
  }
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => noteTpl(e.name))).observe({ type: 'resource', buffered: true });
  } catch {
    // 浏览器不支持就拿不到模板，弹窗里会提示「我回他」暂时没数据
  }

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

  // 标签格式：[名次图标]名次 [回复图标]次数
  const ICON_RANK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 14h3.5V8H1.5zM6.25 14h3.5V2.5h-3.5zM11 14h3.5V10H11z"/></svg>';
  const ICON_REPLY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.5L5 15v-3H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/></svg>';

  function mark(nameEl) {
    const handle = handleOf(nameEl);
    const u = handle && users[handle];
    let badge = nameEl.querySelector('.xir-badge');
    if (!u) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'xir-badge';
      badge.innerHTML = `${ICON_RANK}<span class="xir-rank"></span>${ICON_REPLY}<span class="xir-count"></span>`;
      badge.addEventListener('mouseenter', showTip);
      badge.addEventListener('mouseleave', hideTip);
    }
    // 标签放进用户名区域的最后一行里（@handle · 时间 那一行），不直接挂在用户名区域下面：
    // 别的插件（实测 FeedSieve）会把「用户名区域的最后一个子节点」当成那一行，往里塞自己的标记；
    // 我们要是成了最后一个子节点，它的标记就会塞进我们的标签里，把标签撑长。
    const host = nameEl.lastElementChild || nameEl;
    if (badge.parentElement !== host) host.appendChild(badge);
    // X 的列表会复用节点，同一个节点可能换成另一个人，每次都按当前 handle 重写
    const [rank, count] = [badge.children[1], badge.children[3]];
    if (rank.textContent !== String(u.rank)) rank.textContent = u.rank;
    if (count.textContent !== String(u.count)) count.textContent = u.count;
    badge.dataset.handle = handle;
    // 颜色由统计层按回复次数和用户设置算好，放在快照里；色值在 badge.css 的 [data-xir-c]
    badge.dataset.xirC = u.color || 'gray';
  }

  let tip;
  function showTip(e) {
    const u = users[e.currentTarget.dataset.handle];
    if (!u) return;
    tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'xir-tip' }));
    tip.textContent =
      `最近 ${windowDays} 天回复我第 ${u.rank} 名，共 ${u.count} 次\n` +
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
    hideTip();
    document.querySelectorAll(SEL.userName).forEach(mark);
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled || !alive) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      rescan();
    });
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- 页面结构自检 ----------
  // 页面上有帖子却一个用户名节点都找不到，说明 X 改了结构，告诉后台在界面上提示。
  let reported = null;
  setInterval(() => {
    if (!alive || document.hidden) return;
    const tweets = document.querySelectorAll(SEL.tweet).length;
    if (!tweets) return;
    const broken = document.querySelectorAll(`${SEL.tweet} ${SEL.userName}`).length === 0;
    if (broken !== reported) {
      reported = broken;
      send({ type: 'xir:dom', broken });
    }
  }, 15000);

  hello();
})();
