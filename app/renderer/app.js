
/* LB-M1Pro 配置 UI — v0.2.0 */
(function () {
  'use strict';
  const { M1Pro, DPISET, KEYFUN, KEYS, kbCode, macroCode, HID, MODBIT, hex, sleep } = window.M1P;
  const mouse = new M1Pro();

  const DEF_DPI = [600, 1200, 2400, 4800];
  const DEF_COLORS = [[255,0,0],[255,255,0],[0,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255],[255,128,0]];

  const state = {
    dpiCount: 4,
    dpi: DEF_DPI.slice(),
    colors: DEF_COLORS.map((c) => c.slice()),
    cur: 2,
    rate: 500,
    keys: KEYS.map((k) => ({ ...k, funId: k.def, code: findCode(k.def) })),
    selKey: 0,
    funTab: 'mouse',
    lod: 1,
    sleep: 3,
    lightOff: false,
    wake: true,
    ripple: false,
    angle: false,
    motion: false,
    perf: false,
    macros: [],
    selMacro: -1,
    recording: false,
    lastTs: 0,
    macroMode: '20',
  };

  let saveTimer = null;
  let appliedOnce = false;
  let ready = false;

  function findCode(id) {
    for (const g of Object.values(KEYFUN)) {
      const f = g.find((x) => x.id === id);
      if (f) return f.code.slice();
    }
    return [0x20, 0x01, 0x00];
  }
  function findName(id) {
    for (const g of Object.values(KEYFUN)) {
      const f = g.find((x) => x.id === id);
      if (f) return f.name;
    }
    if (id && id.startsWith('kb:')) return id.slice(3);
    if (id && id.startsWith('mac:')) {
      const m = state.macros.find((x) => x.id === id);
      return m ? `宏 · ${m.name}` : '宏';
    }
    return id || '—';
  }

  function snapshot() {
    return {
      version: 2,
      dpiCount: state.dpiCount,
      dpi: state.dpi.slice(0, state.dpiCount),
      colors: state.colors.slice(0, state.dpiCount).map((c) => c.slice()),
      cur: state.cur,
      rate: state.rate,
      keys: state.keys.map((k) => ({ n: k.n, name: k.name, matrix: k.matrix, funId: k.funId, code: k.code.slice() })),
      lod: state.lod,
      sleep: state.sleep,
      lightOff: state.lightOff,
      wake: state.wake,
      ripple: state.ripple,
      angle: state.angle,
      motion: state.motion,
      perf: state.perf,
      macros: state.macros.map((m) => ({
        id: m.id, name: m.name, bufferId: m.bufferId,
        actions: m.actions.map((a) => ({ ...a })),
      })),
      macroMode: state.macroMode || ($('#macroMode') && $('#macroMode').value) || '20',
    };
  }

  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return;
    if (s.dpiCount) state.dpiCount = Math.max(1, Math.min(6, s.dpiCount | 0));
    if (Array.isArray(s.dpi)) state.dpi = s.dpi.slice(0, state.dpiCount);
    while (state.dpi.length < state.dpiCount) state.dpi.push(800);
    if (Array.isArray(s.colors)) state.colors = s.colors.map((c) => c.slice());
    while (state.colors.length < state.dpiCount) state.colors.push(DEF_COLORS[state.colors.length % DEF_COLORS.length].slice());
    if (s.cur) state.cur = Math.max(1, Math.min(state.dpiCount, s.cur | 0));
    if (s.rate) state.rate = s.rate;
    if (Array.isArray(s.keys) && s.keys.length) {
      state.keys = KEYS.map((base, i) => {
        const k = s.keys.find((x) => x.n === base.n) || s.keys[i] || {};
        const funId = k.funId || base.def;
        const code = Array.isArray(k.code) && k.code.length === 3 ? k.code.slice() : findCode(funId);
        return { ...base, funId, code };
      });
    }
    if (s.lod != null) state.lod = s.lod;
    if (s.sleep != null) state.sleep = s.sleep;
    ['lightOff', 'wake', 'ripple', 'angle', 'motion', 'perf'].forEach((k) => {
      if (typeof s[k] === 'boolean') state[k] = s[k];
    });
    if (Array.isArray(s.macros)) state.macros = s.macros;
    if (s.macroMode) state.macroMode = s.macroMode;
  }

  function scheduleSave() {
    if (!ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const data = snapshot();
      if (window.shell && window.shell.saveSettings) {
        window.shell.saveSettings(data).catch(() => {});
      } else {
        try { localStorage.setItem('lb-m1pro-settings', JSON.stringify(data)); } catch (_) {}
      }
    }, 250);
  }

  async function loadPersisted() {
    let s = null;
    if (window.shell && window.shell.loadSettings) {
      try { s = await window.shell.loadSettings(); } catch (_) {}
    }
    if (!s) {
      try { s = JSON.parse(localStorage.getItem('lb-m1pro-settings') || 'null'); } catch (_) {}
    }
    if (s) applySnapshot(s);
  }

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  function toast(msg, ok = true) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (ok ? 'ok' : 'err');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function rgbHex(c) { return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join(''); }
  function hexRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h);
    if (!m) return [255, 0, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function needConn() {
    if (!mouse.connected) { toast('请先连接鼠标', false); return false; }
    return true;
  }
  async function safe(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg, true);
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), false);
      logLine('err', e.message || String(e));
    }
  }

  $('#wMin').onclick = () => window.shell && window.shell.win('min');
  $('#wMax').onclick = () => window.shell && window.shell.win('max');
  $('#wClose').onclick = () => window.shell && window.shell.win('close');

  $$('.nav').forEach((btn) => (btn.onclick = () => {
    $$('.nav').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + btn.dataset.tab));
  }));

  $('#btnConnect').onclick = () => safe(async () => {
    if (mouse.connected) { await mouse.disconnect(); return; }
    await mouse.connect(true);
    await refreshInfo();
    await autoApplyOnce();
  });

  mouse.addEventListener('connect', () => updateConn(true));
  mouse.addEventListener('disconnect', () => { updateConn(false); appliedOnce = false; });

  function updateConn(on) {
    const c = $('#conn');
    c.classList.toggle('on', on);
    $('#connText').textContent = on ? (mouse.wireless ? '2.4G 已连接' : 'USB 已连接') : '未连接';
    $('#connFlag').src = mouse.wireless ? 'assets/flag_24g.svg' : 'assets/flag_usb.svg';
    $('#btnConnect').textContent = on ? '断开' : '连接鼠标';
  }

  async function refreshInfo() {
    if (!mouse.connected) return;
    const info = await mouse.getInfo();
    $('#statFw').textContent = '0x' + info.fw.toString(16);
    $('#heroSub').textContent = `${info.sensor} · Identify ${info.identifyOk ? 'OK' : info.identify}`;
    if (info.dpiLevel) { state.cur = info.dpiLevel; renderStages(); syncHero(); scheduleSave(); }
    setBattery(info.battery, info.charging, info.online);
    pollBatt();
  }
  function setBattery(pct, charging, online) {
    if (online === 0 && mouse.wireless) {
      $('#battText').textContent = '离线';
      $('#battFill').style.width = '0%';
      return;
    }
    const p = Math.max(0, Math.min(100, pct | 0));
    $('#battFill').style.width = p + '%';
    $('#battFill').style.background = p < 20
      ? 'linear-gradient(90deg,#e45757,#ff8a8a)'
      : p < 50 ? 'linear-gradient(90deg,#f5b942,#ffe066)' : '';
    $('#battText').textContent = p + '%';
    $('#batt').classList.toggle('charging', !!charging);
  }
  let battTimer;
  function pollBatt() {
    clearInterval(battTimer);
    battTimer = setInterval(() => {
      if (mouse.connected) {
        mouse.getInfo().then((i) => setBattery(i.battery, i.charging, i.online)).catch(() => {});
      }
    }, 15000);
  }

  async function applyAllToDevice() {
    await mouse.setDPI(state.dpi.slice(0, state.dpiCount), state.cur);
    await sleep(50);
    await mouse.setDPIColors(state.colors.slice(0, state.dpiCount));
    await sleep(50);
    await mouse.setRate(state.rate);
    await sleep(40);
    if (!state.keys.some((k) => k.funId === 'left')) throw new Error('请保留至少一个键为“左键”功能');
    for (const k of state.keys) {
      if (k.funId && k.funId.startsWith('mac:')) {
        const m = state.macros.find((x) => x.id === k.funId);
        if (m) {
          await mouse.writeMacro(m.bufferId, m.actions);
          await sleep(50);
          k.code = macroCode(m.bufferId, parseInt($('#macroMode').value, 16), 1);
        }
      }
      await mouse.setKey(k.matrix, k.code);
      await sleep(40);
    }
    await mouse.setLOD(state.lod); await sleep(40);
    await mouse.setSleep(state.sleep, state.lightOff); await sleep(40);
    await mouse.setWake(state.wake); await sleep(30);
    await mouse.setRipple(state.ripple); await sleep(30);
    await mouse.setAngleSnap(state.angle); await sleep(30);
    await mouse.setMotionSync(state.motion); await sleep(30);
    await mouse.setHighPerf(state.perf);
  }

  async function autoApplyOnce() {
    if (appliedOnce || !mouse.connected) return;
    appliedOnce = true;
    try {
      await applyAllToDevice();
      toast('已自动应用已保存的配置到鼠标');
    } catch (e) {
      appliedOnce = false;
      toast('自动应用失败：' + (e.message || e), false);
    }
  }

  function renderDpiCount() {
    const el = $('#dpiCount'); el.innerHTML = '';
    [1, 2, 3, 4, 5, 6].forEach((n) => {
      const b = document.createElement('button');
      b.textContent = n;
      if (n === state.dpiCount) b.className = 'on';
      b.onclick = () => {
        state.dpiCount = n;
        while (state.dpi.length < n) {
          state.dpi.push(DPISET[Math.min(DPISET.length - 1, state.dpi.length * 2)] || 800);
          state.colors.push(DEF_COLORS[state.dpi.length % DEF_COLORS.length].slice());
        }
        state.dpi = state.dpi.slice(0, n);
        state.colors = state.colors.slice(0, n);
        if (state.cur > n) state.cur = n;
        renderDpiCount(); renderStages(); syncHero(); scheduleSave();
      };
      el.appendChild(b);
    });
  }
  function renderStages() {
    const el = $('#stages'); el.innerHTML = '';
    for (let i = 0; i < state.dpiCount; i++) {
      const s = document.createElement('div');
      s.className = 'stage' + (state.cur === i + 1 ? ' cur' : '');
      s.innerHTML = `<div class="chip" style="background:${rgbHex(state.colors[i])}"></div>
        <div class="idx">档位 ${i + 1}${state.cur === i + 1 ? ' · 当前' : ''}</div>
        <div class="val">${state.dpi[i]}</div>
        <input type="range" min="0" max="${DPISET.length - 1}" value="${Math.max(0, DPISET.indexOf(state.dpi[i]))}">
        <input type="color" class="color" value="${rgbHex(state.colors[i])}">`;
      s.querySelector('input[type=range]').oninput = (e) => {
        state.dpi[i] = DPISET[+e.target.value];
        s.querySelector('.val').textContent = state.dpi[i];
        if (state.cur === i + 1) syncHero();
        scheduleSave();
      };
      s.querySelector('input[type=color]').oninput = (e) => {
        state.colors[i] = hexRgb(e.target.value);
        s.querySelector('.chip').style.background = e.target.value;
        if (state.cur === i + 1) syncHero();
        scheduleSave();
        e.stopPropagation();
      };
      s.onclick = (e) => {
        if (e.target.closest('input')) return;
        state.cur = i + 1;
        renderStages(); syncHero(); scheduleSave();
      };
      el.appendChild(s);
    }
  }
  function renderRate() {
    const el = $('#rateSeg'); el.innerHTML = '';
    [125, 250, 500, 1000].forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r;
      if (r === state.rate) b.className = 'on';
      b.onclick = () => { state.rate = r; renderRate(); syncHero(); scheduleSave(); };
      el.appendChild(b);
    });
  }
  function syncHero() {
    $('#statDpi').textContent = state.dpi[state.cur - 1] || '--';
    $('#statRate').textContent = state.rate;
    const c = state.colors[state.cur - 1] || [0, 169, 224];
    $('#heroGlow').style.background = `radial-gradient(circle,rgba(${c[0]},${c[1]},${c[2]},.35),transparent 70%)`;
  }
  $('#dpiReset').onclick = () => {
    state.dpiCount = 4; state.dpi = DEF_DPI.slice();
    state.colors = DEF_COLORS.slice(0, 4).map((c) => c.slice());
    state.cur = 2; state.rate = 500;
    renderDpiCount(); renderStages(); renderRate(); syncHero(); scheduleSave();
  };
  $('#dpiApply').onclick = () => {
    if (!needConn()) return;
    safe(async () => {
      await mouse.setDPI(state.dpi.slice(0, state.dpiCount), state.cur);
      await sleep(50); await mouse.setDPIColors(state.colors.slice(0, state.dpiCount));
      await sleep(50); await mouse.setRate(state.rate);
      scheduleSave();
    }, 'DPI / 回报率已写入');
  };

  function renderKeys() {
    const el = $('#keyList'); el.innerHTML = '';
    state.keys.forEach((k, i) => {
      const d = document.createElement('div');
      d.className = 'keyitem' + (state.selKey === i ? ' on' : '');
      d.innerHTML = `<div class="num">${k.n}</div><div class="meta"><b>${k.name}</b><span>${findName(k.funId)}</span></div>`;
      d.onclick = () => { state.selKey = i; renderKeys(); renderFun(); };
      el.appendChild(d);
    });
  }
  const FUN_TABS = [
    { id: 'mouse', name: '鼠标' }, { id: 'dpi', name: 'DPI/灯光键' }, { id: 'media', name: '多媒体' },
    { id: 'kb', name: '键盘' }, { id: 'macro', name: '宏' }, { id: 'other', name: '其它' },
  ];
  function renderFun() {
    const tabs = $('#funTabs'); tabs.innerHTML = '';
    FUN_TABS.forEach((t) => {
      const b = document.createElement('button');
      b.textContent = t.name;
      if (t.id === state.funTab) b.className = 'on';
      b.onclick = () => { state.funTab = t.id; renderFun(); };
      tabs.appendChild(b);
    });
    const body = $('#funBody'); body.innerHTML = '';
    const cur = state.keys[state.selKey];
    if (state.funTab === 'kb') {
      const cap = document.createElement('div');
      cap.className = 'kb-capture'; cap.tabIndex = 0;
      cap.textContent = '点击此处后按下想要的单键或组合键…';
      cap.onkeydown = (e) => {
        e.preventDefault(); e.stopPropagation();
        let mods = 0, key = null;
        if (e.ctrlKey) mods |= 0x01; if (e.shiftKey) mods |= 0x02;
        if (e.altKey) mods |= 0x04; if (e.metaKey) mods |= 0x08;
        if (HID[e.code] && !(e.code in MODBIT)) key = HID[e.code];
        if (!key) { toast('请输入一个有效按键', false); return; }
        const label = (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + (e.metaKey ? 'Win+' : '') + (e.key.length === 1 ? e.key.toUpperCase() : e.code);
        cur.funId = 'kb:' + label; cur.code = kbCode(mods, key);
        renderKeys(); renderFun(); scheduleSave(); toast('已指派：' + label);
      };
      body.appendChild(cap); setTimeout(() => cap.focus(), 30); return;
    }
    if (state.funTab === 'macro') {
      if (!state.macros.length) {
        body.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);padding:20px;text-align:center">暂无宏，请先到“宏”页创建</div>';
        return;
      }
      state.macros.forEach((m) => {
        const b = document.createElement('button');
        b.className = 'fun' + (cur.funId === m.id ? ' on' : '');
        b.textContent = m.name;
        b.onclick = () => {
          cur.funId = m.id;
          cur.code = macroCode(m.bufferId, parseInt($('#macroMode').value, 16), 1);
          renderKeys(); renderFun(); scheduleSave();
        };
        body.appendChild(b);
      });
      return;
    }
    let list = state.funTab === 'dpi' ? [...KEYFUN.dpi, ...KEYFUN.light] : (KEYFUN[state.funTab] || []);
    list.forEach((f) => {
      const b = document.createElement('button');
      b.className = 'fun' + (cur.funId === f.id ? ' on' : '');
      b.innerHTML = f.name + (f.exp ? '<span class="exp">实验性</span>' : '');
      b.onclick = () => { cur.funId = f.id; cur.code = f.code.slice(); renderKeys(); renderFun(); scheduleSave(); };
      body.appendChild(b);
    });
  }
  $('#keyReset').onclick = () => {
    state.keys = KEYS.map((k) => ({ ...k, funId: k.def, code: findCode(k.def) }));
    renderKeys(); renderFun(); scheduleSave();
  };
  $('#keyApply').onclick = () => {
    if (!needConn()) return;
    safe(async () => {
      if (!state.keys.some((k) => k.funId === 'left')) { toast('请保留至少一个键为“左键”功能', false); return; }
      for (const k of state.keys) {
        if (k.funId && k.funId.startsWith('mac:')) {
          const m = state.macros.find((x) => x.id === k.funId);
          if (m) {
            await mouse.writeMacro(m.bufferId, m.actions); await sleep(50);
            k.code = macroCode(m.bufferId, parseInt($('#macroMode').value, 16), 1);
          }
        }
        await mouse.setKey(k.matrix, k.code); await sleep(40);
      }
      scheduleSave();
    }, '按键指派已写入');
  };

  function renderMacros() {
    const ul = $('#macroList'); ul.innerHTML = '';
    state.macros.forEach((m, i) => {
      const li = document.createElement('li');
      li.className = state.selMacro === i ? 'on' : '';
      li.innerHTML = `<span>${m.name}</span><small style="color:var(--muted)">#${m.bufferId}</small>`;
      li.onclick = () => selectMacro(i);
      ul.appendChild(li);
    });
    const on = state.selMacro >= 0;
    $('#macroName').disabled = !on; $('#macroDel').disabled = !on;
    $('#recBtn').disabled = !on; $('#macroWrite').disabled = !on;
    if (on) {
      const m = state.macros[state.selMacro];
      $('#macroName').value = m.name;
      renderActions(m);
    } else {
      $('#macroName').value = '';
      $('#actionList').innerHTML = '';
    }
  }
  function selectMacro(i) { state.selMacro = i; renderMacros(); }
  function renderActions(m) {
    const el = $('#actionList');
    if (!m.actions.length) {
      el.innerHTML = '<div style="color:var(--muted)">暂无动作。点击“开始录制”后在此窗口按键。</div>';
      return;
    }
    el.innerHTML = m.actions.map((a, i) =>
      `<div><span>${String(i + 1).padStart(3, '0')}</span><span>${a.down ? '按下' : '松开'}</span><span>${a.label}</span><span>${a.delay}ms</span></div>`
    ).join('');
  }
  $('#macroNew').onclick = () => {
    if (state.macros.length >= 10) { toast('宏数量已达上限 10', false); return; }
    const used = new Set(state.macros.map((m) => m.bufferId));
    let bid = 1; while (used.has(bid) && bid <= 10) bid++;
    state.macros.push({ id: 'mac:' + Date.now(), name: '新建宏 ' + (state.macros.length + 1), bufferId: bid, actions: [] });
    selectMacro(state.macros.length - 1); scheduleSave();
  };
  $('#macroDel').onclick = () => {
    if (state.selMacro < 0) return;
    state.macros.splice(state.selMacro, 1); state.selMacro = -1;
    renderMacros(); scheduleSave();
  };
  $('#macroName').onchange = (e) => {
    if (state.selMacro >= 0) state.macros[state.selMacro].name = e.target.value || '未命名';
    renderMacros(); scheduleSave();
  };
  $('#macroMode').onchange = () => { state.macroMode = $('#macroMode').value; scheduleSave(); };
  $('#recBtn').onclick = () => {
    if (state.selMacro < 0) return;
    state.recording = !state.recording;
    const btn = $('#recBtn');
    btn.classList.toggle('on', state.recording);
    btn.innerHTML = state.recording ? '<span class="rec-dot"></span>停止录制' : '<span class="rec-dot"></span>开始录制';
    state.lastTs = performance.now();
    if (state.recording) {
      state.macros[state.selMacro].actions = [];
      renderActions(state.macros[state.selMacro]);
      $('#recZone').focus();
      toast('正在录制，请在此窗口按键');
    } else scheduleSave();
  };
  function onRecKey(e) {
    if (!state.recording || state.selMacro < 0) return;
    if (e.target.closest && e.target.closest('input,textarea,select,.hex')) return;
    e.preventDefault();
    const m = state.macros[state.selMacro];
    if (m.actions.length >= 158) { toast('动作数已达上限', false); return; }
    const mode = document.querySelector('input[name=delayMode]:checked').value;
    const now = performance.now();
    let delay = mode === 'fixed' ? (+$('#fixedDelay').value || 0) : Math.round(now - state.lastTs);
    if (m.actions.length === 0) delay = 0;
    delay = Math.max(0, Math.min(4095, delay));
    state.lastTs = now;
    let type = 3, code = 0, label = e.code;
    if (e.code in MODBIT) { type = 2; code = MODBIT[e.code]; label = e.code.replace('Left', '').replace('Right', 'R'); }
    else if (HID[e.code]) { type = 3; code = HID[e.code]; }
    else return;
    if (e.type === 'keydown' && e.repeat) return;
    m.actions.push({ type, code, delay, down: e.type === 'keydown', label: (e.type === 'keydown' ? '↓' : '↑') + label });
    renderActions(m);
  }
  window.addEventListener('keydown', onRecKey, true);
  window.addEventListener('keyup', onRecKey, true);
  $('#recZone').onmousedown = (e) => {
    if (!state.recording || state.selMacro < 0) return;
    e.preventDefault();
    const bits = { 0: 0x01, 1: 0x04, 2: 0x02 }[e.button];
    if (!bits) return;
    const m = state.macros[state.selMacro];
    const mode = document.querySelector('input[name=delayMode]:checked').value;
    const now = performance.now();
    let delay = mode === 'fixed' ? (+$('#fixedDelay').value || 0) : Math.round(now - state.lastTs);
    if (m.actions.length === 0) delay = 0;
    state.lastTs = now;
    m.actions.push({ type: 1, code: bits, delay: Math.min(4095, delay), down: true, label: '↓鼠标' + e.button });
    renderActions(m);
  };
  $('#recZone').onmouseup = (e) => {
    if (!state.recording || state.selMacro < 0) return;
    const bits = { 0: 0x01, 1: 0x04, 2: 0x02 }[e.button];
    if (!bits) return;
    const m = state.macros[state.selMacro];
    const now = performance.now();
    const delay = Math.min(4095, Math.round(now - state.lastTs));
    state.lastTs = now;
    m.actions.push({ type: 1, code: bits, delay, down: false, label: '↑鼠标' + e.button });
    renderActions(m);
  };
  $('#macroWrite').onclick = () => {
    if (!needConn() || state.selMacro < 0) return;
    safe(async () => {
      const m = state.macros[state.selMacro];
      await mouse.writeMacro(m.bufferId, m.actions);
      scheduleSave();
    }, `宏「${state.macros[state.selMacro].name}」已写入缓冲区 #${state.macros[state.selMacro].bufferId}`);
  };

  function renderLod() {
    const el = $('#lodSeg'); el.innerHTML = '';
    [{ v: 1, t: '1 mm' }, { v: 2, t: '2 mm' }].forEach((o) => {
      const b = document.createElement('button');
      b.textContent = o.t;
      if (o.v === state.lod) b.className = 'on';
      b.onclick = () => { state.lod = o.v; renderLod(); scheduleSave(); };
      el.appendChild(b);
    });
  }
  function syncAdvControls() {
    $('#sleepTime').value = String(state.sleep);
    $('#tLightOff').checked = !!state.lightOff;
    $('#tWake').checked = !!state.wake;
    $('#tRipple').checked = !!state.ripple;
    $('#tAngle').checked = !!state.angle;
    $('#tMotion').checked = !!state.motion;
    $('#tPerf').checked = !!state.perf;
    if (state.macroMode) $('#macroMode').value = state.macroMode;
  }
  ['sleepTime', 'tLightOff', 'tWake', 'tRipple', 'tAngle', 'tMotion', 'tPerf'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      state.sleep = +$('#sleepTime').value;
      state.lightOff = $('#tLightOff').checked;
      state.wake = $('#tWake').checked;
      state.ripple = $('#tRipple').checked;
      state.angle = $('#tAngle').checked;
      state.motion = $('#tMotion').checked;
      state.perf = $('#tPerf').checked;
      scheduleSave();
    });
  });
  $('#advApply').onclick = () => {
    if (!needConn()) return;
    safe(async () => {
      state.sleep = +$('#sleepTime').value;
      state.lightOff = $('#tLightOff').checked;
      state.wake = $('#tWake').checked;
      state.ripple = $('#tRipple').checked;
      state.angle = $('#tAngle').checked;
      state.motion = $('#tMotion').checked;
      state.perf = $('#tPerf').checked;
      await mouse.setLOD(state.lod); await sleep(50);
      await mouse.setSleep(state.sleep, state.lightOff); await sleep(50);
      await mouse.setWake(state.wake); await sleep(40);
      await mouse.setRipple(state.ripple); await sleep(40);
      await mouse.setAngleSnap(state.angle); await sleep(40);
      await mouse.setMotionSync(state.motion); await sleep(40);
      await mouse.setHighPerf(state.perf);
      scheduleSave();
    }, '高级设置已写入（实验性）');
  };

  function logLine(dir, text, data) {
    const pre = $('#log');
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const extra = data ? '  ' + hex(data) : '';
    pre.insertAdjacentHTML('beforeend', `<span class="${dir}">[${t}] ${text}${extra}</span>\n`);
    pre.scrollTop = pre.scrollHeight;
  }
  mouse.addEventListener('log', (e) => logLine(e.detail.dir, e.detail.text, e.detail.data));
  $('#rawClear').onclick = () => { $('#log').textContent = ''; };
  $('#rawSend').onclick = () => {
    if (!needConn()) return;
    safe(async () => {
      const r = await mouse.raw($('#rawHex').value, { framed: $('#rawFramed').checked, reply: true });
      if (r) toast('已发送，状态=' + r.status);
    });
  };
  $('#rawRead').onclick = () => { if (!needConn()) return; safe(async () => { await mouse.readFeatureRaw(); }); };
  $('#rawInfo').onclick = () => {
    if (!needConn()) return;
    safe(async () => {
      const i = await mouse.getInfo();
      toast(`电量 ${i.battery}% · 档位 ${i.dpiLevel} · ${i.sensor} · fw 0x${i.fw.toString(16)}`);
      setBattery(i.battery, i.charging, i.online);
    });
  };

  $('#btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lb-m1pro-config.json';
    a.click();
  };
  $('#btnImport').onclick = () => $('#fileImport').click();
  $('#fileImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      applySnapshot(j.state || j);
      renderAll();
      scheduleSave();
      toast('配置已导入');
    } catch (err) {
      toast('导入失败：' + err.message, false);
    }
  };

  function renderAll() {
    renderDpiCount(); renderStages(); renderRate(); syncHero();
    renderKeys(); renderFun(); renderMacros(); renderLod(); syncAdvControls();
  }

  (async function boot() {
    await loadPersisted();
    renderAll();
    ready = true;
    if (window.shell && window.shell.getVersion) {
      try {
        const v = await window.shell.getVersion();
        $('#verLabel').textContent = 'v' + v + ' · 非官方';
      } catch (_) {}
    }
    if (mouse.supported) {
      mouse.connect(false).then(async () => {
        await refreshInfo();
        await autoApplyOnce();
      }).catch(() => {});
    } else {
      toast('当前环境不支持 WebHID（请使用本 Electron 应用）', false);
    }
  })();
})();
