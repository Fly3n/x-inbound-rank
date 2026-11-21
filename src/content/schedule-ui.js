// X 原生排期弹窗辅助界面：在排期日期/时间选择器上方嵌入快捷半小时档期条 + 「更多档期」下拉列表。
// 只负责展示档期占用状态、点击后将带随机浮动的时间填入 X 原生表单，绝不代点确认或发布。
/* global XIRSchedule, XIRRel */

(() => {
  if (typeof XIRSchedule === 'undefined') return;

  // X 原生排期表单选择器（优先 data-testid，X 改版移除时回退语义识别）
  const SEL = {
    dialog: 'div[role="dialog"]',
    month: 'select[data-testid="scheduledDateSelectMonth"]',
    day: 'select[data-testid="scheduledDateSelectDay"]',
    year: 'select[data-testid="scheduledDateSelectYear"]',
    hour: 'select[data-testid="scheduledDateSelectHour"]',
    minute: 'select[data-testid="scheduledDateSelectMinute"]',
    ampm: 'select[data-testid="scheduledDateSelectAmPm"]',
  };

  const INLINE_LIMIT = 7; // 直接排列区最多展示最近 7 个半小时档，放不下的收进「更多档期」下拉
  const DAYS_AHEAD = 2; // 只看今天和明天

  let account = null;
  let enabled = false; // 设置页「发帖排期弹窗显示快捷档期」开关
  let alive = true;
  let state = { items: [], syncedAt: 0, lastPostAt: 0, status: 'idle', message: '' };
  let activeDialog = null;
  let panel = null;
  let dropOpen = false;
  let lastPicked = null; // { slotTs, filledTs }

  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch(() => {
      alive = false;
      return null;
    });

  // ---------- 识别 X 原生排期表单 ----------

  function findByTestId(dialog) {
    const month = dialog.querySelector(SEL.month);
    const day = dialog.querySelector(SEL.day);
    const year = dialog.querySelector(SEL.year);
    const hour = dialog.querySelector(SEL.hour);
    const minute = dialog.querySelector(SEL.minute);
    const ampm = dialog.querySelector(SEL.ampm);
    if (month && day && year && hour && minute) return { month, day, year, hour, minute, ampm };
    return null;
  }

  /** 语义兜底：X 去掉 data-testid 时，按 <select> 选项范围识别年/月/日/时/分/AMPM。 */
  function findBySemantics(dialog) {
    const selects = [...dialog.querySelectorAll('select')];
    if (selects.length < 5 || selects.length > 7) return null;
    const vals = (s) => [...s.options].map((o) => String(o.value).trim()).filter(Boolean);
    const nums = (s) => vals(s).map(Number).filter(Number.isFinite);
    let year = null;
    let month = null;
    let day = null;
    let hour = null;
    let minute = null;
    let ampm = null;
    for (const s of selects) {
      const v = vals(s);
      const n = nums(s);
      if (!v.length) continue;
      if (!ampm && v.length === 2 && v.some((x) => /am|pm|上午|下午/i.test(x))) {
        ampm = s;
      } else if (!year && n.length >= 2 && n.every((x) => x >= 2024 && x <= 2100)) {
        year = s;
      } else if (!minute && n.length === 60 && n[0] === 0 && n[n.length - 1] === 59) {
        minute = s;
      } else if (!day && n.length >= 28 && n.length <= 31 && n[0] === 1) {
        day = s;
      } else if (!hour && ((n.length === 24 && n[0] === 0) || (n.length === 12 && n[0] === 1 && !month))) {
        // 12 选项可能是月或 12 小时制的小时：结合位置与 aria-label 区分
        const label = (s.getAttribute('aria-label') || s.previousElementSibling?.textContent || '').toLowerCase();
        if (n.length === 24 || /hour|时|時/.test(label)) hour = s;
        else if (!month) month = s;
        else hour = s;
      } else if (!month && n.length === 12 && n[0] === 1) {
        month = s;
      }
    }
    if (month && day && year && hour && minute) return { month, day, year, hour, minute, ampm };
    return null;
  }

  function findScheduleForm(dialog) {
    return findByTestId(dialog) || findBySemantics(dialog);
  }

  /** 找到适合插在日期选择器上方的位置。 */
  function findMountAnchor(dialog, form) {
    let cur = form.month;
    while (cur && cur.parentElement && cur.parentElement !== dialog) {
      if (cur.parentElement.contains(form.year) && cur.parentElement.contains(form.minute)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return form.month.parentElement || dialog.firstElementChild;
  }

  // ---------- 填充 X 原生 <select>（React 受控组件兼容） ----------

  const nativeSelectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

  function setSelectValue(select, candidates) {
    if (!select) return false;
    const opts = [...select.options];
    let target = null;
    for (const c of candidates) {
      const s = String(c);
      target = opts.find((o) => o.value === s || o.textContent.trim() === s);
      if (target) break;
    }
    if (!target) return false;
    if (nativeSelectSetter) nativeSelectSetter.call(select, target.value);
    else select.value = target.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  /** X 换月后 React 可能异步重建「日」的选项：等到目标选项出现再填，最多等 600ms。 */
  async function setSelectWhenReady(select, candidates, timeout = 600) {
    const start = performance.now();
    for (;;) {
      if (setSelectValue(select, candidates)) return true;
      if (performance.now() - start >= timeout) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function fillNativeForm(form, targetTs) {
    let current = () => (activeDialog && document.contains(activeDialog) && findScheduleForm(activeDialog)) || form;
    const d = new Date(targetTs);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const h24 = d.getHours();
    const min = d.getMinutes();

    let f = current();
    const okY = setSelectValue(f.year, [y]);
    const okM = setSelectValue(f.month, [m, String(m).padStart(2, '0')]);
    await nextFrame();
    f = current();
    const okD = await setSelectWhenReady(f.day, [day, String(day).padStart(2, '0')]);

    let okH = false;
    f = current();
    if (f.ampm) {
      const isPm = h24 >= 12;
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      setSelectValue(f.ampm, isPm ? ['pm', 'PM', '下午'] : ['am', 'AM', '上午']);
      await nextFrame();
      f = current();
      okH = await setSelectWhenReady(f.hour, [h12, String(h12).padStart(2, '0')]);
    } else {
      okH = setSelectValue(f.hour, [h24, String(h24).padStart(2, '0')]);
    }
    f = current();
    const okMin = await setSelectWhenReady(f.minute, [min, String(min).padStart(2, '0')]);
    return okY && okM && okD && okH && okMin;
  }

  // ---------- 渲染与交互 ----------

  function isDarkPage() {
    const bg = getComputedStyle(document.body).backgroundColor || '';
    const m = bg.match(/\d+/g);
    if (!m || m.length < 3) return false;
    return (Number(m[0]) * 299 + Number(m[1]) * 587 + Number(m[2]) * 114) / 1000 < 128;
  }

  function slotTooltip(slot) {
    if (!slot.occupied) return `点击填入 ${slot.label} 附近随机时间（前后浮动 5–20 分钟）`;
    return slot.items
      .map((it) => `已排 ${XIRSchedule.formatTime(it.executeAt)}${it.text ? `：${it.text}` : ''}`)
      .join('\n');
  }

  function makeSlotButton(slot, form, inDropdown) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xir-sched-slot' + (slot.isHour ? ' is-hour' : '') + (slot.occupied ? ' is-busy' : '');
    if (lastPicked && lastPicked.slotTs === slot.ts) btn.classList.add('is-picked');
    btn.textContent = slot.label;
    btn.title = slotTooltip(slot);
    if (slot.occupied) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (XIRRel.session()?.account !== account || !enabled) return;
        const filledTs = XIRSchedule.pickJitteredTime(slot.ts, { nowTs: Date.now(), scheduled: state.items });
        const ok = await fillNativeForm(form, filledTs);
        if (XIRRel.session()?.account !== account || !enabled) return;
        lastPicked = { slotTs: slot.ts, filledTs, label: slot.label, ok };
        if (inDropdown) dropOpen = false;
        renderPanel((activeDialog && findScheduleForm(activeDialog)) || form);
      });
    }
    return btn;
  }

  function statusSummary() {
    if (lastPicked) {
      const t = XIRSchedule.formatTime(lastPicked.filledTs);
      return lastPicked.ok
        ? { text: `已填 ${t}（${lastPicked.label} 微调），请点确认`, tone: 'ok' }
        : { text: `未能自动填入，请手动选 ${t}`, tone: 'warn' };
    }
    if (state.status === 'loading') return { text: '正在同步已排期列表…', tone: 'muted' };
    if (state.status === 'need_tpl') return { text: state.message || '点下方「已排期帖子」完成首次同步', tone: 'warn' };
    if (state.status === 'error') return { text: state.message || '同步失败，已显示缓存', tone: 'warn' };
    const futureCount = state.items.filter((x) => x.executeAt >= Date.now() - XIRSchedule.CONFLICT_MS).length;
    if (state.syncedAt) return { text: `已同步 · ${futureCount} 条待发`, tone: 'muted' };
    return { text: '准备就绪', tone: 'muted' };
  }

  function renderPanel(form) {
    if (!panel || !activeDialog) return;
    panel.dataset.xirTheme = isDarkPage() ? 'dark' : 'light';

    const nowTs = Date.now();
    const plan = XIRSchedule.buildSchedulePlan({
      nowTs,
      days: DAYS_AHEAD,
      scheduled: state.items,
      lastPostAt: state.lastPostAt,
    });
    const primary = plan.primary;
    const inlineSlots = primary.slots.slice(0, INLINE_LIMIT);
    const hasMore = primary.slots.length > INLINE_LIMIT || plan.groups.length > 1;
    const status = statusSummary();

    panel.innerHTML = '';

    // 顶行：标题 + 状态 + 刷新按钮
    const head = document.createElement('div');
    head.className = 'xir-sched-head';
    const title = document.createElement('span');
    title.className = 'xir-sched-title';
    title.textContent = primary.dayOffset === 0 ? '快捷档期' : `快捷档期 · ${primary.title}`;
    const stat = document.createElement('span');
    stat.className = `xir-sched-stat is-${status.tone}`;
    stat.textContent = status.text;
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'xir-sched-refresh';
    refresh.title = '立即刷新已排期列表';
    refresh.setAttribute('aria-label', '立即刷新已排期列表');
    refresh.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.45-3.72l-1.55.02v1.3h3.7V1.9h-1.3l-.02 1.38A6.8 6.8 0 1 0 14.8 8h-1.3z"/></svg>';
    refresh.disabled = state.status === 'loading';
    refresh.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastPicked = null;
      syncScheduled(true, form);
    });
    head.append(title, stat, refresh);
    panel.appendChild(head);

    // 直接排列行：当天最近几个半小时档 + 「更多档期 ▾」下拉按钮
    const row = document.createElement('div');
    row.className = 'xir-sched-row';
    for (const slot of inlineSlots) row.appendChild(makeSlotButton(slot, form, false));
    if (hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'xir-sched-more' + (dropOpen ? ' is-open' : '');
      more.textContent = dropOpen ? '收起 ▴' : '更多档期 ▾';
      more.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropOpen = !dropOpen;
        renderPanel(form);
      });
      row.appendChild(more);
    }
    panel.appendChild(row);

    // 下拉列表：今天横排之后剩余的档位 + 明天全天（07:00–24:00），不与上方横排重复
    if (dropOpen && hasMore) {
      const drop = document.createElement('div');
      drop.className = 'xir-sched-drop';
      for (let i = 0; i < plan.groups.length; i++) {
        const group = plan.groups[i];
        const slots = i === 0 ? group.slots.slice(INLINE_LIMIT) : group.slots;
        if (!slots.length) continue;
        const sec = document.createElement('div');
        sec.className = 'xir-sched-day';
        const dayTitle = document.createElement('div');
        dayTitle.className = 'xir-sched-day-title';
        dayTitle.textContent = i === 0 ? `${group.title} · 其余档期` : group.title;
        const grid = document.createElement('div');
        grid.className = 'xir-sched-grid';
        for (const slot of slots) grid.appendChild(makeSlotButton(slot, form, true));
        sec.append(dayTitle, grid);
        drop.appendChild(sec);
      }
      panel.appendChild(drop);
    }
  }

  async function syncScheduled(force, form) {
    const session = XIRRel.session();
    if (!alive || !session || session.account !== account) return;
    const dialog = activeDialog;
    state.status = 'loading';
    renderPanel(form);
    const res = await send({ type: 'xir:scheduled:sync', userId: session.userId, activation: session.activation, force: !!force });
    if (XIRRel.session() !== session || activeDialog !== dialog) return;
    if (!res) {
      state.status = 'error';
      state.message = '扩展连接已断开，请刷新页面';
    } else {
      state = {
        items: Array.isArray(res.items) ? res.items : [],
        syncedAt: res.syncedAt || 0,
        lastPostAt: res.lastPostAt || 0,
        status: res.status || 'ok',
        message: res.message || '',
      };
    }
    if (activeDialog && document.contains(activeDialog)) renderPanel(form);
  }

  function unmount() {
    panel?.remove();
    panel = null;
    activeDialog = null;
    dropOpen = false;
    lastPicked = null;
  }

  function scanDialogs() {
    if (!alive || !enabled || XIRRel.session()?.account !== account) {
      if (panel) unmount();
      return;
    }
    if (activeDialog && !document.contains(activeDialog)) unmount();

    for (const dialog of document.querySelectorAll(SEL.dialog)) {
      const form = findScheduleForm(dialog);
      if (!form) continue;
      if (activeDialog === dialog && panel && dialog.contains(panel)) return;

      unmount();
      activeDialog = dialog;
      panel = document.createElement('div');
      panel.className = 'xir-sched';
      const anchor = findMountAnchor(dialog, form);
      if (anchor?.parentElement) anchor.parentElement.insertBefore(panel, anchor);
      else dialog.prepend(panel);

      // 先秒显本地缓存，再静默按需同步最新排期列表
      loadLocalCache().then(() => {
        if (activeDialog === dialog) {
          renderPanel(form);
          syncScheduled(false, form);
        }
      });
      return;
    }
  }

  async function loadLocalCache() {
    if (!account) return;
    const session = XIRRel.session();
    const keys = [`scheduled:${account}`, `lastPostAt:${account}`];
    const r = await chrome.storage.local.get(keys);
    if (XIRRel.session() !== session) return;
    const cached = r[keys[0]];
    if (cached) {
      state.items = Array.isArray(cached.items) ? cached.items : [];
      state.syncedAt = cached.syncedAt || 0;
    }
    state.lastPostAt = r[keys[1]] || 0;
  }

  async function useSession(session) {
    unmount();
    account = session?.account || null;
    enabled = false;
    state = { items: [], syncedAt: 0, lastPostAt: 0, status: 'idle', message: '' };
    if (!account) return;
    const snapKey = `snap:${account}`;
    const stored = await chrome.storage.local.get(snapKey);
    if (XIRRel.session() !== session) return;
    enabled = stored[snapKey]?.show?.schedule !== false;
    await loadLocalCache();
    scanDialogs();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || XIRRel.session()?.account !== account) return;
    if (account && changes[`snap:${account}`]) {
      const next = changes[`snap:${account}`].newValue?.show?.schedule !== false;
      if (next !== enabled) {
        enabled = next;
        scanDialogs();
      }
    }
    if (account && (changes[`scheduled:${account}`] || changes[`lastPostAt:${account}`])) {
      if (changes[`scheduled:${account}`]?.newValue) {
        const v = changes[`scheduled:${account}`].newValue;
        state.items = Array.isArray(v.items) ? v.items : [];
        state.syncedAt = v.syncedAt || 0;
        if (state.status === 'need_tpl' && state.syncedAt) {
          state.status = 'ok';
          state.message = '';
        }
      }
      if (changes[`lastPostAt:${account}`]) {
        state.lastPostAt = changes[`lastPostAt:${account}`].newValue || 0;
      }
      if (activeDialog && document.contains(activeDialog)) {
        const form = findScheduleForm(activeDialog);
        if (form) renderPanel(form);
      }
    }
  });

  let pending = false;
  const scheduleScan = () => {
    if (pending || !alive || !XIRRel.session()) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scanDialogs();
    });
  };
  new MutationObserver((records) => {
    const onlyOurs = records.every((r) => r.target.closest?.('.xir-sched'));
    if (!onlyOurs) scheduleScan();
  }).observe(document.body, { childList: true, subtree: true });

  const session = XIRRel.session();
  XIRRel.onSession(useSession);
  useSession(session);
})();
