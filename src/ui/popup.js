// 弹窗：榜单页、设置页。只和后台通信，不直接发任何 X 请求。
import { COLORS, LIMITS, DEFAULT_RULES, colorOf } from '../rank.js';

const $ = (id) => document.getElementById(id);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const view = { account: null, tab: null, rows: [], rules: null, eventCount: 0, tiersKey: '', open: null, detail: null }; // open：榜单里点开的那个人

const COLOR_NAMES = { red: '红', orange: '橙', yellow: '黄', green: '绿', cyan: '青', blue: '蓝', purple: '紫', gray: '灰' };
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const fmtTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const windowLabel = (days) => (days === 15 ? '半个月' : ` ${days} 天`);

function el(tag, props = {}, children = []) {
  const { dataset, ...rest } = props;
  const n = Object.assign(document.createElement(tag), rest);
  Object.assign(n.dataset, dataset);
  n.append(...children);
  return n;
}

function banners(items) {
  $('banners').replaceChildren(...items.map(([kind, text]) => el('div', { className: `banner ${kind}`, textContent: text })));
}

/** 用户正在输入的框不去覆盖它的值。 */
function setValue(input, value) {
  if (document.activeElement !== input) input.value = String(value);
}

function jobText(job) {
  const reached = job.oldestTs ? `，已回溯到 ${fmtDay(job.oldestTs)}` : '';
  const progress = `已读 ${job.pages} 页、入库 ${job.added} 条${reached}`;
  const next = job.nextAt && job.nextAt > Date.now() ? `，下一次请求约 ${fmtTime(job.nextAt)}` : '';
  return {
    running: `进行中（范围 ${job.rangeDays} 天）：${progress}${next}`,
    waiting_tab: `等待中：${job.message}。${progress}`,
    paused: `已暂停：${job.message}。${progress}${job.auto ? next : ''}`,
    error: `出错停止：${job.message}。${progress}`,
    done: job.reachedEnd
      ? job.oldestTs
        ? `已完成，但没翻到 ${job.rangeDays} 天前：X 的提及列表到底了，最早只拿到 ${fmtDay(job.oldestTs)}。共入库 ${job.added} 条`
        : '已完成：X 的提及列表是空的，没有可回填的数据'
      : `已完成：回溯到 ${fmtDay(job.oldestTs)}（范围 ${job.rangeDays} 天），共读 ${job.pages} 页、入库 ${job.added} 条`,
  }[job.status];
}

// ---------- 榜单页 ----------

const fetchDetail = () => call('getReplies', { account: view.account, actorId: view.open });

/** 点开某个人后，他那一行下面展开的回复列表。每条点了跳到 X 上的那条回复。 */
function detailRow() {
  const d = view.detail;
  if (!d) return el('li', { className: 'detail hint', textContent: '读取中…' });
  const more = d.total > d.items.length ? `，这里显示最近 ${d.items.length} 条` : '';
  return el('li', { className: 'detail' }, [
    el('div', { className: 'hint', textContent: `窗口内在我的帖子下回复了 ${d.total} 次${more}：` }),
    ...d.items.map((it) =>
      el('a', { className: 'reply', href: `https://x.com/i/status/${it.id}`, target: '_blank', rel: 'noreferrer' }, [
        el('span', { className: 'time', textContent: fmtTime(it.created_at) }),
        el('span', { className: 'text', textContent: it.text || '（没存内容，点开看原文）' }),
      ]),
    ),
  ]);
}

function renderList() {
  const { eventCount } = view;
  const q = $('search').value.trim().toLowerCase().replace(/^@/, '');
  const rows = q ? view.rows.filter((r) => r.handle.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : view.rows;
  const empty = !eventCount
    ? '还没有数据，到「设置」页点「启动 / 初始化」'
    : q
      ? '榜上没有匹配的人'
      : `这个窗口内还没有人回复我 ${view.rules.minCount} 次及以上`;
  $('list').replaceChildren(
    ...(rows.length
      ? rows.flatMap((r) => [
          el('li', { className: 'person', title: '点开看他回复了哪几条', dataset: { actor: r.actor_id } }, [
            el('span', { className: 'rank', textContent: r.rank }),
            el('img', { src: r.avatar, alt: '', referrerPolicy: 'no-referrer', loading: 'lazy' }),
            el('div', { className: 'who' }, [
              el('a', { className: 'name', href: `https://x.com/${r.handle}`, target: '_blank', rel: 'noreferrer', textContent: r.name }),
              el('span', { className: 'sub', textContent: `@${r.handle} · 最近 ${fmtTime(r.last)}` }),
            ]),
            el('span', { className: 'chip', dataset: { xirC: r.color }, title: '窗口内的回复次数，颜色和时间线标签一致', textContent: `${r.count} 次` }),
          ]),
          ...(view.open === r.actor_id ? [detailRow()] : []),
        ])
      : [el('li', { className: 'empty', textContent: empty })]),
  );
}

// ---------- 设置页：颜色档位 ----------

function swatches(current, onPick) {
  return el(
    'span',
    { className: 'swatches' },
    COLORS.map((c) => {
      const b = el('button', { className: c === current ? 'on' : '', title: COLOR_NAMES[c], dataset: { xirC: c } });
      b.addEventListener('click', () => onPick(c));
      return b;
    }),
  );
}

const saveRules = (patch) => act('setSettings', { patch });

function renderTiers(rules) {
  const key = JSON.stringify([rules.tiers, rules.baseColor, rules.minCount]);
  if (key === view.tiersKey) return; // 没变就不重建，免得打断正在输入的框
  view.tiersKey = key;

  const rows = rules.tiers.map((t, i) => {
    const input = el('input', { type: 'number', min: 1, value: t.min });
    input.addEventListener('change', () => saveRules({ tiers: rules.tiers.map((x, j) => (j === i ? { ...x, min: Number(input.value) } : x)) }));
    const del = el('button', { className: 'icon', title: '删掉这一档', textContent: '×' });
    del.addEventListener('click', () => saveRules({ tiers: rules.tiers.filter((_, j) => j !== i) }));
    return el('div', { className: 'row tier' }, [
      el('span', { className: 'cond' }, ['≥ ', input, ' 次']),
      swatches(t.color, (c) => saveRules({ tiers: rules.tiers.map((x, j) => (j === i ? { ...x, color: c } : x)) })),
      del,
    ]);
  });
  rows.push(
    el('div', { className: 'row tier' }, [
      el('span', { className: 'cond', textContent: '其余上榜的' }),
      swatches(rules.baseColor, (c) => saveRules({ baseColor: c })),
      el('span', { className: 'icon' }),
    ]),
  );
  $('tiers').replaceChildren(...rows);
  $('addTier').disabled = rules.tiers.length >= LIMITS.maxTiers;

  // 预览：每一档拿它的门槛次数当例子
  const samples = [...rules.tiers.map((t) => t.min), rules.minCount].filter((n, i, a) => a.indexOf(n) === i && n >= rules.minCount);
  $('preview').replaceChildren(
    ...samples.map((n) => el('span', { className: 'chip', dataset: { xirC: colorOf(n, rules) }, textContent: `${n} 次起` })),
  );
}

// ---------- 整体渲染 ----------

async function render() {
  const g = await call('getState');
  const handles = Object.keys(g.accounts);
  if (!view.account || !g.accounts[view.account]) view.account = g.current || handles[0] || null;

  const items = [];
  if (g.domWarning) items.push(['warn', 'X 页面结构可能变了：时间线里找不到用户名位置，内联标签暂时无法显示，需要更新插件。']);

  $('bind').hidden = !!g.current;
  $('main').hidden = !view.account;
  $('account').hidden = handles.length < 2;
  $('account').replaceChildren(...handles.map((h) => el('option', { value: h, textContent: `@${g.accounts[h].handle}`, selected: h === view.account })));

  if (!view.account) return banners(items);

  const s = await call('getAccountState', { account: view.account });
  const rules = s.settings;
  const isSession = view.account === g.current;
  if (!isSession) items.push(['warn', `@${g.accounts[view.account].handle} 不是当前登录 X 的账号，这里只能查看它已有的数据。`]);
  if (s.alert) items.push(['err', `${fmtTime(s.alert.at)} ${s.alert.message}`]);
  banners(items);

  // 还没有任何数据时先落在设置页，那里有启动按钮
  view.tab ??= s.eventCount || s.job ? 'board' : 'settings';
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === view.tab);
  $('view-board').hidden = view.tab !== 'board';
  $('view-settings').hidden = view.tab !== 'settings';

  // 榜单页
  const { rows, people, replies } = await call('getBoard', { account: view.account });
  Object.assign(view, { rows, rules, eventCount: s.eventCount });
  const label = windowLabel(rules.windowDays);
  $('window').value = String(rules.windowDays);
  $('export').disabled = !rows.length;
  $('boardHint').textContent =
    `最近${label}共 ${people} 人在我的帖子下回复了 ${replies} 次；上榜 ${rows.length} 人` +
    `（回复 ${rules.minCount} 次及以上，最多前 ${rules.topN} 名）。`;
  const job = s.job;
  const unfinished = job && job.status !== 'done';
  $('jobLine').hidden = !unfinished;
  if (unfinished) $('jobLine').textContent = `数据还在读取，榜单会继续变。${jobText(job)}`;
  if (view.open) view.detail = await fetchDetail();
  renderList();

  // 设置页：数据
  const active = job && ['running', 'waiting_tab', 'paused', 'error'].includes(job.status);
  $('jobStatus').hidden = !job;
  if (job) $('jobStatus').textContent = jobText(job);
  $('pause').hidden = !(job && ['running', 'waiting_tab'].includes(job.status)) && !(job && job.status === 'paused' && job.auto);
  $('resume').hidden = !(job && (job.status === 'error' || (job.status === 'paused' && !job.auto)));
  $('start').textContent = active ? '重新初始化' : '启动 / 初始化';
  $('start').disabled = !isSession || !rules.fetchEnabled;
  $('resume').disabled = !isSession || !rules.fetchEnabled;
  const short = s.cursor.earliestTs > Date.now() - rules.windowDays * 86400000;
  $('coverage').textContent = s.cursor.earliestTs
    ? `本地数据最早覆盖到 ${fmtDay(s.cursor.earliestTs)}，共 ${s.eventCount} 条直接回复（只有你帖子下的上榜）。` +
      (short ? `还没覆盖满${label}，要补齐就点「启动 / 初始化」。` : '')
    : '';
  $('fetchEnabled').checked = rules.fetchEnabled;
  $('lastInc').textContent = s.cursor.lastIncrementalAt ? `上次自动更新：${fmtTime(s.cursor.lastIncrementalAt)}` : '';

  // 设置页：口径与颜色
  setValue($('topN'), rules.topN);
  setValue($('minCount'), rules.minCount);
  renderTiers(rules);
}

async function act(type, extra) {
  const r = await call(type, { account: view.account, ...extra });
  if (r?.error) alert(r.error);
  await render();
}

// ---------- 事件 ----------

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  view.tab = tab;
  render();
});
$('window').addEventListener('change', (e) => saveRules({ windowDays: Number(e.target.value) }));
$('search').addEventListener('input', renderList);
$('list').addEventListener('click', async (e) => {
  if (e.target.closest('a')) return; // 名字和回复条目是链接，照常跳转
  const li = e.target.closest('li.person');
  if (!li) return;
  view.open = view.open === li.dataset.actor ? null : li.dataset.actor;
  view.detail = null;
  renderList();
  if (view.open) {
    view.detail = await fetchDetail();
    renderList();
  }
});

// 加减按钮：名次上限每次 50（10 和 50 之间直接跳），次数每次 1；也可以直接输入，越界的由后台夹回范围
const STEP = {
  topN: (v, dir) => (dir > 0 ? (v < 50 ? 50 : v + 50) : v <= 50 ? LIMITS.topN[0] : v - 50),
  minCount: (v, dir) => v + dir,
};
for (const box of document.querySelectorAll('.stepper')) {
  const key = box.dataset.key;
  const input = box.querySelector('input');
  box.addEventListener('click', (e) => {
    const dir = Number(e.target.dataset.dir);
    if (dir) saveRules({ [key]: STEP[key](view.rules[key], dir) });
  });
  input.addEventListener('change', async () => {
    await saveRules({ [key]: Number(input.value) });
    input.value = String(view.rules[key]); // 显示夹回范围后的实际值
  });
}

$('addTier').addEventListener('click', () => {
  const { tiers, minCount } = view.rules;
  const min = tiers.length ? tiers[0].min * 2 : Math.max(5, minCount + 1);
  const used = new Set([...tiers.map((t) => t.color), view.rules.baseColor]);
  saveRules({ tiers: [{ min, color: COLORS.find((c) => !used.has(c)) || 'red' }, ...tiers] });
});
$('reset').addEventListener('click', () => {
  const { topN, minCount, tiers, baseColor } = DEFAULT_RULES;
  if (confirm('把名次上限、最少次数和标签颜色恢复成默认？数据不受影响。')) saveRules({ topN, minCount, tiers, baseColor });
});

// 导出当前榜单为 CSV（带 BOM，Excel 直接打开不乱码）。纯本地生成文件，不发请求。
$('export').addEventListener('click', () => {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [
    ['名次', '名字', 'ID', '回复次数', '最近一次回复', '主页'],
    ...view.rows.map((r) => [r.rank, r.name, `@${r.handle}`, r.count, new Date(r.last).toLocaleString('zh-CN', { hour12: false }), `https://x.com/${r.handle}`]),
  ];
  const csv = '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
  const d = new Date();
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `回复榜_${view.account}_${view.rules.windowDays}天_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('account').addEventListener('change', (e) => { view.account = e.target.value; view.tab = null; view.open = null; render(); });
$('start').addEventListener('click', () => {
  const again = $('start').textContent === '重新初始化' ? '当前任务会被丢弃并从头开始。' : '';
  if (confirm(`将用你的 X 登录会话，限速回填最近 ${view.rules.windowDays} 天别人对你的回复。${again}确定开始？`)) act('startBackfill');
});
$('pause').addEventListener('click', () => act('pauseJob'));
$('resume').addEventListener('click', () => act('resumeJob'));
$('fetchEnabled').addEventListener('change', (e) => saveRules({ fetchEnabled: e.target.checked }));
$('clear').addEventListener('click', () => {
  if (confirm(`清空 @${view.account} 在本机的全部回复数据？榜单和时间线标签都会消失，不可恢复。`)) act('clearData');
});
$('bindBtn').addEventListener('click', async () => {
  const r = await call('setManualHandle', { handle: $('bindHandle').value });
  if (r?.error) alert(r.error);
  view.account = null;
  render();
});

// 任务状态、快照变化时自动刷新
chrome.storage.onChanged.addListener(() => render());
render();
