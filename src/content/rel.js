// 关系、帖子归属与原文缓存：接收 tap.js 转来的 X 接口返回，从里面挑出三样东西，只放在这个页面的内存里，不落盘：
//   ① 每个用户和我的关注关系（我是否关注他、他是否关注我）
//   ② 每条帖子的作者、所在对话的根帖、回复的是哪条 / 回复给谁
//   ③ 每条帖子的完整原文（含折叠长文 note_tweet、展开后的外链与媒体直链），供分享菜单「复制原文」零请求使用
// content.js 给用户名旁加关系小标（互 / 粉）、通知列表加帖子归属小标（M）或复制原文时来这里查。
// 字段名是按 X 网页版的返回结构假设的；对不上时只是查不到、不显示，不会报错。
const XIRRel = (() => {
  const decodeHtml = (s) => String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  /** 从单条媒体对象选出最具体的直链：视频/动图优先最高码率 mp4，图片取 media_url_https，兜底 expanded_url。 */
  function mediaUrlOf(m) {
    if (!m || typeof m !== 'object') return null;
    if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants : [];
      const mp4s = variants.filter((v) => v && typeof v.url === 'string' && (!v.content_type || v.content_type === 'video/mp4'));
      if (mp4s.length) {
        mp4s.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
        return mp4s[0].url;
      }
    }
    return (typeof m.media_url_https === 'string' && m.media_url_https)
      || (typeof m.expanded_url === 'string' && m.expanded_url)
      || null;
  }

  /**
   * 从一条 GraphQL/REST 帖子对象构造可直接复制的完整原文：
   * - 优先取 note_tweet 全文（折叠长文无需展开），其次取 legacy.full_text 并按码点跳过回复隐藏前缀；
   * - 将外链与引用短链替换为 expanded_url；
   * - 将媒体短链（或长文附带媒体）转为具体媒体直链，多条按行排列。
   * @returns {{ text: string, isNote: boolean } | null}
   */
  function formatTweetText(o, t) {
    if (!t || typeof t !== 'object') return null;
    const article = o?.article?.article_results?.result || null;
    const articleBlocks = Array.isArray(article?.content_state?.blocks) ? article.content_state.blocks : null;
    if (articleBlocks?.length) {
      const parts = [];
      if (typeof article.title === 'string' && article.title.trim()) parts.push(article.title.trim());
      for (const b of articleBlocks) {
        if (typeof b?.text === 'string' && b.text.trim()) parts.push(b.text);
      }
      if (parts.length) return { text: decodeHtml(parts.join('\n\n')).trim(), isNote: true };
    }

    const note = o?.note_tweet?.note_tweet_results?.result || o?.note_tweet_results?.result || null;
    const isNote = typeof note?.text === 'string' && note.text.length > 0;
    let raw = isNote
      ? note.text
      : (typeof t.full_text === 'string' ? t.full_text : typeof t.text === 'string' ? t.text : '');
    if (!isNote && raw && Array.isArray(t.display_text_range) && Number.isInteger(t.display_text_range[0]) && t.display_text_range[0] > 0) {
      raw = Array.from(raw).slice(t.display_text_range[0]).join('');
    }
    let text = decodeHtml(raw);

    // 外链与引用帖短链展开（在 HTML 解码后替换，避免误改 URL 查询参数）
    const urlMap = new Map();
    const collectUrls = (list) => {
      if (!Array.isArray(list)) return;
      for (const u of list) {
        if (typeof u?.url === 'string' && u.url && typeof u?.expanded_url === 'string' && u.expanded_url) {
          urlMap.set(u.url, u.expanded_url);
        }
      }
    };
    collectUrls(t.entities?.urls);
    collectUrls(note?.entity_set?.urls);
    const qp = o?.quoted_status_permalink;
    if (typeof qp?.url === 'string' && qp.url && typeof qp?.expanded === 'string' && qp.expanded) {
      urlMap.set(qp.url, qp.expanded);
    }
    for (const [shortUrl, expanded] of urlMap) {
      if (text.includes(shortUrl)) text = text.split(shortUrl).join(expanded);
    }

    // 媒体短链替换为具体直链；长文 note_tweet 不含尾部媒体短链时追加在末尾
    const mediaList = Array.isArray(t.extended_entities?.media) && t.extended_entities.media.length
      ? t.extended_entities.media
      : Array.isArray(t.entities?.media) ? t.entities.media : [];
    const byShort = new Map();
    const extraMedia = [];
    const pushUnique = (arr, val) => {
      if (val && !arr.includes(val)) arr.push(val);
    };
    for (const m of mediaList) {
      const target = mediaUrlOf(m);
      if (!target) continue;
      if (typeof m.url === 'string' && m.url) {
        if (!byShort.has(m.url)) byShort.set(m.url, []);
        pushUnique(byShort.get(m.url), target);
      } else {
        pushUnique(extraMedia, target);
      }
    }
    for (const [shortUrl, urls] of byShort) {
      if (text.includes(shortUrl)) {
        const replacement = urls.join('\n');
        const idx = text.indexOf(shortUrl);
        const before = text.slice(0, idx).replace(/[ \t]+$/, '');
        const after = text.slice(idx + shortUrl.length).replace(/^[ \t]+/, '');
        const joinBefore = before && !before.endsWith('\n') ? '\n' : '';
        const joinAfter = after && !after.startsWith('\n') ? '\n' : '';
        text = `${before}${joinBefore}${replacement}${joinAfter}${after}`;
      } else {
        for (const u of urls) pushUnique(extraMedia, u);
      }
    }
    if (extraMedia.length) {
      const missing = extraMedia.filter((u) => !text.includes(u));
      if (missing.length) {
        const trimmed = text.trimEnd();
        text = trimmed ? `${trimmed}\n${missing.join('\n')}` : missing.join('\n');
      }
    }

    text = text.trim();
    return text ? { text, isNote } : null;
  }

  /**
   * 从一份接口返回里挑出用户关系和帖子。
   * @returns {{ users: Array<{id, handle, following, followedBy}>, tweets: Array<{id, uid, conv, rtoStatus, rtoUser, text, isNote}> }}
   */
  function extract(body) {
    const users = [];
    const tweets = [];
    const seenLegacy = new WeakSet();
    const stack = [body];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) {
        for (const x of o) if (x && typeof x === 'object') stack.push(x);
        continue;
      }
      // 用户：新结构是 { rest_id, core: { screen_name }, relationship_perspectives: { following, followed_by } }，
      // 旧结构把 screen_name、following、followed_by 都放在 legacy（或 REST 接口的用户对象本身）里
      const lg = o.legacy && typeof o.legacy === 'object' ? o.legacy : null;
      const handle = o.core?.screen_name || lg?.screen_name || (typeof o.id_str === 'string' && typeof o.screen_name === 'string' ? o.screen_name : null);
      const uid = typeof o.rest_id === 'string' ? o.rest_id : o.id_str;
      if (handle && typeof handle === 'string' && uid && !o.conversation_id_str && !lg?.conversation_id_str) {
        // 关系字段只在为真时出现的情况也有，所以：这几个地方只要出现过其中一个字段，就认为关系是已知的
        const src = [o.relationship_perspectives, lg, o].find((s) => s && typeof s === 'object' && ('following' in s || 'followed_by' in s));
        if (src) users.push({ id: uid, handle: handle.toLowerCase(), following: src.following === true, followedBy: src.followed_by === true });
      }
      // 帖子：GraphQL 是 { rest_id, legacy: { conversation_id_str, ... } }，REST 是帖子对象本身；
      // GraphQL 外层已合入 legacy 后标记 seenLegacy，避免再次把内层 legacy 当独立帖子重提、丢失外层 note_tweet/quoted_status_permalink
      const t = lg?.conversation_id_str ? lg : (!seenLegacy.has(o) && typeof o.conversation_id_str === 'string' ? o : null);
      const tid = t && (t === lg ? o.rest_id || t.id_str : t.id_str);
      if (t && tid) {
        if (t === lg) seenLegacy.add(lg);
        const formatted = formatTweetText(o, t);
        tweets.push({
          id: tid,
          uid: t.user_id_str || o.core?.user_results?.result?.rest_id || null,
          conv: t.conversation_id_str,
          rtoStatus: t.in_reply_to_status_id_str || null,
          rtoUser: t.in_reply_to_user_id_str || null,
          text: formatted?.text || null,
          isNote: Boolean(formatted?.isNote),
        });
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
    }
    return { users, tweets };
  }

  /** 关系归成一个词：mutual 互关 / fan 他关注我 / following 我关注他 / none 互不关注 */
  const relOf = (u) => (u.following && u.followedBy ? 'mutual' : u.followedBy ? 'fan' : u.following ? 'following' : 'none');

  /**
   * 通知列表里一条回复是在谁的帖子下：'me' 我的 / 'him' 回复者自己的 / 'other' 别人的 / null 看不出来。
   * - 直接回复我：根帖归属已知时返回 'me' / 'him' / 'other'；
   * - 非直接回复我（如我帖子下的二、三级评论）：只要能证明根帖是我的就返回 'me'，其余返回 null。
   * 只用页面旁听内存能直接确定的情况；确定不了的由 content.js 再去问后台的本地数据。
   */
  function placeOf(id, myId, tweets, convOwners) {
    const t = tweets.get(id);
    if (!t || !myId || !t.rtoStatus) return null;
    if (t.rtoUser === myId && t.conv === t.rtoStatus) return 'me'; // 直接回复的就是根帖，而回复对象是我
    const root = tweets.get(t.conv);
    let rootUid = convOwners?.get(t.conv) || (root && !root.rtoStatus ? root.uid : null) || null;
    if (!rootUid && !convOwners) {
      for (const x of tweets.values()) {
        if (x.conv === t.conv && x.rtoStatus === t.conv && x.rtoUser) {
          rootUid = x.rtoUser;
          break;
        }
      }
    }
    if (!rootUid) return null;
    if (t.rtoUser !== myId) return rootUid === myId ? 'me' : null;
    return rootUid === myId ? 'me' : rootUid === t.uid ? 'him' : 'other';
  }

  const rel = new Map(); // 小写 handle -> 'mutual' | 'fan' | 'following' | 'none'
  const tweets = new Map(); // 帖子 ID -> { uid, conv, rtoStatus, rtoUser }
  const convOwners = new Map(); // 对话根帖 ID -> 根帖作者数字 ID（由根帖本身或一级回复直接推断，O(1) 查询）
  const tweetTexts = new Map(); // 帖子 ID -> { text, isNote }
  const tweetText = (id) => (id ? tweetTexts.get(String(id))?.text || null : null);
  const ops = new Set(); // 这个页面发过的接口请求的名字，只留最近 40 个（诊断用）
  // tpls / notificationsTaps / repliesTaps：content.js 就绪之前来的先短缓冲，就绪后由对应回调接手
  const api = {
    extract, formatTweetText, relOf, placeOf, rel, tweets, convOwners, tweetTexts, tweetText, ops,
    tpls: [], notificationsTaps: [], repliesTaps: [],
    onNotificationsTap: null, onRepliesTap: null,
    onChange: null, onTpl: null, onCreateTweetTap: null, onScheduledTap: null, onPostEvent: null,
  };

  // 页面开久了会越攒越多，超了就把最早的一批丢掉
  const trim = (map, max) => {
    if (map.size <= max) return;
    let n = map.size - Math.floor(max * 0.75);
    for (const k of map.keys()) {
      if (n-- <= 0) break;
      map.delete(k);
    }
  };

  function take(text) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    const got = extract(body);
    let changed = false;
    for (const u of got.users) {
      const r = relOf(u);
      if (rel.get(u.handle) !== r) changed = true;
      rel.set(u.handle, r);
    }
    for (const t of got.tweets) {
      if (!tweets.has(t.id)) changed = true;
      tweets.set(t.id, { id: t.id, uid: t.uid, conv: t.conv, rtoStatus: t.rtoStatus, rtoUser: t.rtoUser });
      const owner = t.id === t.conv && !t.rtoStatus ? t.uid : t.conv && t.conv === t.rtoStatus ? t.rtoUser : null;
      if (owner && convOwners.get(t.conv) !== owner) {
        convOwners.set(t.conv, owner);
        changed = true;
      }
      if (t.text) {
        const prev = tweetTexts.get(t.id);
        if (!prev || !prev.isNote || t.isNote) {
          tweetTexts.set(t.id, { text: t.text, isNote: Boolean(t.isNote) });
        }
      }
    }
    trim(rel, 8000);
    trim(tweets, 8000);
    trim(convOwners, 8000);
    trim(tweetTexts, 2000);
    if (changed) api.onChange?.();
  }

  // 开关与登录会话共同决定本页是否工作。切换时清掉上一账号留在页面里的信息。
  const BOOT_INIT = 'ui:ch:i';
  const BOOT_READY = 'ui:ch:r';
  const randCh = () => {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      return '_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return '_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  };
  const toMain = randCh();
  const toIso = randCh();
  let lastSessionMsg = null;
  const pushSession = (payload) => {
    lastSessionMsg = payload;
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    try {
      document.dispatchEvent(new CustomEvent(toMain, { detail: JSON.stringify({ t: 's', s: payload }) }));
    } catch {
      // 忽略
    }
  };
  const sendBoot = () => {
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    try {
      document.dispatchEvent(new CustomEvent(BOOT_INIT, { detail: JSON.stringify({ a: toMain, b: toIso }) }));
    } catch {
      // 忽略
    }
  };

  let accounts = {};
  let session = null;
  const listeners = new Set();
  api.onSession = (fn) => listeners.add(fn);
  api.session = () => {
    const userId = globalThis.XIRFetcher?.sessionUserId();
    const matches = userId ? Object.entries(accounts).filter(([, a]) => a.enabled && a.userId === userId) : [];
    const [account, entry] = matches.length === 1 ? matches[0] : [];
    if (session?.account === account && session?.activation === entry?.activation) return session;
    session = account ? { account, userId, activation: entry.activation, handle: entry.handle } : null;
    rel.clear();
    tweets.clear();
    convOwners.clear();
    tweetTexts.clear();
    ops.clear();
    api.tpls.length = 0;
    api.notificationsTaps.length = 0;
    api.repliesTaps.length = 0;
    pushSession(session && { userId, activation: session.activation });
    for (const fn of listeners) fn(session);
    return session;
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.addEventListener && typeof chrome !== 'undefined') {
    let readyArmed = true;
    const onReady = () => {
      disarmReady();
      sendBoot();
      pushSession(lastSessionMsg);
    };
    const disarmReady = () => {
      if (!readyArmed) return;
      readyArmed = false;
      document.removeEventListener(BOOT_READY, onReady);
    };
    document.addEventListener(toIso, (e) => {
      if (typeof e?.detail !== 'string') return;
      let data;
      try { data = JSON.parse(e.detail); } catch { return; }
      if (data?.ack === 1) {
        disarmReady();
        return;
      }
      if (!data?.s) return;
      const current = api.session();
      if (!current || data.s.userId !== current.userId || data.s.activation !== current.activation) return;
      if (typeof data.op === 'string' && data.op.length < 80) {
        ops.delete(data.op);
        ops.add(data.op);
        if (ops.size > 40) ops.delete(ops.values().next().value);
      }
      if (typeof data.tpl === 'string') {
        api.tpls.push(data.tpl);
        if (api.tpls.length > 6) api.tpls.shift();
        api.onTpl?.(data.tpl);
      }
      if (data.pe && typeof data.pe.op === 'string') {
        api.onPostEvent?.(data.pe);
      }
      if (typeof data.tap !== 'string') return;
      if (data.ev && data.tap.length < 8_000_000) {
        const item = { ...data.ev, text: data.tap };
        if (api.onNotificationsTap) api.onNotificationsTap(item);
        else {
          api.notificationsTaps.push(item);
          if (api.notificationsTaps.length > 4) api.notificationsTaps.shift();
        }
      }
      if (data.rv && data.tap.length < 8_000_000) {
        const item = { ...data.rv, text: data.tap };
        if (api.onRepliesTap) api.onRepliesTap(item);
        else {
          api.repliesTaps.push(item);
          if (api.repliesTaps.length > 4) api.repliesTaps.shift();
        }
      }
      if (data.top === 'FetchScheduledTweets') {
        try {
          api.onScheduledTap?.(data.tap);
        } catch {
          // 忽略
        }
      }
      if (data.top === 'CreateTweet') {
        try {
          api.onCreateTweetTap?.(data.tap);
        } catch {
          // 忽略
        }
      }
      try {
        take(data.tap);
      } catch {
        // 结构对不上就当没看到
      }
    });
    document.addEventListener(BOOT_READY, onReady);
    sendBoot();

    let registryChanged = false;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.accounts) return;
      registryChanged = true;
      accounts = changes.accounts.newValue || {};
      api.session();
    });
    chrome.storage.local.get('accounts').then((stored) => {
      if (registryChanged) return;
      accounts = stored.accounts || {};
      api.session();
    }).catch(() => {});
    // cookieStore 不是每个 Chrome 都支持；轮询也覆盖 X 在同一个页面内切换账号的情况。
    window.cookieStore?.addEventListener('change', () => api.session());
    setInterval(() => api.session(), 1_000);
  }

  return api;
})();
if (typeof globalThis !== 'undefined') globalThis.XIRRel = XIRRel;
