// 关系和帖子归属：接收 tap.js 转来的 X 接口返回，从里面挑出两样东西，只放在这个页面的内存里，不落盘：
//   ① 每个用户和我的关注关系（我是否关注他、他是否关注我）
//   ② 每条帖子的作者、所在对话的根帖、回复的是哪条 / 回复给谁
// content.js 给用户名旁加「互关 / 粉丝 / 已关注」和通知列表的「我帖 / 他帖」时来这里查。
// 字段名是按 X 网页版的返回结构假设的；对不上时只是查不到、不显示，不会报错。
const XIRRel = (() => {
  /**
   * 从一份接口返回里挑出用户关系和帖子。
   * @returns {{ users: Array<{id, handle, following, followedBy}>, tweets: Array<{id, uid, conv, rtoStatus, rtoUser}> }}
   */
  function extract(body) {
    const users = [];
    const tweets = [];
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
      // 帖子：GraphQL 是 { rest_id, legacy: { conversation_id_str, ... } }，REST 是帖子对象本身
      const t = lg?.conversation_id_str ? lg : typeof o.conversation_id_str === 'string' ? o : null;
      const tid = t && (t === lg ? o.rest_id || t.id_str : t.id_str);
      if (t && tid) {
        tweets.push({
          id: tid,
          uid: t.user_id_str || o.core?.user_results?.result?.rest_id || null,
          conv: t.conversation_id_str,
          rtoStatus: t.in_reply_to_status_id_str || null,
          rtoUser: t.in_reply_to_user_id_str || null,
        });
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
    }
    return { users, tweets };
  }

  /** 关系归成一个词：mutual 互关 / fan 他关注我 / following 我关注他 / none 互不关注 */
  const relOf = (u) => (u.following && u.followedBy ? 'mutual' : u.followedBy ? 'fan' : u.following ? 'following' : 'none');

  /**
   * 一条回复我的帖子，是在谁的帖子下：'me' 我的 / 'him' 回复者自己的 / 'other' 别人的 / null 看不出来。
   * 只用页面数据能直接确定的情况；确定不了的由 content.js 再去问后台的本地数据。
   */
  function placeOf(id, myId, tweets) {
    const t = tweets.get(id);
    if (!t || !myId || t.rtoUser !== myId) return null;
    if (t.conv === t.rtoStatus) return 'me'; // 直接回复的就是根帖，而回复对象是我
    const root = tweets.get(t.conv);
    if (!root?.uid) return null;
    return root.uid === myId ? 'me' : root.uid === t.uid ? 'him' : 'other';
  }

  const rel = new Map(); // 小写 handle -> 'mutual' | 'fan' | 'following' | 'none'
  const tweets = new Map(); // 帖子 ID -> { uid, conv, rtoStatus, rtoUser }
  const api = { extract, relOf, placeOf, rel, tweets, onChange: null };

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
      tweets.set(t.id, t);
    }
    trim(rel, 8000);
    trim(tweets, 8000);
    if (changed) api.onChange?.();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || typeof e.data?.xirTap !== 'string') return;
      try {
        take(e.data.xirTap);
      } catch {
        // 结构对不上就当没看到
      }
    });
  }

  return api;
})();
if (typeof globalThis !== 'undefined') globalThis.XIRRel = XIRRel;
