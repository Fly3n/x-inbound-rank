// 旁听脚本：跑在 X 页面自己的脚本环境里（manifest 里 world: MAIN），在页面加载最早的时候装上。
// 只做一件事：X 页面自己读时间线、通知、已排期列表这些接口拿到返回后，把返回的文本抄一份转给插件（rel.js 接收）。
// 不发任何请求，不改请求，也不改返回给页面的内容。出任何错都吞掉，不能影响 X 页面本身。
(() => {
  const API = /\/i\/api\/(graphql|2)\//;
  // 每个接口请求报一下名字（诊断用：插件认不出「回复」列表时，能看到页面实际发的是哪些请求）；
  // 名字像「回复」列表（User…Replies…）、读通知（NotificationsTimeline）、读已排期列表（FetchScheduledTweets）的，把完整地址也报上去
  const OP = /\/i\/api\/graphql\/[\w-]+\/(\w+)/;
  // 只有隔离脚本确认本页账号已开启后，才读取响应。请求发出时固定会话，切号后丢弃迟到的结果。
  let approval = null;
  const sessionId = () => {
    const raw = document.cookie.match(/(?:^|;\s*)twid=([^;]*)/)?.[1];
    try { return raw && decodeURIComponent(raw).match(/u=(\d+)/)?.[1]; }
    catch { return null; }
  };
  const approved = () => approval?.userId && sessionId() === approval.userId ? approval : null;
  window.addEventListener('message', (event) => {
    if (event.source === window && event.origin === location.origin && event.data?.xirSetSession === true) {
      approval = event.data.session;
    }
  });
  const TPL_OP = /^User\w*Replies|^NotificationsTimeline$|^FetchScheduledTweets$/;
  const POST_OP = /^(CreateTweet|CreateScheduledTweet|DeleteScheduledTweet)$/;
  const opOf = (url) => {
    try {
      return String(url).match(OP)?.[1] || null;
    } catch {
      return null;
    }
  };
  const note = (url, method, session) => {
    try {
      const op = opOf(url);
      if (!op) return { session };
      const upper = String(method || 'GET').toUpperCase();
      const msg = { xirSession: session, xirOp: `${op}${upper === 'GET' ? '' : '(POST)'}` };
      if (TPL_OP.test(op)) msg.xirTpl = new URL(url, location.href).href;
      window.postMessage(msg, location.origin);
      const urlObject = op === 'NotificationsTimeline' && upper === 'GET' ? new URL(url, location.href) : null;
      const mentionsUrl = urlObject?.origin === location.origin &&
        JSON.parse(urlObject.searchParams.get('variables') || '{}')?.timeline_type === 'Mentions'
        ? urlObject.href : null;
      return { op, upper, mentionsUrl, session };
    } catch {
      return { session };
    }
  };
  const MAX = 8_000_000; // 太大的返回不转

  const post = (text, meta, readHeader, status) => {
    try {
      const current = approved();
      if (!current || current.userId !== meta.session.userId || current.activation !== meta.session.activation) return;
      if (typeof text === 'string' && text.length < MAX && text[0] === '{') {
        const mentions = meta?.mentionsUrl ? {
          xirMentionsEvidence: {
            url: meta.mentionsUrl, status,
            metadata: {
              date: readHeader('date'), age: readHeader('age'),
              cache: readHeader('x-cache'), cloudflareCache: readHeader('cf-cache-status'),
            },
          },
        } : {};
        window.postMessage({ xirSession: current, xirTap: text, ...(meta?.op ? { xirTapOp: meta.op } : {}), ...mentions }, location.origin);
      }
      if (meta.upper === 'POST' && POST_OP.test(meta.op)) {
        window.postMessage({ xirSession: current, xirPostEvent: { op: meta.op, at: Date.now() } }, location.origin);
      }
    } catch {
      // 忽略
    }
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const session = API.test(String(url)) && approved();
      if (session) {
        const meta = note(String(url), method, session);
        this.addEventListener('load', () => {
          try {
            if (approved() !== session) return;
            const header = (name) => this.getResponseHeader(name);
            if (this.responseType === '' || this.responseType === 'text') post(this.responseText, meta, header, this.status);
            else if (this.responseType === 'json') post(JSON.stringify(this.response), meta, header, this.status);
          } catch {
            // 忽略
          }
        });
      }
    } catch {
      // 忽略
    }
    return open.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const session = API.test(String(url)) && approved();
      if (session) {
        const meta = note(String(url), init?.method || input?.method, session);
        p.then((res) => {
          if (approved() !== session) return;
          return res.clone().text().then((text) => post(text, meta, (name) => res.headers.get(name), res.status));
        }).catch(() => {});
      }
    } catch {
      // 忽略
    }
    return p;
  };
})();
