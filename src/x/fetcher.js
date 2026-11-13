// 抓取层（运行在 x.com 页面的内容脚本里）。
// 只负责「用当前已登录的网页会话读一页提及列表」，返回原始 JSON；不解析、不存储、不做任何写操作。
// X 改接口时只改这个文件和 parser.js。
//
// 【待实测】下面的接口路径、参数、请求头按 X 网页版已知形态写成，尚未在真实会话上验证，
// 结论见 README「实测结论」。

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

  /**
   * 读一页提及。cursor 为空表示最新一页。
   * 返回 { ok, status, body, rateResetAt, userId, error }，不抛异常。
   */
  async function fetchMentions(cursor) {
    const userId = sessionUserId();
    const csrf = cookie('ct0');
    if (!csrf) return { ok: false, status: 0, userId, error: 'no_session' };

    const qs = new URLSearchParams(PARAMS);
    if (cursor) qs.set('cursor', cursor);

    let res;
    try {
      res = await fetch(`${location.origin}${ENDPOINT}?${qs}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          authorization: `Bearer ${WEB_BEARER}`,
          'x-csrf-token': csrf,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': document.documentElement.lang || 'en',
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

  return { fetchMentions, sessionUserId };
})();
