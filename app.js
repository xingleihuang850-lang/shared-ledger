/* ================================================================
   共享账本 app.js
   纯前端 · 零框架 · 零构建工具
   ================================================================ */

// ======================== 常量 ========================
const DB_NAME = 'sharedLedger';
const DB_VER  = 7;   // v7: 新增 snapshots store，用于恢复前自动快照
const APP_VERSION = '1.2.1';
const BACKUP_FORMAT_VERSION = 2;
const DATA_STORES = [
  'transactions', 'categories', 'users', 'settings',
  'badges', 'wishes', 'recurring',
];
const SNAPSHOT_STORE = 'snapshots';

const DEFAULT_EXPENSE_CATS = [
  { id: 'e1',  name: '餐饮', icon: '🍜', type: 'expense' },
  { id: 'e2',  name: '交通', icon: '🚗', type: 'expense' },
  { id: 'e3',  name: '购物', icon: '🛍️', type: 'expense' },
  { id: 'e4',  name: '住房', icon: '🏠', type: 'expense' },
  { id: 'e5',  name: '娱乐', icon: '🎮', type: 'expense' },
  { id: 'e6',  name: '医疗', icon: '💊', type: 'expense' },
  { id: 'e7',  name: '教育', icon: '📚', type: 'expense' },
  { id: 'e8',  name: '通讯', icon: '📱', type: 'expense' },
  { id: 'e9',  name: '日用', icon: '🧴', type: 'expense' },
  { id: 'e10', name: '其他', icon: '❓', type: 'expense' },
];
const DEFAULT_INCOME_CATS = [
  { id: 'i1', name: '工资', icon: '💼', type: 'income' },
  { id: 'i2', name: '兼职', icon: '💡', type: 'income' },
  { id: 'i3', name: '红包', icon: '🧧', type: 'income' },
  { id: 'i4', name: '理财', icon: '📈', type: 'income' },
  { id: 'i5', name: '其他', icon: '❓', type: 'income' },
];
const USER_COLORS = [
  '#E17055', '#00B894', '#0984E3', '#6C5CE7',
  '#FDCB6E', '#E84393', '#00CEC9', '#D63031',
];

// ======================== IndexedDB 工具层 ========================
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      // settings 记录结构是 { key, value }，主键应为 'key'；历史版本误用 'id'，
      // 导致 put({key,value}) 因缺少 id 字段抛 DataError，写入静默失败。
      // 旧库中 settings 因该 bug 恒为空，可安全删除重建。
      if (idb.objectStoreNames.contains('settings')) {
        const old = e.target.transaction.objectStore('settings');
        if (old.keyPath !== 'key') idb.deleteObjectStore('settings');
      }
      if (!idb.objectStoreNames.contains('settings')) {
        idb.createObjectStore('settings', { keyPath: 'key' });
      }
      ['transactions', 'categories', 'users', 'badges', 'wishes', 'recurring']
        .forEach(storeName => {
          if (!idb.objectStoreNames.contains(storeName)) {
            idb.createObjectStore(storeName, { keyPath: 'id' });
          }
        });
      if (!idb.objectStoreNames.contains(SNAPSHOT_STORE)) {
        idb.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror   = ()  => reject(req.error);
  });
}

function dbPut(storeName, record) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(record);
    tx.oncomplete = () => {
      markLocalDataChanged(storeName);
      resolve();
    };
    tx.onerror    = () => reject(tx.error);
  });
}

/** 批量写入同一 store，共用一个事务（比逐条串行快 10x）*/
function dbPutBatch(storeName, records) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    records.forEach(r => store.put(r));
    tx.oncomplete = () => {
      markLocalDataChanged(storeName);
      resolve();
    };
    tx.onerror    = () => reject(tx.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req   = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req   = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.delete(key);
    tx.oncomplete = () => {
      markLocalDataChanged(storeName);
      resolve();
    };
    tx.onerror    = () => reject(tx.error);
  });
}

function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    tx.oncomplete = () => {
      markLocalDataChanged(storeName);
      resolve();
    };
    tx.onerror    = () => reject(tx.error);
  });
}

function markLocalDataChanged(storeName) {
  if (DATA_STORES.includes(storeName)) {
    localStorage.setItem('ledgerLocalDirty', '1');
  }
}

/**
 * 在一个 IndexedDB 事务中替换全部业务数据。任一写入失败会整体回滚。
 */
function dbReplaceAll(data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DATA_STORES, 'readwrite');
    try {
      for (const storeName of DATA_STORES) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const record of data[storeName] || []) store.put(record);
      }
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('数据库写入失败'));
    tx.onabort = () => reject(tx.error || new Error('数据库事务已回滚'));
  });
}

function normalizeBackupData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('备份根节点必须是对象');
  }

  const sourceVersion = Number(raw.formatVersion || 1);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error('备份版本无效');
  }
  if (sourceVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(`该备份来自更新版本（v${sourceVersion}），请先升级应用`);
  }

  const data = {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: String(raw.appVersion || 'legacy'),
    exportedAt: raw.exportedAt || new Date().toISOString(),
    syncVersion: Number(raw.syncVersion) || 0,
  };

  for (const storeName of DATA_STORES) {
    const rows = raw[storeName] == null ? [] : raw[storeName];
    if (!Array.isArray(rows)) throw new Error(`${storeName} 必须是数组`);
    data[storeName] = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${storeName} 中存在无效记录`);
      }
      return { ...row };
    });
  }

  // v1 settings 可能使用 id 作为键；迁移为 v2 的 {key,value}。
  data.settings = data.settings
    .map(row => ({ key: String(row.key || row.id || ''), value: row.value }))
    .filter(row => row.key);

  const settingKeys = new Set();
  for (const row of data.settings) {
    if (settingKeys.has(row.key)) throw new Error(`settings 存在重复 key：${row.key}`);
    settingKeys.add(row.key);
  }

  for (const storeName of DATA_STORES.filter(name => name !== 'settings')) {
    const ids = new Set();
    for (const row of data[storeName]) {
      if (row.id == null || String(row.id) === '') throw new Error(`${storeName} 记录缺少 id`);
      const id = String(row.id);
      if (ids.has(id)) throw new Error(`${storeName} 存在重复 id：${id}`);
      ids.add(id);
      row.id = id;
    }
  }

  for (const txn of data.transactions) {
    txn.amount = Number(txn.amount);
    if (!Number.isFinite(txn.amount) || txn.amount <= 0) throw new Error('交易金额无效');
    if (!['income', 'expense'].includes(txn.type)) throw new Error('交易类型无效');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(txn.date || ''))) throw new Error('交易日期无效');
  }

  if (data.users.length === 0) {
    data.users.push({ id: 'u1', name: '我', color: USER_COLORS[0] });
  }
  if (data.categories.length === 0) {
    data.categories.push(...DEFAULT_EXPENSE_CATS.map(x => ({ ...x })), ...DEFAULT_INCOME_CATS.map(x => ({ ...x })));
  }
  return data;
}

// ======================== 粒子系统 ========================
const Particles = {
  ctx:       null,
  canvas:    null,   // 缓存 canvas 引用，避免每帧 getElementById
  particles: [],
  running:   true,
  count:     25,

  init() {
    this.canvas = document.getElementById('particles');
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];

    for (let i = 0; i < this.count; i++) {
      this.particles.push({
        x:  Math.random() * this.canvas.width,
        y:  Math.random() * this.canvas.height,
        r:  Math.random() * 2 + 0.5,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        o:  Math.random() * 0.3 + 0.1,
      });
    }

    window.addEventListener('resize', () => {
      this.canvas.width  = window.innerWidth;
      this.canvas.height = window.innerHeight;
    });

    this.animate();
  },

  animate() {
    if (!this.running) return;
    const { canvas, ctx } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const isDark = document.documentElement.classList.contains('dark');
    const col    = isDark ? '255,255,255' : '45,52,54';

    this.particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0)             p.x = canvas.width;
      if (p.x > canvas.width)  p.x = 0;
      if (p.y < 0)             p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col},${p.o})`;
      ctx.fill();
    });

    requestAnimationFrame(() => this.animate());
  },
};

// ======================== 分类图标工具函数 ========================
/**
 * 生成分类图标的 HTML 字符串
 * 有 iconImg（URL 或 base64）时优先用 <img>，否则用 emoji 文字
 * @param {Object} cat  - 分类对象 { icon, iconImg }
 * @param {string} size - CSS 尺寸，默认 '24px'
 * @returns {string}
 */
function catIconHtml(cat, size = '24px') {
  const icon = cat ? escapeHtml(cat.icon || '📌') : '📌';
  if (cat && cat.iconImg) {
    const img = escapeHtml(cat.iconImg);
    return `<img src="${img}" alt="${icon}"
               style="width:${size};height:${size};object-fit:contain;border-radius:4px;vertical-align:middle"
               onerror="this.style.display='none';this.nextSibling.style.display='inline'">` +
           `<span style="display:none">${icon}</span>`;
  }
  return icon;
}

/**
 * 压缩图片为 64×64 base64（canvas 缩放）
 * @param {File|Blob} file
 * @returns {Promise<string>} base64 data URL
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        // 居中裁剪
        const side = Math.min(img.width, img.height);
        const sx   = (img.width  - side) / 2;
        const sy   = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, 64, 64);
        resolve(canvas.toDataURL('image/png', 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ======================== CSV 分类识别（公共逻辑，消除重复）========================
/**
 * 根据交易描述和方向猜测分类名称
 * @param {string} desc  - 商品名 + 交易对方拼接
 * @param {string} dir   - '收入' | '支出'
 * @returns {string} 分类名
 */
function guessCategoryFromDesc(desc, dir) {
  if (dir === '收入') return '其他';
  const d = desc.toLowerCase();
  if (d.includes('餐') || d.includes('饭') || d.includes('外卖') ||
      d.includes('美团') || d.includes('饿了么') || d.includes('饿了吗') || d.includes('食') || d.includes('饮')) return '餐饮';
  if (d.includes('公交') || d.includes('地铁') || d.includes('打车') ||
      d.includes('滴滴') || d.includes('高铁') || d.includes('火车') ||
      d.includes('飞机') || d.includes('加油') || d.includes('停车'))  return '交通';
  if (d.includes('电影') || d.includes('游戏') || d.includes('视频') || d.includes('会员')) return '娱乐';
  if (d.includes('超市') || d.includes('便利店') || d.includes('淘宝') ||
      d.includes('京东') || d.includes('拼多多'))                        return '购物';
  if (d.includes('医院') || d.includes('药') || d.includes('诊所') || d.includes('健身')) return '医疗';
  if (d.includes('房租') || d.includes('水电') || d.includes('物业') ||
      d.includes('话费') || d.includes('网费'))                         return '住房';
  if (d.includes('手机') || d.includes('电脑') || d.includes('数码'))   return '购物';
  return '购物';
}

/**
 * HTML 转义，防止 XSS 注入。
 * 所有拼进 innerHTML 的用户输入（用户名/分类名/备注/地点等）都必须经过此函数。
 * @param {*} value - 任意值
 * @returns {string} 转义后的安全字符串
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成可安全嵌入「HTML 属性内的内联 JS 字符串」的值。
 * 先 JSON.stringify 得到合法 JS 字符串字面量，再 HTML 转义。
 * 用于 onclick="App.foo(${jsId(id)})" 这类场景，防导入 JSON 中的恶意 id 注入。
 */
function jsId(value) {
  return escapeHtml(JSON.stringify(value == null ? '' : String(value)));
}

/**
 * 将 Date 对象格式化为本地日期 YYYY-MM-DD。
 * 不能用 toISOString().slice(0,10)，因为 toISOString 返回 UTC 时间，
 * 在东八区凌晨会导致日期偏移一天（甚至定期任务死循环）。
 */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 返回今天的本地日期字符串 YYYY-MM-DD */
function todayStr() {
  return formatLocalDate(new Date());
}

/** 按类型求和（income/expense） */
function sumByType(txns, type) {
  return txns.reduce((s, t) => (t.type === type ? s + (t.amount || 0) : s), 0);
}

/** 月份平移 delta 个月（跨年自动处理），返回新对象，不修改入参 */
function shiftMonth(m, delta) {
  let y = m.year, mo = m.month + delta;
  if (mo < 1) { mo = 12; y--; }
  else if (mo > 12) { mo = 1; y++; }
  return { year: y, month: mo };
}

// ======================== 主应用 ========================
const App = {
  // ----- 状态 -----
  currentUser:  null,
  currentType:  'expense',
  currentCat:   null,
  currentMood:  '😊',
  currentMonth: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
  statsMonth:   { year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
  yearSummary:  { year: new Date().getFullYear() },
  trendChart:   null,
  pieChart:     null,
  installPromptEvent: null,

  // ----- 高级搜索状态 -----
  searchState: {
    active:    false,   // 是否处于搜索模式
    keyword:   '',      // 关键词
    type:      '',      // 'expense' | 'income' | ''
    catId:     '',      // 分类 id | ''
    amountMin: '',
    amountMax: '',
    dateFrom:  '',
    dateTo:    '',
  },
  eggCount:     0,

  // ----- 初始化 -----
  async init() {
    try {
      await openDB();
      await this.initUsers();
      await this.initCategories();
      this.currentMonth = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
      this.statsMonth   = { ...this.currentMonth };
      this.yearSummary  = { year: new Date().getFullYear() };
      this.initTheme();
      Particles.init();
      this.setTodayDate();
      this.renderCats();
      await this.processRecurring();   // 检查并自动生成定期收支
      await this.render();
      this.typewriter('共享账本');
      this.switchPage('home', document.querySelector('.nav-btn[data-page="home"]'));
      this.updateInstallUI();
    } catch (err) {
      console.error('初始化失败', err);
      alert('应用启动失败，请刷新页面重试。\n错误：' + (err && err.message || err));
    }
  },

  // ----- 打字机标题 -----
  typewriter(text) {
    const el  = document.getElementById('titleText');
    const cur = document.getElementById('titleCursor');
    el.textContent = '';
    let i = 0;
    return new Promise(resolve => {
      const timer = setInterval(() => {
        el.textContent += text[i];
        i++;
        if (i >= text.length) {
          clearInterval(timer);
          setTimeout(() => { cur.style.display = 'none'; }, 2000);
          resolve();
        }
      }, 80);
    });
  },

  // ======================== 主题 ========================
  initTheme() {
    const saved = localStorage.getItem('ledger_theme');
    this.setTheme(saved === 'dark' ? 'dark' : 'light');
  },

  setTheme(themeName) {
    document.documentElement.className = themeName;
    localStorage.setItem('ledger_theme', themeName);
    document.querySelector('meta[name="theme-color"]').content =
      themeName === 'dark' ? '#1A1A2E' : '#F5F5F0';
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content =
      themeName === 'dark' ? 'black-translucent' : 'default';
  },

  toggleTheme() {
    const isDark   = document.documentElement.classList.contains('dark');
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.style.transition = 'background 0.6s';
    this.setTheme(newTheme);
    setTimeout(() => { document.documentElement.style.transition = ''; }, 600);
    this.toast(newTheme === 'dark' ? '🌙 暗黑模式已开启' : '☀️ 亮色模式已开启');
    if (!isDark) {
      Particles.particles.forEach(p => { p.vx *= -1; p.vy *= -1; });
    }
  },

  // ======================== PWA 安装与更新 ========================
  isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  },

  isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  },

  updateInstallUI() {
    const label = document.getElementById('installAppLabel');
    const hint  = document.getElementById('installAppHint');
    if (!label || !hint) return;
    if (this.isStandalone()) {
      label.textContent = '共享账本已安装';
      hint.textContent  = '每次打开都会自动检查更新';
    } else {
      label.textContent = '安装到手机';
      hint.textContent  = this.installPromptEvent
        ? '点击即可安装，后续自动更新'
        : '安装后可离线使用并自动更新';
    }
  },

  async installApp() {
    if (this.isStandalone()) {
      this.toast('✅ 已安装，应用会自动更新');
      return;
    }

    if (this.installPromptEvent) {
      const promptEvent = this.installPromptEvent;
      this.installPromptEvent = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      this.updateInstallUI();
      if (choice.outcome === 'accepted') {
        this.toast('✅ 安装完成');
      } else {
        this.toast('浏览器安装已取消，也可以下载正式 APK');
        this.showInstallGuide();
      }
      return;
    }

    this.showInstallGuide();
  },

  showInstallGuide() {
    const text = document.getElementById('installGuideText');
    if (this.isIOS()) {
      text.innerHTML = '<b>iPhone / iPad：</b><br>请使用 Safari 打开本页面，点击底部“分享”按钮，然后选择“添加到主屏幕”。';
    } else {
      text.innerHTML = '<b>Android 有两种安装方式：</b><br>① 使用支持 PWA 的浏览器选择“安装应用”或“添加到主屏幕”；<br>② 从 GitHub Releases 下载正式签名 APK。APK 安装后仍会打开同一在线账本，联网启动即可使用最新网页版本。';
    }
    this.openModal('installGuideModal');
  },

  showPrivacyNotice() {
    this.openModal('privacyModal');
  },

  // ======================== 特效 ========================
  emojiRain(x, y, emojis = ['🎉', '✨', '💫', '🌟', '💰', '💵', '🎊']) {
    for (let i = 0; i < 8; i++) {
      setTimeout(() => {
        const el = document.createElement('span');
        el.className = 'emoji-drop';
        el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        el.style.left             = (x - 20 + Math.random() * 40) + 'px';
        el.style.top              = y + 'px';
        el.style.animationDuration = (0.8 + Math.random() * 0.8) + 's';
        el.style.fontSize         = (18 + Math.random() * 16) + 'px';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1500);
      }, i * 60);
    }
  },

  confetti() {
    const colors = ['#FDCB6E', '#E17055', '#00B894', '#0984E3', '#6C5CE7', '#E84393', '#FFD740', '#40C4FF'];
    for (let i = 0; i < 40; i++) {
      setTimeout(() => {
        const el = document.createElement('span');
        el.className = 'confetti';
        const w = 6 + Math.random() * 8;
        el.style.cssText = [
          `left:${Math.random() * 100}vw`,
          'top:-20px',
          `width:${w}px`,
          `height:${w * (Math.random() * 0.5 + 0.8)}px`,
          `background:${colors[Math.floor(Math.random() * colors.length)]}`,
          `border-radius:${Math.random() > 0.5 ? '50%' : '2px'}`,
          `animation-duration:${1.5 + Math.random() * 2}s`,
          `animation-delay:${Math.random() * 0.3}s`,
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3500);
      }, i * 30);
    }
  },

  ripple(evt, btn) {
    const el   = document.createElement('span');
    el.className = 'ripple';
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    el.style.width  = el.style.height = size + 'px';
    el.style.left   = (evt.clientX - rect.left - size / 2) + 'px';
    el.style.top    = (evt.clientY - rect.top  - size / 2) + 'px';
    btn.appendChild(el);
    setTimeout(() => el.remove(), 600);
  },

  easterEgg() {
    this.eggCount++;
    if (this.eggCount >= 3) {
      this.eggCount = 0;
      this.confetti();
      this.toast('🎉 你发现了隐藏彩蛋！阿奇为你撒花~');
    }
  },

  // ======================== 用户管理 ========================
  async initUsers() {
    let users = await dbGetAll('users');
    if (users.length === 0) {
      users = [{ id: 'u1', name: '我', color: USER_COLORS[0] }];
      await dbPutBatch('users', users);
    }
    const setting = await dbGet('settings', 'currentUser');
    this.currentUser = setting
      ? (users.find(u => u.id === setting.value) || users[0])
      : users[0];
  },

  async getUsers() {
    return await dbGetAll('users');
  },

  async switchUser(userId) {
    const users = await this.getUsers();
    this.currentUser = users.find(u => u.id === userId) || users[0] || this.currentUser;
    await dbPut('settings', { key: 'currentUser', value: userId });
    this.closeModal('userModal');
    this.render();
    this.toast('已切换至 ' + this.currentUser.name);
  },

  async addUser() {
    const name = document.getElementById('newUserName').value.trim();
    if (!name) return;
    const users = await this.getUsers();
    const color = USER_COLORS[users.length % USER_COLORS.length];
    const user  = { id: 'u' + Date.now(), name, color };
    await dbPut('users', user);
    document.getElementById('newUserName').value = '';
    this.showUserSwitcher();
    this.toast('添加成功：' + name);
  },

  async showUserSwitcher() {
    const users = await this.getUsers();
    const list  = document.getElementById('userList');
    list.innerHTML = users.map(u => `
      <div class="user-item ${u.id === this.currentUser.id ? 'active' : ''}"
           onclick="App.switchUser(${jsId(u.id)})">
        <div class="user-avatar" style="background:${escapeHtml(u.color || '#0984E3')}">${escapeHtml((u.name || '?').charAt(0) || '?')}</div>
        <span class="user-name">${escapeHtml(u.name || '')}</span>
      </div>`
    ).join('');
    this.openModal('userModal');
  },

  // ======================== 分类管理 ========================
  async initCategories() {
    const cats = await dbGetAll('categories');
    if (cats.length === 0) {
      await dbPutBatch('categories', [...DEFAULT_EXPENSE_CATS, ...DEFAULT_INCOME_CATS]);
    }
  },

  async getCategories() {
    return await dbGetAll('categories');
  },

  renderCats() {
    const grid = document.getElementById('catGrid');
    this.getCategories().then(cats => {
      const filtered = cats.filter(c => c.type === this.currentType);
      grid.innerHTML = filtered.map(c => `
        <div class="cat-chip ${this.currentCat === c.id ? 'selected' : ''}"
             onclick="App.selectCat(${jsId(c.id)})">
          <span class="cat-chip-icon">${catIconHtml(c, '20px')}</span><span class="cat-label">${escapeHtml(c.name)}</span>
        </div>`
      ).join('');
    });
  },

  selectCat(id) {
    this.currentCat = id;
    this.renderCats();
  },

  setType(type, btn) {
    this.currentType = type;
    this.currentCat  = null;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active', 'income', 'expense'));
    btn.classList.add('active', type);
    this.renderCats();
  },

  async showCatManager() {
    const cats = await this.getCategories();
    const list = document.getElementById('catManagerList');
    list.innerHTML = cats.map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="display:flex;align-items:center;gap:8px">
          <span class="cat-mgr-icon">${catIconHtml(c, '28px')}</span>
          <span>${escapeHtml(c.name)} <small style="color:var(--text3)">${c.type === 'expense' ? '支出' : '收入'}</small></span>
        </span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline" style="width:auto;padding:5px 10px;font-size:12px"
                  onclick="App.editCatIcon(${jsId(c.id)})">图标</button>
          <button class="btn btn-outline" style="width:auto;padding:5px 10px;font-size:12px;color:var(--danger);border-color:var(--danger)"
                  onclick="App.delCategory(${jsId(c.id)})">删除</button>
        </div>
      </div>`
    ).join('');
    this.openModal('catManagerModal');
  },

  // 打开分类图标编辑器
  async editCatIcon(catId) {
    const cats = await this.getCategories();
    const cat  = cats.find(c => c.id === catId);
    if (!cat) return;

    // 设置弹窗内容
    document.getElementById('catIconEditorTitle').textContent  = `编辑「${cat.name}」图标`;
    document.getElementById('catIconEditorEmoji').value        = cat.icon || '📌';
    document.getElementById('catIconEditorUrl').value          = (cat.iconImg && !cat.iconImg.startsWith('data:')) ? cat.iconImg : '';
    document.getElementById('catIconEditorPreview').innerHTML  = catIconHtml(cat, '48px');
    const uploadEl = document.getElementById('catIconEditorUpload');
    uploadEl.value = '';
    delete uploadEl.dataset.b64;  // 清除上次上传缓存
    this._editingCatId = catId;
    this.openModal('catIconEditorModal');
  },

  // 实时预览：URL 或 emoji 改变时更新
  previewCatIcon() {
    const url   = document.getElementById('catIconEditorUrl').value.trim();
    const emoji = document.getElementById('catIconEditorEmoji').value.trim() || '📌';
    const prev  = document.getElementById('catIconEditorPreview');
    if (url) {
      prev.innerHTML = catIconHtml({ icon: emoji, iconImg: url }, '48px');
    } else {
      prev.innerHTML = catIconHtml({ icon: emoji }, '48px');
    }
  },

  // 上传图片：压缩后预览
  async onCatIconUpload(input) {
    const file = input.files[0];
    if (!file) return;
    try {
      const b64 = await compressImage(file);
      const emoji = document.getElementById('catIconEditorEmoji').value.trim() || '📌';
      document.getElementById('catIconEditorPreview').innerHTML = catIconHtml({ icon: emoji, iconImg: b64 }, '48px');
      // 临存到 input 的 dataset，保存时取
      input.dataset.b64 = b64;
      document.getElementById('catIconEditorUrl').value = '';
    } catch {
      this.toast('图片读取失败');
    }
  },

  // 保存分类图标
  async saveCatIcon() {
    const catId  = this._editingCatId;
    const cats   = await this.getCategories();
    const cat    = cats.find(c => c.id === catId);
    if (!cat) return;

    const emoji   = document.getElementById('catIconEditorEmoji').value.trim() || cat.icon;
    const url     = document.getElementById('catIconEditorUrl').value.trim();
    const upload  = document.getElementById('catIconEditorUpload');
    const b64     = upload.dataset.b64 || '';

    cat.icon    = emoji;
    cat.iconImg = b64 || url || cat.iconImg || '';
    if (!cat.iconImg) delete cat.iconImg;

    await dbPut('categories', cat);
    this.closeModal('catIconEditorModal');
    this.renderCats();
    await this.showCatManager();
    this.toast('图标已保存');
  },

  // 清除分类自定义图标
  async clearCatIcon() {
    const catId = this._editingCatId;
    const cats  = await this.getCategories();
    const cat   = cats.find(c => c.id === catId);
    if (!cat) return;
    delete cat.iconImg;
    await dbPut('categories', cat);
    this.closeModal('catIconEditorModal');
    this.renderCats();
    await this.showCatManager();
    this.toast('已恢复默认图标');
  },

  async addCategory() {
    const name = document.getElementById('newCatName').value.trim();
    const icon = document.getElementById('newCatIcon').value.trim() || '📌';
    const type = document.getElementById('newCatType').value;
    if (!name) return;
    // 新分类暂不带 iconImg，添加后可通过「图标」按钮进一步定制
    const cat = { id: 'c' + Date.now(), name, icon, type };
    await dbPut('categories', cat);
    document.getElementById('newCatName').value = '';
    document.getElementById('newCatIcon').value = '';
    this.renderCats();
    this.showCatManager();
    this.toast('分类已添加');
  },

  async delCategory(id) {
    await dbDelete('categories', id);
    this.renderCats();
    this.showCatManager();
    this.toast('分类已删除');
  },

  // ======================== 记账 ========================
  setTodayDate() {
    document.getElementById('addDate').value = todayStr();
  },

  selectMood(mood, el) {
    this.currentMood = mood;
    document.querySelectorAll('.mood-chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
  },

  // ======================== 消费人格 ========================
  renderPersonality(monthTxns) {
    const card = document.getElementById('personalityCard');
    const totalExpense = monthTxns
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);

    if (totalExpense === 0) { card.style.display = 'none'; return; }

    const breakdown = this.getCategoryBreakdown(monthTxns, 'expense');
    const totalBreakdown = breakdown.reduce((s, b) => s + b.amount, 0);
    const shares = {};
    breakdown.forEach(b => { shares[b.name] = b.amount / totalBreakdown; });

    const dining = shares['餐饮'] || 0;
    const shop   = shares['购物']  || 0;
    const trans  = shares['交通'] || 0;
    const edu    = shares['教育'] || 0;
    const house  = shares['住房'] || 0;
    const ent    = shares['娱乐'] || 0;

    let persona, desc;
    if (dining > 0.3) {
      persona = { name: '精致美食家', icon: '🍽️', tag: '美食' };
      desc    = `本月 ${(dining * 100).toFixed(0)}% 的支出都献给了味蕾。你是用舌尖丈量世界的人，每一餐都不将就。`;
    } else if (shop > 0.25) {
      persona = { name: '都市买手', icon: '🛍️', tag: '买手' };
      desc    = `购物占 ${(shop * 100).toFixed(0)}%，你总能在好东西出现时精准下手。消费是投资，眼光决定回报。`;
    } else if (edu > 0.2) {
      persona = { name: '学霸型选手', icon: '📚', tag: '学霸' };
      desc    = `教育支出占比 ${(edu * 100).toFixed(0)}%，你在用真金白银投资自己。知识就是最好的理财产品。`;
    } else if (house > 0.35) {
      persona = { name: '宅家达人', icon: '🏠', tag: '宅家' };
      desc    = `住房相关支出超 ${(house * 100).toFixed(0)}%，家是你的宇宙中心。舒适是第一生产力。`;
    } else if (trans > 0.2) {
      persona = { name: '行走江湖', icon: '✈️', tag: '行旅' };
      desc    = `交通支出 ${(trans * 100).toFixed(0)}%，你不是在路上就是在准备出发。世界那么大，你一直在看。`;
    } else if (ent > 0.25) {
      persona = { name: '快乐玩家', icon: '🎮', tag: '玩家' };
      desc    = `娱乐消费占比 ${(ent * 100).toFixed(0)}%，你深谙"会玩才会赚"的道理。活得快乐就是最好的理财。`;
    } else {
      persona = { name: '生活家', icon: '🌿', tag: '生活' };
      desc    = '各项支出均衡分布，你是一个懂得平衡的人。不被单一欲望支配，把生活过成自己想要的样子。';
    }

    card.style.display = 'block';
    card.innerHTML = `
      <div class="personality-card">
        <div class="p-header">
          <span class="p-avatar">${persona.icon}</span>
          <div>
            <div class="p-title">${persona.name}</div>
            <span class="p-tag">本月消费人格</span>
          </div>
        </div>
        <div class="p-desc">${desc}</div>
      </div>`;
  },

  // ======================== 成就徽章 ========================
  BADGE_DEFS: [
    { id: 'first_txn', name: '初来乍到', icon: '🌟', desc: '记录第一笔账' },
    { id: 'streak_7',  name: '周更达人', icon: '🔥', desc: '连续7天记账' },
    { id: 'save_50',   name: '省钱大师', icon: '💰', desc: '月存储率超50%' },
    { id: 'txn_100',   name: '百笔达人', icon: '✍️', desc: '累计100笔记录' },
    { id: 'budget_3',  name: '预算大师', icon: '🎯', desc: '连续3月不超预算' },
    { id: 'ten_k',     name: '万元户',   icon: '💎', desc: '年收入破万' },
    { id: 'no_dining', name: '零外卖月', icon: '🍳', desc: '整月零餐饮支出' },
    { id: 'diverse',   name: '百花齐放', icon: '🌈', desc: '用过10种以上分类' },
  ],

  /**
   * 检查徽章，仅在记账 / 删除交易后调用，不在每次 render() 调用
   * @param {Array} allTxns      - 当前用户所有交易
   * @param {Array} monthTxns    - 当月交易
   * @returns {Promise<Array>}   - 新解锁的徽章列表
   */
  async checkBadges(allTxns, monthTxns) {
    const allBadges      = await dbGetAll('badges');
    const myBadges       = allBadges.filter(b => (b.userId || 'u1') === this.currentUser.id);
    const unlockedIds    = new Set(myBadges.map(b => b.badgeId || b.id));
    const monthStats     = this.getMonthlyStats(monthTxns);
    const totalIncome    = sumByType(allTxns, 'income');
    const newBadges      = [];

    const checks = {
      first_txn: () => allTxns.length >= 1,

      streak_7: () => {
        // 统计所有交易（含纯收入）的日期，与文案「连续7天记账」一致
        const dates = new Set(
          allTxns.map(t => (t.date || '')).filter(Boolean)
        );
        let maxStreak = 0, cur = 0;
        const day = new Date();
        for (let i = 0; i < 60; i++) {
          const ds = formatLocalDate(day);
          if (dates.has(ds)) { cur++; maxStreak = Math.max(maxStreak, cur); }
          else                 { cur = 0; }
          day.setDate(day.getDate() - 1);
        }
        return maxStreak >= 7;
      },

      save_50: () =>
        monthStats.income > 0 &&
        monthStats.balance > 0 &&
        (monthStats.balance / monthStats.income * 100) >= 50,

      txn_100: () => allTxns.length >= 100,

      budget_3: async () => {
        const settings = await this.getSettings();
        let consecutive = 0;
        for (let i = 0; i < 6; i++) {
          const d      = new Date(this.currentMonth.year, this.currentMonth.month - 1 - i, 1);
          const key    = `budget_${this.currentUser.id}_${d.getFullYear()}_${d.getMonth() + 1}`;
          const entry  = settings.find(s => s.key === key);
          if (!entry) break;
          const prefix  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const expense = allTxns
            .filter(t => (t.date || '').startsWith(prefix) && t.type === 'expense')
            .reduce((s, t) => s + t.amount, 0);
          if (expense <= entry.value) consecutive++;
          else break;
        }
        return consecutive >= 3;
      },

      ten_k: () => totalIncome >= 10000,

      no_dining: () => {
        // 只对已结束的月份（上月）判定，避免月初第一天就误发「整月零餐饮」
        const { year: py, month: pm } = shiftMonth(this.currentMonth, -1);
        const prevTxns    = this.getTransactionsByMonth(allTxns, py, pm);
        const diningTotal = sumByType(prevTxns.filter(t => t.categoryName === '餐饮'), 'expense');
        const prevExpense = sumByType(prevTxns, 'expense');
        return prevExpense > 0 && diningTotal === 0;
      },

      diverse: () => new Set(allTxns.map(t => t.categoryName)).size >= 10,
    };

    for (const def of this.BADGE_DEFS) {
      if (unlockedIds.has(def.id)) continue;
      const passed = def.id === 'budget_3'
        ? await checks.budget_3()
        : checks[def.id]();
      if (passed) {
        const badge = {
          id:         this.currentUser.id + '_' + def.id,
          badgeId:    def.id,
          userId:     this.currentUser.id,
          name:       def.name,
          icon:       def.icon,
          desc:       def.desc,
          unlockedAt: new Date().toISOString(),
        };
        await dbPut('badges', badge);
        newBadges.push(badge);
      }
    }
    return newBadges;
  },

  async getSettings() {
    return await dbGetAll('settings');
  },

  /**
   * 渲染徽章行
   * B1 修复：badge 详情改为 data 属性，避免 onclick 字符串中引用 JS 变量
   */
  renderBadges(unlockedBadges) {
    const card     = document.getElementById('badgeCard');
    const row      = document.getElementById('badgeRow');
    const unlockMap = new Map(unlockedBadges.map(b => [b.badgeId || b.id, b]));

    card.style.display = 'block';
    document.getElementById('badgeCount').textContent =
      `${unlockedBadges.length}/${this.BADGE_DEFS.length}`;

    row.innerHTML = this.BADGE_DEFS.map(def => {
      const badge   = unlockMap.get(def.id);
      const isUnlocked = !!badge;
      const tipData = isUnlocked
        ? `${badge.desc} · ${new Date(badge.unlockedAt).toLocaleDateString()}`
        : `${def.desc}（尚未解锁）`;
      return `
        <div class="badge-item ${isUnlocked ? 'unlocked' : 'locked'}"
             data-tip="${tipData.replace(/"/g, '&quot;')}"
             onclick="App.toast(this.dataset.tip)">
          <div class="b-icon">${isUnlocked ? badge.icon : '🔒'}</div>
          <div class="b-name">${def.name}</div>
        </div>`;
    }).join('');
  },

  // ======================== 愿望清单 ========================
  async getWishes() {
    const all = await dbGetAll('wishes');
    return all.filter(w => (w.userId || 'u1') === this.currentUser.id);
  },

  showWishModal() {
    document.getElementById('wishName').value   = '';
    document.getElementById('wishTarget').value = '';
    document.getElementById('wishIcon').value   = '';
    this.openModal('wishModal');
  },

  async addWish() {
    const name   = document.getElementById('wishName').value.trim();
    const target = parseFloat(document.getElementById('wishTarget').value);
    const icon   = document.getElementById('wishIcon').value.trim() || '🎯';
    if (!name || !target || target <= 0) return this.toast('请填写完整信息');
    const wish = { id: 'w' + Date.now(), name, target, icon, createdAt: new Date().toISOString(), userId: this.currentUser.id };
    await dbPut('wishes', wish);
    this.toast('✨ 愿望已添加，加油！');
    this.closeModal('wishModal');
    this.renderWishes();
  },

  async renderWishes(txns) {
    const wishes = await this.getWishes();
    const card   = document.getElementById('wishCard');
    const list   = document.getElementById('wishList');
    if (!wishes || wishes.length === 0) { card.style.display = 'none'; return; }
    card.style.display = 'block';

    const totalSavings = txns
      ? sumByType(txns, 'income') - sumByType(txns, 'expense')
      : 0;

    list.innerHTML =
      '<div style="font-size:12px;color:var(--text3);padding:2px 0 8px">进度按「当前用户总存款（收入−支出）」独立计算，多个愿望会同时计入</div>' +
      wishes.map(w => {
      const pct       = Math.min(totalSavings / w.target * 100, 100);
      const savedAmt  = Math.min(totalSavings, w.target).toFixed(0);
      const emoji     = pct >= 100 ? '🎉' : pct >= 50 ? '💪' : pct >= 25 ? '🔥' : '💤';
      return `
        <div class="wish-item"
             data-wish-id="${escapeHtml(w.id)}"
             data-wish-name="${escapeHtml(w.name)}"
             onclick="App._onWishClick(event, this)">
          <div class="wish-icon">${escapeHtml(w.icon)}</div>
          <div class="wish-info">
            <div class="w-name">${escapeHtml(w.name)}</div>
            <div class="w-progress">
              ¥${savedAmt} / ¥${w.target}${pct >= 100 ? ' ✅ 已达成！' : ''}
            </div>
            <div class="wish-bar">
              <div class="w-fill" style="width:${pct}%"></div>
            </div>
          </div>
          <span style="font-size:20px">${emoji}</span>
        </div>`;
    }).join('');
  },

  _onWishClick(evt, el) {
    const id   = el.dataset.wishId;
    const name = el.dataset.wishName;
    if (confirm(`删除愿望「${name}」？`)) this.delWish(id);
  },

  async delWish(id) {
    await dbDelete('wishes', id);
    const txns = await this.getTransactions(true);
    this.renderWishes(txns);
    this.toast('愿望已删除');
  },

  // ======================== 记账保存 ========================
  async saveTxn() {
    const amount = parseFloat(document.getElementById('addAmount').value);
    const date   = document.getElementById('addDate').value;
    const note   = document.getElementById('addNote').value.trim();

    if (!amount || amount <= 0)  return this.toast('请输入金额');
    if (!this.currentCat)        return this.toast('请选择分类');
    if (!date)                   return this.toast('请选择日期');

    const cats = await this.getCategories();
    const cat  = cats.find(c => c.id === this.currentCat);

    const locationName = document.getElementById('addLocation').value.trim();
    const lat          = parseFloat(document.getElementById('addLat').value);
    const lng          = parseFloat(document.getElementById('addLng').value);

    const txn = {
      id:              't' + Date.now(),
      type:            this.currentType,
      amount,
      categoryId:      this.currentCat,
      categoryName:    cat ? cat.name : '未知',
      categoryIcon:    cat ? cat.icon : '❓',
      categoryIconImg: cat && cat.iconImg ? cat.iconImg : undefined,
      date,
      note,
      mood:            this.currentMood,
      userId:          this.currentUser.id,
      userName:        this.currentUser.name,
      userColor:       this.currentUser.color,
      createdAt:       new Date().toISOString(),
      locationName:    locationName || undefined,
      lat:             isNaN(lat) ? undefined : lat,
      lng:             isNaN(lng) ? undefined : lng,
    };

    await dbPut('transactions', txn);

    document.getElementById('addAmount').value   = '';
    document.getElementById('addNote').value     = '';
    document.getElementById('addLocation').value = '';
    document.getElementById('addLat').value      = '';
    document.getElementById('addLng').value      = '';
    document.getElementById('locHint').textContent = '';
    this.currentCat = null;
    this.renderCats();

    // 保存后检查徽章（不在 render() 中重复检查）
    const allTxns   = await this.getTransactions(true);
    const monthTxns = this.getTransactionsByMonth(
      allTxns, this.currentMonth.year, this.currentMonth.month
    );
    const newBadges = await this.checkBadges(allTxns, monthTxns);
    if (newBadges.length > 0) {
      newBadges.forEach(b => this.toast(`🏆 解锁成就：${b.name}！`));
      setTimeout(() => this.confetti(), 500);
    }

    // Emoji 雨特效
    const btn  = document.getElementById('saveBtn');
    const rect = btn.getBoundingClientRect();
    this.emojiRain(rect.left + rect.width / 2, rect.top);
    this.toast('✨ 记账成功！');
    this.switchPage('home', document.querySelector('.nav-btn[data-page="home"]'));
  },

  async deleteTxn(id) {
    await dbDelete('transactions', id);
    // 删除后也触发徽章检查（某些徽章依赖记录数）
    const allTxns   = await this.getTransactions(true);
    const monthTxns = this.getTransactionsByMonth(
      allTxns, this.currentMonth.year, this.currentMonth.month
    );
    await this.checkBadges(allTxns, monthTxns);
    this.render();
    this.toast('已删除');
  },

  // ======================== 交易编辑 ========================
  /** 点击交易条目：打开编辑弹窗（支持编辑 + 删除） */
  async openEditTxn(id) {
    const txns = await this.getTransactions(true);
    const txn = txns.find(t => t.id === id);
    if (!txn) return;
    this._editingTxnId = id;
    this._editType     = txn.type || 'expense';
    document.getElementById('editAmount').value = txn.amount;
    document.getElementById('editDate').value   = txn.date || todayStr();
    document.getElementById('editNote').value   = txn.note || '';
    this._renderEditTypeButtons();
    await this._renderEditCats(txn.categoryId);
    this.openModal('editTxnModal');
  },

  /** 切换编辑弹窗的收支类型 */
  editSetType(type) {
    this._editType = type;
    this._renderEditTypeButtons();
    this._renderEditCats(null);
  },

  _renderEditTypeButtons() {
    const expBtn = document.getElementById('editBtnExpense');
    const incBtn = document.getElementById('editBtnIncome');
    if (expBtn) expBtn.classList.toggle('active', this._editType === 'expense');
    if (incBtn) incBtn.classList.toggle('active', this._editType === 'income');
  },

  /** 按类型填充分类下拉 */
  async _renderEditCats(selectedId) {
    const cats = await this.getCategories();
    const list = cats.filter(c => c.type === this._editType);
    const sel  = document.getElementById('editCat');
    sel.innerHTML = list.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.icon || '')} ${escapeHtml(c.name)}</option>`
    ).join('');
    if (selectedId && list.some(c => c.id === selectedId)) sel.value = selectedId;
  },

  /** 保存编辑 */
  async saveEditTxn() {
    const id = this._editingTxnId;
    if (!id) return;
    const amount = parseFloat(document.getElementById('editAmount').value);
    const date   = document.getElementById('editDate').value;
    const note   = document.getElementById('editNote').value.trim();
    const catId  = document.getElementById('editCat').value;
    if (!amount || amount <= 0) return this.toast('请输入金额');
    if (!date)                  return this.toast('请选择日期');
    if (!catId)                 return this.toast('请选择分类');

    const txns = await this.getTransactions(true);
    const txn = txns.find(t => t.id === id);
    if (!txn) return;
    const cats = await this.getCategories();
    const cat  = cats.find(c => c.id === catId);

    txn.amount         = amount;
    txn.date           = date;
    txn.note           = note;
    txn.type           = this._editType;
    txn.categoryId     = catId;
    txn.categoryName   = cat ? cat.name : '未知';
    txn.categoryIcon   = cat ? cat.icon : '❓';
    txn.categoryIconImg = cat && cat.iconImg ? cat.iconImg : undefined;

    await dbPut('transactions', txn);
    this.closeModal('editTxnModal');
    this._editingTxnId = null;

    const allTxns   = await this.getTransactions(true);
    const monthTxns = this.getTransactionsByMonth(allTxns, this.currentMonth.year, this.currentMonth.month);
    await this.checkBadges(allTxns, monthTxns);
    this.render();
    this.toast('已保存');
  },

  /** 编辑弹窗里的删除按钮 */
  async confirmDeleteTxn() {
    const id = this._editingTxnId;
    if (!id) return;
    if (!confirm('确定删除这条记录？')) return;
    this.closeModal('editTxnModal');
    this._editingTxnId = null;
    await this.deleteTxn(id);
  },

  // ======================== 预算 ========================
  async getBudget() {
    const key = `budget_${this.currentUser.id}_${this.currentMonth.year}_${this.currentMonth.month}`;
    const setting = await dbGet('settings', key);
    return setting ? setting.value : null;
  },

  showBudgetModal() {
    this.getBudget().then(budget => {
      document.getElementById('budgetInput').value = budget || '';
    });
    this.openModal('budgetModal');
  },

  async saveBudget() {
    const val = parseFloat(document.getElementById('budgetInput').value);
    const key = `budget_${this.currentUser.id}_${this.currentMonth.year}_${this.currentMonth.month}`;
    if (val && val > 0) {
      await dbPut('settings', { key, value: val });
      this.toast('预算已设置');
    } else {
      await dbDelete('settings', key);
      this.toast('预算已清除');
    }
    this.closeModal('budgetModal');
    this.render();
  },

  // ======================== 定期收支自动记账 ========================
  /**
   * 定期项结构：
   * { id, name, type('expense'|'income'), amount, categoryId, categoryName, categoryIcon,
   *   freq('daily'|'weekly'|'monthly'), dayOfMonth(1-28), dayOfWeek(0-6),
   *   startDate(YYYY-MM-DD), lastGenDate(YYYY-MM-DD), enabled(bool) }
   */

  async getRecurring() {
    const all = await dbGetAll('recurring');
    // 定期项按用户隔离：无 userId 的旧数据视为当前用户所有，有 userId 的只返回当前用户的
    return all.filter(r => !r.userId || r.userId === this.currentUser.id);
  },

  /** 在 init 时调用：自动补生成所有逾期定期记录 */
  async processRecurring() {
    const items = await this.getRecurring();
    const today = todayStr();
    const records = [];

    for (const item of items) {
      if (!item.enabled) continue;
      const nextDates = this._getOverdueDates(item, today);
      for (const date of nextDates) {
        records.push({
          id:           'r' + item.id + '_' + date.replace(/-/g, ''),
          type:         item.type,
          amount:       item.amount,
          categoryId:   item.categoryId,
          categoryName: item.categoryName,
          categoryIcon: item.categoryIcon,
          date,
          note:         '[定期] ' + item.name,
          mood:         '',
          userId:       this.currentUser.id,
          userName:     this.currentUser.name,
          userColor:    this.currentUser.color,
          createdAt:    new Date().toISOString(),
          fromRecurring: item.id,
        });
      }
      if (nextDates.length > 0) {
        item.lastGenDate = nextDates[nextDates.length - 1];
        await dbPut('recurring', item);
      }
    }

    if (records.length > 0) {
      // 去重（避免重复 id 写入）
      const existing = await dbGetAll('transactions');
      const existIds = new Set(existing.map(t => t.id));
      const newRecs  = records.filter(r => !existIds.has(r.id));
      if (newRecs.length > 0) {
        await dbPutBatch('transactions', newRecs);
        this.toast(`📅 已自动生成 ${newRecs.length} 条定期记录`);
      }
    }
  },

  /**
   * 根据定期项配置，计算从上次生成日期到今天（含）之间应生成的日期列表
   */
  _getOverdueDates(item, today) {
    const start = item.lastGenDate
      ? this._nextDate(item, item.lastGenDate)   // 下一次应该生成的日期
      : (item.startDate || today);
    const dates = [];
    let cursor  = start;
    while (cursor <= today) {
      dates.push(cursor);
      cursor = this._nextDate(item, cursor);
      if (!cursor) break;
    }
    return dates;
  },

  /** 计算指定定期项在 fromDate 之后的下一个触发日期 */
  _nextDate(item, fromDate) {
    const d = new Date(fromDate + 'T00:00:00');
    if (item.freq === 'daily') {
      d.setDate(d.getDate() + 1);
    } else if (item.freq === 'weekly') {
      d.setDate(d.getDate() + 7);
    } else if (item.freq === 'monthly') {
      // 先回到本月 1 号再 +1 月，避免 1/31 溢出到 3/3 导致整月跳过 2 月
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const dom = item.dayOfMonth || 1;
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dom, lastDay));
    } else {
      return null;
    }
    return formatLocalDate(d);
  },

  /** 计算月度定期项首次触发日：本月 dayOfMonth 已过则顺延到下月 */
  _firstMonthlyDate(dayOfMonth) {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth();
    const dom = dayOfMonth || 1;
    const clamp = (yy, mm) => Math.min(dom, new Date(yy, mm + 1, 0).getDate());
    let first = new Date(y, m, clamp(y, m));
    if (first < new Date(y, m, today.getDate())) {
      first = new Date(y, m + 1, clamp(y, m + 1));
    }
    return formatLocalDate(first);
  },

  /** 打开定期收支管理弹窗 */
  async showRecurringManager() {
    const items = await this.getRecurring();
    const cats  = await this.getCategories();
    const list  = document.getElementById('recurringList');

    list.innerHTML = items.length === 0
      ? '<div style="text-align:center;color:var(--text3);padding:24px 0">暂无定期项，点击下方添加</div>'
      : items.map(item => {
        const freqLabel = { daily: '每天', weekly: '每周', monthly: '每月' }[item.freq] || item.freq;
        const typeLabel = item.type === 'income' ? '收入' : '支出';
        return `
          <div class="recurring-item" style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)">
            <div>
              <div style="font-weight:600">${escapeHtml(item.categoryIcon || '📅')} ${escapeHtml(item.name)}</div>
              <div style="font-size:12px;color:var(--text3)">${freqLabel} · ${typeLabel} · ¥${item.amount}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <label class="toggle-wrap">
                <input type="checkbox" ${item.enabled ? 'checked' : ''}
                       onchange="App.toggleRecurring(${jsId(item.id)}, this.checked)">
                <span class="toggle-slider"></span>
              </label>
              <button class="btn btn-outline" style="width:auto;padding:5px 10px;font-size:12px;color:var(--danger);border-color:var(--danger)"
                      onclick="App.deleteRecurring(${jsId(item.id)})">删除</button>
            </div>
          </div>`;
      }).join('');

    // 填充分类选项
    const catSel = document.getElementById('newRecurCat');
    catSel.innerHTML = cats.map(c =>
      `<option value="${escapeHtml(c.id)}" data-icon="${escapeHtml(c.icon)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`
    ).join('');

    this.openModal('recurringModal');
  },

  async addRecurring() {
    const name = document.getElementById('newRecurName').value.trim();
    const type = document.getElementById('newRecurType').value;
    const amt  = parseFloat(document.getElementById('newRecurAmt').value);
    const freq = document.getElementById('newRecurFreq').value;
    const dom  = parseInt(document.getElementById('newRecurDOM').value) || 1;
    const catSel = document.getElementById('newRecurCat');
    const catId  = catSel.value;
    const selOpt = catSel.options[catSel.selectedIndex];

    if (!name)       return this.toast('请输入名称');
    if (!amt || amt <= 0) return this.toast('请输入金额');
    if (!catId)      return this.toast('请选择分类');

    const item = {
      id:           'rec' + Date.now(),
      name, type, amount: amt, freq,
      dayOfMonth:   dom,
      categoryId:   catId,
      categoryName: selOpt ? selOpt.dataset.name : '',
      categoryIcon: selOpt ? selOpt.dataset.icon : '📅',
      startDate:    freq === 'monthly' ? this._firstMonthlyDate(dom) : todayStr(),
      lastGenDate:  '',
      enabled:      true,
      userId:       this.currentUser.id,
    };
    await dbPut('recurring', item);
    document.getElementById('newRecurName').value = '';
    document.getElementById('newRecurAmt').value  = '';
    await this.showRecurringManager();
    this.toast('定期项已添加');
  },

  async toggleRecurring(id, enabled) {
    const items = await this.getRecurring();
    const item  = items.find(r => r.id === id);
    if (!item) return;
    item.enabled = enabled;
    await dbPut('recurring', item);
  },

  async deleteRecurring(id) {
    if (!confirm('删除此定期项？（已生成的记录不受影响）')) return;
    await dbDelete('recurring', id);
    await this.showRecurringManager();
  },

  // ======================== 数据查询 ========================
  /**
   * @param {boolean} filterByUser - 是否按当前用户过滤
   */
  async getTransactions(filterByUser = true) {
    const all = await dbGetAll('transactions');
    const result = filterByUser && this.currentUser
      ? all.filter(t => t.userId === this.currentUser.id)
      : all;
    return result.sort(
      (a, b) => (b.date || '').localeCompare(a.date || '')
        || (b.createdAt || '').localeCompare(a.createdAt || '')
    );
  },

  getTransactionsByMonth(txns, year, month) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    return txns.filter(t => (t.date || '').startsWith(prefix));
  },

  getMonthlyStats(txns) {
    const income  = sumByType(txns, 'income');
    const expense = sumByType(txns, 'expense');
    return { income, expense, balance: income - expense };
  },

  getCategoryBreakdown(txns, type) {
    const map = {};
    txns.filter(t => t.type === type).forEach(t => {
      const catName = t.categoryName || '未分类';
      if (!map[catName]) {
        map[catName] = {
          name: catName, icon: t.categoryIcon,
          iconImg: t.categoryIconImg || '', amount: 0,
        };
      }
      // 若有更新的 iconImg 则更新（最新记录优先）
      if (t.categoryIconImg) map[catName].iconImg = t.categoryIconImg;
      map[catName].amount += t.amount;
    });
    return Object.values(map).sort((a, b) => b.amount - a.amount);
  },

  getMonthlyTrend(txns, year) {
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const prefix = `${year}-${String(m).padStart(2, '0')}`;
      const mt     = txns.filter(t => (t.date || '').startsWith(prefix));
      months.push({
        month:   m,
        income:  sumByType(mt, 'income'),
        expense: sumByType(mt, 'expense'),
      });
    }
    return months;
  },

  // ======================== 月份导航 ========================
  prevMonth() {
    Object.assign(this.currentMonth, shiftMonth(this.currentMonth, -1));
    this.render();
  },
  nextMonth() {
    Object.assign(this.currentMonth, shiftMonth(this.currentMonth, 1));
    this.render();
  },
  statsPrevMonth() {
    Object.assign(this.statsMonth, shiftMonth(this.statsMonth, -1));
    this.renderStats();
  },
  statsNextMonth() {
    Object.assign(this.statsMonth, shiftMonth(this.statsMonth, 1));
    this.renderStats();
  },

  // ======================== 渲染首页 ========================
  async render() {
    const allTxns   = await this.getTransactions(true);

    // ---- 搜索模式：应用过滤条件 ----
    const ss = this.searchState;
    let displayTxns;
    if (ss.active) {
      displayTxns = this._applySearch(allTxns);
    } else {
      displayTxns = this.getTransactionsByMonth(
        allTxns, this.currentMonth.year, this.currentMonth.month
      );
    }
    const stats = this.getMonthlyStats(
      ss.active
        ? this.getTransactionsByMonth(allTxns, this.currentMonth.year, this.currentMonth.month)
        : displayTxns
    );

    // 头部
    document.getElementById('titleText').textContent = this.currentUser.name + ' 的账本';
    document.getElementById('currentUserName').textContent = this.currentUser.name;
    document.getElementById('homeMonth').textContent =
      `${this.currentMonth.year}年${this.currentMonth.month}月`;

    // 搜索模式下月份导航隐藏
    const monthNav = document.getElementById('monthSelector');
    if (monthNav) monthNav.style.display = ss.active ? 'none' : '';

    // 概览数字
    document.getElementById('ovIncome').textContent  = '¥' + stats.income.toFixed(2);
    document.getElementById('ovExpense').textContent = '¥' + stats.expense.toFixed(2);
    document.getElementById('ovBalance').textContent = '¥' + stats.balance.toFixed(2);

    // 数字弹跳效果
    ['ovIncomeBox', 'ovExpenseBox', 'ovBalanceBox'].forEach(id => {
      const el = document.getElementById(id);
      el.classList.remove('bump');
      void el.offsetWidth;   // 强制回流以重启动画
      el.classList.add('bump');
    });

    // 预算进度条（搜索模式下隐藏）
    const budget    = await this.getBudget();
    const budgetCard = document.getElementById('budgetCard');
    if (budget && !ss.active) {
      budgetCard.style.display = 'block';
      const pct  = Math.min((stats.expense / budget) * 100, 100);
      const fill = document.getElementById('budgetFill');
      fill.style.width = pct + '%';
      fill.className   = 'fill ' + (pct > 90 ? 'danger' : pct > 70 ? 'warn' : 'safe');
      document.getElementById('budgetLabel').textContent =
        `¥${stats.expense.toFixed(0)} / ¥${budget}`;
      const remaining = budget - stats.expense;
      const tip       = document.getElementById('budgetTip');
      if (remaining < 0)
        tip.textContent = `⚠️ 已超支 ¥${Math.abs(remaining).toFixed(0)}`;
      else if (pct > 90)
        tip.textContent = `⚡ 即将超支，剩余 ¥${remaining.toFixed(0)}`;
      else {
        const now = new Date();
        const isCurrentMonth =
          this.currentMonth.year === now.getFullYear() &&
          this.currentMonth.month === now.getMonth() + 1;
        if (isCurrentMonth) {
          const daysInMonth = new Date(this.currentMonth.year, this.currentMonth.month, 0).getDate();
          const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
          tip.textContent = `剩余 ¥${remaining.toFixed(0)}，日均可用 ¥${(remaining / daysLeft).toFixed(0)}`;
        } else {
          tip.textContent = `剩余 ¥${remaining.toFixed(0)}`;
        }
      }
    } else {
      budgetCard.style.display = 'none';
    }

    // 交易列表
    const list  = document.getElementById('txnList');
    const empty = document.getElementById('txnEmpty');
    const countEl = document.getElementById('txnCount');
    if (ss.active) {
      countEl.innerHTML = `搜索结果 <b>${displayTxns.length}</b> 条 <a href="#" onclick="App.clearSearch();return false" style="font-size:12px;color:var(--primary);margin-left:6px">清除</a>`;
    } else {
      countEl.textContent = displayTxns.length + '条';
    }
    if (displayTxns.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      list.innerHTML = displayTxns.map((t, i) => `
        <li class="txn-item" style="animation-delay:${i * 0.05}s"
            data-txn-id="${escapeHtml(t.id)}"
            onclick="App._onTxnClick(this)">
          <div class="txn-left">
            <div class="txn-icon" style="background:${t.type === 'income' ? '#FEE' : '#E8F8F5'}">
              ${catIconHtml({ icon: t.categoryIcon, iconImg: t.categoryIconImg }, '22px')}
            </div>
            <div class="txn-info">
              <div class="txn-cat">${escapeHtml(t.categoryName)} ${escapeHtml(t.mood || '')}${ss.active ? `<span class="txn-date-tag">${escapeHtml(t.date)}</span>` : ''}</div>
              <div class="txn-meta">
                ${escapeHtml((t.date || '').slice(5))} · ${escapeHtml(t.userName || '')}${t.note ? ' · ' + escapeHtml(t.note) : ''}
              </div>
            </div>
          </div>
          <div class="txn-right">
            <div class="txn-amount ${t.type === 'income' ? 'in' : 'out'}">
              ${t.type === 'income' ? '+' : '-'}¥${t.amount.toFixed(2)}
            </div>
          </div>
        </li>`
      ).join('');
    }

    // 消费人格
    this.renderPersonality(ss.active ? displayTxns : displayTxns);

    // 徽章（只展示，不在这里触发检查）
    const allBadges = await dbGetAll('badges');
    this.renderBadges(allBadges.filter(b => (b.userId || 'u1') === this.currentUser.id));

    // 愿望清单
    await this.renderWishes(allTxns);

    // 月度对比
    await this.renderCompare(allTxns);
  },

  // ======================== 搜索与筛选 ========================

  /** 应用 searchState 过滤，不限制月份 */
  _applySearch(txns) {
    const ss = this.searchState;
    return txns.filter(t => {
      if (ss.type     && t.type !== ss.type)             return false;
      if (ss.catId    && t.categoryId !== ss.catId)      return false;
      if (ss.amountMin && t.amount < parseFloat(ss.amountMin)) return false;
      if (ss.amountMax && t.amount > parseFloat(ss.amountMax)) return false;
      if (ss.dateFrom  && t.date < ss.dateFrom)          return false;
      if (ss.dateTo    && t.date > ss.dateTo)            return false;
      if (ss.keyword) {
        const kw = ss.keyword.toLowerCase();
        const hit = (t.categoryName || '').toLowerCase().includes(kw)
          || (t.note || '').toLowerCase().includes(kw)
          || String(t.amount).includes(kw);
        if (!hit) return false;
      }
      return true;
    });
  },

  /** 打开搜索面板 */
  async openSearch() {
    const cats = await this.getCategories();
    const catOptions = cats.map(c =>
      `<option value="${escapeHtml(c.id)}" ${this.searchState.catId === c.id ? 'selected' : ''}>${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`
    ).join('');
    document.getElementById('searchCatOptions').innerHTML =
      `<option value="">全部分类</option>` + catOptions;

    // 恢复已有值
    const ss = this.searchState;
    document.getElementById('searchKeyword').value  = ss.keyword;
    document.getElementById('searchType').value     = ss.type;
    document.getElementById('searchAmtMin').value   = ss.amountMin;
    document.getElementById('searchAmtMax').value   = ss.amountMax;
    document.getElementById('searchDateFrom').value = ss.dateFrom;
    document.getElementById('searchDateTo').value   = ss.dateTo;

    this.openModal('searchModal');
  },

  /** 执行搜索 */
  applySearch() {
    this.searchState = {
      active:    true,
      keyword:   document.getElementById('searchKeyword').value.trim(),
      type:      document.getElementById('searchType').value,
      catId:     document.getElementById('searchCatOptions').value,
      amountMin: document.getElementById('searchAmtMin').value,
      amountMax: document.getElementById('searchAmtMax').value,
      dateFrom:  document.getElementById('searchDateFrom').value,
      dateTo:    document.getElementById('searchDateTo').value,
    };
    this.closeModal('searchModal');
    this.render();
  },

  /** 清除搜索 */
  clearSearch() {
    this.searchState = {
      active: false, keyword: '', type: '', catId: '',
      amountMin: '', amountMax: '', dateFrom: '', dateTo: '',
    };
    this.render();
  },

  _onTxnClick(el) {
    this.openEditTxn(el.dataset.txnId);
  },

  // ======================== 统计页 ========================
  async renderStats() {
    // 等待 Chart.js 库加载完成
    if (typeof Chart === 'undefined') {
      setTimeout(() => this.renderStats(), 150);
      return;
    }
    const allTxns   = await this.getTransactions(true);
    const monthTxns = this.getTransactionsByMonth(
      allTxns, this.statsMonth.year, this.statsMonth.month
    );
    document.getElementById('statsMonth').textContent =
      `${this.statsMonth.year}年${this.statsMonth.month}月`;

    // 趋势折线图
    const trend    = this.getMonthlyTrend(allTxns, this.statsMonth.year);
    const trendCtx = document.getElementById('trendChart');
    if (this.trendChart) this.trendChart.destroy();
    this.trendChart = new Chart(trendCtx, {
      type: 'line',
      data: {
        labels:   trend.map(t => t.month + '月'),
        datasets: [
          {
            label:           '收入',
            data:            trend.map(t => t.income),
            borderColor:     '#E17055',
            backgroundColor: 'rgba(225,112,85,0.1)',
            fill: true, tension: 0.4, pointRadius: 3,
          },
          {
            label:           '支出',
            data:            trend.map(t => t.expense),
            borderColor:     '#00B894',
            backgroundColor: 'rgba(0,184,148,0.1)',
            fill: true, tension: 0.4, pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800, easing: 'easeOutBounce' },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 11 } } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { ticks: { font: { size: 10 }, callback: v => '¥' + v } },
        },
      },
    });

    // 支出饼图
    const breakdown = this.getCategoryBreakdown(monthTxns, 'expense');
    const pieCtx    = document.getElementById('pieChart');
    if (this.pieChart) this.pieChart.destroy();
    if (breakdown.length === 0) { this.pieChart = null; return; }
    const colors = ['#00B894', '#0984E3', '#6C5CE7', '#FDCB6E', '#E17055',
                    '#E84393', '#00CEC9', '#636E72', '#B2BEC3', '#DFE6E9'];
    this.pieChart = new Chart(pieCtx, {
      type: 'doughnut',
      data: {
        labels:   breakdown.map(b => (b.icon || '📌') + ' ' + b.name),
        datasets: [{ data: breakdown.map(b => b.amount), backgroundColor: colors.slice(0, breakdown.length), borderWidth: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 1000, animateRotate: true },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: ctx => ` ¥${ctx.raw.toFixed(2)}` } },
        },
      },
    });
  },

  // ======================== 月度对比 ========================
  async renderCompare(allTxns) {
    const card    = document.getElementById('compareCard');
    const content = document.getElementById('compareContent');

    const thisMonth = this.getTransactionsByMonth(
      allTxns, this.currentMonth.year, this.currentMonth.month
    );
    const { year: prevYear, month: prevMonth } = shiftMonth(this.currentMonth, -1);
    const prevMonthTxns = this.getTransactionsByMonth(allTxns, prevYear, prevMonth);

    if (prevMonthTxns.length === 0) { card.style.display = 'none'; return; }

    const thisExp = sumByType(thisMonth, 'expense');
    const prevExp = sumByType(prevMonthTxns, 'expense');
    const diff    = thisExp - prevExp;

    card.style.display = 'block';

    if (diff <= 0) {
      const pct = prevExp > 0 ? Math.abs(diff) / prevExp * 100 : 0;
      content.innerHTML = `<div class="compare-card good">
        <span class="cmp-emoji">${pct > 15 ? '🏆' : pct > 5 ? '🎉' : '👍'}</span>
        <div class="cmp-main">
          <div>比上个月少花了 <b>¥${Math.abs(diff).toFixed(0)}</b>
            ${pct > 15 ? '，相当厉害！' : pct > 5 ? '，不错哦！' : '，稳住了！'}
          </div>
          <div class="cmp-detail">
            ${prevYear}年${prevMonth}月支出 ¥${prevExp.toFixed(0)}
            → ${this.currentMonth.year}年${this.currentMonth.month}月支出 ¥${thisExp.toFixed(0)}
          </div>
        </div></div>`;
    } else {
      const breakdown     = this.getCategoryBreakdown(thisMonth, 'expense');
      const prevBreakdown = this.getCategoryBreakdown(prevMonthTxns, 'expense');
      const increases = [];
      breakdown.forEach(b => {
        const prev    = prevBreakdown.find(pb => pb.name === b.name);
        const prevAmt = prev ? prev.amount : 0;
        if (b.amount > prevAmt) increases.push({ name: b.name, icon: b.icon, iconImg: b.iconImg, diff: b.amount - prevAmt });
      });
      increases.sort((a, b) => b.diff - a.diff);
      const top3 = increases.slice(0, 3)
        .map(item => `${catIconHtml({ icon: item.icon, iconImg: item.iconImg }, '16px')}${escapeHtml(item.name)} +¥${item.diff.toFixed(0)}`)
        .join('，');
      content.innerHTML = `<div class="compare-card bad">
        <span class="cmp-emoji">😅</span>
        <div class="cmp-main">
          <div>比上个月多花了 <b>¥${diff.toFixed(0)}</b></div>
          <div class="cmp-detail">主要多花在：${top3 || '各项均有小幅增长'}</div>
        </div></div>`;
    }
  },

  // ======================== 年度总结 ========================
  yearPrev() { this.yearSummary.year--; this.renderYearSummary(); },
  yearNext() { this.yearSummary.year++; this.renderYearSummary(); },

  async renderYearSummary() {
    const allTxns   = await this.getTransactions(true);
    const year      = this.yearSummary.year;
    document.getElementById('yearLabel').textContent = year + '年';

    const yearTxns  = allTxns.filter(t => (t.date || '').startsWith(year + '-'));
    const totalIn   = sumByType(yearTxns, 'income');
    const totalOut  = sumByType(yearTxns, 'expense');
    const savings   = totalIn - totalOut;
    const saveRate  = totalIn > 0 ? Math.round(savings / totalIn * 100) : 0;

    const now        = new Date();
    const isCurYear  = now.getFullYear() === year;
    const maxMonths  = isCurYear ? now.getMonth() + 1 : 12;
    const avgIn      = Math.round(totalIn  / Math.max(1, maxMonths));
    const avgOut     = Math.round(totalOut / Math.max(1, maxMonths));

    let bestMonth  = { m: 0, amt: -Infinity };
    let worstMonth = { m: 0, amt:  Infinity };
    for (let m = 1; m <= maxMonths; m++) {
      const prefix  = `${year}-${String(m).padStart(2, '0')}`;
      const expense = yearTxns
        .filter(t => (t.date || '').startsWith(prefix) && t.type === 'expense')
        .reduce((s, t) => s + t.amount, 0);
      if (expense > bestMonth.amt) bestMonth  = { m, amt: expense };
      if (expense < worstMonth.amt && expense > 0) worstMonth = { m, amt: expense };
    }

    const breakdown = this.getCategoryBreakdown(yearTxns, 'expense');
    const topCat    = breakdown.slice(0, 3);

    const saveColor = saveRate >= 30
      ? 'var(--expense)' : saveRate >= 10 ? 'var(--accent)' : 'var(--danger)';

    let insight;
    if (saveRate >= 40)
      insight = `<span class="insight-icon">🏆</span><b>太强了！</b>存储率 ${saveRate}%，你简直是理财大师。按这个节奏，明年能存下 <span class="insight-highlight">¥${Math.round(savings * 1.1).toFixed(0)}</span>！`;
    else if (saveRate >= 20)
      insight = `<span class="insight-icon">👍</span><b>不错！</b>存储率 ${saveRate}%，稳扎稳打。如果能再压缩 5% 支出，明年能多存 <span class="insight-highlight">¥${Math.round(totalOut * 0.05).toFixed(0)}</span>。`;
    else if (saveRate >= 0)
      insight = `<span class="insight-icon">💡</span><b>注意！</b>存储率仅 ${saveRate}%，月光族警告。建议每月先存后花，哪怕从 <span class="insight-highlight">¥${Math.round(avgIn * 0.1).toFixed(0)}</span> 开始也好。`;
    else
      insight = `<span class="insight-icon">⚠️</span><b>赤字！</b>今年支出超过收入 ¥${Math.abs(savings).toFixed(0)}，需要尽快调整消费习惯。`;

    document.getElementById('yearSummary').innerHTML = `
      <div class="summary-highlight">
        <div class="hl-item"><div class="hl-val red">¥${totalIn.toFixed(0)}</div><div class="hl-label">📥 年总收入</div></div>
        <div class="hl-item"><div class="hl-val green">¥${totalOut.toFixed(0)}</div><div class="hl-label">📤 年总支出</div></div>
        <div class="hl-item"><div class="hl-val blue">¥${savings.toFixed(0)}</div><div class="hl-label">💰 年结余</div></div>
        <div class="hl-item"><div class="hl-val" style="color:${saveColor}">${saveRate}%</div><div class="hl-label">📊 存储率</div></div>
      </div>
      <div class="summary-salary-card">
        <div class="ss-title">📋 月度财务分解</div>
        <div class="ss-amount">¥${avgIn.toFixed(0)}<span style="font-size:14px;font-weight:400;opacity:0.8"> /月均收入</span></div>
        <div class="ss-breakdown">
          <div class="ss-item">
            <div class="ss-val">¥${avgOut.toFixed(0)}</div>
            <div class="ss-label">月均支出 ${totalIn > 0 ? Math.round(avgOut / avgIn * 100) : 0}%</div>
          </div>
          <div class="ss-item">
            <div class="ss-val">¥${Math.round(avgIn - avgOut)}</div>
            <div class="ss-label">月均存入 ${saveRate}%</div>
          </div>
        </div>
      </div>
      <div class="summary-insight" style="margin-bottom:8px">
        ${topCat.length > 0
          ? `<div>🔝 <b>支出 TOP3：</b>${topCat.map(c => `${catIconHtml({ icon: c.icon, iconImg: c.iconImg }, '16px')}${escapeHtml(c.name)} ¥${c.amount.toFixed(0)}`).join(' &nbsp;')}</div>`
          : ''}
        ${bestMonth.m > 0
          ? `<div>🏖️ <b>最省钱月：</b>${bestMonth.m}月（仅 ¥${bestMonth.amt.toFixed(0)}）</div>`
          : ''}
        ${worstMonth.m > 0 && worstMonth.amt > bestMonth.amt
          ? `<div>💸 <b>最花钱月：</b>${worstMonth.m}月（花了 ¥${worstMonth.amt.toFixed(0)}）</div>`
          : ''}
      </div>
      <div class="summary-insight">${insight}</div>`;
  },

  // ======================== 页面切换 ========================
  switchPage(page, btn) {
    document.querySelectorAll('.page').forEach(p => {
      if (p.classList.contains('active')) {
        p.classList.add('leaving');
        setTimeout(() => p.classList.remove('leaving'), 350);
      }
      p.classList.remove('active');
    });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const target = document.getElementById('page-' + page);
    if (!target) return;
    target.classList.add('active');
    target.style.opacity   = '0';
    target.style.transform = 'translateY(12px)';
    requestAnimationFrame(() => {
      target.style.opacity   = '1';
      target.style.transform = 'translateY(0)';
    });

    if (btn) {
      btn.classList.add('active');
      const icon = btn.querySelector('.icon');
      icon.style.transform = 'scale(1.3)';
      setTimeout(() => { icon.style.transform = ''; }, 300);
    }

    if (page === 'home')     this.render();
    if (page === 'stats')    this.renderStats();
    if (page === 'yearly')   this.renderYearSummary();
    if (page === 'map')      setTimeout(() => this.renderMap(), 100);
    if (page === 'add')      this.setTodayDate();
    window.scrollTo(0, 0);
  },

  // ======================== 导入导出 ========================
  async exportData() {
    const data = await this.collectAllData();
    this.downloadBackup(data, `账本备份_v${BACKUP_FORMAT_VERSION}_${todayStr()}.json`);
    this.toast('导出成功');
  },

  downloadBackup(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // ======================== Excel 导出 ========================
  async exportExcel() {
    if (typeof XLSX === 'undefined') {
      this.toast('Excel 库未加载，请刷新后重试');
      return;
    }
    const txns = await this.getTransactions(true);
    if (txns.length === 0) { this.toast('暂无数据可导出'); return; }

    // 排序：日期降序
    const sorted = [...txns].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const wsData = [
      ['日期', '类型', '金额(元)', '分类', '心情', '地点', '备注', '记录人', '创建时间'],
      ...sorted.map(t => [
        t.date,
        t.type === 'expense' ? '支出' : '收入',
        t.amount,
        t.categoryName || '',
        t.mood || '',
        t.locationName || '',
        t.note || '',
        t.userName || '',
        t.createdAt ? t.createdAt.slice(0, 19).replace('T', ' ') : '',
      ]),
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // 列宽
    ws['!cols'] = [
      { wch: 12 }, { wch: 6 }, { wch: 10 }, { wch: 10 },
      { wch: 6 }, { wch: 20 }, { wch: 20 }, { wch: 8 }, { wch: 20 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, '账单明细');

    // 月度汇总 sheet
    const monthMap = {};
    for (const t of sorted) {
      const key = (t.date || '').slice(0, 7);
      if (!monthMap[key]) monthMap[key] = { income: 0, expense: 0 };
      if (t.type === 'income') monthMap[key].income += t.amount;
      else monthMap[key].expense += t.amount;
    }
    const summaryData = [
      ['月份', '收入(元)', '支出(元)', '结余(元)'],
      ...Object.entries(monthMap).sort((a, b) => b[0].localeCompare(a[0])).map(([k, v]) => [
        k, +v.income.toFixed(2), +v.expense.toFixed(2), +(v.income - v.expense).toFixed(2),
      ]),
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, '月度汇总');

    XLSX.writeFile(wb, `账本_${todayStr()}.xlsx`);
    this.toast('✅ Excel 导出成功');
  },

  // ======================== GPS 定位 ========================
  locateGPS() {
    if (!navigator.geolocation) {
      this.toast('当前浏览器不支持定位');
      return;
    }
    if (localStorage.getItem('ledgerLocationDisclosure') !== 'accepted') {
      if (!confirm(
        '定位会读取你的精确位置，并将经纬度发送给 OpenStreetMap Nominatim 以查询地点名称。\n' +
        '位置也会保存在这笔账目中。是否继续？'
      )) return;
      localStorage.setItem('ledgerLocationDisclosure', 'accepted');
    }
    const btn  = document.getElementById('gpsBtn');
    const hint = document.getElementById('locHint');
    btn.textContent = '⏳';
    btn.disabled    = true;
    hint.textContent = '定位中…';

    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        document.getElementById('addLat').value = lat.toFixed(6);
        document.getElementById('addLng').value = lng.toFixed(6);
        hint.textContent = `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}  精度 ±${Math.round(accuracy)}m`;
        hint.style.color = 'var(--success)';
        btn.textContent  = '✅';
        btn.disabled     = false;
        // 尝试反地理编码（Nominatim，免费无需 Key）
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh`)
          .then(r => r.json())
          .then(d => {
            if (d && d.display_name) {
              const short = (d.address.road || d.address.suburb || d.address.city_district || '')
                + (d.address.city || d.address.town || '');
              const loc = document.getElementById('addLocation');
              if (!loc.value) loc.value = short || d.display_name.split(',')[0];
            }
          })
          .catch(() => {});
      },
      err => {
        hint.textContent = '定位失败：' + (err.message || '未知错误');
        hint.style.color = 'var(--danger)';
        btn.textContent  = '📍';
        btn.disabled     = false;
      },
      { timeout: 10000, maximumAge: 30000 }
    );
  },

  // ======================== 消费地图 ========================
  async renderMap() {
    // 等待 Leaflet 库加载完成
    if (typeof L === 'undefined') {
      setTimeout(() => this.renderMap(), 150);
      return;
    }
    const filter = document.getElementById('mapTypeFilter')?.value || '';
    let txns = await this.getTransactions(true);
    if (filter) txns = txns.filter(t => t.type === filter);

    // 有坐标的记录
    const located = txns.filter(t => t.lat != null && t.lng != null);
    const statsEl  = document.getElementById('mapStats');
    const cardEl   = document.getElementById('mapTxnCard');
    const listEl   = document.getElementById('mapTxnList');
    const countEl  = document.getElementById('mapTxnCount');

    statsEl.textContent = located.length > 0
      ? `共 ${located.length} 条带位置记录（总 ${txns.length} 条），` +
        `消费合计 ¥${located.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0).toFixed(2)}`
      : `暂无带位置的记录。记账时点击 📍 按钮可自动标记当前位置。`;

    const container = document.getElementById('mapContainer');

    if (located.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text3);padding:48px 0;font-size:14px">📍 暂无位置数据<br><br>记账时点击「📍」按钮，<br>即可自动记录消费地点</div>';
      cardEl.style.display = 'none';
      return;
    }

    container.innerHTML = '';
    container.style.height = '340px';
    container.style.borderRadius = '12px';
    container.style.overflow = 'hidden';

    // 等待 Leaflet 加载完
    if (typeof L === 'undefined') {
      container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text3)">地图库加载中，请稍候…</div>';
      return;
    }

    // 销毁旧地图实例
    if (this._leafletMap) {
      this._leafletMap.remove();
      this._leafletMap = null;
    }

    const center = [
      located.reduce((s, t) => s + t.lat, 0) / located.length,
      located.reduce((s, t) => s + t.lng, 0) / located.length,
    ];

    const map = L.map(container, { zoomControl: true }).setView(center, 13);
    this._leafletMap = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    // 热力图点：[lat, lng, intensity]
    const maxAmt = Math.max(...located.map(t => t.amount), 1);
    const heatPoints = located.map(t => [t.lat, t.lng, t.amount / maxAmt]);

    if (typeof L.heatLayer !== 'undefined') {
      L.heatLayer(heatPoints, {
        radius: 28, blur: 20, maxZoom: 17,
        gradient: { 0.2: '#00B894', 0.5: '#FDCB6E', 0.8: '#E17055', 1.0: '#D63031' },
      }).addTo(map);
    }

    // 标记点（按金额大小显示）
    located.forEach(t => {
      const color = t.type === 'expense' ? '#D63031' : '#00B894';
      const r     = Math.max(8, Math.min(20, 8 + (t.amount / maxAmt) * 12));
      const icon  = L.divIcon({
        html: `<div style="width:${r*2}px;height:${r*2}px;border-radius:50%;background:${color};opacity:0.75;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`,
        iconSize: [r*2, r*2],
        iconAnchor: [r, r],
        className: '',
      });
      L.marker([t.lat, t.lng], { icon })
        .bindPopup(`<b>${escapeHtml(t.categoryIcon)} ${escapeHtml(t.categoryName)}</b><br>¥${t.amount}<br>${escapeHtml(t.date)}${t.locationName ? '<br>📍 '+escapeHtml(t.locationName) : ''}${t.note ? '<br>'+escapeHtml(t.note) : ''}`)
        .addTo(map);
    });

    // 列表
    cardEl.style.display = '';
    countEl.textContent  = `${located.length}条`;
    listEl.innerHTML     = [...located]
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(t => `
        <li class="txn-item">
          <div class="txn-left">
            <div class="txn-icon">${escapeHtml(t.categoryIcon)}</div>
            <div class="txn-info">
              <div class="txn-name">${escapeHtml(t.categoryName)}</div>
              <div class="txn-meta">
                📍 ${t.locationName ? escapeHtml(t.locationName) : `${(+t.lat).toFixed(3)}, ${(+t.lng).toFixed(3)}`}
                &nbsp;·&nbsp;${escapeHtml(t.date)}
              </div>
            </div>
          </div>
          <div class="txn-amount ${t.type}">${t.type==='expense'?'-':'+'}¥${t.amount.toFixed(2)}</div>
        </li>`).join('');
  },

  async collectAllData(syncVersion = Date.now()) {
    const values = await Promise.all(DATA_STORES.map(storeName => dbGetAll(storeName)));
    const data = {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      syncVersion,
    };
    DATA_STORES.forEach((storeName, index) => { data[storeName] = values[index]; });
    return data;
  },

  async saveRecoverySnapshot(reason, data = null) {
    const payload = normalizeBackupData(data || await this.collectAllData());
    const snapshot = {
      id: `snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      reason,
      createdAt: new Date().toISOString(),
      data: payload,
    };
    await dbPut(SNAPSHOT_STORE, snapshot);

    const snapshots = await dbGetAll(SNAPSHOT_STORE);
    const stale = snapshots
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(5);
    await Promise.all(stale.map(item => dbDelete(SNAPSHOT_STORE, item.id)));
    return snapshot;
  },

  async refreshAfterDataReplace() {
    await this.initUsers();
    await this.initCategories();
    this.renderCats();
    await this.render();
  },

  async replaceWithBackup(raw, { reason = '数据恢复', markSynced = false } = {}) {
    const normalized = normalizeBackupData(raw);
    const before = await this.collectAllData();
    await this.saveRecoverySnapshot(`${reason}前自动快照`, before);
    await dbReplaceAll(normalized);
    if (markSynced) {
      localStorage.setItem('ledgerLocalDirty', '0');
      localStorage.setItem('ledgerLastSyncedVersion', String(normalized.syncVersion || 0));
    } else {
      localStorage.setItem('ledgerLocalDirty', '1');
    }
    await this.refreshAfterDataReplace();
    return normalized;
  },

  async restoreLatestSnapshot() {
    const snapshots = await dbGetAll(SNAPSHOT_STORE);
    const latest = snapshots.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    if (!latest) return this.toast('暂无自动恢复点');
    const time = new Date(latest.createdAt).toLocaleString('zh-CN');
    if (!confirm(`恢复自动快照？\n${time}\n${latest.reason || ''}\n\n当前数据也会先保存为新的恢复点。`)) return;
    try {
      await this.replaceWithBackup(latest.data, { reason: '恢复历史快照' });
      this.toast('✅ 已恢复自动快照');
    } catch (err) {
      this.toast('恢复失败：' + (err.message || '未知错误'));
    }
  },

  importData() {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.json';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const d = normalizeBackupData(JSON.parse(text));
        if (!confirm(
          `将用备份中的 ${d.transactions.length} 条记录替换当前账本。\n` +
          `替换前会自动创建本地恢复点。\n\n确定继续？`
        )) return;
        await this.replaceWithBackup(d, { reason: '导入 JSON 备份' });
        this.toast('✅ 数据导入成功');
      } catch (err) {
        this.toast('导入失败：' + (err.message || '文件格式不正确'));
      }
    };
    input.click();
  },

  async clearAll() {
    if (!confirm('⚠️ 确定要清空所有数据吗？\n清空前会自动创建恢复点。')) return;
    try {
      await this.saveRecoverySnapshot('清空数据前自动快照');
      const empty = normalizeBackupData({
        formatVersion: BACKUP_FORMAT_VERSION,
        transactions: [], categories: [], users: [], settings: [],
        badges: [], wishes: [], recurring: [],
      });
      await dbReplaceAll(empty);
      localStorage.setItem('ledgerLocalDirty', '1');
      await this.refreshAfterDataReplace();
      this.toast('数据已清空，可在设置中恢复');
    } catch (err) {
      this.toast('清空失败：' + (err.message || '未知错误'));
    }
  },

  // ======================== CSV 账单导入 ========================
  importBillCSV() {
    document.getElementById('csvFileInput').click();
  },

  async handleCSVFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    const text = await file.text();
    if (!text) { this.toast('文件为空'); return; }

    const rows = this.parseCSV(text);
    if (!rows || rows.length === 0) {
      this.toast('未能识别 CSV 格式，请确认是支付宝或微信账单');
      return;
    }

    const type = this.detectCSVType(rows[0]);
    let parsedTxns = [];

    if (type === 'alipay')       parsedTxns = this.parseAlipayCSV(rows);
    else if (type === 'wechat')  parsedTxns = this.parseWechatCSV(rows);
    else { this.toast('未能识别账单类型，请确认是支付宝或微信导出的 CSV'); return; }

    if (parsedTxns.length === 0) { this.toast('未发现有效交易记录'); return; }

    // 去重
    const existing = await dbGetAll('transactions');
    const existSet = new Set(existing.map(x => `${x.date}|${x.amount.toFixed(2)}|${x.note || ''}`));
    const newTxns  = parsedTxns.filter(x => !existSet.has(`${x.date}|${x.amount.toFixed(2)}|${x.note || ''}`));
    const skipped  = parsedTxns.length - newTxns.length;

    const cats    = await this.getCategories();
    const records = [];
    for (const txn of newTxns) {
      const typeCats = cats.filter(c => c.type === txn.type);
      let cat = typeCats.find(c => c.name === txn.categoryName);
      if (!cat) cat = typeCats.find(c => c.id === (txn.type === 'expense' ? 'e10' : 'i5')) || typeCats[0];
      if (!cat) continue;
      records.push({
        id:           't' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type:         txn.type,
        amount:       txn.amount,
        categoryId:   cat.id,
        categoryName: cat.name,
        categoryIcon: cat.icon,
        date:         txn.date,
        note:         txn.note,
        mood:         '',
        userId:       this.currentUser.id,
        userName:     this.currentUser.name,
        userColor:    this.currentUser.color,
        createdAt:    new Date().toISOString(),
      });
    }

    if (records.length > 0) await dbPutBatch('transactions', records);

    this.toast(`✅ 导入 ${records.length} 条${skipped > 0 ? `，跳过 ${skipped} 条重复` : ''}`);
    this.render();
    this.renderCats();
  },

  parseCSV(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('---'));
    const csv   = [];
    for (const line of lines) {
      if (!line.includes(',')) continue;
      const row = [];
      let cell = '', inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
          else inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
          row.push(cell.trim()); cell = '';
        } else {
          cell += ch;
        }
      }
      row.push(cell.trim());
      csv.push(row);
    }
    if (csv.length === 0) return null;
    // Strip BOM
    if (csv[0][0] && csv[0][0].charCodeAt(0) === 0xFEFF) csv[0][0] = csv[0][0].slice(1);
    return csv;
  },

  detectCSVType(row) {
    const joined = row.join(',');
    if (joined.includes('支付宝') || joined.includes('交易号') || joined.includes('交易创建时间'))
      return 'alipay';
    if (joined.includes('微信') || joined.includes('微信支付') ||
        (row.length >= 9 && row[0] === '交易时间'))
      return 'wechat';
    return 'unknown';
  },

  parsePaymentCSV(rows, cfg) {
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === cfg.headerCell) { headerIdx = i; break; }
    }
    if (headerIdx === -1) { this.toast(`未找到${cfg.brand}账单表头`); return []; }

    const h      = rows[headerIdx];
    const cTime  = h.indexOf(cfg.timeCol);
    const cOther = h.indexOf(cfg.otherCol);
    const cGoods = h.indexOf(cfg.goodsCol);
    const cAmt   = h.indexOf(cfg.amtCol);
    const cDir   = h.indexOf(cfg.dirCol);
    const cNote  = Math.max(h.indexOf(cfg.noteCol), -1);

    if (cTime === -1 || cAmt === -1 || cDir === -1) {
      this.toast(`${cfg.brand}账单格式不匹配`); return [];
    }

    const txns = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length <= Math.max(cTime, cAmt, cDir)) continue;
      const dir = (r[cDir] || '').trim();
      if (dir !== '支出' && dir !== '收入') continue;
      const amt = cfg.amountParse(r[cAmt]);
      if (isNaN(amt) || amt <= 0) continue;
      const dateStr = r[cTime] ? r[cTime].split(' ')[0] : '';
      if (!dateStr || !dateStr.includes('-')) continue;

      const other   = cOther >= 0 ? (r[cOther] || '') : '';
      const goods   = cGoods >= 0 ? (r[cGoods] || '') : '';
      const note    = cNote  >= 0 ? (r[cNote]  || '') : '';
      const cat     = guessCategoryFromDesc(goods + other, dir);
      const noteStr = [other, goods, note].filter(Boolean).join(' · ').slice(0, 100);
      txns.push({
        type:         dir === '收入' ? 'income' : 'expense',
        amount:       amt,
        date:         dateStr,
        note:         noteStr || cfg.defaultNote,
        categoryName: cat,
      });
    }
    return txns;
  },

  parseAlipayCSV(rows) {
    return this.parsePaymentCSV(rows, {
      headerCell:  '交易号',
      timeCol:     '交易创建时间',
      otherCol:    '交易对方',
      goodsCol:    '商品名称',
      amtCol:      '金额(元)',
      dirCol:      '收/支',
      noteCol:     '备注',
      defaultNote: '支付宝账单',
      brand:       '支付宝',
      amountParse: v => parseFloat(v),
    });
  },

  parseWechatCSV(rows) {
    return this.parsePaymentCSV(rows, {
      headerCell:  '交易时间',
      timeCol:     '交易时间',
      otherCol:    '交易对方',
      goodsCol:    '商品',
      amtCol:      '金额(元)',
      dirCol:      '收/支',
      noteCol:     '备注',
      defaultNote: '微信账单',
      brand:       '微信',
      amountParse: v => parseFloat(v.replace(/[¥￥,]/g, '')),
    });
  },

  // ======================== GitHub Gist 同步 ========================
  getSyncToken() {
    return sessionStorage.getItem('ledgerSyncToken') || localStorage.getItem('ledgerSyncToken') || '';
  },

  saveSyncTokenFromInput() {
    const input = document.getElementById('syncToken');
    const token = input.value.trim() || this.getSyncToken();
    if (!token) { this.toast('请输入 GitHub Token'); return ''; }
    const remember = document.getElementById('rememberSyncToken').checked;
    sessionStorage.setItem('ledgerSyncToken', token);
    if (remember) localStorage.setItem('ledgerSyncToken', token);
    else localStorage.removeItem('ledgerSyncToken');
    return token;
  },

  clearSyncToken() {
    sessionStorage.removeItem('ledgerSyncToken');
    localStorage.removeItem('ledgerSyncToken');
    const input = document.getElementById('syncToken');
    if (input) input.value = '';
    const remember = document.getElementById('rememberSyncToken');
    if (remember) remember.checked = false;
    this.renderSyncStatus();
    this.toast('Token 已从本设备清除');
  },

  showSyncModal() {
    const el    = document.getElementById('syncToken');
    const saved = this.getSyncToken();
    if (saved) el.value = saved;
    document.getElementById('rememberSyncToken').checked = !!localStorage.getItem('ledgerSyncToken');
    this.renderSyncStatus();
    this.openModal('syncModal');
  },

  renderSyncStatus() {
    const statusEl  = document.getElementById('syncStatus');
    const hasToken  = !!this.getSyncToken();
    const gistId    = localStorage.getItem('ledgerGistId');
    const lastSync  = localStorage.getItem('ledgerSyncTime');

    if (!hasToken || !gistId) {
      statusEl.innerHTML = '<div class="sync-status warn">🔧 请先输入 GitHub Token 并创建 Gist</div>';
      return;
    }
    let html = '<div class="sync-status ok">✅ 已就绪';
    if (lastSync) html += ' · 上次同步：' + lastSync;
    html += '</div>';
    statusEl.innerHTML = html;
  },

  async githubAPI(url, opts = {}) {
    const token = this.getSyncToken();
    if (!token) { this.toast('请先输入 GitHub Token'); return null; }
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept':        'application/vnd.github.v3+json',
      ...opts.headers,
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    try {
      const resp = await fetch(url, {
        method:  opts.method || 'GET',
        headers,
        body:    opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        this.toast('GitHub API 错误: ' + (err.message || resp.status));
        return null;
      }
      return await resp.json();
    } catch (err) {
      this.toast('网络错误: ' + (err.message || '连接失败'));
      return null;
    }
  },

  async getGistId() {
    let gistId = localStorage.getItem('ledgerGistId');
    if (gistId) return gistId;
    const data  = await this.collectAllData();
    const gist  = await this.githubAPI('https://api.github.com/gists', {
      method: 'POST',
      body:   {
        description: 'Shared Ledger 账本数据同步',
        public:      false,
        files:       { 'ledger_data.json': { content: JSON.stringify(data) } },
      },
    });
    if (!gist || !gist.id) return null;
    localStorage.setItem('ledgerGistId', gist.id);
    localStorage.setItem('ledgerLastSyncedVersion', String(data.syncVersion));
    localStorage.setItem('ledgerLocalDirty', '0');
    this.toast('📦 同步仓库已创建');
    return gist.id;
  },

  parseGistBackup(gist) {
    const file = gist?.files?.['ledger_data.json'];
    if (!file || typeof file.content !== 'string') throw new Error('云端备份文件不存在');
    return normalizeBackupData(JSON.parse(file.content));
  },

  async pushSync() {
    if (!this.currentUser) { this.toast('请先选择用户'); return; }
    if (!this.saveSyncTokenFromInput()) return;
    const gistId = await this.getGistId();
    if (!gistId) return;

    const currentGist = await this.githubAPI('https://api.github.com/gists/' + gistId);
    if (!currentGist) return;
    try {
      const remote = this.parseGistBackup(currentGist);
      const lastSynced = Number(localStorage.getItem('ledgerLastSyncedVersion') || 0);
      const remoteChanged = !!remote.syncVersion && (
        lastSynced ? remote.syncVersion !== lastSynced : remote.transactions.length > 0
      );
      if (remoteChanged) {
        await this.saveRecoverySnapshot('上传冲突：保留云端副本', remote);
        if (!confirm(
          '检测到云端已被另一台设备更新。\n' +
          '云端版本已保存为本地恢复点。\n\n仍要用当前设备覆盖云端吗？'
        )) {
          this.toast('已取消上传，云端副本已保留');
          return;
        }
      }
    } catch (err) {
      this.toast('云端数据校验失败：' + (err.message || '格式错误'));
      return;
    }

    const data = await this.collectAllData();
    const gist = await this.githubAPI('https://api.github.com/gists/' + gistId, {
      method: 'PATCH',
      body:   { files: { 'ledger_data.json': { content: JSON.stringify(data) } } },
    });
    if (!gist) return;
    const now = new Date().toLocaleString('zh-CN');
    localStorage.setItem('ledgerSyncTime', now);
    localStorage.setItem('ledgerLastSyncedVersion', String(data.syncVersion));
    localStorage.setItem('ledgerLocalDirty', '0');
    this.toast(`☁️ 数据已上传 (${data.transactions.length} 条记录)`);
    this.renderSyncStatus();
  },

  async pullSync() {
    if (!this.currentUser) { this.toast('请先选择用户'); return; }
    if (!this.saveSyncTokenFromInput()) return;
    const gistId = await this.getGistId();
    if (!gistId) return;
    const gist = await this.githubAPI('https://api.github.com/gists/' + gistId);
    if (!gist) return;
    try {
      const d = this.parseGistBackup(gist);
      const localDirty = localStorage.getItem('ledgerLocalDirty') === '1';
      const lastSynced = Number(localStorage.getItem('ledgerLastSyncedVersion') || 0);
      const remoteChanged = !!d.syncVersion && !!lastSynced && d.syncVersion !== lastSynced;
      const conflictText = localDirty
        ? '检测到本地有尚未上传的修改。继续下载前会把当前本地数据保存为恢复点。\n'
        : remoteChanged ? '检测到云端版本已更新。\n' : '';
      if (!confirm(
        conflictText +
        `将用云端数据替换本地账本。\n` +
        `云端有 ${d.transactions?.length || 0} 条记录。\n` +
        `替换前会自动创建恢复点。\n\n确定继续？`
      )) return;
      await this.replaceWithBackup(d, { reason: '云端同步', markSynced: true });
      const now = new Date().toLocaleString('zh-CN');
      localStorage.setItem('ledgerSyncTime', now);
      this.renderSyncStatus();
      this.toast(`✅ 同步完成 (${d.transactions?.length || 0} 条记录)`);
    } catch (err) {
      this.toast('同步失败：' + (err.message || '数据格式异常'));
    }
  },

  // ======================== 弹窗 ========================
  openModal(id) {
    const el = document.getElementById(id);
    el.classList.add('show');
    el.style.opacity = '0';
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  },

  closeModal(id) {
    const el = document.getElementById(id);
    el.style.opacity = '0';
    setTimeout(() => el.classList.remove('show'), 300);
  },

  // ======================== Toast ========================
  toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.classList.remove('show'), 2000);
  },
};

// ======================== 全局事件 ========================

// 按钮波纹
document.addEventListener('click', e => {
  const btn = e.target.closest('.btn');
  if (btn) App.ripple(e, btn);
});

// 点背景关闭弹窗
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) App.closeModal(e.target.id);
});

// ======================== 启动 ========================
// 内联按钮通过 window.App 调用，显式暴露可避免不同浏览器的全局词法作用域差异。
window.App = App;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  App.installPromptEvent = e;
  App.updateInstallUI();
});

window.addEventListener('appinstalled', () => {
  App.installPromptEvent = null;
  App.updateInstallUI();
  App.toast('✅ 共享账本已安装');
});

App.init();

// ======================== PWA Service Worker ========================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(reg => reg.update())
      .catch(err => console.warn('Service Worker 注册失败', err));
  });
}
