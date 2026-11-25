import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import '../src/content/rel.js';

const { extract, formatTweetText, tweetTexts, tweetText } = globalThis.XIRRel;
const shareCopyCode = readFileSync(new URL('../src/content/share-copy.js', import.meta.url), 'utf8');

test('rel.js 原文提取：外链展开、HTML 转义还原、码点安全跳过回复前缀、多图与视频最高码率直链', () => {
  const replyWithLinksAndPhotos = {
    rest_id: '1001',
    legacy: {
      id_str: '1001',
      user_id_str: '10',
      conversation_id_str: '900',
      in_reply_to_status_id_str: '900',
      in_reply_to_user_id_str: '20',
      // 隐藏回复前缀 "@alice " 共 7 码点，正文包含 emoji 代理对、HTML 转义与外链/图片短链
      full_text: '@alice 看看 A &amp; B &gt; C &amp;lt; D 😑 https://t.co/ext1 https://t.co/pic1',
      display_text_range: [7, 60],
      entities: {
        urls: [{ url: 'https://t.co/ext1', expanded_url: 'https://example.com/path?a=1&b=2' }],
        media: [{ url: 'https://t.co/pic1', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/p1.jpg' }],
      },
      extended_entities: {
        media: [
          { url: 'https://t.co/pic1', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/p1.jpg' },
          { url: 'https://t.co/pic1', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/p2.jpg' },
        ],
      },
    },
  };

  const formatted = formatTweetText(replyWithLinksAndPhotos, replyWithLinksAndPhotos.legacy);
  assert.equal(formatted.isNote, false);
  assert.equal(
    formatted.text,
    '看看 A & B > C &lt; D 😑 https://example.com/path?a=1&b=2\nhttps://pbs.twimg.com/media/p1.jpg\nhttps://pbs.twimg.com/media/p2.jpg',
  );

  // 视频选最高码率 mp4（忽略 m3u8）
  const videoTweet = {
    rest_id: '1002',
    legacy: {
      id_str: '1002',
      user_id_str: '10',
      conversation_id_str: '1002',
      full_text: '演示视频 https://t.co/vid1',
      extended_entities: {
        media: [{
          url: 'https://t.co/vid1',
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/thumb.jpg',
          expanded_url: 'https://x.com/u/status/1002/video/1',
          video_info: {
            variants: [
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/v.m3u8' },
              { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/low.mp4' },
              { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/high.mp4' },
            ],
          },
        }],
      },
    },
  };
  assert.equal(
    formatTweetText(videoTweet, videoTweet.legacy).text,
    '演示视频\nhttps://video.twimg.com/high.mp4',
  );
});

test('rel.js 原文提取：折叠长推文 note_tweet 优先完整全文并保留附带媒体，不被残缺副本覆盖', () => {
  const longTweet = {
    rest_id: '2001',
    note_tweet: {
      note_tweet_results: {
        result: {
          text: '第一段长文内容\n\n第二段包含链接 https://t.co/long1 以及 &amp; 符号',
          entity_set: {
            urls: [{ url: 'https://t.co/long1', expanded_url: 'https://docs.example.org/full' }],
          },
        },
      },
    },
    legacy: {
      id_str: '2001',
      user_id_str: '11',
      conversation_id_str: '2001',
      full_text: '第一段长文内容… https://t.co/pic_long',
      extended_entities: {
        media: [{ url: 'https://t.co/pic_long', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/long.png' }],
      },
    },
  };

  const got = extract({ data: { tweet: longTweet } });
  assert.equal(got.tweets.length, 1);
  assert.equal(got.tweets[0].isNote, true);
  assert.equal(
    got.tweets[0].text,
    '第一段长文内容\n\n第二段包含链接 https://docs.example.org/full 以及 & 符号\nhttps://pbs.twimg.com/media/long.png',
  );

  // 模拟 X Article 正文块提取
  const articleTweet = {
    rest_id: '2002',
    article: {
      article_results: {
        result: {
          title: '长文章标题',
          content_state: { blocks: [{ text: '第一段' }, { text: '第二段 &amp; 结尾' }] },
        },
      },
    },
    legacy: { id_str: '2002', user_id_str: '11', conversation_id_str: '2002', full_text: 'https://t.co/art' },
  };
  assert.equal(formatTweetText(articleTweet, articleTweet.legacy).text, '长文章标题\n\n第一段\n\n第二段 & 结尾');

  // 模拟内存缓存防降级：先写入 note_tweet，再用不带 note_tweet 的截断版到达时不能覆盖
  tweetTexts.clear();
  tweetTexts.set('2001', { text: got.tweets[0].text, isNote: true });
  assert.equal(tweetText('2001'), got.tweets[0].text);

  // 嵌套在 legacy.retweeted_status_result 里的原帖依然能被正确提取（不被 seenLegacy 跳过）
  const retweetWrapper = {
    rest_id: '2099',
    legacy: {
      id_str: '2099',
      user_id_str: '99',
      conversation_id_str: '2099',
      full_text: 'RT @orig: 截断…',
      retweeted_status_result: {
        result: {
          rest_id: '2088',
          quoted_status_permalink: { url: 'https://t.co/qt1', expanded: 'https://x.com/someone/status/888' },
          legacy: {
            id_str: '2088',
            user_id_str: '88',
            conversation_id_str: '2088',
            full_text: '原帖完整正文 https://t.co/qt1',
          },
        },
      },
    },
  };
  const rtGot = extract({ data: { rt: retweetWrapper } });
  const orig = rtGot.tweets.find((x) => x.id === '2088');
  assert.equal(orig?.text, '原帖完整正文 https://x.com/someone/status/888');

  // 空媒体短链单帖也能直接还原成媒体直链
  const mediaOnly = {
    rest_id: '2003',
    legacy: {
      id_str: '2003',
      user_id_str: '11',
      conversation_id_str: '2003',
      full_text: 'https://t.co/onlypic',
      extended_entities: {
        media: [{ url: 'https://t.co/onlypic', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/only.jpg' }],
      },
    },
  };
  assert.equal(formatTweetText(mediaOnly, mediaOnly.legacy).text, 'https://pbs.twimg.com/media/only.jpg');
});

// ---- 轻量 DOM 模拟：验证分享菜单注入、点击复制、优先旁听、纯 DOM 回退与非分享菜单不误插 ----

function createMiniDom() {
  class FakeNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentElement = null;
      this.childNodes = [];
    }
  }
  class FakeText extends FakeNode {
    constructor(value) {
      super(3);
      this.nodeValue = value;
    }
    cloneNode() {
      return new FakeText(this.nodeValue);
    }
  }
  class FakeElement extends FakeNode {
    constructor(tagName) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map();
      this.listeners = new Map();
      this.dataset = {};
      this.style = { cssText: '' };
      this.classList = {
        add: (...cls) => {
          const set = new Set((this.attrs.get('class') || '').split(/\s+/).filter(Boolean));
          for (const c of cls) set.add(c);
          this.attrs.set('class', [...set].join(' '));
        },
        remove: (...cls) => {
          const set = new Set((this.attrs.get('class') || '').split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          this.attrs.set('class', [...set].join(' '));
        },
        toggle: (c, force) => {
          const set = new Set((this.attrs.get('class') || '').split(/\s+/).filter(Boolean));
          const has = set.has(c);
          const next = force === undefined ? !has : Boolean(force);
          if (next) set.add(c); else set.delete(c);
          this.attrs.set('class', [...set].join(' '));
        },
        contains: (c) => (this.attrs.get('class') || '').split(/\s+/).includes(c),
      };
    }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v || '')); }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    get lastElementChild() { return this.children.at(-1) || null; }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const sibs = this.parentElement.children;
      const idx = sibs.indexOf(this);
      return idx >= 0 ? sibs[idx + 1] || null : null;
    }
    get textContent() {
      return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('');
    }
    set textContent(v) {
      this.childNodes = [];
      if (v != null && String(v) !== '') this.appendChild(new FakeText(String(v)));
    }
    set innerHTML(html) {
      this.childNodes = [];
      const pathMatch = String(html).match(/<path\s+d="([^"]+)"/);
      if (pathMatch) {
        const g = new FakeElement('g');
        const p = new FakeElement('path');
        p.setAttribute('d', pathMatch[1]);
        g.appendChild(p);
        this.appendChild(g);
      }
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    }
    insertAdjacentElement(pos, el) {
      if (pos !== 'afterend' || !this.parentElement) return el;
      if (el.parentElement) el.remove();
      el.parentElement = this.parentElement;
      const idx = this.parentElement.childNodes.indexOf(this);
      this.parentElement.childNodes.splice(idx + 1, 0, el);
      return el;
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.childNodes.indexOf(this);
      if (idx >= 0) this.parentElement.childNodes.splice(idx, 1);
      this.parentElement = null;
    }
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    cloneNode(deep = false) {
      const copy = new FakeElement(this.tagName);
      for (const [k, v] of this.attrs) copy.attrs.set(k, v);
      if (deep) {
        for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
      }
      return copy;
    }
    matches(sel) {
      return sel.split(',').map((s) => s.trim()).some((part) => matchesSimple(this, part));
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (matchesSelector(c, sel, this)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    dispatchEvent(event) {
      event.target ??= this;
      for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
      return true;
    }
    getBoundingClientRect() {
      return this.attrs.get('data-backdrop') === '1'
        ? { width: 1200, height: 800 }
        : { width: 200, height: 180 };
    }
  }

  function matchesSimple(el, part) {
    let rest = part.trim();
    const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
      if (el.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    for (const m of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
      if (!el.classList.contains(m[1])) return false;
    }
    for (const m of rest.matchAll(/\[([^\]=*^$]+)(?:(\*?=)"([^"]*)")?\]/g)) {
      const [, attr, op, val] = m;
      const actual = el.getAttribute(attr);
      if (actual === null) return false;
      if (op === '=' && actual !== val) return false;
      if (op === '*=' && !actual.includes(val)) return false;
    }
    return true;
  }

  function matchesSelector(el, sel, root) {
    return sel.split(',').map((s) => s.trim()).some((branch) => {
      const tokens = branch.split(/\s+/).filter(Boolean);
      if (!matchesSimple(el, tokens.at(-1))) return false;
      let cur = el.parentElement;
      for (let i = tokens.length - 2; i >= 0; i--) {
        let ok = false;
        while (cur && cur !== root.parentElement) {
          if (matchesSimple(cur, tokens[i])) {
            ok = true;
            cur = cur.parentElement;
            break;
          }
          cur = cur.parentElement;
        }
        if (!ok) return false;
      }
      return true;
    });
  }

  const body = new FakeElement('body');
  const layers = new FakeElement('div');
  layers.setAttribute('id', 'layers');
  body.appendChild(layers);

  const docListeners = new Map();
  const doc = {
    body,
    visibilityState: 'visible',
    hidden: false,
    activeElement: body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => (id === 'layers' ? layers : null),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    dispatchEvent(event) {
      for (const fn of [...(docListeners.get(event.type) || [])]) fn(event);
      return true;
    },
  };

  let observerCb = null;
  class MutationObserver {
    constructor(cb) { observerCb = cb; }
    observe() {}
  }

  const el = (tag, attrs = {}, children = []) => {
    const node = new FakeElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) node.appendChild(typeof c === 'string' ? new FakeText(c) : c);
    return node;
  };

  return {
    FakeElement, FakeText, body, layers, doc, el, MutationObserver,
    triggerMutation: (added = []) => observerCb?.([{ target: layers, addedNodes: added, removedNodes: [] }]),
  };
}

test('分享菜单注入「复制原文」：优先旁听长文、无旁听走纯 DOM 回退（保 Emoji 去引用）、不误插普通菜单、连续切换正常', async () => {
  const dom = createMiniDom();
  const { el, body, layers, doc } = dom;
  const copied = [];
  let backdropClicks = 0;

  // 构造推文 A（旁听内存有长文）与推文 B（无旁听，含 Emoji、换行、引用帖与配图）
  const makeTweet = (id, { textChildren, quoteChildren, photoSrcs = [] }) => {
    const shareBtn = el('button', { 'aria-label': '分享帖子', role: 'button' }, [
      el('svg', { viewBox: '0 0 24 24' }, [el('g', {}, [el('path', { d: 'M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2z' })])]),
    ]);
    const caretBtn = el('button', { 'data-testid': 'caret', 'aria-label': '更多' }, []);
    const group = el('div', { role: 'group' }, [shareBtn]);
    const mainAuthor = el('div', { 'data-testid': 'User-Name' }, [el('a', { href: `/u_${id}` }, [`@u_${id}`])]);
    const timeLink = el('a', { href: `/u_${id}/status/${id}` }, [el('time', {}, ['1m'])]);
    const mainText = el('div', { 'data-testid': 'tweetText' }, textChildren);
    const photos = photoSrcs.map((src) => el('div', { 'data-testid': 'tweetPhoto' }, [el('img', { src })]));
    const quoteCard = quoteChildren
      ? el('div', { role: 'link' }, [
          el('div', { 'data-testid': 'User-Name' }, [el('a', { href: '/quoted' }, ['@quoted'])]),
          el('a', { href: '/quoted/status/999999' }, [el('time', {}, ['2h'])]),
          el('div', { 'data-testid': 'tweetText' }, quoteChildren),
          el('div', { 'data-testid': 'tweetPhoto' }, [el('img', { src: 'https://pbs.twimg.com/media/quoted_should_skip.jpg' })]),
        ])
      : null;
    const article = el('article', { 'data-testid': 'tweet' }, [
      mainAuthor, timeLink, caretBtn, mainText, ...photos, ...(quoteCard ? [quoteCard] : []), group,
    ]);
    body.appendChild(article);
    return { article, shareBtn, caretBtn };
  };

  const tweetA = makeTweet('3001', { textChildren: ['折叠后的前两行…'] });
  const tweetB = makeTweet('3002', {
    textChildren: [
      '主帖正文 ',
      el('img', { alt: '🔥' }),
      el('br'),
      '第二行 ',
      el('a', { href: 'https://docs.example.com/guide' }, ['docs.example.com/guide']),
    ],
    quoteChildren: ['被引用帖的内容绝不能混进来'],
    photoSrcs: ['https://pbs.twimg.com/media/main_photo.jpg'],
  });

  const relMem = new Map([['3001', '来自旁听内存的完整长文\nhttps://expanded.example.com/x']]);
  const rafQueue = [];
  const flushRaf = () => {
    while (rafQueue.length) rafQueue.shift()();
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
    preventDefault() {}
    stopPropagation() {}
  }

  const ctx = {
    window: { innerWidth: 1200, innerHeight: 800, addEventListener: () => {} },
    document: doc,
    Element: dom.FakeElement,
    location: { pathname: '/home', href: 'https://x.com/home' },
    navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    MutationObserver: dom.MutationObserver,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    chrome: {
      runtime: {
        id: 'test-extension',
        getManifest: () => ({ version: '0.41.0' }),
        onMessage: { addListener: () => {} },
        sendMessage: async () => null,
      },
      storage: {
        local: { get: async () => ({}) },
        onChanged: { addListener: () => {} },
      },
    },
    XIRFetcher: { sessionUserId: () => null, isOwn: () => false, tplKind: () => null },
    XIRRel: {
      session: () => null,
      onSession: () => {},
      rel: new Map(),
      tweets: new Map(),
      tpls: [],
      notificationsTaps: [],
      repliesTaps: [],
      tweetText: (id) => relMem.get(String(id)) || null,
    },
  };
  runInNewContext(shareCopyCode, ctx);

  const openMenu = (kind) => {
    const backdrop = el('div', { 'data-backdrop': '1' });
    backdrop.addEventListener('click', () => {
      backdropClicks++;
      layerWrap.remove();
    });
    const dropdown = el('div', { 'data-testid': 'Dropdown' }, kind === 'share'
      ? [
          el('div', { role: 'menuitem', tabindex: '0' }, [
            el('svg', { viewBox: '0 0 24 24' }, [el('g', {}, [el('path', { d: 'M18.36 5.64c-1.95-1.96' })])]),
            el('div', {}, [el('span', {}, ['复制链接'])]),
          ]),
          el('div', { role: 'menuitem', tabindex: '0' }, [
            el('svg', { viewBox: '0 0 24 24' }, [el('g', {}, [el('path', { d: 'M12 2.59l5.7 5.7' })])]),
            el('div', {}, [el('span', {}, ['帖子分享途径…'])]),
          ]),
        ]
      : [
          el('div', { role: 'menuitem', tabindex: '0' }, [
            el('svg', { viewBox: '0 0 24 24' }, [el('g', {}, [el('path', { d: 'M9 9h6v6H9z' })])]),
            el('div', {}, [el('span', {}, ['不感兴趣'])]),
          ]),
        ]);
    const menu = el('div', { role: 'menu' }, [dropdown]);
    const layerWrap = el('div', {}, [backdrop, menu]);
    layers.appendChild(layerWrap);
    dom.triggerMutation([layerWrap]);
    flushRaf();
    return { dropdown, layerWrap };
  };

  // 1. 点击推文 A 的分享按钮 -> 在「复制链接」后插入「复制原文」-> 点击复制拿到旁听完整长文并关闭菜单
  doc.dispatchEvent(new FakeEvent('click', { target: tweetA.shareBtn }));
  const menuA = openMenu('share');
  const itemsA = menuA.dropdown.querySelectorAll('[role="menuitem"]');
  assert.deepEqual(itemsA.map((x) => x.textContent), ['复制链接', '复制原文', '帖子分享途径…']);
  itemsA[1].dispatchEvent(new FakeEvent('click', { target: itemsA[1] }));
  await new Promise((r) => setImmediate(r));
  flushRaf();
  assert.equal(copied[0], '来自旁听内存的完整长文\nhttps://expanded.example.com/x');
  assert.equal(backdropClicks, 1, '复制完成后自动关闭分享菜单');
  assert.equal(doc.querySelector('.xir-toast')?.textContent, '已复制原文');

  // 2. 点击「更多」(...) 按钮打开普通菜单 -> 绝不误插「复制原文」
  doc.dispatchEvent(new FakeEvent('click', { target: tweetA.caretBtn }));
  const caretMenu = openMenu('caret');
  assert.equal(caretMenu.dropdown.querySelector('.xir-copy-item'), null, '普通下拉菜单不能被误插');
  caretMenu.layerWrap.remove();

  // 3. 在推文 A 菜单尚未关闭时直接点推文 B 的分享按钮 -> 新打开的推文 B 菜单依然正常注入并走纯 DOM 回退
  doc.dispatchEvent(new FakeEvent('click', { target: tweetA.shareBtn }));
  const staleMenuA = openMenu('share');
  doc.dispatchEvent(new FakeEvent('pointerdown', { target: tweetB.shareBtn }));
  flushRaf(); // 此时旧 menuA 还在 DOM 中，不得清掉 pendingShare
  staleMenuA.layerWrap.remove();
  doc.dispatchEvent(new FakeEvent('click', { target: tweetB.shareBtn }));
  const menuB = openMenu('share');
  const copyB = menuB.dropdown.querySelector('.xir-copy-item');
  assert.ok(copyB, '连续切换分享菜单时仍应正常注入');
  copyB.dispatchEvent(new FakeEvent('click', { target: copyB }));
  await new Promise((r) => setImmediate(r));
  flushRaf();
  assert.equal(copied[1], '主帖正文 🔥\n第二行 https://docs.example.com/guide\nhttps://pbs.twimg.com/media/main_photo.jpg');
});
