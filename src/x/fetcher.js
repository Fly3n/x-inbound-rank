// 抓取层（运行在 x.com 页面的内容脚本里）。
// 只负责「用当前已登录的网页会话读一页列表」（别人对我的提及、我自己的回复），返回原始 JSON；不解析、不存储、不做任何写操作。
// X 改接口时只改这个文件和 parser.js。
//
// 提及仅使用 X 网页版现行的 GraphQL NotificationsTimeline（2026-11-19 小号实测：额度 1500 次 / 15 分钟，
// 每页 40 条）；它的查询 ID 和 features 随 X 发版变，照页面发过的模板重发，模板缺失或过期时提示用户打开一次通知页，
// 不再自动降级请求已废弃的旧版 REST mentions.json。

const XIRFetcher = (() => {
  const PAGE_SIZE = 20; // 「回复」栏：与网页版自己翻页的大小一致
  const NOTIF_PAGE = 40; // 提及接口：网页版自己翻页用 40（2026-11-19 实测）

  // X 网页客户端内置的公开 Bearer（所有访客相同，不是用户凭证）；用户身份由会话 cookie 承载。
  const WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    try { return m ? decodeURIComponent(m[1]) : null; }
    catch { return null; }
  }

  /** 当前会话的用户 ID（twid cookie 形如 u=123456），读不到返回 null。 */
  function sessionUserId() {
    const twid = cookie('twid');
    const m = twid && twid.match(/u=(\d+)/);
    return m ? m[1] : null;
  }

  const own = new Set(); // 我们自己发出的请求地址，内容脚本据此不把它们当成 X 页面的请求
  const MAX_OWN = 500;
  function rememberOwn(url) {
    own.delete(url);
    own.add(url);
    while (own.size > MAX_OWN) own.delete(own.values().next().value);
  }

  /** 用当前会话发一个只读 GET。返回 { ok, status, body, rateResetAt, userId, error }，不抛异常。 */
  async function get(url, extraHeaders = {}, diagnose = false) {
    const userId = sessionUserId();
    const csrf = cookie('ct0');
    const request = diagnose ? { requestUrl: url } : {};
    if (!csrf) return { ...request, ok: false, status: 0, userId, error: 'no_session' };

    rememberOwn(url);
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          authorization: `Bearer ${WEB_BEARER}`,
          'x-csrf-token': csrf,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': document.documentElement.lang || 'en',
          ...extraHeaders,
        },
      });
    } catch (e) {
      return { ...request, ok: false, status: 0, userId, error: 'network', detail: String(e) };
    }

    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const out = {
      ...request,
      ok: res.ok,
      status: res.status,
      userId,
      rateResetAt: reset ? reset * 1000 : null,
      cfMitigated: res.headers.get('cf-mitigated') || null,
      contentType: res.headers.get('content-type') || null,
      redirected: Boolean(res.redirected),
      finalUrl: res.redirected ? String(res.url || '') : null,
    };
    if (diagnose) {
      out.responseMetadata = {
        date: res.headers.get('date'),
        age: res.headers.get('age'),
        cache: res.headers.get('x-cache'),
        cloudflareCache: res.headers.get('cf-cache-status'),
      };
    }
    let text = '';
    try {
      text = await res.text();
      out.body = JSON.parse(text);
    } catch {
      out.ok = false;
      out.error = out.error || 'not_json';
      out.detail = text.slice(0, 200);
    }
    return out;
  }

  // X 页面读通知（「全部」或「提及」）的请求，记下来当模板；读的时候一律换成「提及」
  const NOTIF_RE = /\/i\/api\/graphql\/[\w-]+\/NotificationsTimeline\?/;

  /** 把模板里的 variables 换成我们要的（cursor 为空表示最新一页），模板不对返回 null。 */
  function fromTpl(tpl, re, patch, cursor) {
    try {
      const u = new URL(tpl, location.origin);
      if (!re.test(u.pathname + '?')) return null;
      const vars = { ...JSON.parse(u.searchParams.get('variables')), ...patch };
      if (cursor) vars.cursor = cursor;
      else delete vars.cursor;
      u.searchParams.set('variables', JSON.stringify(vars));
      return `${location.origin}${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  }

  /** 读一页提及。cursor 为空表示最新一页。必须使用页面旁听到的 NotificationsTimeline 模板，不降级旧 REST。 */
  function fetchMentions(cursor, tpl) {
    if (!tpl) return Promise.resolve({ ok: false, status: 0, userId: sessionUserId(), error: 'bad_tpl' });
    const url = fromTpl(tpl, NOTIF_RE, { timeline_type: 'Mentions', count: NOTIF_PAGE }, cursor);
    if (!url) return Promise.resolve({ ok: false, status: 0, userId: sessionUserId(), error: 'bad_tpl' });
    return get(url, { 'content-type': 'application/json' }, true);
  }

  // ---- 我自己的回复列表（个人主页「回复」栏背后的 GraphQL 接口）----
  // 这个接口的查询 ID 和一长串 features 参数随 X 发版变化，不写死：
  // 内容脚本记下 X 页面自己发过的那条请求地址（模板），这里只把其中的 userId、count、cursor 换掉再发。
  // 2026-11-19 实测名字是 UserRepliesTimeline（之前是 UserTweetsAndReplies）；只要是 User 开头、带 Replies 的都认
  const REPLIES_RE = /\/i\/api\/graphql\/[\w-]+\/User\w*Replies\w*\?/;

  /** 读一页「我的帖子和回复」。tpl 是 X 页面自己发过的请求地址（2026-11-19 实测能照着发）。 */
  function fetchMyReplies(tpl, cursor) {
    const userId = sessionUserId();
    if (!userId) return Promise.resolve({ ok: false, status: 0, userId, error: 'no_session' });
    const url = fromTpl(tpl, REPLIES_RE, { userId, count: PAGE_SIZE }, cursor); // 模板可能是在别人主页上记下的，一律换成我自己
    if (!url) return Promise.resolve({ ok: false, status: 0, userId, error: 'bad_tpl' });
    return get(url, { 'content-type': 'application/json' });
  }

  // ---- 已排期帖子列表（GraphQL：FetchScheduledTweets）----
  // 同样不写死查询 ID 和 features，照着 X 页面自己发过的模板 URL 原样 GET 一次。
  const SCHED_RE = /\/i\/api\/graphql\/[\w-]+\/FetchScheduledTweets(?:\?|$)/;

  /** 读当前账号的已排期帖子列表（只读 GET）。 */
  function fetchScheduled(tpl) {
    try {
      const u = new URL(tpl, location.origin);
      if (u.origin !== location.origin || !SCHED_RE.test(u.pathname + (u.search ? '?' : ''))) {
        return Promise.resolve({ ok: false, status: 0, userId: sessionUserId(), error: 'bad_tpl' });
      }
      return get(`${location.origin}${u.pathname}${u.search}`, { 'content-type': 'application/json' });
    } catch {
      return Promise.resolve({ ok: false, status: 0, userId: sessionUserId(), error: 'bad_tpl' });
    }
  }

  /** 这个地址是哪种模板：'replies' 我的回复列表、'mentions' 通知、'scheduled' 已排期列表，都不是返回 null。 */
  function tplKind(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin) return null;
      const path = u.pathname + '?';
      return REPLIES_RE.test(path) ? 'replies' : NOTIF_RE.test(path) ? 'mentions' : SCHED_RE.test(path) ? 'scheduled' : null;
    } catch {
      return null;
    }
  }

  return { fetchMentions, fetchMyReplies, fetchScheduled, sessionUserId, tplKind, isOwn: (url) => own.has(url) };
})();

if (typeof globalThis !== 'undefined') globalThis.XIRFetcher = XIRFetcher;
