/*
 * LB-M1Pro HID 协议实现（WebHID）
 * ------------------------------------------------------------
 * 来源：对官方驱动 CBMouse.exe（v0x102）的静态逆向（Ghidra 12.1.4 反编译/反汇编），
 * 类 CDevSprime（MS.ini 未设置 Protocol，默认值 1 => CDevSprime，"nFw"=1 分支）。
 * 详见 /workspace/m1pro/PROTOCOL.md。
 *
 * 置信度标记：
 *   [已确认-二进制]  直接从反汇编中读出的字节布局/命令号
 *   [推断]          由代码结构推断出的含义（字节位置确定，但语义/取值范围未在实机验证）
 *   [未验证]        合理猜测，必须实机抓包/测试确认
 * 所有写入在实机验证前都应视为“实验性”。
 * 灯光(SetLED 0x08)配置页已从本应用移除（与官方 ShowLED=0 一致）；按键上的「开关灯/灯效切换」指派仍保留。
 */
(function (global) {
  'use strict';

  const REPORT_ID = 0x0f;            // [已确认-二进制] HidD_SetFeature/GetFeature 缓冲区首字节 0x0F
  const REPORT_LEN = 0x21;           // [已确认-二进制] 33 字节（含 ReportID）
  const PAYLOAD_MAX = 26;            // [已确认-二进制] SendPackage: nBytesToWrite <= 0x1A
  const VID = 0x088d, PID_WIRED = 0x052e, PID_WIRELESS = 0x052f; // [已确认-MS.ini]

  // 命令号  [已确认-二进制]：均来自 CDevSprime::ApplySetting / GetDeviceInfo 调用点的立即数
  const CMD = {
    SET_MATRIX: 0x01,   // 整体按键矩阵（多包, 每键3字节）。仅 nFw==2 使用，本鼠标不用
    SET_KEY: 0x04,      // 单键指派 len=4
    SET_DPI: 0x05,      // DPI 档位 len=0x12
    SET_DPI_COLOR: 0x06,// DPI 档位颜色 len=0x18
    SET_RATE: 0x07,     // 回报率 len=1
    SET_LOD: 0x09,      // 静默高度 len=2
    SET_DEBOUNCE: 0x0a, // 按键去抖 len=1（仅当 AVT 类型 4 存在时官方才发送；本鼠标 AVT=1,2,5）
    SET_SLEEP: 0x0b,    // 休眠时间 + 移动时关灯 len=2
    SET_WAKE: 0x0c,     // 移动唤醒 len=1
    SET_MACRO: 0x0e,    // 宏数据（多包）
    RESET: 0x0f,        // 恢复出厂 —— 危险，已在本程序中禁止
    SET_RIPPLE: 0x10,   // 纹波控制 len=1
    SET_ANGLE: 0x11,    // 角度捕捉 len=1
    SET_MOTION: 0x12,   // 动作同步 len=1
    SET_PERF: 0x13,     // Sensor 高性能模式 (nEfficiencyMode) len=1
    GET_INFO: 0x30,     // 读取设备信息（电量/在线/固件/当前DPI档）
  };
  const BLOCKED_CMDS = new Set([CMD.RESET]);

  // 回报率编码 [已确认-二进制] (SetRate: 0x125->8, 0x250->4, 0x500->2, 0x1000->1, 0x2000->0x10, 0x4000->0x20)
  const RATE_CODE = { 125: 0x08, 250: 0x04, 500: 0x02, 1000: 0x01, 2000: 0x10, 4000: 0x20 };

  // MS.ini [Sensor1] DPISET；DPIHW 未配置时官方用 “索引+1” 作为硬件值 [已确认-二进制]
  const DPISET = [200,300,400,500,600,700,800,900,1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,2000,2100,2200,2300,2400,2500,2600,2700,2800,2900,3000,3100,3200,3300,3400,3500,3600,3700,3800,3900,4000,4100,4200,4300,4400,4500,4600,4700,4800,4900,5000,5500,6000,6400,7000,7500,8000,8500,9000,9500,10000];
  const dpiToHw = (dpi) => { const i = DPISET.indexOf(dpi); return i < 0 ? 0 : i + 1; };
  const hwToDpi = (hw) => DPISET[hw - 1] || 0;

  const SENSOR = { 0x11: 'PAW3311', 0x25: 'PAW3325', 0x35: 'PAW3335', 0x95: 'PAW3395' }; // [已确认-二进制] FUN_00416f60

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

  class M1Pro extends EventTarget {
    constructor() {
      super();
      this.devices = [];      // 同一鼠标的所有 HID 接口
      this.ctrl = null;       // 含 Feature Report 0x0F 的接口（UsagePage 0xFF00 / Usage 0x01）
      this.seq = 1;           // [已确认-二进制] 每包递增的序号（CDevSprime+0x28C，初值1）
      this.busy = Promise.resolve();
      this.wireless = false;
    }

    log(dir, text, data) { this.dispatchEvent(new CustomEvent('log', { detail: { dir, text, data, t: new Date() } })); }

    get supported() { return !!(navigator && navigator.hid); }
    get connected() { return !!this.ctrl && this.ctrl.opened; }

    static filters() {
      return [
        { vendorId: VID, productId: PID_WIRED },
        { vendorId: VID, productId: PID_WIRELESS },
        { vendorId: 0x089d, productId: 0x053f }, // [未验证] 二进制硬编码的备用 ID
      ];
    }

    async connect(interactive = true) {
      if (!this.supported) throw new Error('当前环境不支持 WebHID');
      let devs = await navigator.hid.getDevices();
      devs = devs.filter((d) => M1Pro.filters().some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
      if (!devs.length && interactive) devs = await navigator.hid.requestDevice({ filters: M1Pro.filters() });
      if (!devs.length) throw new Error('未找到 LB-M1Pro（VID 088D / PID 052E 或 052F）');
      // 只保留同一 productId 的接口；有线优先
      const pid = devs.some((d) => d.productId === PID_WIRED) ? PID_WIRED : devs[0].productId;
      this.devices = devs.filter((d) => d.productId === pid);
      this.wireless = pid === PID_WIRELESS;
      for (const d of this.devices) {
        if (!d.opened) { try { await d.open(); } catch (e) { this.log('err', `打开接口失败: ${e.message}`); continue; } }
        d.oninputreport = (ev) => this._onInput(d, ev);
      }
      this.ctrl = this.devices.find((d) => d.opened && d.collections.some((c) => (c.featureReports || []).some((r) => r.reportId === REPORT_ID)))
        || this.devices.find((d) => d.opened && d.collections.some((c) => c.usagePage === 0xff00));
      if (!this.ctrl) throw new Error('找到设备，但没有找到包含 Feature Report 0x0F 的厂商接口');
      this.log('sys', `已连接 ${this.ctrl.productName || 'LB-M1Pro'}  PID=${pid.toString(16).padStart(4, '0')}  (${this.wireless ? '2.4G' : 'USB 有线'})`);
      this.devices.forEach((d, i) => d.collections.forEach((c) => this.log('sys',
        `接口${i} 集合 UsagePage=0x${c.usagePage.toString(16)} Usage=0x${c.usage.toString(16)} in=[${(c.inputReports||[]).map(r=>r.reportId)}] out=[${(c.outputReports||[]).map(r=>r.reportId)}] feature=[${(c.featureReports||[]).map(r=>r.reportId)}]`)));
      navigator.hid.addEventListener('disconnect', this._onDisc = (e) => {
        if (this.devices.includes(e.device)) { this.ctrl = null; this.devices = []; this.log('sys', '设备已断开'); this.dispatchEvent(new Event('disconnect')); }
      });
      this.dispatchEvent(new Event('connect'));
      return this.ctrl;
    }

    async disconnect() {
      for (const d of this.devices) { try { d.oninputreport = null; await d.close(); } catch (_) {} }
      this.devices = []; this.ctrl = null; this.dispatchEvent(new Event('disconnect'));
    }

    // 通知输入报告（16 字节接口）[推断] 来自 Sprime_ServiceThread/FUN_0045a290：
    //   buf[0]=ReportID, buf[1]∈{1,2}, buf[2]=1 => 值 buf[3]（推测为 DPI 档位/按键事件），buf[2]=2 => 在线状态 buf[15]
    _onInput(dev, ev) {
      const data = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
      const buf = new Uint8Array(data.length + 1); buf[0] = ev.reportId; buf.set(data, 1);
      this.log('in', `Input  RID=0x${ev.reportId.toString(16)} len=${data.length}`, data);
      if (buf[1] === 1 || buf[1] === 2) {
        if (buf[2] === 1) this.dispatchEvent(new CustomEvent('notify', { detail: { type: 'value', value: buf[3] } }));
        else if (buf[2] === 2) this.dispatchEvent(new CustomEvent('notify', { detail: { type: 'online', value: buf[15] } }));
      }
    }

    // ---- 底层收发 ------------------------------------------------------
    // SendPackage [已确认-二进制] (FUN_0045ac10)：
    //   [0]=0x0F [1]=有线?1:0 [2]=cmd [3]=0 [4]=seq++ [5]=(总包数&0xF)|(包序号<<4) [6]=len [7..32]=数据(≤26)
    //   无校验和。WebHID 的 sendFeatureReport 数据不含 ReportID，所以整体左移 1 字节。
    _frame(cmd, payload = [], total = 1, index = 0) {
      if (payload.length > PAYLOAD_MAX) throw new Error('payload > 26');
      const d = new Uint8Array(REPORT_LEN - 1);
      d[0] = this.wireless ? 0 : 1;
      d[1] = cmd;
      d[2] = 0;
      d[3] = this.seq & 0xff; this.seq = (this.seq + 1) & 0xff;
      d[4] = (total & 0x0f) | ((index & 0x0f) << 4);
      d[5] = payload.length;
      d.set(payload, 6);
      return d;
    }

    async _sendFeature(d) {
      this.log('out', `SetFeature RID=0x0f`, d);
      await this.ctrl.sendFeatureReport(REPORT_ID, d);
    }

    // ReadPackage [已确认-二进制] (FUN_0045ade0)：GetFeature(0x0F,33)；[3]=状态 0=OK 1=忙(100ms后重试,最多3次) 2=离线；数据从 [7] 开始
    async _readFeature() {
      let last;
      for (let i = 0; i < 3; i++) {
        const dv = await this.ctrl.receiveFeatureReport(REPORT_ID);
        let r = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        if (r.length === REPORT_LEN - 1 || r[0] !== REPORT_ID) { const t = new Uint8Array(r.length + 1); t[0] = REPORT_ID; t.set(r, 1); r = t; }
        this.log('in', `GetFeature RID=0x0f status=${r[3]}`, r.subarray(1));
        last = { status: r[3], data: r.slice(7, 7 + PAYLOAD_MAX), raw: r };
        if (r[3] === 0) return last;
        if (r[3] === 2) { last.offline = true; return last; }
        await sleep(100);
      }
      return last;
    }

    _queue(fn) { const p = this.busy.then(fn, fn); this.busy = p.catch(() => {}); return p; }

    send(cmd, payload = [], { reply = true, total = 1, index = 0 } = {}) {
      if (BLOCKED_CMDS.has(cmd)) return Promise.reject(new Error(`命令 0x${cmd.toString(16)} 被禁止（危险操作）`));
      return this._queue(async () => {
        if (!this.connected) throw new Error('鼠标未连接');
        await this._sendFeature(this._frame(cmd, payload, total, index));
        if (!reply) return null;
        await sleep(25);                 // 官方 Sleep(0x19)
        const r = await this._readFeature();
        if (r && r.status === 1) throw new Error('设备忙请稍后重试');
        if (r && r.status === 2) throw new Error('鼠标已断开无线连接');
        return r;
      });
    }

    // 多包写入 [已确认-二进制] (FUN_0045af00 AccessData)：每包 26 字节，包间隔 20ms
    async sendMulti(cmd, bytes) {
      const total = Math.ceil(bytes.length / PAYLOAD_MAX);
      if (total > 15) throw new Error('数据太长（超过 15 包）');
      for (let i = 0; i < total; i++) {
        await sleep(20);
        await this.send(cmd, bytes.slice(i * PAYLOAD_MAX, (i + 1) * PAYLOAD_MAX), { total, index: i });
      }
    }

    // ---- 高层命令 ------------------------------------------------------
    // GetDeviceInfo 0x30 [已确认-二进制]：发送 len=0 且不等待回复，Sleep(15) 后 GetFeature。
    // 数据偏移（相对 data[0] = 报告字节[7]）：
    //   [0..3] 设备标识（与 MS.ini Identify=4d,35,33,36 比较）[已确认]
    //   [4] 固件版本低字节 [5] 高字节  [已确认]
    //   [8] Sensor 代码 (0x25=PAW3325)  [已确认]
    //   [9] 高4位 = 当前 DPI 档(从1起)   [已确认]
    //   [11] 电量 %   [12] 充电状态       [已确认（字段名来自日志字符串 nPower/nCharging）]
    //   [14] 无线在线 (bOnline)           [已确认]
    getInfo() {
      return this._queue(async () => {
        if (!this.connected) throw new Error('鼠标未连接');
        await this._sendFeature(this._frame(CMD.GET_INFO, []));
        await sleep(15);
        const r = await this._readFeature();
        const d = r.data;
        return {
          status: r.status,
          identify: hex(d.slice(0, 4)),
          identifyOk: d[0] === 0x4d && d[1] === 0x35 && d[2] === 0x33 && d[3] === 0x36,
          fw: (d[5] << 8) | d[4],
          sensor: SENSOR[d[8]] || `0x${d[8].toString(16)}`,
          dpiLevel: (d[9] >> 4) & 0x0f,
          battery: d[11],
          charging: d[12],
          online: r.status === 2 ? 0 : (this.wireless ? d[14] : 1),
          raw: d,
        };
      });
    }

    // SetDPI 0x05 len 18 [已确认-二进制]：
    //   [0]=(当前档(1起)<<4)|档数  [1]=(1<<档数)-1（启用掩码）  [2+2i],[3+2i]=第 i 档硬件值(LE)
    setDPI(stages, current) {
      const n = Math.max(1, Math.min(8, stages.length));
      const cur = Math.max(1, Math.min(n, current));
      const p = new Uint8Array(18);
      p[0] = (cur << 4) | (n & 0x0f);
      p[1] = ((1 << n) - 1) & 0xff;
      for (let i = 0; i < n; i++) { const hw = dpiToHw(stages[i]); p[2 + 2 * i] = hw & 0xff; p[3 + 2 * i] = hw >> 8; }
      return this.send(CMD.SET_DPI, p);
    }

    // SetDpiColor 0x06 len 24 [已确认-二进制]：每档 R,G,B
    setDPIColors(colors) {
      const p = new Uint8Array(24);
      colors.slice(0, 8).forEach((c, i) => { p[i * 3] = c[0]; p[i * 3 + 1] = c[1]; p[i * 3 + 2] = c[2]; });
      return this.send(CMD.SET_DPI_COLOR, p);
    }

    // SetRate 0x07 len 1 [已确认-二进制]
    setRate(hz) { const c = RATE_CODE[hz]; if (!c) return Promise.reject(new Error('无效回报率')); return this.send(CMD.SET_RATE, [c]); }

    // SetKey 0x04 len 4 [已确认-二进制]：[0]=矩阵索引（MS.ini K 行第4字段-1） [1..3]=3 字节硬件功能码
    setKey(matrixIndex, code3) { return this.send(CMD.SET_KEY, [matrixIndex, code3[0], code3[1], code3[2]]); }


    // 以下：命令号与长度 [已确认-二进制]，取值含义 [推断/未验证]
    setSleep(minutes, lightOffWhenMoving) { return this.send(CMD.SET_SLEEP, [minutes & 0xff, lightOffWhenMoving ? 1 : 0]); }
    setWake(on) { return this.send(CMD.SET_WAKE, [on ? 1 : 0]); }
    setRipple(on) { return this.send(CMD.SET_RIPPLE, [on ? 1 : 0]); }
    setAngleSnap(on) { return this.send(CMD.SET_ANGLE, [on ? 1 : 0]); }
    setMotionSync(on) { return this.send(CMD.SET_MOTION, [on ? 1 : 0]); }
    setHighPerf(on) { return this.send(CMD.SET_PERF, [on ? 1 : 0]); }
    // LOD: 官方发送 {1,2,3}[UI值]，即 1mm->2, 2mm->3（与 MS.ini LodHW=2,3 吻合）[推断]
    setLOD(mm) { return this.send(CMD.SET_LOD, [[1, 2, 3][mm] || 2, 0]); }
    setDebounce(ms) { return this.send(CMD.SET_DEBOUNCE, [ms & 0xff]); }

    // 宏 0x0E [已确认-二进制] (FUN_0045b0b0 + FUN_0045b140)：
    //   数据 = [缓冲区ID(1..10)] + 动作×3 字节；动作：
    //     b0 = (类型<<4) | (延时>>8 & 0xF) | (松开 ? 0x80 : 0)   类型: 1=鼠标键 2=修饰键 3=普通键
    //     b1 = 延时 & 0xFF  （毫秒，最大 4095）
    //     b2 = 鼠标键位掩码(1左 2右 4中 8后退 0x10前进) / 修饰键位(HID) / HID 键码
    //   官方未写结束标记/动作数，设备应通过包长度判断 [未验证]
    async writeMacro(bufferId, actions) {
      const bytes = [bufferId & 0xff];
      for (const a of actions) {
        const delay = Math.max(0, Math.min(0xfff, a.delay | 0));
        bytes.push(((a.type & 0x0f) << 4) | ((delay >> 8) & 0x0f) | (a.down ? 0 : 0x80), delay & 0xff, a.code & 0xff);
      }
      if (bytes.length > 15 * PAYLOAD_MAX) throw new Error('宏动作过多');
      await this.sendMulti(CMD.SET_MACRO, Uint8Array.from(bytes));
    }

    // 原始发送（调试面板）：hex = 完整 32 字节（不含 ReportID）或仅 [cmd payload...] 两种格式
    async raw(hexStr, { framed = false, reply = true } = {}) {
      const bytes = hexStr.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16));
      if (bytes.some((b) => isNaN(b) || b < 0 || b > 255)) throw new Error('十六进制格式错误');
      if (framed) {
        const d = new Uint8Array(REPORT_LEN - 1); d.set(bytes.slice(0, 32));
        if (BLOCKED_CMDS.has(d[1])) throw new Error('该命令被禁止（恢复出厂）');
        return this._queue(async () => { await this._sendFeature(d); if (reply) { await sleep(25); return this._readFeature(); } });
      }
      const [cmd, ...payload] = bytes;
      return this.send(cmd, payload, { reply });
    }

    async readFeatureRaw() { return this._queue(() => this._readFeature()); }
  }

  // ---- 按键功能码表 [已确认-二进制] FUN_00458500 (keyinfo_to_hardware_code) ----
  // 菜单 ID 与名称对应关系来自 FUN_004230a8（按键指派菜单）对 fun_ms* 字符串的引用
  const KEYFUN = {
    mouse: [
      { id: 'left',   name: '左键',   code: [0x20, 0x01, 0x00] },
      { id: 'right',  name: '右键',   code: [0x20, 0x02, 0x00] },
      { id: 'middle', name: '中键',   code: [0x20, 0x04, 0x00] },
      { id: 'fwd',    name: '前进',   code: [0x20, 0x10, 0x00] },
      { id: 'back',   name: '后退',   code: [0x20, 0x08, 0x00] },
      { id: 'triple', name: '三连发', code: [0x40, 0x32, 0x03] },
      { id: 'wup',    name: '上滚',   code: [0x30, 0x01, 0x00], exp: true }, // 内部ID 0x19 → 名称为推断
      { id: 'wdn',    name: '下滚',   code: [0x30, 0xff, 0x00], exp: true }, // 内部ID 0x1A → 名称为推断
    ],
    dpi: [
      { id: 'dpiup',   name: 'DPI +',   code: [0x50, 0x02, 0x00] },
      { id: 'dpidn',   name: 'DPI -',   code: [0x50, 0x03, 0x00] },
      { id: 'dpiloop', name: 'DPI循环', code: [0x50, 0x01, 0x00] },
    ],
    light: [
      { id: 'ledsw',  name: '开关灯',   code: [0x70, 0x01, 0x00] },
      { id: 'ledfx',  name: '灯效切换', code: [0x70, 0x04, 0x00] },
    ],
    other: [ { id: 'off', name: '禁用', code: [0x70, 0x00, 0x00] } ],
    // 多媒体：[0x90, usage低, usage高]（Consumer Page）
    media: [
      { id: 'm_pl',   name: '播放/暂停', code: [0x90, 0xcd, 0x00] },
      { id: 'm_stop', name: '停止播放',  code: [0x90, 0xb7, 0x00] },
      { id: 'm_prev', name: '上一曲',    code: [0x90, 0xb6, 0x00] },
      { id: 'm_next', name: '下一曲',    code: [0x90, 0xb5, 0x00] },
      { id: 'm_vup',  name: '音量 +',    code: [0x90, 0xe9, 0x00] },
      { id: 'm_vdn',  name: '音量 -',    code: [0x90, 0xea, 0x00] },
      { id: 'm_mute', name: '静音',      code: [0x90, 0xe2, 0x00] },
      { id: 'm_play', name: '播放器',    code: [0x90, 0x83, 0x01] },
      { id: 'm_mail', name: '邮件',      code: [0x90, 0x8a, 0x01] },
      { id: 'm_calc', name: '计算器',    code: [0x90, 0x92, 0x01] },
      { id: 'm_pc',   name: '我的电脑',  code: [0x90, 0x94, 0x01] },
      { id: 'm_web',  name: '浏览器',    code: [0x90, 0x23, 0x02] },
    ],
  };
  // 键盘组合键：[0x80, 修饰键位(HID: 1=LCtrl 2=LShift 4=LAlt 8=LWin 0x10=RCtrl 0x20=RShift 0x40=RAlt 0x80=RWin), HID 键码]
  const kbCode = (mods, hid) => [0x80, mods & 0xff, hid & 0xff];
  // 宏：[0xA0, 模式|缓冲区ID, 次数]  模式 0x20=执行N次 0x40=循环直到松开(推断) 0x10=循环直到任意键按下(推断)
  const macroCode = (bufferId, mode, count) => [0xa0, (mode & 0xf0) | (bufferId & 0x0f), count & 0xff];

  // 按键位置 [已确认-MS.ini]：K行第4字段为矩阵号(1起)，图片 mouse_nr.png 上的编号即 K 序号
  const KEYS = [
    { n: 1, name: '左键',   matrix: 0, def: 'left' },
    { n: 2, name: '右键',   matrix: 1, def: 'right' },
    { n: 3, name: '中键',   matrix: 2, def: 'middle' },
    { n: 4, name: '前进键', matrix: 4, def: 'fwd' },
    { n: 5, name: '后退键', matrix: 3, def: 'back' },
    { n: 6, name: 'DPI 键', matrix: 5, def: 'dpiloop' },
  ];

  // KeyboardEvent.code → HID Usage（Keyboard/Keypad Page 0x07）
  const HID = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => (HID['Key' + c.toUpperCase()] = 4 + i));
  '1234567890'.split('').forEach((c, i) => (HID['Digit' + c] = 0x1e + i));
  Object.assign(HID, { Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
    BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36,
    Period: 0x37, Slash: 0x38, CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a,
    PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
    Numpad1: 0x59, Numpad2: 0x5a, Numpad3: 0x5b, Numpad4: 0x5c, Numpad5: 0x5d, Numpad6: 0x5e, Numpad7: 0x5f, Numpad8: 0x60,
    Numpad9: 0x61, Numpad0: 0x62, NumpadDecimal: 0x63, ContextMenu: 0x65 });
  for (let i = 1; i <= 12; i++) HID['F' + i] = 0x39 + i;
  const MODBIT = { ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08, ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80 };

  global.M1P = { M1Pro, CMD, RATE_CODE, DPISET, dpiToHw, hwToDpi, KEYFUN, KEYS, kbCode, macroCode, HID, MODBIT, hex, sleep };
})(window);
