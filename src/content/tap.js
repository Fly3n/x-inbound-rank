// 旁听脚本：跑在 X 页面自己的脚本环境里（manifest 里 world: MAIN），在页面加载最早的时候装上。
// 只做一件事：X 页面自己读时间线、通知、已排期列表这些接口拿到返回后，经由页面启动时协商的随机通道转给隔离环境（rel.js 接收）。
// 不走全局 window.postMessage 广播，不发任何请求，不改请求，也不改返回给页面的内容。出任何错都吞掉，不能影响 X 页面本身。
(() => {
  const API = /\/i\/api\/(graphql|2)\//;
  const OP = /\/i\/api\/graphql\/[\w-]+\/(\w+)/;
  const TPL_OP = /^User\w*Replies|^NotificationsTimeline$|^FetchScheduledTweets$/;
  const POST_OP = /^(CreateScheduledTweet|DeleteScheduledTweet)$/;
  const BOOT_INIT = 'ui:ch:i';
  const BOOT_READY = 'ui:ch:r';
  // 在 document_start 缓存原生引用，避免页面脚本后续改写 CustomEvent / JSON / document 事件方法
  const docAdd = document.addEventListener.bind(document);
  const docRemove = document.removeEventListener.bind(document);
  const docDispatch = document.dispatchEvent.bind(document);
  const CE = CustomEvent;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  // 只有隔离脚本确认本页账号已开启后，才读取响应。请求发出时固定会话，切号后丢弃迟到的结果。
  let approval = null;
  let toIso = null;
  const sessionId = () => {
    const raw = document.cookie.match(/(?:^|;\s*)twid=([^;]*)/)?.[1];
    try { return raw && decodeURIComponent(raw).match(/u=(\d+)/)?.[1]; }
    catch { return null; }
  };
  const approved = () => approval?.userId && sessionId() === approval.userId ? approval : null;
  const emit = (payload) => {
    if (!toIso) return;
    try {
      docDispatch(new CE(toIso, { detail: jsonStringify(payload) }));
    } catch {
      // 忽略
    }
  };
  const onBoot = (event) => {
    if (toIso || typeof event?.detail !== 'string') return;
    try {
      const ch = jsonParse(event.detail);
      if (typeof ch?.a !== 'string' || typeof ch?.b !== 'string' || !ch.a || !ch.b) return;
      toIso = ch.b;
      docRemove(BOOT_INIT, onBoot);
      docAdd(ch.a, (ev) => {
        if (typeof ev?.detail !== 'string') return;
        try {
          const msg = jsonParse(ev.detail);
          if (msg?.t === 's') approval = msg.s;
        } catch {
          // 忽略
        }
      });
      // 通知隔离脚本握手已完成，立即摘掉 BOOT_READY 监听，防止页面脚本伪造握手探出通道名
      emit({ ack: 1 });
    } catch {
      // 忽略
    }
  };
  docAdd(BOOT_INIT, onBoot);
  try {
    docDispatch(new CE(BOOT_READY));
  } catch {
    // 忽略
  }

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
      const msg = { s: session, op: `${op}${upper === 'GET' ? '' : '(POST)'}` };
      let sameOriginUrl = null;
      if (TPL_OP.test(op)) {
        const urlObject = new URL(url, location.href);
        msg.tpl = urlObject.href;
        if (urlObject.origin === location.origin) sameOriginUrl = urlObject.href;
      }
      emit(msg);
      const notifUrl = op === 'NotificationsTimeline' && upper === 'GET' ? sameOriginUrl : null;
      const repliesUrl = /^User\w*Replies/.test(op) && upper === 'GET' ? sameOriginUrl : null;
      return { op, upper, notifUrl, repliesUrl, session };
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
        const ev = meta?.notifUrl ? {
          url: meta.notifUrl, status,
          metadata: {
            date: readHeader('date'), age: readHeader('age'),
            cache: readHeader('x-cache'), cloudflareCache: readHeader('cf-cache-status'),
          },
        } : undefined;
        const rv = meta?.repliesUrl ? { url: meta.repliesUrl, status } : undefined;
        emit({ s: current, tap: text, ...(meta?.op ? { top: meta.op } : {}), ...(ev ? { ev } : {}), ...(rv ? { rv } : {}) });
      }
      if (meta.upper === 'POST' && POST_OP.test(meta.op)) {
        emit({ s: current, pe: { op: meta.op, at: Date.now() } });
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
