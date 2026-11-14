// 旁听脚本：跑在 X 页面自己的脚本环境里（manifest 里 world: MAIN），在页面加载最早的时候装上。
// 只做一件事：X 页面自己读时间线、通知这些接口拿到返回后，把返回的文本抄一份转给插件（rel.js 接收）。
// 不发任何请求，不改请求，也不改返回给页面的内容。出任何错都吞掉，不能影响 X 页面本身。
(() => {
  const API = /\/i\/api\/(graphql|2)\//;
  const REPLIES = /\/i\/api\/graphql\/[\w-]+\/UserTweetsAndReplies\?/; // 我自己主页「回复」栏的列表
  const note = (url) => {
    try {
      if (REPLIES.test(url)) window.postMessage({ xirTpl: new URL(url, location.href).href }, location.origin);
    } catch {
      // 忽略
    }
  };
  const MAX = 8_000_000; // 太大的返回不转

  const post = (text) => {
    try {
      if (typeof text === 'string' && text.length < MAX && text[0] === '{') window.postMessage({ xirTap: text }, location.origin);
    } catch {
      // 忽略
    }
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      note(String(url));
      if (API.test(String(url))) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') post(this.responseText);
            else if (this.responseType === 'json') post(JSON.stringify(this.response));
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
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      note(String(url));
      if (API.test(String(url))) {
        p.then((res) => res.clone().text().then(post)).catch(() => {});
      }
    } catch {
      // 忽略
    }
    return p;
  };
})();
