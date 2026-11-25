// 弹窗：榜单页、设置页。只和后台通信，不直接发任何 X 请求。
import {
  COLORS, LIMITS, DEFAULT_RULES, KEEP_DAYS, WARN_DAYS, DAY_MS,
  colorOf,
} from '../rank.js';
import {
  COLOR_NAMES, SHOW_KEYS, STORAGE_WATCH,
  pad, fmtDay, fmtShortDay, fmtTime, fullTime, windowLabel,
  jobText, readSummary, formatDurationLabel, suggestFetchWindow, stepRuleValue,
  buildCsv, buildBoardExportRows, buildAllExportRows,
} from './popup-helpers.js';

const $ = (id) => document.getElementById(id);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const view = { account: null, tab: null, rows: [], rules: null, eventCount: 0, tiersKey: '', open: null, detail: null, outCountable: false, fetchTouched: false }; // open：榜单里点开的那个人

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

// ---------- 榜单页 ----------

async function loadDetail() {
  const { account, open: actorId } = view;
  if (!actorId) return;
  const detail = await call('getReplies', { account, actorId }).catch(() => ({ error: true }));
  if (view.account === account && view.open === actorId) view.detail = detail;
}

function replyColumn(label, data, ready = true) {
  const heading = ready ? `${label} · ${data.total} 次` : label;
  return el('div', { className: 'reply-column' }, [
    el('div', { className: 'reply-heading', textContent: heading }),
    ...(ready ? data.items.map((it) => el('a', {
      className: 'reply',
      href: `https://x.com/i/status/${it.id}`,
      target: '_blank',
      rel: 'noreferrer',
      textContent: fmtTime(it.created_at),
      title: [label, fullTime(it.created_at), it.text ? `摘要：${it.text}` : ''].filter(Boolean).join('\n'),
    })) : []),
    ...(!ready ? [el('p', { className: 'hint', textContent: '尚未读取' })]
      : !data.items.length ? [el('p', { className: 'hint', textContent: '暂无记录' })] : []),
    ...(ready && data.total > data.items.length ? [el('p', { className: 'hint', textContent: `仅显示最近 ${data.items.length} 条` })] : []),
  ]);
}

/** 点开某个人后，他那一行下面展开的回复列表。每条点了跳到 X 上的那条回复。 */
function detailRow() {
  const d = view.detail;
  if (!d) return el('li', { className: 'detail hint', textContent: '读取中…' });
  if (d.error) return el('li', { className: 'detail hint', textContent: '读取明细失败，收起后再试。' });
  return el('li', { className: 'detail reply-columns' }, [
    replyColumn('他回我', d),
    replyColumn('我回他', d.outbound, view.outCountable),
  ]);
}

function renderList() {
  const { eventCount } = view;
  const q = $('search').value.trim().toLowerCase().replace(/^@/, '');
  const rows = q ? view.rows.filter((r) => `${r.handle || ''} ${r.name || ''}`.toLowerCase().includes(q)) : view.rows;
  const empty = !eventCount
    ? '还没有数据，可在「设置」开启自动更新或点「补历史」'
    : q
      ? '榜上没有匹配的人'
      : `这个范围内还没有人回复我 ${view.rules.minCount} 次及以上`;
  $('list').replaceChildren(
    ...(rows.length
      ? rows.flatMap((r) => [
          el('li', { className: 'person', title: '点开看双方的回复记录', dataset: { actor: r.actor_id } }, [
            el('span', { className: 'rank', textContent: r.rank }),
            // 只有头像是去他主页的链接，这一行其他地方点了都是展开回复列表
            el('a', { className: 'avatar', href: `https://x.com/${r.handle || r.actor_id}`, target: '_blank', rel: 'noreferrer', title: `打开 @${r.handle || r.actor_id} 的主页` }, [
              el('img', { src: r.avatar, alt: '', referrerPolicy: 'no-referrer', loading: 'lazy' }),
            ]),
            el('div', { className: 'who' }, [
              el('span', { className: 'name', textContent: r.name }),
              el('span', { className: 'sub', textContent: `@${r.handle || r.actor_id} · 最近 ${fmtTime(r.last)}` }),
            ]),
            ...(view.outCountable
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
  const inactivePage = !!g.active && !g.active.account;
  if (view.selected === undefined || (view.selected ? !g.accounts[view.selected] : !inactivePage)) {
    view.selected = g.active?.account || (inactivePage ? null : handles[0] || null);
  }
  if (view.account !== view.selected) {
    $('updateStatus').textContent = '';
    $('updateOutStatus').textContent = '';
    view.fetchTouched = false;
  }
  view.account = view.selected;
  view.activationUserId = inactivePage ? g.active.userId : null;

  const items = [];
  $('bind').hidden = !!view.account;
  $('bindBtn').hidden = !inactivePage;
  $('bindStatus').textContent = inactivePage
    ? `${g.active.handle ? '@' + g.active.handle : '当前 X 账号'}尚未开启 X 友。`
    : '请打开或刷新一个已登录的 X 页面，再为该账号开启 X 友。';
  $('main').hidden = !view.account;
  const accountOptions = handles.map((h) => el('option', {
    value: h, textContent: g.accounts[h].handle ? `@${g.accounts[h].handle}` : 'X 账号', selected: h === view.account,
  }));
  if (inactivePage) accountOptions.unshift(el('option', { value: '', selected: !view.account, textContent: g.active.handle ? `@${g.active.handle}（未开启）` : '当前账号（未开启）' }));
  $('account').hidden = accountOptions.length < 2;
  $('account').replaceChildren(...accountOptions);

  if (!view.account) return banners(items);

  const { handle, userId } = g.accounts[view.account];
  const disableAccount = $('disableAccount');
  disableAccount.textContent = `关闭 ${handle ? `@${handle}` : `用户 ID ${userId}`} 的 X 友`;
  disableAccount.dataset.account = view.account;

  const s = await call('getAccountState', { account: view.account });
  if (s.error) return banners([['warn', s.error]]);
  const rules = s.settings;
  const isSession = g.online.includes(view.account);
  if (!isSession) items.push(['warn', '此账号没有可用的 X 页面。打开此账号的 X 页面后即可旁听收集或手动更新。']);
  if (s.domWarning) items.push(['warn', 'X 页面结构可能变了，暂时无法显示时间线标签。']);
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
  const outHasData = s.db.out.count > 0 || !!out?.lastAt;
  Object.assign(view, { rows, rules, eventCount: s.db.in.count, outCountable: outHasData });
  const lbIn = s.cursor.lastBackfill;

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
  $('outIssue').textContent = outBad + (out?.limitReached && out?.attemptCoverTs ? ` 实际最早读到 ${fmtDay(out.attemptCoverTs)}。` : '');
  $('outIssue').hidden = !outBad;
  view.handle = handle;
  const outLink = $('outRepliesLink');
  outLink.hidden = !(isSession && out?.status === 'need_tpl' && /^[A-Za-z0-9_]{1,15}$/.test(handle || ''));
  if (!outLink.hidden) outLink.href = `https://x.com/${handle}/with_replies`;
  $('outLine').textContent = outProgress || outBad
    ? `我回别人 · ${outProgress}${outBad}`
    : '';
  $('outLine').hidden = !$('outLine').textContent;
  $('outNotice').hidden = $('outIssue').hidden && outLink.hidden;
  $('window').value = String(rules.windowDays);
  $('exportBoard').disabled = !rows.length;
  $('exportAll').disabled = !s.db.in.count && !s.db.out.count;
  $('boardHint').textContent =
    `最近${label}共 ${people} 人在我的帖子下回复我 ${replies} 次；上榜 ${rows.length} 人` +
    `（回复 ${rules.minCount} 次及以上，最多前 ${rules.topN} 名）。`;
  const job = s.job;
  const unfinished = job && job.status !== 'done';
  $('jobLine').hidden = !unfinished;
  if (unfinished) $('jobLine').textContent = `别人回我 · ${jobText(job)}`;
  await loadDetail();
  renderList();

  // 设置页：数据
  $('jobStatus').hidden = !job || job.status === 'done';
  if (job) $('jobStatus').textContent = jobText(job);
  $('pause').hidden = !(job && ['running', 'waiting_tab'].includes(job.status)) && !(job && job.status === 'paused' && job.auto);
  $('resume').hidden = !(job && (job.status === 'error' || (job.status === 'paused' && !job.auto)));
  $('jobControls').hidden = $('jobStatus').hidden;
  const inPhase = job?.status === 'running' ? '进行中' : job?.status === 'waiting_tab' ? '等待 X 页面'
    : job?.status === 'paused' ? '已暂停' : '';
  $('resume').disabled = !isSession;
  const inboundAt = s.cursor.inLastReadAt ?? s.cursor.lastIncrementalAt;
  const inboundTapAt = s.cursor.inLastTapAt || null;
  const outboundAt = out?.lastReadAt ?? out?.lastAt;
  const outboundTapAt = s.cursor.outLastTapAt || null;
  const fmtCompactTime = (ts) => {
    if (!ts) return '未读取';
    const d = new Date(ts);
    const nowD = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const sameDay = d.getFullYear() === nowD.getFullYear() && d.getMonth() === nowD.getMonth() && d.getDate() === nowD.getDate();
    return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const latestOf = (...vals) => Math.max(0, ...vals.map((v) => v || 0)) || null;
  const inTapTag = { All: '全部', Mentions: '提及', Verified: '已认证' }[s.cursor.inLastTapCounts?.timeline] || '';
  const outTapTag = s.cursor.outLastTapCounts?.source === 'replies_timeline' ? '回复栏' : s.cursor.outLastTapCounts?.source === 'create_tweet' ? '发帖' : '';
  $('inLastAt').textContent = fmtCompactTime(latestOf(inboundAt, inboundTapAt));
  $('outLastAt').textContent = fmtCompactTime(latestOf(outboundAt, outboundTapAt));
  $('inReadSummary').textContent = `最近读取：${readSummary(inboundAt, s.cursor.inLastReadCounts, true)}`
    + (inboundTapAt ? `；最近旁听${inTapTag ? `（${inTapTag}）` : ''}：${readSummary(inboundTapAt, s.cursor.inLastTapCounts, true)}` : '');
  $('outReadSummary').textContent = `最近读取：${readSummary(outboundAt, out?.lastReadCounts, true)}`
    + (outboundTapAt ? `；最近旁听${outTapTag ? `（${outTapTag}）` : ''}：${readSummary(outboundTapAt, s.cursor.outLastTapCounts, true)}` : '');
  const suggest = suggestFetchWindow(latestOf(inboundAt, inboundTapAt, outboundAt, outboundTapAt));
  $('fetchSuggest').textContent = suggest.note;
  if (!view.fetchTouched) {
    $('fetchUnit').value = suggest.unit;
    $('fetchAmount').max = suggest.unit === 'd' ? '15' : '24';
    setValue($('fetchAmount'), suggest.amount);
  }
  const inLastLabel = lbIn?.hours ? formatDurationLabel(lbIn.hours) : lbIn?.rangeDays ? `${lbIn.rangeDays} 天` : '';
  const outLastLabel = out?.lastFullHours ? formatDurationLabel(out.lastFullHours) : out?.lastFullDays ? `${out.lastFullDays} 天` : '';
  renderDataStatus('coverage', s.db.in, lbIn?.finishedAt, inLastLabel, inboundAt, s.cursor.inLastReadCounts, inboundTapAt, s.cursor.inLastTapCounts);
  renderDataStatus('outStatus', s.db.out, out?.lastFullAt, outLastLabel, outboundAt, out?.lastReadCounts, outboundTapAt, s.cursor.outLastTapCounts);
  // 本机占用：这个插件的全部本地数据（两份回复 + 设置）
  navigator.storage?.estimate?.().then(
    (e) => ($('storage').textContent = `本机共存 ${s.db.in.count + s.db.out.count} 条回复，插件数据约占 ${(e.usage / 1048576).toFixed(1)} MB。只保留最近 3 个月。`),
    () => {},
  );
  $('tapInEnabled').checked = rules.tapInEnabled;
  $('tapOutEnabled').checked = rules.tapOutEnabled;
  $('fetchInBtn').disabled = !isSession || !!inPhase || updatingNow;
  $('fetchInBtn').textContent = updatingNow ? '补读中…' : inPhase ? `别人回我（${inPhase}）` : '补读 [别人回我]';
  $('fetchOutBtn').disabled = !isSession || outPending || updatingOutNow;
  $('fetchOutBtn').textContent = updatingOutNow ? '补读中…' : outPhase ? `我回别人（${outPhase}）` : '补读 [我回别人]';
  for (const k of SHOW_KEYS) $(k).checked = rules[k];

  // 设置页：口径与颜色
  setValue($('topN'), rules.topN);
  setValue($('minCount'), rules.minCount);
  renderTiers(rules);
}

function renderDataStatus(id, data, initializedAt, spanLabel, readAt, counts, tapAt, tapCounts) {
  const fields = [
    ['本机条数', `${data.count} 条`],
    ['记录日期', data.count ? `${fmtShortDay(data.from)} – ${fmtShortDay(data.to)}` : '暂无记录'],
    ['上次补读', initializedAt ? `${fmtTime(initializedAt)}${spanLabel ? `（${spanLabel}）` : ''}` : '未补读'],
    ['上次读取', readSummary(readAt, counts)],
  ];
  if (tapAt) fields.push(['上次旁听', readSummary(tapAt, tapCounts)]);
  renderFields(id, fields);
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
function readSelectedHours() {
  const unit = $('fetchUnit').value === 'd' ? 'd' : 'h';
  const max = unit === 'd' ? 15 : 24;
  const raw = Math.round(Number($('fetchAmount').value));
  const clamped = Number.isFinite(raw) ? Math.min(max, Math.max(1, raw)) : 1;
  $('fetchAmount').value = String(clamped);
  return unit === 'd' ? clamped * 24 : clamped;
}
$('fetchUnit').addEventListener('change', () => {
  view.fetchTouched = true;
  const max = $('fetchUnit').value === 'd' ? 15 : 24;
  $('fetchAmount').max = String(max);
  readSelectedHours();
});
$('fetchAmount').addEventListener('change', () => {
  view.fetchTouched = true;
  readSelectedHours();
});

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
    await loadDetail();
    renderList();
  }
});

// 加减按钮：名次上限每次 50（10 和 50 之间直接跳），次数每次 1；也可以直接输入，越界的由后台夹回范围
for (const box of document.querySelectorAll('.stepper')) {
  const key = box.dataset.key;
  const input = box.querySelector('input');
  box.addEventListener('click', (e) => {
    const dir = Number(e.target.dataset.dir);
    if (dir) saveRules({ [key]: stepRuleValue(key, view.rules[key], dir) });
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
  const csv = buildCsv(lines);
  const d = new Date();
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', {
    href: url,
    download: `${name}_${view.handle || 'X'}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  $('exportMenu').open = false;
}

// 导出榜单：当前榜上的人，一人一行
$('exportBoard').addEventListener('click', () =>
  download(`回复榜_${view.rules.windowDays}天`, buildBoardExportRows(view.rows, view.outCountable)),
);

// 导出全量数据：本机保存的全部统计相关回复，一条一行，两份数据放在同一张表里用「类型」区分
$('exportAll').addEventListener('click', async () => {
  const { account } = view;
  const { inbound, out: outAll } = await call('exportAll', { account });
  if (view.account !== account || !Array.isArray(inbound) || !Array.isArray(outAll)) return;
  download('全量数据', buildAllExportRows(inbound, outAll));
});

$('account').addEventListener('change', (e) => { view.selected = e.target.value || null; view.tab = null; view.open = null; view.fetchTouched = false; render(); });

let updatingNow = false;
let updatingOutNow = false;
async function runManualFetch({ buttonId, statusId, isBusy, setBusy, rpc, okText }) {
  const button = $(buttonId);
  const { account } = view;
  const status = $(statusId);
  if (isBusy() || button.disabled) return;
  const hours = readSelectedHours();
  setBusy(true);
  button.disabled = true;
  button.textContent = '补读中…';
  button.setAttribute('aria-busy', 'true');
  status.textContent = `正在补读最近 ${formatDurationLabel(hours)}…`;
  const visible = new Promise((resolve) => setTimeout(resolve, 600));
  let message;
  try {
    const result = await call(rpc, { account, hours });
    if (result?.ok) {
      message = okText(hours);
    } else {
      message = result?.error || result?.message || '未收到本次补读结果，请重新加载扩展再试。';
    }
  } catch {
    message = '未能确认补读结果，请重新加载扩展再试。';
  } finally {
    await visible;
    if (view.account === account) status.textContent = message;
    button.removeAttribute('aria-busy');
    setBusy(false);
    await render();
  }
}
$('fetchInBtn').addEventListener('click', () => runManualFetch({
  buttonId: 'fetchInBtn',
  statusId: 'updateStatus',
  isBusy: () => updatingNow,
  setBusy: (v) => { updatingNow = v; },
  rpc: 'manualFetchIn',
  okText: (h) => h > 24 ? `已启动别人回我补读（最近 ${formatDurationLabel(h)}）。` : `别人回我已补读完成（最近 ${formatDurationLabel(h)}）。`,
}));
$('fetchOutBtn').addEventListener('click', () => runManualFetch({
  buttonId: 'fetchOutBtn',
  statusId: 'updateOutStatus',
  isBusy: () => updatingOutNow,
  setBusy: (v) => { updatingOutNow = v; },
  rpc: 'manualFetchOut',
  okText: (h) => `已启动我回别人补读（最近 ${formatDurationLabel(h)}）。`,
}));
$('keepExport').addEventListener('click', () => $('exportAll').click());
$('pause').addEventListener('click', () => act('pauseJob'));
$('resume').addEventListener('click', () => act('resumeJob'));
for (const k of SHOW_KEYS) $(k).addEventListener('change', (e) => saveRules({ [k]: e.target.checked }));
$('tapInEnabled').addEventListener('change', (e) => saveRules({ tapInEnabled: e.target.checked }));
$('tapOutEnabled').addEventListener('change', (e) => saveRules({ tapOutEnabled: e.target.checked }));
$('clear').addEventListener('click', () => {
  if (confirm(`清空此账号在本机的全部回复数据（别人回我、我回别人）？榜单和时间线标签都会消失，不可恢复。`)) act('clearData');
});
$('bindBtn').addEventListener('click', async () => {
  const button = $('bindBtn');
  button.disabled = true;
  try {
    const result = await call('setAccountEnabled', { enabled: true, userId: view.activationUserId });
    if (result.error) return alert(result.error);
    Object.assign(view, { selected: result.account, tab: null, open: null });
    await render();
  } finally {
    button.disabled = false;
  }
});
$('disableAccount').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const { account } = button.dataset;
  if (!account) return;
  button.disabled = true;
  try {
    const result = await call('setAccountEnabled', { enabled: false, account });
    if (result.error) return alert(result.error);
    if (view.selected === account) Object.assign(view, { selected: undefined, tab: null, open: null });
    await render();
  } finally {
    button.disabled = false;
  }
});

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

// 任务状态、快照变化时自动刷新。读取过程中一页要写好几次存储，攒 200 毫秒再画；
// 只看和界面有关的键（tplTry 这类后台自用的不管）
let redrawTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => STORAGE_WATCH.test(k))) return;
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(render, 200);
});
render();
