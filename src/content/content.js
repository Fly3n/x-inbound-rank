// 内容脚本：① 识别当前登录账号 ② 代后台读一页提及（抓取层在 fetcher.js）③ 在用户名旁注入排名标签。
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
  let users = {}; // 快照：handle -> { rank, c30, c7, last }
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
    users = (await chrome.storage.local.get(key))[key]?.users || {};
    rescan();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.current) {
      // 手动绑定账号、或换号登录后由后台更新
      if (changes.current.newValue) useAccount(changes.current.newValue);
      else {
        account = null;
        users = {};
        rescan();
      }
    }
    if (account && changes[`snap:${account}`]) {
      users = changes[`snap:${account}`].newValue?.users || {};
      rescan();
    }
  });

  // ---------- 代后台抓取 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'xir:fetch') return false;
    XIRFetcher.fetchMentions(msg.cursor).then(sendResponse);
    return true;
  });

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

  function badgeText(u) {
    return `#${u.rank} · 💬${u.c30}`;
  }

  function mark(nameEl) {
    const handle = handleOf(nameEl);
    const u = handle && users[handle];
    let badge = nameEl.querySelector(':scope > .xir-badge');
    if (!u) {
      badge?.remove();
      return;
    }
    const text = badgeText(u);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'xir-badge';
      badge.addEventListener('mouseenter', showTip);
      badge.addEventListener('mouseleave', hideTip);
      nameEl.appendChild(badge);
    }
    // X 的列表会复用节点，同一个节点可能换成另一个人，每次都按当前 handle 重写
    if (badge.textContent !== text) badge.textContent = text;
    badge.dataset.handle = handle;
    badge.classList.toggle('xir-top', u.rank <= 10);
  }

  let tip;
  function showTip(e) {
    const u = users[e.currentTarget.dataset.handle];
    if (!u) return;
    tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'xir-tip' }));
    tip.textContent =
      `30 天回复我第 ${u.rank} 名\n` +
      `30 天 ${u.c30} 次 · 7 天 ${u.c7} 次\n` +
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
