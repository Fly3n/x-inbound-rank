// 内容脚本：在推文分享菜单注入「复制原文」（常开轻量增强，零请求）。
// 原文优先读 rel.js 旁听内存里的完整文本（长文、外链展开、媒体直链），没有时退回纯 DOM 解析；不读本机数据、不发任何消息。
/* global XIRRel */

(() => {
  // 本功能用到的页面结构选择器集中在这里，X 改版时只改这一处
  const SEL = {
    tweet: 'article[data-testid="tweet"]',
    userName: '[data-testid="User-Name"]',
    statusLink: 'a[href*="/status/"]',
    tweetText: '[data-testid="tweetText"]',
    tweetPhoto: '[data-testid="tweetPhoto"]',
    actionGroup: '[role="group"]',
    dropdown: '[data-testid="Dropdown"]',
    menu: '[role="menu"]',
    menuItem: '[role="menuitem"]',
  };
  const SHARE_ICON_PREFIX = 'M12 2.59l5.7 5.7';
  const LINK_ICON_PREFIX = 'M18.36 5.64';
  const COPY_TEXT_ICON_PATH = 'M7 4.5C7 3.12 8.12 2 9.5 2h8C18.88 2 20 3.12 20 4.5v10c0 1.38-1.12 2.5-2.5 2.5h-8C8.12 17 7 15.88 7 14.5v-10zM9.5 4c-.28 0-.5.22-.5.5v10c0 .28.22.5.5.5h8c.28 0 .5-.22.5-.5v-10c0-.28-.22-.5-.5-.5h-8zM4 7.5C4 6.67 4.67 6 5.5 6H6v2h-.5v11.5c0 .28.22.5.5.5H15v2H6c-1.38 0-2.5-1.12-2.5-2.5V7.5z';
  const SHARE_PENDING_TTL_MS = 2_000;

  // 插件被重载后旧脚本的 chrome.runtime.id 会消失，此后不再注入
  const alive = () => !!globalThis.chrome?.runtime?.id;

  // ---------- 定位帖子与读 DOM 原文 ----------

  function isInsideQuote(el, article) {
    const mainAuthor = article.querySelector(SEL.userName);
    let cur = el.parentElement;
    while (cur && cur !== article) {
      const names = cur.querySelectorAll(SEL.userName);
      if (names.length && (!mainAuthor || ![...names].includes(mainAuthor))) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function tweetIdOf(article) {
    if (!article) return null;
    const links = [...article.querySelectorAll(SEL.statusLink)].filter((a) => !isInsideQuote(a, article));
    const timeLink = links.find((a) => a.querySelector('time'));
    const hit = (timeLink || links[0])?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
    if (hit) return hit;
    const pathId = location.pathname.match(/\/status\/(\d+)/)?.[1];
    if (pathId && document.querySelector(SEL.tweet) === article) return pathId;
    return null;
  }

  function readTweetTextNode(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (tag === 'IMG') return node.getAttribute('alt') || '';
    if (tag === 'BR') return '\n';
    if (tag === 'A') {
      const visible = [...node.childNodes].map(readTweetTextNode).join('');
      const href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        const trimmed = visible.trim();
        if (/^https?:\/\//i.test(trimmed) && !/(?:…|\.\.\.)$/.test(trimmed)) return trimmed;
        if (!/^https?:\/\/t\.co\//i.test(href)) return href;
      }
      return visible;
    }
    return [...node.childNodes].map(readTweetTextNode).join('');
  }

  function extractDomTweetText(article) {
    if (!article) return '';
    const textEl = [...article.querySelectorAll(SEL.tweetText)].find((el) => !isInsideQuote(el, article));
    let text = textEl ? readTweetTextNode(textEl).trim() : '';
    const mediaUrls = [];
    for (const img of article.querySelectorAll(`${SEL.tweetPhoto} img[src]`)) {
      if (isInsideQuote(img, article)) continue;
      const src = img.getAttribute('src');
      if (src && !mediaUrls.includes(src)) mediaUrls.push(src);
    }
    if (mediaUrls.length) {
      const missing = mediaUrls.filter((u) => !text.includes(u));
      if (missing.length) text = text ? `${text}\n${missing.join('\n')}` : missing.join('\n');
    }
    return text.trim();
  }

  function isShareButton(btn, article) {
    if (!btn || !article) return false;
    if (btn.getAttribute('data-testid') === 'share') return true;
    const group = btn.closest(SEL.actionGroup);
    if (!group || !article.contains(group)) return false;
    const path = btn.querySelector('svg path')?.getAttribute('d') || '';
    if (path.startsWith(SHARE_ICON_PREFIX)) return true;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    return /(^|\b)share\b|分享/.test(label);
  }

  // ---------- 剪贴板与提示 ----------

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // 焦点状态异常时退回 textarea
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  let toastTimer = null;
  let toastHideTimer = null;
  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    let el = document.querySelector('.xir-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'xir-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('is-error', isError);
    el.classList.remove('is-show');
    requestAnimationFrame(() => el.classList.add('is-show'));
    toastTimer = setTimeout(() => {
      el.classList.remove('is-show');
      toastHideTimer = setTimeout(() => el.remove(), 220);
    }, 2_000);
  }

  // ---------- 分享菜单注入 ----------

  function closeShareMenu(dropdown) {
    const menu = dropdown?.closest(SEL.menu) || dropdown;
    const layers = document.getElementById('layers');
    if (menu && layers?.contains(menu)) {
      let cur = menu;
      while (cur && cur.parentElement && cur.parentElement !== layers) {
        const siblings = [...cur.parentElement.children].filter((c) => c !== cur && !c.contains(menu));
        const backdrop = siblings.find((c) => {
          const r = c.getBoundingClientRect?.();
          return r && r.width >= window.innerWidth * 0.5 && r.height >= window.innerHeight * 0.5;
        }) || siblings[0];
        if (backdrop) {
          for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            const Ctor = type === 'pointerdown' && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
            backdrop.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
          }
          return;
        }
        cur = cur.parentElement;
      }
    }
    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
    (document.activeElement || document).dispatchEvent(esc);
  }

  function findShareMenuAnchor(dropdown) {
    const items = [...dropdown.querySelectorAll(SEL.menuItem)];
    if (!items.length) return null;
    const copyLink = items.find((it) => {
      const d = it.querySelector('svg path')?.getAttribute('d') || '';
      if (d.startsWith(LINK_ICON_PREFIX)) return true;
      return /复制链接|copy link/i.test(it.textContent || '');
    });
    if (copyLink) return copyLink;
    const hasShareVia = items.some((it) => (it.querySelector('svg path')?.getAttribute('d') || '').startsWith(SHARE_ICON_PREFIX));
    return hasShareVia ? items[0] : null;
  }

  function buildCopyMenuItem(anchor, source, dropdown) {
    const item = anchor.cloneNode(true);
    item.classList.add('xir-copy-item');
    item.removeAttribute('data-testid');
    const svg = item.querySelector('svg');
    if (svg) {
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.innerHTML = `<g><path d="${COPY_TEXT_ICON_PATH}"></path></g>`;
    }
    const spans = item.querySelectorAll('span');
    if (spans.length) {
      spans[spans.length - 1].textContent = '复制原文';
    } else {
      item.textContent = '复制原文';
    }
    const run = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = (source.tweetId && XIRRel.tweetText?.(source.tweetId)) || extractDomTweetText(source.article);
      if (!text) {
        closeShareMenu(dropdown);
        showToast('这条帖子没有可复制的正文', true);
        return;
      }
      const ok = await copyToClipboard(text);
      closeShareMenu(dropdown);
      showToast(ok ? '已复制原文' : '复制失败，请重试', !ok);
    };
    item.addEventListener('click', run);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') run(e);
    });
    return item;
  }

  let pendingShare = null;
  let shareCheckScheduled = false;

  function injectShareCopyItem() {
    if (!pendingShare) return;
    if (Date.now() - pendingShare.at > SHARE_PENDING_TTL_MS) {
      pendingShare = null;
      return;
    }
    for (const dropdown of document.querySelectorAll(SEL.dropdown)) {
      if (dropdown.querySelector('.xir-copy-item')) continue;
      const anchor = findShareMenuAnchor(dropdown);
      if (!anchor) continue;
      const source = pendingShare;
      pendingShare = null;
      const item = buildCopyMenuItem(anchor, source, dropdown);
      anchor.insertAdjacentElement('afterend', item);
      return;
    }
  }

  function scheduleShareMenu() {
    if (shareCheckScheduled || !alive()) return;
    shareCheckScheduled = true;
    requestAnimationFrame(() => {
      shareCheckScheduled = false;
      injectShareCopyItem();
    });
  }

  function trackShareTrigger(target) {
    if (!alive() || !(target instanceof Element)) return;
    if (target.closest('.xir-copy-item')) return;
    const btn = target.closest('button');
    const article = btn?.closest(SEL.tweet);
    if (btn && article && isShareButton(btn, article)) {
      pendingShare = { article, tweetId: tweetIdOf(article), at: Date.now() };
      scheduleShareMenu();
    } else if (!target.closest(SEL.menu)) {
      pendingShare = null;
    }
  }

  document.addEventListener('pointerdown', (e) => trackShareTrigger(e.target), true);
  document.addEventListener('click', (e) => trackShareTrigger(e.target), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') trackShareTrigger(e.target);
  }, true);

  // 只在刚点过分享按钮、等菜单出现时才做事；其余页面变化直接忽略
  new MutationObserver(() => {
    if (pendingShare) scheduleShareMenu();
  }).observe(document.body, { childList: true, subtree: true });
})();
