// 弹窗：榜单、初始化、设置。只和后台通信，不直接发任何 X 请求。

const $ = (id) => document.getElementById(id);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const view = { account: null, days: 30 };

const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const fmtTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

function banners(items) {
  $('banners').replaceChildren(...items.map(([kind, text]) => el('div', { className: `banner ${kind}`, textContent: text })));
}

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
  const isSession = view.account === g.current;
  if (!isSession) items.push(['warn', `@${g.accounts[view.account].handle} 不是当前登录 X 的账号，这里只能查看它已有的数据。`]);
  if (s.alert) items.push(['err', `${fmtTime(s.alert.at)} ${s.alert.message}`]);
  banners(items);

  // 榜单
  const { rows } = await call('getBoard', { account: view.account, windowDays: view.days });
  $('boardHint').textContent = `最近 ${view.days} 天回复过我的 ${rows.length} 人，按回复次数排。`;
  $('list').replaceChildren(
    ...(rows.length
      ? rows.map((r) =>
          el('li', {}, [
            el('span', { className: 'rank', textContent: r.rank }),
            el('img', { src: r.avatar, alt: '', referrerPolicy: 'no-referrer', loading: 'lazy' }),
            el('div', { className: 'who' }, [
              el('a', { className: 'name', href: `https://x.com/${r.handle}`, target: '_blank', rel: 'noreferrer', textContent: r.name }),
              el('span', { className: 'sub', textContent: `@${r.handle} · 最近 ${fmtTime(r.last)}` }),
            ]),
            el('div', { className: 'count' }, [el('b', { textContent: r.count }), el('span', { textContent: '次回复' })]),
          ]),
        )
      : [el('li', { className: 'empty', textContent: s.eventCount ? '这个时间窗内没有人回复' : '还没有数据，先点下方「启动 / 初始化」' })]),
  );

  // 回填任务
  const job = s.job;
  const active = job && ['running', 'waiting_tab', 'paused', 'error'].includes(job.status);
  $('job').hidden = !job;
  if (job) {
    const reached = job.oldestTs ? `，已回溯到 ${fmtDay(job.oldestTs)}` : '';
    const progress = `已读 ${job.pages} 页、入库 ${job.added} 条${reached}`;
    const next = job.nextAt && job.nextAt > Date.now() ? `，下一次请求约 ${fmtTime(job.nextAt)}` : '';
    const text = {
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
    $('jobStatus').textContent = text;
  }
  $('pause').hidden = !(job && ['running', 'waiting_tab'].includes(job.status)) && !(job && job.status === 'paused' && job.auto);
  $('resume').hidden = !(job && (job.status === 'error' || (job.status === 'paused' && !job.auto)));
  $('start').textContent = active ? '重新初始化' : '启动 / 初始化';
  $('start').disabled = !isSession || !s.settings.fetchEnabled;
  $('resume').disabled = !isSession || !s.settings.fetchEnabled;
  $('coverage').textContent = s.cursor.earliestTs
    ? `本地数据最早覆盖到 ${fmtDay(s.cursor.earliestTs)}，共 ${s.eventCount} 条直接回复（只有你帖子下的上榜）。`
    : '';

  // 设置
  $('fetchEnabled').checked = s.settings.fetchEnabled;
  $('interval').value = String(s.settings.intervalHours);
  $('interval').disabled = !s.settings.fetchEnabled;
  $('lastInc').textContent = s.cursor.lastIncrementalAt ? `上次增量：${fmtTime(s.cursor.lastIncrementalAt)}` : '';
}

async function act(type, extra) {
  const r = await call(type, { account: view.account, ...extra });
  if (r?.error) alert(r.error);
  await render();
}

$('boards').addEventListener('click', (e) => {
  const d = e.target.closest('[data-days]');
  if (!d) return;
  view.days = Number(d.dataset.days);
  document.querySelectorAll('[data-days]').forEach((n) => n.classList.toggle('on', Number(n.dataset.days) === view.days));
  render();
});
$('account').addEventListener('change', (e) => { view.account = e.target.value; render(); });
$('start').addEventListener('click', () => {
  const days = Number($('range').value);
  const again = $('start').textContent === '重新初始化' ? '当前任务会被丢弃并从头开始。' : '';
  if (confirm(`将用你的 X 登录会话，限速回填最近 ${days} 天别人对你的回复。${again}确定开始？`)) act('startBackfill', { rangeDays: days });
});
$('pause').addEventListener('click', () => act('pauseJob'));
$('resume').addEventListener('click', () => act('resumeJob'));
$('fetchEnabled').addEventListener('change', (e) => act('setSettings', { patch: { fetchEnabled: e.target.checked } }));
$('interval').addEventListener('change', (e) => act('setSettings', { patch: { intervalHours: Number(e.target.value) } }));
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
