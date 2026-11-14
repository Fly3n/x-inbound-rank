// 弹窗：榜单页、设置页。只和后台通信，不直接发任何 X 请求。
import { COLORS, LIMITS, DEFAULT_RULES, colorOf } from '../rank.js';

const $ = (id) => document.getElementById(id);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const view = { account: null, tab: null, rows: [], rules: null, eventCount: 0, tiersKey: '', open: null, detail: null, outReady: false }; // open：榜单里点开的那个人

const COLOR_NAMES = { red: '红', orange: '橙', yellow: '黄', green: '绿', cyan: '青', blue: '蓝', purple: '紫', gray: '灰' };
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const fmtTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const windowLabel = (days) => ({ 15: '半个月', 30: '一个月' })[days] || ` ${days} 天`;

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
    el('div', { className: 'hint', textContent: `统计范围内在我的帖子下回复了 ${d.total} 次${more}：` }),
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
    ? '还没有数据，到「设置」页点「初始化」'
    : q
      ? '榜上没有匹配的人'
      : `这个范围内还没有人回复我 ${view.rules.minCount} 次及以上`;
  $('list').replaceChildren(
    ...(rows.length
      ? rows.flatMap((r) => [
          el('li', { className: 'person', title: '点开看他回复了哪几条', dataset: { actor: r.actor_id } }, [
            el('span', { className: 'rank', textContent: r.rank }),
            // 只有头像是去他主页的链接，这一行其他地方点了都是展开回复列表
            el('a', { className: 'avatar', href: `https://x.com/${r.handle}`, target: '_blank', rel: 'noreferrer', title: `打开 @${r.handle} 的主页` }, [
              el('img', { src: r.avatar, alt: '', referrerPolicy: 'no-referrer', loading: 'lazy' }),
            ]),
            el('div', { className: 'who' }, [
              el('span', { className: 'name', textContent: r.name }),
              el('span', { className: 'sub', textContent: `@${r.handle} · 最近 ${fmtTime(r.last)}` }),
            ]),
            ...(view.outReady
              ? [el('span', { className: `mine${r.replied ? '' : ' zero'}`, title: '同一范围内，我在他的帖子下回复了几次', textContent: `我回 ${r.replied}` })]
              : []),
            el('span', { className: 'chip', dataset: { xirC: r.color }, title: '统计范围内他在我帖子下的回复次数，颜色和时间线标签一致', textContent: `${r.count} 次` }),
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
  // 插件刷新或更新后，之前打开的 x.com 页面里还是旧脚本，连不上后台：读取和新功能都不生效，要刷新页面
  const ver = chrome.runtime.getManifest().version;
  if (g.current && (!g.page || (g.page.versions.length && !g.page.versions.includes(ver)))) items.push(['warn', '开着的 x.com 页面还没连上这一版插件：请刷新 x.com 页面（没开就打开一个）。']);
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
  const out = s.cursor.out;
  const label = windowLabel(rules.windowDays);
  Object.assign(view, { rows, rules, eventCount: s.eventCount, outReady: !!out?.lastAt });
  // 「我回别人」这份数据的状态：设置页总是显示；榜单页只在需要用户处理时提一句
  const outBad = out && out.status !== 'ok' ? `${out.status === 'need_tpl' ? '还读不了' : '读取出错'}：${out.message}` : '';
  // 每份数据一行现状：本机有多少条、从哪天到哪天、上次初始化和上次更新是什么时候
  const span = (d) => (d.count ? `本机 ${d.count} 条，${fmtDay(d.from)} – ${fmtDay(d.to)}。` : '本机还没有数据。');
  const running = out?.running && Date.now() - out.running.at < 120000 ? out.running : null; // 超过两分钟没动静就当它已经停了
  $('outStatus').textContent =
    (running ? `正在读取：已读 ${running.pages} 页…` : '') +
    (s.tplAt ? '' : `还没看到 X 的「回复」列表请求：先在 X 上打开自己主页的「回复」栏一次${g.page?.ops?.length ? `（页面见过的请求：${g.page.ops.join('、')}）` : ''}。`) +
    span(s.db.out) +
    (out?.lastFullAt ? `上次初始化完成：${fmtTime(out.lastFullAt)}（最近${windowLabel(out.lastFullDays)}）。` : '') +
    (out?.lastAt ? `上次更新：${fmtTime(out.lastAt)}。` : '') +
    (out?.resume ? '还在继续往回读…' : '') +
    (outBad ? `${outBad}。` : '') +
    (!out ? '「别人回我」初始化完成后一两分钟会自动开始，也可以直接点「初始化」。' : '') +
    (out?.status === 'ok' && !out.resume && (out.fullFor || 0) < rules.windowDays ? `还没覆盖满最近${label}，点「初始化」补齐。` : '');
  $('outLine').hidden = !(outBad && s.eventCount);
  $('outLine').textContent = outBad ? `「我回」${outBad}` : '';
  $('outSync').disabled = !isSession || !rules.fetchEnabled || !!running;
  $('outSync').textContent = running ? '读取中…' : '初始化';
  $('window').value = $('range').value = String(rules.windowDays);
  $('exportBoard').disabled = !rows.length;
  $('exportAll').disabled = !s.db.in.count && !s.db.out.count;
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
  $('start').textContent = active ? '重新初始化' : '初始化';
  $('start').disabled = !isSession || !rules.fetchEnabled;
  $('resume').disabled = !isSession || !rules.fetchEnabled;
  const lb = s.cursor.lastBackfill;
  const short = s.cursor.earliestTs > Date.now() - rules.windowDays * 86400000;
  $('coverage').textContent =
    span(s.db.in) +
    (lb ? `上次初始化完成：${fmtTime(lb.finishedAt)}（最近${windowLabel(lb.rangeDays)}）。` : '') +
    (s.cursor.lastIncrementalAt ? `上次更新：${fmtTime(s.cursor.lastIncrementalAt)}。` : '') +
    (s.cursor.earliestTs && short ? `还没覆盖满最近${label}，点「初始化」补齐。` : '');
  $('fetchEnabled').checked = rules.fetchEnabled;
  for (const k of SHOW) $(k).checked = rules[k];

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
for (const id of ['window', 'range']) $(id).addEventListener('change', (e) => saveRules({ windowDays: Number(e.target.value) }));

// 小问号：点了展开或收起它对应的说明
document.addEventListener('click', (e) => {
  const q = e.target.closest('.q');
  if (!q) return;
  const tip = $(q.dataset.tip);
  tip.hidden = !tip.hidden;
  q.classList.toggle('on', !tip.hidden);
});
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

// 导出为 CSV（带 BOM，Excel 直接打开不乱码）。纯本地生成文件，不发请求。
function download(name, lines) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
  const d = new Date();
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `${name}_${view.account}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  $('exportMenu').open = false;
}
const fullTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

// 导出榜单：当前榜上的人，一人一行
$('exportBoard').addEventListener('click', () =>
  download(`回复榜_${view.rules.windowDays}天`, [
    ['名次', '名字', 'ID', '回复次数', '我在他帖子下回复次数', '最近一次回复', '主页'],
    ...view.rows.map((r) => [r.rank, r.name, `@${r.handle}`, r.count, view.outReady ? r.replied : '', fullTime(r.last), `https://x.com/${r.handle}`]),
  ]),
);

// 导出全量数据：本机存的每一条回复，一条一行，两份数据放在同一张表里用「类型」区分
$('exportAll').addEventListener('click', async () => {
  const { inbound, out } = await call('exportAll', { account: view.account });
  const handleOf = new Map(inbound.map((e) => [e.actor_id, e.actor_handle])); // 我回别人那份只存了用户编号，能对上的补成 @ID
  const mine = new Set(inbound.filter((e) => e.root_mine === true).map((e) => e.conversation_id));
  const link = (id) => `https://x.com/i/status/${id}`;
  const rows = [
    ...inbound.map((e) => ({
      ts: e.created_at,
      line: ['别人回我', fullTime(e.created_at), e.actor_name, `@${e.actor_handle}`, e.root_mine === true || (e.root_mine === null && mine.has(e.conversation_id)) ? '是' : '否', e.text || '', link(e.id)],
    })),
    ...out.map((e) => {
      const h = e.root_handle || handleOf.get(e.root_user_id);
      return { ts: e.created_at, line: ['我回别人', fullTime(e.created_at), '', h ? `@${h}` : e.root_user_id ? `用户编号 ${e.root_user_id}` : '未知', '', e.text || '', link(e.id)] };
    }),
  ].sort((x, y) => y.ts - x.ts);
  download('全量数据', [['类型', '时间', '对方名字', '对方 ID（我回别人时是帖子的主人）', '是否计入榜单', '内容摘要', '链接'], ...rows.map((r) => r.line)]);
});

$('account').addEventListener('change', (e) => { view.account = e.target.value; view.tab = null; view.open = null; render(); });
$('start').addEventListener('click', () => {
  const again = $('start').textContent === '重新初始化' ? '当前任务会被丢弃并从头开始。' : '';
  if (confirm(`将用你的 X 登录会话，限速读取最近${windowLabel(view.rules.windowDays)}别人对你的回复。${again}确定开始？`)) act('startBackfill');
});
$('outSync').addEventListener('click', () => act('syncOutNow'));
$('pause').addEventListener('click', () => act('pauseJob'));
$('resume').addEventListener('click', () => act('resumeJob'));
const SHOW = ['showRank', 'showRel', 'showPlace']; // 时间线上三种标签的开关
for (const k of SHOW) $(k).addEventListener('change', (e) => saveRules({ [k]: e.target.checked }));
$('fetchEnabled').addEventListener('change', (e) => saveRules({ fetchEnabled: e.target.checked }));
$('clear').addEventListener('click', () => {
  if (confirm(`清空 @${view.account} 在本机的全部回复数据（别人回我、我回别人）？榜单和时间线标签都会消失，不可恢复。`)) act('clearData');
});
$('bindBtn').addEventListener('click', async () => {
  const r = await call('setManualHandle', { handle: $('bindHandle').value });
  if (r?.error) alert(r.error);
  view.account = null;
  render();
});

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

// 任务状态、快照变化时自动刷新
chrome.storage.onChanged.addListener(() => render());
render();
