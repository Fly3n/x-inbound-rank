// 弹窗：榜单页、设置页。只和后台通信，不直接发任何 X 请求。
import { COLORS, LIMITS, DEFAULT_RULES, OUT_SCHEMA, KEEP_DAYS, WARN_DAYS, DAY_MS, colorOf, underMyPosts, countsFromMe } from '../rank.js';

const $ = (id) => document.getElementById(id);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const view = { account: null, tab: null, rows: [], rules: null, eventCount: 0, tiersKey: '', open: null, detail: null, outReady: false }; // open：榜单里点开的那个人

const COLOR_NAMES = { red: '红', orange: '橙', yellow: '黄', green: '绿', cyan: '青', blue: '蓝', purple: '紫', gray: '灰' };
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const fmtTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const windowLabel = (days) => ({ 15: '半个月', 30: '一个月', 60: ' 2 个月', 90: ' 3 个月' })[days] || ` ${days} 天`;

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
    el('div', { className: 'hint', textContent: `榜单范围内在我的帖子下回复我 ${d.total} 次${more}：` }),
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
              ? [el('span', { className: `mine${r.replied ? '' : ' zero'}`, title: '同一范围内，本机已读取的直接评论次数', textContent: `我回 ${r.replied}` })]
              : [el('span', { className: 'mine zero', textContent: '我回 —' })]),
            el('span', { className: 'chip', dataset: { xirC: r.color }, title: '榜单范围内他在我的帖子下回复我几次，颜色和时间线标签一致', textContent: `${r.count} 次` }),
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

// 同一时间只画一遍：画的过程中又来的请求合并成画完后再补一遍，免得几遍交叠、旧结果盖掉新结果
let drawing = null;
let again = false;
function render() {
  if (drawing) {
    again = true;
    return drawing;
  }
  drawing = (async () => {
    try {
      do {
        again = false;
        await draw();
      } while (again);
    } finally {
      drawing = null;
    }
  })();
  return drawing;
}

async function draw() {
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
  view.tab ??= s.db.in.count || s.job ? 'board' : 'settings';
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === view.tab);
  $('view-board').hidden = view.tab !== 'board';
  $('view-settings').hidden = view.tab !== 'settings';

  // 榜单页
  const { rows, people, replies } = await call('getBoard', { account: view.account });
  const out = s.cursor.out;
  const label = windowLabel(rules.windowDays);
  Object.assign(view, { rows, rules, eventCount: s.db.in.count, outReady: !!out?.lastAt && (out.schema || 1) >= OUT_SCHEMA || s.db.out.count > 0 });
  // 本机数据是不是已经覆盖了所选的初始化范围（覆盖了就把「初始化」置灰）：
  // 上次初始化往回读到了哪天；之后靠自动更新接着，是连续的
  const initStart = Date.now() - rules.initDays * DAY_MS;
  const lbIn = s.cursor.lastBackfill;
  const inFrom = lbIn ? lbIn.finishedAt - lbIn.rangeDays * DAY_MS : null;
  const inCovered = !!lbIn && !!s.cursor.syncedId && (lbIn.reachedEnd || inFrom <= initStart);
  const outFrom = out?.lastFullAt && out.lastFullDays ? out.lastFullAt - out.lastFullDays * DAY_MS : null;
  const outCovered = !!outFrom && !!out.syncedId && out.fullFor !== 0 && (out.schema || 1) >= OUT_SCHEMA && outFrom <= initStart;

  // 保存期限：最早的数据存满 80 天时挂红字提示先导出；第一次清理之后数据每天滚动清，改成一行小字
  const oldest = Math.min(s.db.in.from ?? Infinity, s.db.out.from ?? Infinity);
  const age = Number.isFinite(oldest) ? (Date.now() - oldest) / DAY_MS : 0;
  const warn = !s.cursor.prunedAt && age >= WARN_DAYS;
  $('keepWarn').hidden = !warn;
  if (warn) $('keepWarnText').textContent = `本机最早的数据是 ${fmtDay(oldest)} 的，约 ${Math.max(0, Math.ceil(KEEP_DAYS - age))} 天后开始自动清理（只保留最近 3 个月）。需要留底的话先导出。`;
  $('keepLine').hidden = !s.cursor.prunedAt;
  $('keepLine').textContent = '本机只保留最近 3 个月的数据，更早的已自动清理。';
  // 榜单范围比本机数据长：照常算，说清楚最早只有哪天
  const inOldest = s.db.in.from;
  $('shortLine').hidden = !(inOldest && inOldest > Date.now() - rules.windowDays * DAY_MS + DAY_MS);
  if (inOldest) $('shortLine').textContent = `本机最早只有 ${fmtDay(inOldest)} 的数据，榜单按已有的算。`;

  // 「我回别人」这份数据的状态：设置页总是显示；榜单页只在需要用户处理时提一句
  const outBad = out?.message || '';
  const running = out?.running && Date.now() - out.running.at < 120000 ? out.running : null; // 超过两分钟没动静就当它已经停了
  const outPhase = running ? '进行中' : out?.status === 'queued' ? '排队中'
    : out?.status === 'need_tpl' ? '等待回复页' : out?.status === 'waiting_tab' ? '等待 X 页面'
    : out?.resume && out.status !== 'error' ? '等待续读' : '';
  const outPending = !!outPhase || out?.fullFor === 0 && out?.status !== 'error';
  const outProgress = running ? `进行中，本轮已读 ${running.pages} 页。`
    : outPhase ? `${outPhase}。` : '';
  $('outIssue').textContent = outBad;
  $('outIssue').hidden = !outBad;
  const handle = g.accounts[view.account]?.handle;
  const outLink = $('outRepliesLink');
  outLink.hidden = !(isSession && out?.status === 'need_tpl' && /^[A-Za-z0-9_]{1,15}$/.test(handle || ''));
  if (!outLink.hidden) outLink.href = `https://x.com/${handle}/with_replies`;
  $('outLine').hidden = false;
  $('outLine').textContent = outProgress || outBad
    ? `我回别人 · ${outProgress}${outBad} 榜单显示已读取的数据。`
    : view.outReady ? '' : '我回别人 · 到设置页初始化后显示次数。';
  $('outLine').hidden = !$('outLine').textContent;
  $('outReason').textContent = !isSession ? '切换到当前登录账号' : !rules.fetchEnabled ? '自动更新已关闭'
    : outCovered && !outPending ? '已覆盖所选范围' : '';
  $('outSync').disabled = !isSession || !rules.fetchEnabled || outPending || outCovered || starting.has('outSync');
  $('outSync').textContent = starting.has('outSync') ? '启动中' : outPhase || (outPending ? '排队中' : '初始化');
  $('window').value = String(rules.windowDays);
  $('initRange').value = String(rules.initDays);
  $('exportBoard').disabled = !rows.length;
  $('exportAll').disabled = !s.db.in.count && !s.db.out.count;
  $('boardHint').textContent =
    `最近${label}共 ${people} 人在我的帖子下回复我 ${replies} 次；上榜 ${rows.length} 人` +
    `（回复 ${rules.minCount} 次及以上，最多前 ${rules.topN} 名）。`;
  const job = s.job;
  const unfinished = job && job.status !== 'done';
  $('jobLine').hidden = !unfinished;
  if (unfinished) $('jobLine').textContent = `别人回我 · ${jobText(job)}`;
  if (view.open) view.detail = await fetchDetail();
  renderList();

  // 设置页：数据
  $('jobStatus').hidden = !job || job.status === 'done';
  if (job) $('jobStatus').textContent = jobText(job);
  $('pause').hidden = !(job && ['running', 'waiting_tab'].includes(job.status)) && !(job && job.status === 'paused' && job.auto);
  $('resume').hidden = !(job && (job.status === 'error' || (job.status === 'paused' && !job.auto)));
  const inPhase = job?.status === 'running' ? '进行中' : job?.status === 'waiting_tab' ? '等待 X 页面'
    : job?.status === 'paused' ? '已暂停' : '';
  $('start').textContent = starting.has('start') ? '启动中' : inPhase || '初始化';
  $('start').disabled = !isSession || !rules.fetchEnabled || !!inPhase || inCovered || starting.has('start');
  $('inReason').textContent = !isSession ? '切换到当前登录账号' : !rules.fetchEnabled ? '自动更新已关闭'
    : inPhase ? '' : inCovered ? (lbIn.reachedEnd && inFrom > initStart ? '已读到列表底部' : '已覆盖所选范围') : '';
  $('resume').disabled = !isSession || !rules.fetchEnabled;
  const inboundRead = readSummary(s.cursor.inLastReadAt ?? s.cursor.lastIncrementalAt, s.cursor.inLastReadCounts);
  const outboundRead = readSummary(out?.lastReadAt ?? out?.lastAt, out?.lastReadCounts);
  renderFields('updateSummary', [['别人回我', inboundRead], ['我回别人', outboundRead]]);
  renderDataStatus('coverage', s.db.in, lbIn?.finishedAt, lbIn?.rangeDays, inboundRead);
  renderDataStatus('outStatus', s.db.out, out?.lastFullAt, out?.lastFullDays, outboundRead);
  // 本机占用：这个插件的全部本地数据（两份回复 + 设置）
  navigator.storage?.estimate?.().then(
    (e) => ($('storage').textContent = `本机共存 ${s.db.in.count + s.db.out.count} 条回复，插件数据约占 ${(e.usage / 1048576).toFixed(1)} MB。只保留最近 3 个月。`),
    () => {},
  );
  $('fetchEnabled').checked = rules.fetchEnabled;
  $('updateNow').disabled = !isSession || !rules.fetchEnabled || !s.cursor.syncedId || updatingNow;
  $('updateNow').textContent = updatingNow ? '更新中…' : '立即更新';
  for (const k of SHOW) $(k).checked = rules[k];

  // 设置页：口径与颜色
  setValue($('topN'), rules.topN);
  setValue($('minCount'), rules.minCount);
  renderTiers(rules);
}

function readSummary(at, counts) {
  if (!at) return '暂无读取记录';
  return fullTime(at) + (counts ? ` · 读到 ${counts.read} 条 · 新增 ${counts.added} 条` : ' · 暂无条数');
}

function renderDataStatus(id, data, initializedAt, days, summary) {
  renderFields(id, [
    ['本机条数', `${data.count} 条`],
    ['记录日期', data.count ? `${fmtDay(data.from)} – ${fmtDay(data.to)}` : '暂无记录'],
    ['上次初始化', initializedAt ? `${fmtTime(initializedAt)}（${days} 天）` : '未完成'],
    ['上次读取', summary],
  ]);
}

function renderFields(id, fields) {
  $(id).replaceChildren(...fields.flatMap(([label, value]) => [
    el('dt', { textContent: label }),
    el('dd', { textContent: value }),
  ]));
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
$('initRange').addEventListener('change', (e) => saveRules({ initDays: Number(e.target.value) }));

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

const diagnosticNames = {
  updateNow: '手动更新', updateNowWithReceipt: '手动更新', request: '读取请求', page_saved: '页面入库', parse_failed: '解析失败',
  retry_scheduled: '安排重试', startBackfill: '初始化别人回我', syncOutNow: '初始化我回别人',
  pauseJob: '暂停读取', resumeJob: '继续读取', clearData: '清空数据',
};
const diagnosticSources = {
  'mentions-graphql': '别人回我 · 新接口', 'mentions-rest': '别人回我 · 旧接口',
  mentions: '别人回我', replies: '我回别人', backfill: '历史回填', incremental: '增量更新',
};

async function loadDiagnostics() {
  let timer;
  try {
    return await Promise.race([
      call('getDiagnostics'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取超时')), 8000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function showDiagnostics(exportAll = false) {
  const status = $('diagnosticStatus');
  const refresh = $('refreshDiagnostics');
  const exportButton = $('exportDiagnostics');
  if (refresh.disabled) return;
  refresh.disabled = exportButton.disabled = true;
  status.textContent = '正在读取日志…';
  try {
    const rows = await loadDiagnostics();
    if (!Array.isArray(rows)) throw new Error();
    status.textContent = rows.length ? `共 ${rows.length} 条 · 已刷新 ${fullTime(Date.now())}` : '最近 7 天没有日志可供查看或导出。';
    $('diagnosticRows').replaceChildren(...rows.slice(0, 10).map((r) => el('li', {
      textContent: [fmtTime(r.at), diagnosticNames[r.event] || r.event, diagnosticSources[r.source],
        r.status ? `HTTP ${r.status}` : r.event === 'request' ? ({ no_tab: 'X 页面未连接', network: '网络请求失败', no_session: '未登录', bad_tpl: '读取参数失效' }[r.outcome] || '读取未成功') : '', r.added != null && `新增 ${r.added} 条`,
        r.waitMs && `${r.waitMs / 60_000} 分钟后`].filter(Boolean).join(' · '),
    })));
    if (!exportAll || !rows.length) return;
    const report = {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      platform: navigator.platform,
      browser: navigator.userAgent.match(/(?:Chrome|Chromium|Edg|Firefox|Version)\/[0-9.]+/g) || [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      events: rows,
    };
    const link = el('a', {
      href: URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })),
      download: 'X 友-诊断日志.json',
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    status.textContent = `已发起下载，共 ${rows.length} 条日志。`;
  } catch {
    status.textContent = '日志读取失败。请确认扩展已重新加载，然后重试。';
  } finally {
    refresh.disabled = exportButton.disabled = false;
  }
}

$('diagnostics').addEventListener('toggle', (e) => { if (e.target.open) showDiagnostics(); });
$('refreshDiagnostics').addEventListener('click', () => showDiagnostics());
$('exportDiagnostics').addEventListener('click', () => showDiagnostics(true));

// 导出榜单：当前榜上的人，一人一行
$('exportBoard').addEventListener('click', () =>
  download(`回复榜_${view.rules.windowDays}天`, [
    ['名次', '名字', 'ID', '回复次数', '我回他次数', '最近一次回复', '主页'],
    ...view.rows.map((r) => [r.rank, r.name, `@${r.handle}`, r.count, view.outReady ? r.replied : '', fullTime(r.last), `https://x.com/${r.handle}`]),
  ]),
);

// 导出全量数据：本机存的每一条回复，一条一行，两份数据放在同一张表里用「类型」区分
$('exportAll').addEventListener('click', async () => {
  const { inbound, out: outAll } = await call('exportAll', { account: view.account });
  const counted = new Set(underMyPosts(inbound, outAll).map((e) => e.id)); // 计入回复榜的（在我帖子下回我的）
  const out = outAll.filter((o) => !o.own); // 我在自己帖子下的回复只用来认对话，不导出
  const handleOf = new Map(inbound.map((e) => [e.actor_id, e.actor_handle])); // 我回别人那份只存了用户编号，能对上的补成 @ID
  const link = (id) => `https://x.com/i/status/${id}`;
  const rows = [
    ...inbound.map((e) => ({
      ts: e.created_at,
      line: ['别人回我', fullTime(e.created_at), e.actor_name, `@${e.actor_handle}`, counted.has(e.id) ? '是' : '否', e.text || '', link(e.id)],
    })),
    ...out.map((e) => {
      const h = e.root_handle || handleOf.get(e.root_user_id);
      return { ts: e.created_at, line: ['我回别人', fullTime(e.created_at), '', h ? `@${h}` : e.root_user_id ? `用户编号 ${e.root_user_id}` : '未知', countsFromMe(e) ? '是' : '否', e.text || '', link(e.id)] };
    }),
  ].sort((x, y) => y.ts - x.ts);
  download('全量数据', [['类型', '时间', '对方名字', '对方 ID（我回别人时是帖子的主人）', '是否计入统计', '内容摘要', '链接'], ...rows.map((r) => r.line)]);
});

$('account').addEventListener('change', (e) => { view.account = e.target.value; view.tab = null; view.open = null; render(); });
const starting = new Set();
async function initialize(id, type) {
  const button = $(id);
  if (button.disabled) return;
  starting.add(id);
  button.disabled = true;
  button.textContent = '启动中';
  try {
    const result = await call(type, { account: view.account });
    if (result?.error) alert(result.error);
  } catch {
    alert('未能启动初始化，请重新打开弹窗再试。');
  } finally {
    starting.delete(id);
    await render();
  }
}

let updatingNow = false;
$('updateNow').addEventListener('click', async () => {
  const button = $('updateNow');
  const status = $('updateStatus');
  if (updatingNow || button.disabled) return;
  updatingNow = true;
  button.disabled = true;
  button.textContent = '更新中…';
  button.setAttribute('aria-busy', 'true');
  status.textContent = '正在处理这次更新…';
  // 极快的返回也留出时间显示按钮状态。
  const visible = new Promise((resolve) => setTimeout(resolve, 600));
  let message;
  try {
    const startedAt = Date.now();
    const result = await call('updateNowWithReceipt', { account: view.account });
    const receipt = result?.readAt;
    if (receipt?.inbound >= startedAt && receipt?.outbound >= startedAt) {
      message = '两份数据已读取，结果见下方。';
    } else {
      message = result?.error || result?.message || '未收到本次读取时间，请重新加载扩展再试。';
    }
  } catch {
    message = '未能确认更新结果，请重新加载扩展再试。';
  } finally {
    await visible;
    status.textContent = message;
    button.removeAttribute('aria-busy');
    updatingNow = false;
    await render();
  }
});
$('start').addEventListener('click', () => initialize('start', 'startBackfill'));
$('outSync').addEventListener('click', () => initialize('outSync', 'syncOutNow'));
$('keepExport').addEventListener('click', () => $('exportAll').click());
$('pause').addEventListener('click', () => act('pauseJob'));
$('resume').addEventListener('click', () => act('resumeJob'));
const SHOW = ['showRank', 'showOut', 'showRel', 'showPlace', 'showSchedule']; // 时间线上几种标签与排期辅助的开关
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

// 任务状态、快照变化时自动刷新。读取过程中一页要写好几次存储，攒 200 毫秒再画；
// 只看和界面有关的键（tplTry 这类后台自用的不管）
const WATCH = /^(accounts|current|pendingUserId|domWarning|tpl:(replies|mentions)|(settings|cursor|job|snap|alert):)/;
let redrawTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => WATCH.test(k))) return;
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(render, 200);
});
render();
