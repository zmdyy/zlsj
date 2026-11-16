(function () {
  'use strict';

  var STORE_KEY = 'SC_DATA_V1';
  var PY = window.PY_DATA || {};

  /* 姓氏常见读音（仅影响显示的首选拼音，查询时仍匹配全部候选读音） */
  var PY_FIX = {
    '单': 'shan', '查': 'zha', '解': 'xie', '区': 'ou', '乐': 'yue', '曾': 'zeng',
    '覃': 'qin', '翟': 'zhai', '朴': 'piao', '仇': 'qiu', '缪': 'miao', '冼': 'xian',
    '员': 'yun', '繁': 'po', '折': 'she', '重': 'chong', '种': 'chong', '过': 'guo',
    '召': 'shao', '盖': 'gai', '阚': 'kan', '句': 'gou'
  };

  /* ---------------- 状态 ---------------- */
  var state = null;
  var importMode = 'append';
  var filter = 'all';
  var activeGroup = '';
  var selIdx = 0;          // 当前结果中用 ↑/↓ 选中的人

  /* 状态值：''=未交  done=已交  agree=同意  disagree=不同意 */
  var STATUS_LABEL = { done: '已交', agree: '同意', disagree: '不同意' };
  var PICK_ORDER = ['done', 'agree', 'disagree'];

  function taskMode(task) {
    if (task && task.mode === 'three') return 'three';
    if (task && task.mode === 'score') return 'score';
    return 'binary';
  }
  function statusOf(task, id) { return (task && task.status && task.status[id]) || ''; }
  function scoreOf(task, id) {
    if (!task || !task.scores) return null;
    var v = task.scores[id];
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function formatScore(n) {
    if (n == null) return '';
    return String(Math.round(Number(n) * 10) / 10).replace(/\.0$/, '');
  }
  function parseScore(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/分$/, '');
    if (!s) return null;
    if (!/^\d+(\.\d)?$/.test(s)) return undefined;
    var n = Math.round(Number(s) * 10) / 10;
    if (n > 999) return undefined;
    return n;
  }
  function isResponded(task, id) {
    if (taskMode(task) === 'score') return scoreOf(task, id) != null;
    return !!statusOf(task, id);
  }
  function modeTag(task) {
    var m = taskMode(task);
    if (m === 'three') return '（同意/不同意）';
    if (m === 'score') return '（考试分数）';
    return '';
  }

  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function storageOK() {
    try {
      localStorage.setItem('__sc_test__', '1');
      localStorage.removeItem('__sc_test__');
      return true;
    } catch (e) { return false; }
  }
  var canStore = true;
  var fileMode = false;
  var storageGuarded = false;
  var saveTimer = null;
  var booted = false;
  var API = 'http://127.0.0.1:8765/api/data';

  function emptyState() {
    return { v: 1, people: [], tasks: [], currentTaskId: null };
  }

  function usableState(s) {
    return !!(s && Array.isArray(s.people) && Array.isArray(s.tasks));
  }

  function snapshot() {
    return JSON.stringify(state, function (k, v) {
      if (k === '_idx' || k === '_missing' || k === '_corrupt' || k === '_droppedTest') return undefined;
      return v;
    });
  }

  function load() {
    storageGuarded = false;
    if (!storageOK()) { canStore = false; return null; }
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); }
    catch (e) { canStore = false; return null; }
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (usableState(s)) {
        migrate(s);
        return s;
      }
    } catch (e) { /* 保留原内容，避免用空数据覆盖 */ }
    storageGuarded = true;
    return null;
  }

  /* 旧版 done:{} 布尔表 → 新版 status:{} 状态值；班级从备注提升为分组 */
  function migrate(s) {
    (s.tasks || []).forEach(function (t) {
      if (!t.status || typeof t.status !== 'object') t.status = {};
      if (t.done && typeof t.done === 'object') {
        Object.keys(t.done).forEach(function (k) {
          if (t.done[k] && !t.status[k]) t.status[k] = 'done';
        });
        delete t.done;
      }
      if (!t.mode) t.mode = 'binary';
      if (!t.scores || typeof t.scores !== 'object') t.scores = {};
    });
    (s.people || []).forEach(function (p) {
      if (!p.group && p.note) p.group = String(p.note);
      if (p.group && p.note === p.group) p.note = '';
    });
    var drop = {};
    s.people = (s.people || []).filter(function (p) {
      if (p && p.name === '关闭保存') { drop[p.id] = 1; return false; }
      return true;
    });
    if (Object.keys(drop).length) {
      s._droppedTest = true;
      (s.tasks || []).forEach(function (t) {
        Object.keys(drop).forEach(function (id) {
          if (t.status) delete t.status[id];
          if (t.notes) delete t.notes[id];
          if (t.scores) delete t.scores[id];
        });
      });
    }
  }

  function saveLocal() {
    if (!canStore || storageGuarded) return;
    try {
      localStorage.setItem(STORE_KEY, snapshot());
    } catch (e) {
      toast('浏览器存储失败，请确认本地文件是否已写入');
    }
  }

  function saveFileNow(loud) {
    return fetch(API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot(),
      mode: 'cors',
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 409) {
        return res.json().then(function (d) {
          toast('本地文件里已有名单，已取消用空数据覆盖');
          if (usableState(d)) {
            migrate(d);
            state = d;
            storageGuarded = false;
            saveLocal();
            renderAll();
            updateStoreStatus(true);
          }
          return false;
        });
      }
      if (!res.ok) throw new Error('http ' + res.status);
      fileMode = true;
      updateStoreStatus(true);
      return true;
    }).catch(function () {
      if (fileMode || loud) {
        updateStoreStatus(false);
        toast('写入 data\\store.json 失败，请重新双击「启动.bat」');
      }
      fileMode = false;
      return false;
    });
  }

  function save() {
    if (state) state.updatedAt = Date.now();
    saveLocal();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveFileNow(false); }, 200);
  }

  function saveNow() {
    if (state) state.updatedAt = Date.now();
    saveLocal();
    clearTimeout(saveTimer);
    return saveFileNow(true);
  }

  function updateStoreStatus(ok) {
    var el = document.getElementById('storeStatus');
    if (!el) return;
    if (!fileMode) {
      el.textContent = '可以直接双击 index.html 使用。点「保存」，或关闭页面，都会下载「资料收集数据.json」。下次用「恢复备份」打开这份文件。';
      return;
    }
    if (ok === false) {
      el.textContent = '没能写入 data\\store.json。可以点「保存」下载一份 JSON 文件。';
      return;
    }
    var n = (state && state.people) ? state.people.length : 0;
    el.textContent = '上传名单、登记和关闭页面都会自动写入 data\\store.json（当前 ' + n + ' 人），不用点击保存。';
  }

  function downloadDataFile() {
    var blob = new Blob([snapshot()], { type: 'application/json' });
    download('资料收集数据.json', blob);
  }

  function saveManual() {
    if (state) state.updatedAt = Date.now();
    saveLocal();
    clearTimeout(saveTimer);
    return saveFileNow(false).then(function (ok) {
      if (ok) {
        toast('已保存到 data\\store.json');
        return;
      }
      downloadDataFile();
      toast('已下载 资料收集数据.json');
    });
  }

  function flushFile(isExit) {
    if (!booted || !state) return;
    clearTimeout(saveTimer);
    var body = snapshot();
    var sent = false;
    try {
      if (navigator.sendBeacon) {
        sent = navigator.sendBeacon(API, new Blob([body], { type: 'text/plain;charset=utf-8' }));
      }
    } catch (e) { sent = false; }
    if (!sent) {
      try {
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: body,
          keepalive: true,
          mode: 'cors'
        });
      } catch (e2) { /* 页面正在关闭 */ }
    }
    if (isExit && !fileMode) downloadDataFile();
  }

  window.addEventListener('pagehide', function () { flushFile(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushFile(false);
  });

  function chooseState() {
    state = emptyState();
    var local = load();
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 1500);
    return fetch(API, { cache: 'no-store', mode: 'cors', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('no api');
        return res.json();
      })
      .then(function (disk) {
        fileMode = true;
        if (disk && disk._missing) {
          state = (local && local.people && local.people.length) ? local : emptyState();
        } else if (usableState(disk)) {
          migrate(disk);
          state = disk;
          storageGuarded = false;
          saveLocal();
        } else {
          state = local || emptyState();
        }
      })
      .catch(function () {
        clearTimeout(timer);
        fileMode = false;
        state = local || emptyState();
      });
  }

  function currentTask() {
    var t = state.tasks.filter(function (x) { return x.id === state.currentTaskId; })[0];
    if (!t && state.tasks.length) { t = state.tasks[0]; state.currentTaskId = t.id; }
    return t || null;
  }

  /* ---------------- 拼音索引 ---------------- */
  function readings(ch) {
    var v = PY[ch];
    if (v) return v.split(',');
    return [/[\u4e00-\u9fa5]/.test(ch) ? null : ch.toLowerCase()].filter(Boolean);
  }

  function buildIndex(p) {
    var chars = Array.from(p.name.replace(/\s+/g, ''));
    var combos = [[]];
    for (var i = 0; i < chars.length; i++) {
      var rs = readings(chars[i]);
      if (!rs.length) rs = [chars[i].toLowerCase()];
      var next = [];
      for (var a = 0; a < combos.length; a++) {
        for (var b = 0; b < rs.length; b++) {
          next.push(combos[a].concat(rs[b]));
          if (next.length >= 24) break;
        }
        if (next.length >= 24) break;
      }
      combos = next.length ? next : [[]];
    }
    // 首选显示串（姓氏多音优先，用户自定义优先）
    var main = chars.map(function (c, k) {
      if (p.pyOverride && p.pyOverride[k]) return p.pyOverride[k];
      return PY_FIX[c] || (readings(c)[0] || c.toLowerCase());
    });

    var idx = {
      mainFull: main.join(''),
      mainInit: main.map(function (x) { return x.charAt(0); }).join(''),
      fulls: combos.map(function (c) { return c.join(''); }),
      inits: combos.map(function (c) { return c.map(function (x) { return x.charAt(0); }).join(''); })
    };
    idx.fulls.push(idx.mainFull);
    idx.inits.push(idx.mainInit);
    return idx;
  }

  function idxOf(p) {
    if (!p._idx) p._idx = buildIndex(p);
    return p._idx;
  }

  function normalizeQuery(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '');
  }

  function match(p, q) {
    if (!q) return true;
    var name = p.name.replace(/\s+/g, '');
    if (name.toLowerCase().indexOf(q) >= 0) return true;
    var ix = idxOf(p);
    if (ix.mainFull.indexOf(q) === 0 || ix.mainInit.indexOf(q) === 0) return true;
    for (var i = 0; i < ix.fulls.length; i++) if (ix.fulls[i].indexOf(q) === 0) return true;
    for (var j = 0; j < ix.inits.length; j++) if (ix.inits[j].indexOf(q) === 0) return true;
    return false;
  }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  }
  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_'); }

  /* ---------------- 初始化默认项目 ---------------- */
  function ensureTask() {
    if (!state.tasks.length) {
      var t = { id: uid(), title: '默认收集项目', created: todayStr(), status: {}, notes: {}, mode: 'binary' };
      state.tasks.push(t);
      state.currentTaskId = t.id;
      save();
    }
    if (!currentTask()) state.currentTaskId = state.tasks[0].id;
    state.tasks.forEach(function (t) {
      if (!t.status) t.status = {};
      if (!t.mode) t.mode = 'binary';
      if (!t.scores || typeof t.scores !== 'object') t.scores = {};
    });
  }

  /* 依据项目模式切换界面文案 */
  function updateModeUI(task) {
    var mode = taskMode(task);
    var three = mode === 'three';
    var score = mode === 'score';
    document.getElementById('chipTodo').textContent = score ? '未登分' : (three ? '未回应' : '未交');
    document.getElementById('chipDone').textContent = score ? '已登分' : (three ? '已回应' : '已交');
    document.getElementById('lblDone').textContent = score ? '已登分' : (three ? '已回应' : '已交');
    document.getElementById('lblTodo').textContent = score ? '未登分' : (three ? '未回应' : '未交');
    document.getElementById('markHint').innerHTML = three
      ? '搜索后按 <kbd>回车</kbd> 或 <kbd>空格</kbd> 弹出状态窗：<kbd>←</kbd> <kbd>→</kbd> 在 已交 / 同意 / 不同意 之间切换，再按 <kbd>回车</kbd> 确认'
      : '搜索后按 <kbd>回车</kbd> 或 <kbd>空格</kbd>，第一个结果标记为已交并自动清空，接着查下一个';
    document.getElementById('btnBatchDone').textContent = '结果全部已交';
    document.getElementById('btnBatchDone').classList.toggle('hidden', score);
    document.getElementById('btnBatchReset').textContent = score ? '清空全部分数' : (three ? '全部重置未回应' : '重置未交');
    document.getElementById('miniStats').classList.toggle('hidden', !three);
    document.getElementById('quickMark').classList.toggle('hidden', score);
    document.getElementById('quickScore').classList.toggle('hidden', !score);
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    renderTaskSelect();
    renderGroupChips();
    renderRoster();
    renderResults();
    renderStats();
  }

  function renderTaskSelect() {
    var sel = document.getElementById('taskSelect');
    var cur = currentTask();
    sel.innerHTML = state.tasks.map(function (t) {
      return '<option value="' + t.id + '"' + (cur && t.id === cur.id ? ' selected' : '') + '>' + esc(t.title + modeTag(t)) + '</option>';
    }).join('');
    document.getElementById('taskDate').textContent = cur ? (cur.created + (modeTag(cur) ? ' · ' + modeTag(cur).replace(/[（）]/g, '') : '')) : '';
    updateModeUI(cur);
  }

  function groupLabel(g) {
    if (!g) return '未分班';
    if (/^\d+$/.test(g)) return g + '班';
    return g;
  }

  function groupKeys(list) {
    var seen = {};
    (list || []).forEach(function (p) { seen[p.group || ''] = 1; });
    return Object.keys(seen).sort(function (a, b) {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b, 'zh', { numeric: true });
    });
  }

  function inGroup(p) {
    if (!activeGroup) return true;
    if (activeGroup === '__none__') return !p.group;
    return p.group === activeGroup;
  }

  function scopedPeople() {
    return state.people.filter(inGroup);
  }

  function filteredRoster(qText) {
    var q = normalizeQuery(qText);
    return state.people.filter(function (p) { return match(p, q); });
  }

  function renderGroupChips() {
    var box = document.getElementById('groupChips');
    if (!box) return;
    var keys = groupKeys(state.people).filter(Boolean);
    var hasNone = state.people.some(function (p) { return !p.group; });
    if (activeGroup && activeGroup !== '__none__' && keys.indexOf(activeGroup) < 0) activeGroup = '';
    if (activeGroup === '__none__' && !hasNone) activeGroup = '';
    if (!keys.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var html = '<button type="button" class="chip' + (!activeGroup ? ' active' : '') + '" data-group="">全部 ' + state.people.length + '</button>';
    keys.forEach(function (g) {
      var n = state.people.filter(function (p) { return p.group === g; }).length;
      html += '<button type="button" class="chip' + (activeGroup === g ? ' active' : '') + '" data-group="' + esc(g) + '">' + esc(groupLabel(g)) + ' ' + n + '</button>';
    });
    if (hasNone && keys.length) {
      var noneN = state.people.filter(function (p) { return !p.group; }).length;
      html += '<button type="button" class="chip' + (activeGroup === '__none__' ? ' active' : '') + '" data-group="__none__">未分班 ' + noneN + '</button>';
    }
    box.innerHTML = html;
  }

  function renderRoster() {
    var q = document.getElementById('rosterSearch').value.trim();
    var list = filteredRoster(q);
    var ul = document.getElementById('rosterList');
    document.getElementById('rosterCount').textContent = state.people.length + ' 人';
    if (!state.people.length) {
      ul.innerHTML = '<li class="p-meta">暂无名单</li>';
      return;
    }
    function row(p) {
      var ix = idxOf(p);
      var tag = (p.note && p.note !== p.group) ? '<span class="p-tag">' + esc(p.note) + '</span>' : '';
      return '<li>' +
        '<span class="r-name">' + esc(p.name) + '</span>' +
        tag +
        '<span class="r-py">' + esc(ix.mainFull) + '</span>' +
        '<button class="icon-btn" data-act="editpy" data-id="' + p.id + '" title="修改拼音"><svg class="ico"><use href="#i-spell"></use></svg></button>' +
        '<button class="icon-btn danger" data-act="delperson" data-id="' + p.id + '" title="删除成员"><svg class="ico"><use href="#i-trash"></use></svg></button>' +
        '</li>';
    }
    var keys = groupKeys(list);
    var showHead = keys.length > 1 || (keys.length === 1 && keys[0]);
    ul.innerHTML = keys.map(function (g) {
      var rows = list.filter(function (p) { return (p.group || '') === g; });
      if (!rows.length) return '';
      return (showHead ? '<li class="roster-head">' + esc(groupLabel(g)) + ' · ' + rows.length + ' 人</li>' : '') + rows.map(row).join('');
    }).join('') || '<li class="p-meta">没有匹配的人</li>';
  }

  function currentResults() {
    var task = currentTask();
    var q = normalizeQuery(document.getElementById('q').value);
    return state.people.filter(function (p) {
      if (!inGroup(p)) return false;
      if (!match(p, q)) return false;
      if (!task) return true;
      if (filter === 'done') return isResponded(task, p.id);
      if (filter === 'todo') return !isResponded(task, p.id);
      return true;
    });
  }

  function renderResults() {
    var task = currentTask();
    var list = currentResults();
    if (selIdx >= list.length) selIdx = 0;
    var ul = document.getElementById('resultList');
    document.getElementById('resultCount').textContent = list.length + ' 条';
    document.getElementById('emptyTip').style.display = state.people.length ? 'none' : 'block';

    // 快捷标记按钮：显示当前选中（默认第一个）结果的姓名
    var mk = document.getElementById('btnMarkFirst');
    var mkLabel = document.getElementById('markLabel');
    if (!list.length) {
      mk.disabled = true;
      mkLabel.textContent = taskMode(task) === 'three' ? '选择登记状态' : '标记已交';
    } else if (taskMode(task) === 'three') {
      mk.disabled = false;
      mkLabel.textContent = '选择「' + list[selIdx].name + '」的状态';
    } else if (taskMode(task) === 'score') {
      mk.disabled = false;
      mkLabel.textContent = '为「' + list[selIdx].name + '」登分';
    } else {
      mk.disabled = false;
      mkLabel.textContent = '标记「' + list[selIdx].name + '」已交';
    }

    ul.innerHTML = list.map(function (p, i) {
      var st = statusOf(task, p.id);
      var mode = taskMode(task);
      var three = mode === 'three';
      var score = mode === 'score' ? scoreOf(task, p.id) : null;
      var note = task && task.notes ? task.notes[p.id] : '';
      var ix = idxOf(p);
      var ops;
      if (mode === 'score') {
        ops = '<input class="score-input row" data-act="score" data-id="' + p.id + '" value="' + esc(formatScore(score)) + '" inputmode="decimal" placeholder="分数" aria-label="' + esc(p.name) + '的分数">';
      } else if (three) {
        ops = '<div class="seg-status">' +
          PICK_ORDER.map(function (v) {
            return '<button data-act="set" data-val="' + v + '" data-id="' + p.id + '"' +
              (st === v ? ' class="on"' : '') + '>' + STATUS_LABEL[v] + '</button>';
          }).join('') + '</div>';
      } else {
        ops = '<button class="status-btn ' + (st ? 'done' : 'todo') + '" data-act="toggle" data-id="' + p.id + '">' +
          (st ? '已交' : '未交') + '</button>';
      }
      var rowClass = mode === 'score' ? (score != null ? 'scored' : 'todo') : (st || 'todo');
      return '<li class="' + rowClass + (i === selIdx ? ' sel' : '') + '" data-id="' + p.id + '">' +
        '<div class="p-main">' +
        '<div class="p-name">' + esc(p.name) +
        (p.group && !activeGroup ? ' <span class="p-tag">' + esc(groupLabel(p.group)) + '</span>' : '') +
        (p.note && p.note !== p.group ? ' <span class="p-tag">' + esc(p.note) + '</span>' : '') +
        (three && st ? ' <span class="st-badge ' + st + '">' + STATUS_LABEL[st] + '</span>' : '') + '</div>' +
        '<div class="p-meta">' + esc(ix.mainFull) + ' · ' + esc(ix.mainInit) + (note ? ' · 备注：' + esc(note) : '') + '</div>' +
        '</div>' +
        ops +
        '<button class="icon-btn" data-act="note" data-id="' + p.id + '" title="添加备注"><svg class="ico"><use href="#i-pen"></use></svg></button>' +
        '</li>';
    }).join('');
  }

  function renderStats() {
    var task = currentTask();
    var mode = taskMode(task);
    var three = mode === 'three';
    var cnt = { done: 0, agree: 0, disagree: 0 };
    var scoreSum = 0, scoreN = 0;
    var people = scopedPeople();
    var total = people.length;
    people.forEach(function (p) {
      if (mode === 'score') {
        var sc = scoreOf(task, p.id);
        if (sc != null) { scoreSum += sc; scoreN++; }
        return;
      }
      var st = statusOf(task, p.id);
      if (st) cnt[st]++;
    });
    var done = mode === 'score' ? scoreN : (cnt.done + cnt.agree + cnt.disagree);
    var todo = total - done;
    document.getElementById('statTotal').textContent = total;
    document.getElementById('statDone').textContent = done;
    document.getElementById('statTodo').textContent = todo;
    document.getElementById('msDone').textContent = cnt.done;
    document.getElementById('msAgree').textContent = cnt.agree;
    document.getElementById('msDisagree').textContent = cnt.disagree;
    document.getElementById('exportCount').textContent = (mode === 'score' ? '未登分 ' : (three ? '未回应 ' : '未交 ')) + todo + ' 人';
    document.getElementById('progressBar').style.width = (total ? (done / total * 100) : 0) + '%';
    document.getElementById('rateText').textContent = mode === 'score'
      ? ('平均分 ' + (scoreN ? formatScore(scoreSum / scoreN) : '—') + '　已登分 ' + scoreN + '/' + total)
      : ((three ? '回应率 ' : '完成率 ') + (total ? Math.round(done / total * 100) : 0) + '%　（' + done + '/' + total + '）');
    renderExportText();
    renderGroups();
  }

  function todoPeople() {
    var task = currentTask();
    if (!task) return [];
    return scopedPeople().filter(function (p) { return !isResponded(task, p.id); });
  }

  /* ---------------- 导出分组 ---------------- */
  // 三态项目：已交·同意 / 已交·不同意 / 已交·未表态（有才显示）/ 未交（未回应）
  // 普通项目：已交 / 未交
  function groupsOf(task) {
    var mode = taskMode(task);
    var defs = mode === 'score'
      ? [
          { key: 'scored', title: '已登分', tone: 'done' },
          { key: 'none', title: '未登分', tone: 'none' }
        ]
      : (mode === 'three'
      ? [
          { key: 'agree', title: '已交 · 同意', tone: 'agree' },
          { key: 'disagree', title: '已交 · 不同意', tone: 'disagree' },
          { key: 'done', title: '已交 · 未表态', tone: 'done', onlyIfAny: true },
          { key: 'none', title: '未交（未回应）', tone: 'none' }
        ]
      : [
          { key: 'done', title: '已交', tone: 'done' },
          { key: 'none', title: '未交', tone: 'none' }
        ]);
    var buckets = {};
    defs.forEach(function (d) { buckets[d.key] = []; });
    scopedPeople().forEach(function (p) {
      var st = mode === 'score'
        ? (scoreOf(task, p.id) != null ? 'scored' : 'none')
        : (isResponded(task, p.id) ? (statusOf(task, p.id) || 'done') : 'none');
      if (!buckets[st]) buckets[st] = [];
      buckets[st].push(p);
    });
    return defs
      .filter(function (d) { return !(d.onlyIfAny && !buckets[d.key].length); })
      .map(function (d) {
        return { key: d.key, title: d.title, tone: d.tone, list: buckets[d.key] || [] };
      });
  }

  function personLabel(p) {
    var task = currentTask();
    if (taskMode(task) === 'score') {
      var s = scoreOf(task, p.id);
      if (s != null) return p.name + ' ' + formatScore(s);
    }
    return p.name;
  }

  function joinNames(list, sep) {
    if (sep === 'comma') return list.map(personLabel).join('，');
    if (sep === 'sheet') return list.map(function (p, i) { return (i + 1) + '. ' + personLabel(p); }).join('\n');
    return list.map(personLabel).join('\n');
  }

  function curSep() {
    return (document.querySelector('input[name="sep"]:checked') || {}).value || 'nl';
  }

  function renderGroups() {
    var task = currentTask();
    var box = document.getElementById('groupList');
    if (!box) return;
    var sep = curSep();
    var groups = groupsOf(task);
    box.innerHTML = groups.map(function (g) {
      return '<div class="g-item ' + g.tone + '">' +
        '<div class="g-head">' +
        '<span class="g-title">' + esc(g.title) + '</span>' +
        '<span class="g-count">' + g.list.length + ' 人</span>' +
        '<button class="g-copy" data-act="copygroup" data-g="' + g.key + '">复制</button>' +
        '</div>' +
        '<textarea class="mono g-text" rows="2" readonly>' + esc(joinNames(g.list, sep)) + '</textarea>' +
        '</div>';
    }).join('');
  }

  function groupText(key) {
    var g = groupsOf(currentTask()).filter(function (x) { return x.key === key; })[0];
    return g ? joinNames(g.list, curSep()) : '';
  }

  function renderExportText() {
    var sep = curSep();
    var groups = groupsOf(currentTask());
    var text = groups.map(function (g) {
      return '【' + g.title + '】' + g.list.length + ' 人\n' + (joinNames(g.list, sep) || '（无）');
    }).join('\n\n');
    document.getElementById('exportText').value = text;
  }

  /* ---------------- 快捷标记 ---------------- */
  function clearQuery() {
    selIdx = 0;
    document.getElementById('q').value = '';
    renderResults();
    document.getElementById('q').focus();
  }

  function applyScore(id, raw, input) {
    var task = currentTask();
    if (!task) return false;
    var parsed = parseScore(raw);
    if (parsed === undefined) {
      toast('请输入 0–999 的分数，最多一位小数');
      if (input) input.value = formatScore(scoreOf(task, id));
      return false;
    }
    if (!task.scores) task.scores = {};
    if (parsed == null) delete task.scores[id];
    else task.scores[id] = parsed;
    save();
    return true;
  }

  function focusScoreInput() {
    var task = currentTask();
    var list = currentResults();
    if (selIdx >= list.length) selIdx = 0;
    var box = document.getElementById('scoreInput');
    var cur = list[selIdx] ? scoreOf(task, list[selIdx].id) : null;
    box.value = cur == null ? '' : formatScore(cur);
    box.focus();
    box.select();
  }

  function commitQuickScore() {
    var task = currentTask();
    var list = currentResults();
    if (!document.getElementById('q').value.trim()) {
      toast('请先搜索要登分的人');
      document.getElementById('q').focus();
      return;
    }
    if (selIdx >= list.length) selIdx = 0;
    if (!task || !list.length) { toast('没有可登记的人'); return; }
    var p = list[selIdx];
    var box = document.getElementById('scoreInput');
    if (!applyScore(p.id, box.value, box)) { box.focus(); return; }
    var saved = scoreOf(task, p.id);
    toast(saved == null ? '已清除「' + p.name + '」的分数' : '「' + p.name + '」' + formatScore(saved) + ' 分');
    box.value = '';
    clearQuery();
    renderStats();
  }

  function markFirstDone() {
    var task = currentTask();
    var list = currentResults();
    if (selIdx >= list.length) selIdx = 0;
    if (!task || !list.length) { toast('没有可标记的人'); return; }
    var p = list[selIdx];
    if (taskMode(task) === 'score') { focusScoreInput(); return; }
    if (taskMode(task) === 'three') {         // 三态模式：弹出状态选择窗
      openPicker(p.id, p.name, statusOf(task, p.id));
      return;
    }
    if (statusOf(task, p.id)) {
      toast('「' + p.name + '」已经是已交状态');
    } else {
      task.status[p.id] = 'done';
      save();
      toast('已标记「' + p.name + '」为已交');
    }
    clearQuery();
    renderStats();
  }

  /* ---------------- 状态选择弹窗 ---------------- */
  var pick = { id: null, name: '', idx: 1 };

  function pickerOpen() {
    return !document.getElementById('maskPick').classList.contains('hidden');
  }

  function openPicker(id, name, curStatus) {
    pick.id = id;
    pick.name = name;
    pick.idx = curStatus ? Math.max(0, PICK_ORDER.indexOf(curStatus)) : 1;  // 默认「同意」
    document.getElementById('pickName').textContent = name;
    syncPickSel();
    document.getElementById('maskPick').classList.remove('hidden');
  }

  function syncPickSel() {
    Array.prototype.forEach.call(document.querySelectorAll('.pick-opt'), function (b, i) {
      b.classList.toggle('sel', i === pick.idx);
    });
  }

  function closePicker() {
    document.getElementById('maskPick').classList.add('hidden');
    pick.id = null;
  }

  function confirmPick() {
    var task = currentTask();
    if (!task || !pick.id) { closePicker(); return; }
    var val = PICK_ORDER[pick.idx];
    task.status[pick.id] = val;
    var nm = pick.name;
    save();
    closePicker();
    clearQuery();
    renderStats();
    toast('「' + nm + '」已登记为' + STATUS_LABEL[val]);
  }

  function undoPick() {
    var task = currentTask();
    if (task && pick.id) {
      delete task.status[pick.id];
      save();
    }
    closePicker();
    clearQuery();
    renderStats();
  }

  // 弹窗打开时的统一键盘处理（无论焦点在搜索框还是页面其他地方）
  function handlePickerKey(e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      pick.idx = (pick.idx + PICK_ORDER.length - 1) % PICK_ORDER.length;
      syncPickSel();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      pick.idx = (pick.idx + 1) % PICK_ORDER.length;
      syncPickSel();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      confirmPick();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      document.getElementById('q').focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();   // 弹窗打开时不允许焦点/光标乱跑
    } else if (e.key.length === 1) {
      e.preventDefault();   // 弹窗打开时不往搜索框里打字
    }
  }

  /* ---------------- 名单导入 ---------------- */
  function addPeople(items, mode) {
    // items: [{name, note}]
    var added = 0, updated = 0, skipped = 0;
    if (mode === 'replace') {
      state.people = [];
      state.tasks.forEach(function (t) { t.status = {}; t.notes = {}; t.scores = {}; });
    }
    var groupSeen = {};
    items.forEach(function (it) {
      var name = String(it.name || '').replace(/\s+/g, '').trim();
      if (!name) return;
      if (/^\d+$/.test(name)) return;
      var group = String(it.group || '').trim();
      var note = String(it.note || '').trim();
      if (note && note === group) note = '';
      if (group) groupSeen[group] = 1;
      var exist = state.people.filter(function (p) { return p.name === name; })[0];
      if (exist) {
        var changed = false;
        if (group && exist.group !== group) { exist.group = group; changed = true; }
        if (note && exist.note !== note) { exist.note = note; changed = true; }
        if (changed) updated++; else skipped++;
        return;
      }
      state.people.push({ id: uid(), name: name, note: note, group: group, pyOverride: [] });
      added++;
    });
    renderAll();
    var gnames = Object.keys(groupSeen).sort(function (a, b) { return a.localeCompare(b, 'zh', { numeric: true }); });
    var msg = '导入完成：新增 ' + added + ' 人' + (updated ? '，更新 ' + updated + ' 人' : '') + (skipped ? '，跳过重复 ' + skipped + ' 人' : '');
    if (gnames.length) msg += '，已按班级分成 ' + gnames.length + ' 组（' + gnames.map(groupLabel).join('、') + '）';
    saveNow().then(function (ok) {
      toast(ok ? msg + '，名单已自动保存' : msg + '，名单还没写入本地文件');
    });
  }

  function parseText(raw) {
    var items = [];
    String(raw).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var parts = line.split(/[\t,，;；]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!parts.length) return;
      items.push({
        name: parts[0].replace(/^[\d.、]+/, ''),
        group: parts[1] || '',
        note: parts.slice(2).join(' / ')
      });
    });
    return items;
  }

  function parseRows(rows) {
    if (!rows.length) return [];
    var head = rows[0].map(function (c) { return String(c == null ? '' : c).trim(); });
    var nameCol = head.findIndex(function (h) { return /姓名|名字|学生|人员|成员/.test(h); });
    var start = 0, groupCol = -1, noteCol = -1;
    if (nameCol >= 0) {
      start = 1;
      groupCol = head.findIndex(function (h) { return /班级|组别|小组|班$/.test(h); });
      noteCol = head.findIndex(function (h, i) { return i !== groupCol && /备注|单位/.test(h); });
    } else {
      nameCol = 0;
      if (rows[0].length > 1) groupCol = 1;
      if (rows[0].length > 2) noteCol = 2;
    }
    var items = [];
    for (var i = start; i < rows.length; i++) {
      var row = rows[i] || [];
      var name = String(row[nameCol] == null ? '' : row[nameCol]).trim();
      if (!name) continue;
      if (/^\d+(\.\d+)?$/.test(name)) continue;
      var group = groupCol >= 0 && row[groupCol] != null ? String(row[groupCol]).trim() : '';
      var note = noteCol >= 0 && row[noteCol] != null ? String(row[noteCol]).trim() : '';
      if (!group && !note) {
        var others = row.filter(function (c, ci) {
          if (ci === nameCol || c == null) return false;
          var s = String(c).trim();
          return s !== '' && !/^\d+(\.\d+)?$/.test(s);
        }).map(function (c) { return String(c).trim(); });
        if (others.length) group = others[0];
        if (others.length > 1) note = others.slice(1).join(' / ');
      }
      if (note === group) note = '';
      items.push({ name: name, group: group, note: note });
    }
    return items;
  }

  /* ---------------- 导出 ---------------- */
  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  function checkXlsx() {
    if (typeof XLSX === 'undefined') { toast('未能加载 Excel 组件，请确认 vendor/xlsx.full.min.js 存在'); return false; }
    return true;
  }

  function exportTodoXlsx() {
    if (!checkXlsx()) return;
    var task = currentTask();
    if (!task) return;
    var aoa = [['序号', '姓名', '状态', '备注']];
    todoPeople().forEach(function (p, i) {
      aoa.push([i + 1, p.name, taskMode(task) === 'three' ? '未回应' : '未交', task.notes[p.id] || p.note || '']);
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 8 }, { wch: 20 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '未交名单');
    XLSX.writeFile(wb, safeName('未交名单_' + task.title + '_' + todayStr()) + '.xlsx');
    toast('已导出未交名单 Excel');
  }

  // 按分组导出 Excel：每组一个工作表
  function exportGroupXlsx() {
    if (!checkXlsx()) return;
    var task = currentTask();
    if (!task) return;
    var groups = groupsOf(task);
    var wb = XLSX.utils.book_new();
    var used = {};
    groups.forEach(function (g) {
      var aoa = [['序号', '姓名', '状态', '班级/组别', '备注']];
      var scoreMode = taskMode(task) === 'score';
      aoa[0] = scoreMode ? ['序号', '姓名', '分数', '班级/组别', '备注'] : ['序号', '姓名', '状态', '班级/组别', '备注'];
      g.list.forEach(function (p, i) {
        var cell = scoreMode
          ? (g.key === 'none' ? '' : formatScore(scoreOf(task, p.id)))
          : (g.key === 'none' ? (taskMode(task) === 'three' ? '未回应' : '未交') : g.title);
        aoa.push([i + 1, p.name, cell, p.group || p.note || '', task.notes[p.id] || '']);
      });
      if (!g.list.length) aoa.push(['', '（无）', '', '', '']);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 22 }];
      var sname = g.title.replace(/[\\/?*\[\]:]/g, '-').replace(/[（）]/g, '').slice(0, 28).trim() || '分组';
      var base = sname, n = 2;
      while (used[sname]) { sname = base + n; n++; }
      used[sname] = 1;
      XLSX.utils.book_append_sheet(wb, ws, sname);
    });
    XLSX.writeFile(wb, safeName('分组名单_' + task.title + '_' + todayStr()) + '.xlsx');
    toast('已导出分组 Excel（' + groups.length + ' 个分组）');
  }

  function copyText(text, okMsg) {
    if (!text) { toast(okMsg || '没有可复制的内容'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg || '已复制到剪贴板');
      }, function () { fallbackCopy(text, okMsg); });
    } else {
      fallbackCopy(text, okMsg);
    }
  }

  function fallbackCopy(text, okMsg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, 99999);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? (okMsg || '已复制到剪贴板') : '复制失败，请手动选中复制');
  }

  function exportAllXlsx() {
    if (!checkXlsx()) return;
    var task = currentTask();
    if (!task) return;
    var scoreMode = taskMode(task) === 'score';
    var aoa = [scoreMode
      ? ['序号', '姓名', '班级', '拼音', '首字母', '分数', '备注']
      : ['序号', '姓名', '班级', '拼音', '首字母', '状态', '备注']];
    scopedPeople().forEach(function (p, i) {
      var ix = idxOf(p);
      var cell = scoreMode
        ? (scoreOf(task, p.id) == null ? '' : Number(formatScore(scoreOf(task, p.id))))
        : (statusOf(task, p.id) ? STATUS_LABEL[statusOf(task, p.id)] : '未交');
      aoa.push([i + 1, p.name, p.group || '', ix.mainFull, ix.mainInit, cell, task.notes[p.id] || p.note || '']);
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 22 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '收集明细');
    XLSX.writeFile(wb, safeName('收集明细_' + task.title + '_' + todayStr()) + '.xlsx');
    toast('已导出全量明细 Excel');
  }

  /* ---------------- 事件绑定 ---------------- */
  function on(el, ev, fn) { el.addEventListener(ev, fn); }

  document.addEventListener('DOMContentLoaded', function () {
    chooseState().then(boot);
  });

  function boot() {
    ensureTask();
    if (state && state._droppedTest) {
      delete state._droppedTest;
      save();
    }
    if (!canStore && !fileMode) {
      toast('当前浏览器禁止本地存储。请双击「启动.bat」打开，数据会写到 data\\store.json');
      var warn = document.createElement('div');
      warn.className = 'warnbar';
      warn.textContent = '⚠ 浏览器不能保存数据。请关闭本页，双击文件夹里的「启动.bat」再使用，这样数据会写到 data\\store.json，清理缓存也不会丢。';
      document.body.insertBefore(warn, document.body.firstChild);
    }

    // 项目区
    on(document.getElementById('taskSelect'), 'change', function () {
      state.currentTaskId = this.value;
      save(); renderAll();
    });
    /* 新建项目：名称 + 是否启用同意/不同意状态 */
    function openNewTask() {
      document.getElementById('newTaskTitle').value = '';
      document.getElementById('newTaskMode').checked = false;
      document.getElementById('newTaskScore').checked = false;
      document.getElementById('maskNew').classList.remove('hidden');
      document.getElementById('newTaskTitle').focus();
    }
    function closeNewTask() { document.getElementById('maskNew').classList.add('hidden'); }

    on(document.getElementById('btnNewTask'), 'click', openNewTask);
    on(document.getElementById('btnNewCancel'), 'click', closeNewTask);
    on(document.getElementById('btnNewOk'), 'click', function () {
      var title = String(document.getElementById('newTaskTitle').value).trim() || '新建项目';
      var mode = document.getElementById('newTaskScore').checked ? 'score'
        : (document.getElementById('newTaskMode').checked ? 'three' : 'binary');
      var t = { id: uid(), title: title, created: todayStr(), status: {}, notes: {}, scores: {}, mode: mode };
      state.tasks.push(t);
      state.currentTaskId = t.id;
      save();
      closeNewTask();
      renderAll();
      toast('已创建项目「' + title + '」' + modeTag(t));
    });
    on(document.getElementById('newTaskMode'), 'change', function () {
      if (this.checked) document.getElementById('newTaskScore').checked = false;
    });
    on(document.getElementById('newTaskScore'), 'change', function () {
      if (this.checked) document.getElementById('newTaskMode').checked = false;
    });
    on(document.getElementById('newTaskTitle'), 'keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btnNewOk').click(); }
      if (e.key === 'Escape') closeNewTask();
    });
    on(document.getElementById('maskNew'), 'click', function (e) {
      if (e.target === this) closeNewTask();
    });

    /* 状态选择弹窗 */
    on(document.getElementById('maskPick'), 'click', function (e) {
      if (e.target === this) { closePicker(); document.getElementById('q').focus(); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pick-opt'), function (b) {
      on(b, 'click', function () {
        pick.idx = PICK_ORDER.indexOf(b.dataset.val);
        syncPickSel();
        confirmPick();
      });
    });
    on(document.getElementById('btnPickOk'), 'click', confirmPick);
    on(document.getElementById('btnPickUndo'), 'click', undoPick);
    on(document, 'keydown', function (e) {
      if (!pickerOpen()) return;
      // 若焦点在搜索框上，由搜索框自己的 keydown 处理（那里会 stopPropagation），
      // 这里兜底处理焦点在页面其他位置的情况
      if (e.target === document.getElementById('q')) return;
      handlePickerKey(e);
    });
    on(document.getElementById('btnRenameTask'), 'click', function () {
      var t = currentTask();
      if (!t) return;
      var v = prompt('修改项目名称', t.title);
      if (v === null) return;
      t.title = String(v).trim() || t.title;
      save(); renderAll();
    });
    on(document.getElementById('btnDelTask'), 'click', function () {
      var t = currentTask();
      if (!t) return;
      if (state.tasks.length === 1) {
        if (!confirm('这是最后一个项目，删除后将重置为空项目。继续？')) return;
      } else if (!confirm('确定删除项目「' + t.title + '」及其登记记录？')) return;
      state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
      state.currentTaskId = state.tasks.length ? state.tasks[0].id : null;
      ensureTask();
      save(); renderAll();
    });

    // 导入方式（追加 / 覆盖）
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
      on(b, 'click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        importMode = b.dataset.importMode;
      });
    });

    // 导入选项卡
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      on(t, 'click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var target = t.dataset.tab;
        document.getElementById('panePaste').classList.toggle('hidden', target !== 'paste');
        document.getElementById('paneExcel').classList.toggle('hidden', target !== 'excel');
      });
    });

    on(document.getElementById('btnPasteAdd'), 'click', function () {
      var raw = document.getElementById('pasteBox').value;
      if (!raw.trim()) { toast('请先粘贴姓名'); return; }
      addPeople(parseText(raw), importMode);
      document.getElementById('pasteBox').value = '';
    });
    on(document.getElementById('btnLoadDemo'), 'click', function () {
      var demo = '林传宇,八年级3班\n陈思远,八年级3班\n王一诺,八年级3班\n李佳琪,八年级3班\n单雨桐,八年级3班\n曾国强,八年级3班\n赵敏萱,八年级3班\n周浩然,八年级3班';
      document.getElementById('pasteBox').value = demo;
      toast('已填入示例名单，点击“从文本添加”即可');
    });

    // Excel 导入（点击 / 拖拽）
    function handleExcelFile(file) {
      if (!file) return;
      if (typeof XLSX === 'undefined') { toast('未能加载 Excel 组件'); return; }
      document.getElementById('excelName').textContent = '已选择：' + file.name;
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
          var items = parseRows(rows);
          if (!items.length) { toast('没有读到姓名数据'); return; }
          addPeople(items, importMode);
        } catch (err) {
          toast('文件解析失败：' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    }

    on(document.getElementById('excelFile'), 'change', function () {
      handleExcelFile(this.files && this.files[0]);
      this.value = '';
    });
    on(document.getElementById('dropZone'), 'click', function () {
      document.getElementById('excelFile').click();
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      on(document.getElementById('dropZone'), ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        this.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      on(document.getElementById('dropZone'), ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && this.contains(e.relatedTarget)) return;
        this.classList.remove('dragover');
        if (ev === 'drop') {
          handleExcelFile(e.dataTransfer.files && e.dataTransfer.files[0]);
        }
      });
    });
    // 防止整个页面因拖文件而被浏览器直接打开
    ['dragover', 'drop'].forEach(function (ev) {
      on(window, ev, function (e) { e.preventDefault(); });
    });


    // 搜索
    on(document.getElementById('rosterSearch'), 'input', renderRoster);
    on(document.getElementById('q'), 'input', function () { selIdx = 0; renderResults(); });
    on(document.getElementById('q'), 'keydown', function (e) {
      if (pickerOpen()) {                            // 弹窗打开时：搜索框内直接处理全部按键
        handlePickerKey(e);
        e.stopPropagation();
        return;
      }
      var list = currentResults();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!list.length) return;
        e.preventDefault();
        var dir = e.key === 'ArrowDown' ? 1 : -1;
        selIdx = (selIdx + dir + list.length) % list.length;   // 循环选择
        renderResults();
        // 让选中的行进入可视区域
        var selLi = document.querySelector('#resultList li.sel');
        if (selLi && selLi.scrollIntoView) selLi.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        if (!this.value.trim()) return;   // 空搜索时保留默认行为
        e.preventDefault();
        markFirstDone();
        if (pickerOpen()) e.stopPropagation();       // 避免同一次回车立刻确认
      }
    });
    on(document.getElementById('btnMarkFirst'), 'click', markFirstDone);
    on(document.getElementById('btnSaveScore'), 'click', commitQuickScore);
    on(document.getElementById('scoreInput'), 'keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitQuickScore(); }
      if (e.key === 'Escape') { e.preventDefault(); document.getElementById('q').focus(); }
    });
    on(document.getElementById('btnClearQ'), 'click', function () {
      document.getElementById('q').value = '';
      renderResults();
      document.getElementById('q').focus();
    });

    // 过滤 chip
    Array.prototype.forEach.call(document.querySelectorAll('#filterChips .chip'), function (c) {
      on(c, 'click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('#filterChips .chip'), function (x) { x.classList.remove('active'); });
        c.classList.add('active');
        filter = c.dataset.filter;
        renderResults();
      });
    });
    on(document.getElementById('groupChips'), 'click', function (e) {
      var b = e.target.closest('[data-group]');
      if (!b) return;
      activeGroup = b.dataset.group || '';
      selIdx = 0;
      renderGroupChips();
      renderResults();
      renderStats();
    });

    // 结果列表操作
    // 鼠标悬停同步键盘选中行（保证“高亮的就是回车确认的”）
    on(document.getElementById('resultList'), 'mouseover', function (e) {
      var li = e.target.closest('li[data-id]');
      if (!li) return;
      var idx = Array.prototype.indexOf.call(this.querySelectorAll('li[data-id]'), li);
      if (idx >= 0 && idx !== selIdx) {
        selIdx = idx;
        // 只更新高亮与按钮文案，不整体重绘，避免悬停闪烁
        Array.prototype.forEach.call(this.querySelectorAll('li[data-id]'), function (x, i) {
          x.classList.toggle('sel', i === selIdx);
        });
        var task = currentTask();
        var list = currentResults();
        var mkLabel = document.getElementById('markLabel');
        if (list[selIdx] && mkLabel) {
          mkLabel.textContent = taskMode(task) === 'three'
            ? '选择「' + list[selIdx].name + '」的状态'
            : (taskMode(task) === 'score'
              ? '为「' + list[selIdx].name + '」登分'
              : '标记「' + list[selIdx].name + '」已交');
        }
      }
    });
    on(document.getElementById('resultList'), 'click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var id = btn.dataset.id;
      var act = btn.dataset.act;
      var task = currentTask();
      if (!task) return;
      if (act === 'score') return;
      if (act === 'toggle') {
        if (statusOf(task, id)) delete task.status[id]; else task.status[id] = 'done';
        save(); renderResults(); renderStats();
      } else if (act === 'set') {
        var val = btn.dataset.val;
        if (statusOf(task, id) === val) delete task.status[id];   // 再点一次回到未交
        else task.status[id] = val;
        save(); renderResults(); renderStats();
      } else if (act === 'note') {
        var p = state.people.filter(function (x) { return x.id === id; })[0];
        var v = prompt('为「' + (p ? p.name : '') + '」添加备注（可留空删除）', task.notes[id] || '');
        if (v === null) return;
        v = String(v).trim();
        if (v) task.notes[id] = v; else delete task.notes[id];
        save(); renderResults();
      }
    });
    on(document.getElementById('resultList'), 'change', function (e) {
      var input = e.target.closest('[data-act="score"]');
      if (!input) return;
      var id = input.dataset.id;
      if (!applyScore(id, input.value, input)) return;
      var task = currentTask();
      var p = state.people.filter(function (x) { return x.id === id; })[0];
      var saved = scoreOf(task, id);
      toast(!p ? '已更新分数' : (saved == null ? '已清除「' + p.name + '」的分数' : '「' + p.name + '」' + formatScore(saved) + ' 分'));
      renderResults();
      renderStats();
    });
    on(document.getElementById('resultList'), 'keydown', function (e) {
      if (e.key !== 'Enter') return;
      var input = e.target.closest('[data-act="score"]');
      if (!input) return;
      e.preventDefault();
      input.blur();
    });

    // 名单列表操作
    on(document.getElementById('rosterList'), 'click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var id = btn.dataset.id;
      var p = state.people.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      if (btn.dataset.act === 'delperson') {
        if (!confirm('从名单中删除「' + p.name + '」？')) return;
        state.people = state.people.filter(function (x) { return x.id !== id; });
        state.tasks.forEach(function (t) {
          delete t.status[id];
          delete t.notes[id];
          if (t.scores) delete t.scores[id];
        });
        save(); renderAll();
      } else if (btn.dataset.act === 'editpy') {
        var ix = idxOf(p);
        var v = prompt('修改「' + p.name + '」的拼音（逐字、空格或逗号分隔）\n留空则恢复自动拼音', Array.from(p.pyOverride || []).join(' ') || ix.mainFull);
        if (v === null) return;
        var arr = String(v).trim().split(/[\s,，]+/).filter(Boolean);
        p.pyOverride = arr.length === Array.from(p.name).length ? arr : [];
        p._idx = null;
        save(); renderAll();
        toast(p.pyOverride.length ? '已更新拼音' : '已恢复自动拼音');
      }
    });

    // 批量
    on(document.getElementById('btnBatchDone'), 'click', function () {
      var task = currentTask();
      var list = currentResults();
      if (!list.length) { toast('当前没有可标记的人'); return; }
      if (!confirm('将「' + task.title + '」中当前筛选出的 ' + list.length + ' 人标记为已交？')) return;
      list.forEach(function (p) { task.status[p.id] = 'done'; });
      save(); renderResults(); renderStats();
      toast('已标记 ' + list.length + ' 人为已交');
    });
    on(document.getElementById('btnBatchReset'), 'click', function () {
      var task = currentTask();
      var scope = scopedPeople();
      var who = activeGroup ? groupLabel(activeGroup === '__none__' ? '' : activeGroup) : '全部';
      if (taskMode(task) === 'score') {
        if (!confirm('清空「' + task.title + '」中「' + who + '」的分数？名单不会变。')) return;
        scope.forEach(function (p) { delete task.scores[p.id]; });
      } else {
        if (!confirm('将「' + task.title + '」中「' + who + '」重置为未交？')) return;
        scope.forEach(function (p) { delete task.status[p.id]; });
      }
      save(); renderResults(); renderStats();
    });

    // 导出文本
    Array.prototype.forEach.call(document.querySelectorAll('input[name="sep"]'), function (r) {
      on(r, 'change', function () { renderExportText(); renderGroups(); });
    });
    // 分组卡片：单独复制某一组
    on(document.getElementById('groupList'), 'click', function (e) {
      var b = e.target.closest('[data-act="copygroup"]');
      if (!b) return;
      var t = groupText(b.dataset.g);
      copyText(t, t ? '已复制该分组名单' : '该分组暂无人');
    });
    on(document.getElementById('btnCopyText'), 'click', function () {
      var ta = document.getElementById('exportText');
      if (!ta.value) { toast('名单为空'); return; }
      copyText(ta.value, '已复制全部分组名单');
    });
    on(document.getElementById('btnExportGroupXlsx'), 'click', exportGroupXlsx);
    on(document.getElementById('btnExportAllXlsx'), 'click', exportAllXlsx);

    // 备份与恢复
    on(document.getElementById('btnSaveFile'), 'click', saveManual);
    on(document.getElementById('btnBackup'), 'click', function () {
      var blob = new Blob([JSON.stringify(state, function (k, v) { return k === '_idx' ? undefined : v; }, 2)], { type: 'application/json' });
      download('资料收集备份_' + todayStr() + '.json', blob);
    });
    on(document.getElementById('btnRestore'), 'click', function () { document.getElementById('backupFile').click(); });
    on(document.getElementById('backupFile'), 'change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var s = JSON.parse(e.target.result);
          if (!s || !Array.isArray(s.people) || !Array.isArray(s.tasks)) throw new Error('格式不正确');
          if (!confirm('恢复备份将覆盖当前所有数据，确定继续？')) return;
          migrate(s);
          state = s;
          ensureTask();
          state.people.forEach(function (p) { p._idx = null; });
          save(); renderAll();
          toast('备份已恢复');
        } catch (err) {
          toast('恢复失败：' + err.message);
        }
      };
      reader.readAsText(file, 'utf-8');
      this.value = '';
    });

    renderAll();
    booted = true;
    updateStoreStatus(true);
    setTimeout(function () { document.getElementById('q').focus(); }, 100);
  }
})();
