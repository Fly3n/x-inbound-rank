// 旁听脚本：跑在 X 页面自己的脚本环境里（manifest 里 world: MAIN），在页面加载最早的时候装上。
// 只做一件事：X 页面自己读时间线、通知、已排期列表这些接口拿到返回后，把返回的文本抄一份转给插件（rel.js 接收）。
// 不发任何请求，不改请求，也不改返回给页面的内容。出任何错都吞掉，不能影响 X 页面本身。
(() => {
  const API = /\/i\/api\/(graphql|2)\//;
  // 每个接口请求报一下名字（诊断用：插件认不出「回复」列表时，能看到页面实际发的是哪些请求）；
  // 名字像「回复」列表（User…Replies…）、读通知（NotificationsTimeline）、读已排期列表（FetchScheduledTweets）的，把完整地址也报上去
  const OP = /\/i\/api\/graphql\/[\w-]+\/(\w+)/;
  const TPL_OP = /^User\w*Replies|^NotificationsTimeline$|^FetchScheduledTweets$/;
  const POST_OP = /^(CreateTweet|CreateScheduledTweet|DeleteScheduledTweet)$/;
  const opOf = (url) => {
    try {
      return String(url).match(OP)?.[1] || null;
    } catch {
      return null;
    }
  };
  const note = (url, method) => {
    try {
      const op = opOf(url);
      if (!op) return null;
      const upper = String(method || 'GET').toUpperCase();
      const msg = { xirOp: `${op}${upper === 'GET' ? '' : '(POST)'}` };
      if (TPL_OP.test(op)) msg.xirTpl = new URL(url, location.href).href;
      window.postMessage(msg, location.origin);
      const urlObject = op === 'NotificationsTimeline' && upper === 'GET' ? new URL(url, location.href) : null;
      const mentionsUrl = urlObject?.origin === location.origin &&
        JSON.parse(urlObject.searchParams.get('variables') || '{}')?.timeline_type === 'Mentions'
        ? urlObject.href : null;
      return { op, upper, mentionsUrl };
    } catch {
      return null;
    }
  };
  const MAX = 8_000_000; // 太大的返回不转

  const post = (text, meta, readHeader, status) => {
    try {
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
        window.postMessage({ xirTap: text, ...(meta?.op ? { xirTapOp: meta.op } : {}), ...mentions }, location.origin);
      }
      if (meta && meta.upper === 'POST' && POST_OP.test(meta.op)) {
        window.postMessage({ xirPostEvent: { op: meta.op, at: Date.now() } }, location.origin);
      }
    } catch {
      // 忽略
    }
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const meta = note(String(url), method);
      if (API.test(String(url))) {
        this.addEventListener('load', () => {
          try {
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
      const meta = note(String(url), init?.method || input?.method);
      if (API.test(String(url))) {
        p.then((res) => res.clone().text().then((text) => post(text, meta, (name) => res.headers.get(name), res.status))).catch(() => {});
      }
    } catch {
      // 忽略
    }
    return p;
  };
})();
