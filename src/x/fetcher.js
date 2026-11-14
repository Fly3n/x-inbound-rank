// 抓取层（运行在 x.com 页面的内容脚本里）。
// 只负责「用当前已登录的网页会话读一页列表」（别人对我的提及、我自己的回复），返回原始 JSON；不解析、不存储、不做任何写操作。
// X 改接口时只改这个文件和 parser.js。
//
// 实测（2026-11-13，小号）：这个旧版 REST 接口用下面的请求头能返回 200，不需要 x-client-transaction-id；
// 限流额度 180 次 / 15 分钟。网页版自己已改用 GraphQL 的 NotificationsTimeline，本接口随时可能下线。
// 带真实回复数据的字段尚未验证，见 README「实测结论」。

// eslint-disable-next-line no-unused-vars
const XIRFetcher = (() => {
  const ENDPOINT = '/i/api/2/notifications/mentions.json';
  const PAGE_SIZE = 20; // 与网页版自己翻页的大小一致

  // X 网页客户端内置的公开 Bearer（所有访客相同，不是用户凭证）；用户身份由会话 cookie 承载。
  const WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const PARAMS = {
    include_profile_interstitial_type: 1,
    include_blocking: 1,
    include_blocked_by: 1,
    include_followed_by: 1,
    include_want_retweets: 1,
    include_mute_edge: 1,
    include_can_dm: 1,
    include_can_media_tag: 1,
    include_ext_is_blue_verified: 1,
    skip_status: 1,
    cards_platform: 'Web-12',
    include_cards: 1,
    include_ext_alt_text: true,
    include_quote_count: true,
    include_reply_count: 1,
    tweet_mode: 'extended',
    include_entities: true,
    include_user_entities: true,
    simple_quoted_tweet: true,
    count: PAGE_SIZE,
  };

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** 当前会话的用户 ID（twid cookie 形如 u=123456），读不到返回 null。 */
  function sessionUserId() {
    const twid = cookie('twid');
    const m = twid && twid.match(/u=(\d+)/);
    return m ? m[1] : null;
  }

  const own = new Set(); // 我们自己发出的请求地址，内容脚本据此不把它们当成 X 页面的请求

  /** 用当前会话发一个只读 GET。返回 { ok, status, body, rateResetAt, userId, error }，不抛异常。 */
  async function get(url, extraHeaders = {}) {
    const userId = sessionUserId();
    const csrf = cookie('ct0');
    if (!csrf) return { ok: false, status: 0, userId, error: 'no_session' };

    own.add(url);
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
      return { ok: false, status: 0, userId, error: 'network', detail: String(e) };
    }

    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const out = { ok: res.ok, status: res.status, userId, rateResetAt: reset ? reset * 1000 : null };
    const text = await res.text();
    try {
      out.body = JSON.parse(text);
    } catch {
      out.ok = false;
      out.error = out.error || 'not_json';
      out.detail = text.slice(0, 200);
    }
    return out;
  }

  /** 读一页提及。cursor 为空表示最新一页。 */
  function fetchMentions(cursor) {
    const qs = new URLSearchParams(PARAMS);
    if (cursor) qs.set('cursor', cursor);
    return get(`${location.origin}${ENDPOINT}?${qs}`);
  }

  // ---- 我自己的回复列表（个人主页「回复」栏背后的 GraphQL 接口）----
  // 这个接口的查询 ID 和一长串 features 参数随 X 发版变化，不写死：
  // 内容脚本记下 X 页面自己发过的那条请求地址（模板），这里只把其中的 userId、count、cursor 换掉再发。
  const REPLIES_RE = /\/i\/api\/graphql\/[\w-]+\/UserTweetsAndReplies\?/;

  /** 读一页「我的帖子和回复」。tpl 是 X 页面自己发过的请求地址。【待实测】 */
  function fetchMyReplies(tpl, cursor) {
    const userId = sessionUserId();
    if (!userId) return Promise.resolve({ ok: false, status: 0, userId, error: 'no_session' });
    let url;
    try {
      const u = new URL(tpl, location.origin);
      if (!REPLIES_RE.test(u.pathname + '?')) throw new Error('not replies');
      const vars = JSON.parse(u.searchParams.get('variables'));
      vars.userId = userId; // 模板可能是在别人主页上记下的，一律换成我自己
      vars.count = PAGE_SIZE;
      if (cursor) vars.cursor = cursor;
      else delete vars.cursor;
      u.searchParams.set('variables', JSON.stringify(vars));
      url = `${location.origin}${u.pathname}${u.search}`;
    } catch {
      return Promise.resolve({ ok: false, status: 0, userId, error: 'bad_tpl' });
    }
    return get(url, { 'content-type': 'application/json' });
  }

  return { fetchMentions, fetchMyReplies, sessionUserId, REPLIES_RE, isOwn: (url) => own.has(url) };
})();
