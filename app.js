/* museum — 加密档案阅读器 */
(function () {
  'use strict';

  /* ─────────── 常量 ─────────── */

  var FONT_STEPS = [15, 16, 17, 18, 19, 21, 23];
  var FONT_DEFAULT = 3;                 // 18px
  var K_KEY = 'museum:k';
  var K_FONT = 'museum:font';
  var K_LAST = 'museum:last';
  var K_POS = 'museum:pos:';
  var K_SHELF_Y = 'museum:shelf-y';
  var CHROME_HIDE = 4000;
  var CHROME_INTRO = 2500;
  var POS_DEBOUNCE = 500;
  var DONE_PCT = 0.98;
  var PIN_MIN = 4;
  var PIN_IDLE = 700;
  var CHECK_PLAIN = 'museum-ok';
  var TAP_BAND = 0.55;                  // 纵向中部 55%

  /* ─────────── 纯函数（node 可直测） ─────────── */

  // 保留字母/数字/组合符/下划线/空白/连字符，其余（标点、符号）删除
  var RE_DROP;
  try { RE_DROP = new RegExp('[^\\p{L}\\p{N}\\p{M}_\\s-]', 'gu'); }
  catch (e) { RE_DROP = new RegExp('[^0-9a-z_\\u00C0-\\uFFFF\\s\\-]', 'g'); }

  // GitHub 近似 slug：小写 → 去标点符号 → 每个空白字符各转一个连字符（不合并连续空白）
  function slugify(text) {
    return String(text == null ? '' : text)
      .trim().toLowerCase()
      .replace(RE_DROP, '')
      .replace(/\s/g, '-');
  }

  // 带去重的 slugger（同 GitHub：重复项追加 -1、-2…）
  function makeSlugger() {
    var seen = {};
    return function (text) {
      var s = slugify(text);
      if (!s) s = 'section';
      if (!(s in seen)) { seen[s] = 0; return s; }
      seen[s] += 1;
      return s + '-' + seen[s];
    };
  }

  function isExternal(href) {
    return /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(href) || href.slice(0, 2) === '//';
  }

  function splitHash(href) {
    var i = href.indexOf('#');
    return i < 0 ? [href, ''] : [href.slice(0, i), href.slice(i + 1)];
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // 以 fromSrc（形如 <dir>/<name>.md）为基准解析站内相对路径
  function resolvePath(fromSrc, href) {
    var base = String(fromSrc || '').split('/');
    base.pop();
    var out = href.charAt(0) === '/' ? [] : base;
    var segs = href.replace(/^\/+/, '').split('/');
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return out.join('/');
  }

  // 站内链接归类：external / book / anchor / dead
  function mapHref(fromSrc, rawHref, srcIndex) {
    var href = String(rawHref == null ? '' : rawHref).trim();
    if (!href) return { type: 'dead' };
    if (href.charAt(0) === '#') return { type: 'anchor', hash: safeDecode(href.slice(1)) };
    if (isExternal(href)) return { type: 'external' };
    var parts = splitHash(href);
    var path = safeDecode(parts[0]);
    var hash = parts[1] ? safeDecode(parts[1]) : '';
    if (!/\.md$/i.test(path)) return { type: 'dead' };
    var norm = resolvePath(fromSrc, path);
    var id = srcIndex[norm];
    if (!id) {
      var base = norm.split('/').pop();
      for (var k in srcIndex) {
        if (k.split('/').pop() === base) { id = srcIndex[k]; break; }
      }
    }
    if (!id) return { type: 'dead' };
    if (norm === fromSrc) return { type: 'anchor', hash: hash };
    return { type: 'book', id: id, hash: hash };
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function pctToY(pct, scrollH, viewH) {
    var den = Math.max(0, scrollH - viewH);
    return Math.round(clamp(pct, 0, 1) * den);
  }

  function yToPct(y, scrollH, viewH) {
    var den = scrollH - viewH;
    if (den <= 0) return 1;
    return clamp(y / den, 0, 1);
  }

  function fmtPct(pct) { return Math.round(clamp(pct, 0, 1) * 100) + '%'; }

  // 封面书名：按首个 「——」或「 · 」拆主/副；h1 为空则退回 title
  function splitTitle(b) {
    var t = String((b && b.h1) || '').trim();
    if (!t) t = String((b && b.title) || '').trim();
    var iDash = t.indexOf('——');
    var iDot = t.indexOf(' · ');
    var at = -1, len = 0;
    if (iDash >= 0 && (iDot < 0 || iDash < iDot)) { at = iDash; len = 2; }
    else if (iDot >= 0) { at = iDot; len = 3; }
    if (at <= 0) return { main: t, sub: '' };
    return { main: t.slice(0, at).trim(), sub: t.slice(at + len).trim() };
  }

  // 书架分节：无 group 的档案在前（一节，无节头），其后按出现顺序每个 group 一节
  function shelfSections(books) {
    var plain = [], byGroup = {}, order = [], i;
    for (i = 0; i < (books || []).length; i++) {
      var b = books[i];
      if (!b.group) { plain.push(b); continue; }
      if (!byGroup[b.group]) { byGroup[b.group] = []; order.push(b.group); }
      byGroup[b.group].push(b);
    }
    var out = [];
    if (plain.length) out.push({ group: null, items: plain });
    for (i = 0; i < order.length; i++) out.push({ group: order[i], items: byGroup[order[i]] });
    return out;
  }

  /* CJK 粗体修复：CommonMark 的 flanking 规则让 `**粗体，**后接汉字` 无法闭合。
     在 marked 之前把同行内成对的 ** 直接换成 <strong>，代码区一律不碰。 */

  function fenceOf(line) {
    var m = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/.exec(line);
    if (!m) return null;
    if (m[1].charAt(0) === '`' && m[2].indexOf('`') >= 0) return null;  // ``` 的 info 串不得含反引号
    return { ch: m[1].charAt(0), len: m[1].length, info: m[2].trim() };
  }

  function strongify(text) {
    return text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  }

  // 行内：先把成对反引号包起来的行内代码换成占位符（内容一字不碰），
  // 再对整行做 ** 配对，最后还原。
  // 不能按反引号切段后各段独立配对——一对 ** 跨过行内代码时会被拆成两个孤立
  // 定界符，进而与相邻的 ** 错配（实测 闲聊/家庭App构想.md 有 3 行如此）。
  var NUL = '\u0000';
  var RE_SLOT = new RegExp('\\u0000(\\d+)\\u0000', 'g');

  function fixInlineLine(line) {
    if (line.indexOf(NUL) >= 0) return line;                   // 占位符字符已在原文里 → 不动
    var spans = [], out = '', i = 0, n = line.length;
    while (i < n) {
      var t = line.indexOf('`', i);
      if (t < 0) { out += line.slice(i); break; }
      out += line.slice(i, t);
      var j = t;
      while (j < n && line.charAt(j) === '`') j++;
      var run = j - t, k = j, close = -1;
      while (k < n) {
        var p = line.indexOf('`', k);
        if (p < 0) break;
        var q = p;
        while (q < n && line.charAt(q) === '`') q++;
        if (q - p === run) { close = p; break; }
        k = q;
      }
      if (close < 0) { out += line.slice(t, j); i = j; continue; }   // 未闭合 → 反引号即普通字符
      out += NUL + spans.length + NUL;                     // 行内代码段 → 占位符
      spans.push(line.slice(t, close + run));
      i = close + run;
    }
    out = strongify(out);
    return out.replace(RE_SLOT, function (_, d) { return spans[+d]; });
  }

  function fixCjkStrong(md) {
    var lines = String(md == null ? '' : md).split('\n');
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
      var f = fenceOf(lines[i]);
      if (fence) {
        if (f && f.ch === fence.ch && f.len >= fence.len && f.info === '') fence = null;
        continue;                                                   // 围栏内原样
      }
      if (f) { fence = f; continue; }
      lines[i] = fixInlineLine(lines[i]);
    }
    return lines.join('\n');
  }

  // 文档自身的「目录」不算章节
  function isChapterHeading(text) {
    return String(text == null ? '' : text).trim() !== '目录';
  }

  // 引用块内的 H2 是被引述的他册标题，不计入本册章节（其 id 照常保留）
  function isQuotedHeading(node) {
    return !!(node && node.closest && node.closest('blockquote'));
  }

  var TEST = {
    slugify: slugify, makeSlugger: makeSlugger, isExternal: isExternal,
    splitHash: splitHash, resolvePath: resolvePath, mapHref: mapHref,
    pctToY: pctToY, yToPct: yToPct, fmtPct: fmtPct,
    splitTitle: splitTitle, shelfSections: shelfSections,
    fixCjkStrong: fixCjkStrong, fixInlineLine: fixInlineLine, fenceOf: fenceOf,
    isChapterHeading: isChapterHeading, isQuotedHeading: isQuotedHeading,
    FONT_STEPS: FONT_STEPS
  };
  if (typeof window !== 'undefined') window.__museum_test = TEST;
  else if (typeof globalThis !== 'undefined') globalThis.__museum_test = TEST;

  /* ─────────── base64 / 加密 ─────────── */

  function b64ToBytes(b64) {
    var bin = atob(String(b64));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function bytesToB64(u) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(s);
  }

  function deriveBits(pass, salt, iters) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits'])
      .then(function (km) {
        return crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: salt, iterations: iters, hash: 'SHA-256' }, km, 256);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }

  function importAesKey(rawBits) {
    return crypto.subtle.importKey('raw', rawBits, { name: 'AES-GCM' }, false, ['decrypt']);
  }

  function decryptText(box, key) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(box.iv) }, key, b64ToBytes(box.ct)
    ).then(function (buf) { return new TextDecoder('utf-8').decode(buf); });
  }

  /* ─────────── 运行时状态 ─────────── */

  var KEY = null, META = null, BOOKS = [], BY_ID = {}, SRC_INDEX = {};
  var MD_CACHE = {};
  var view = 'unlock';                  // unlock | shelf | read
  var cur = null;                       // 当前书 meta
  var curChapters = [];
  var fontIdx = FONT_DEFAULT;
  var chromeOn = false, chromeTimer = null;
  var posTimer = null, rafPending = false, shelfTimer = null;
  var busy = false, pinTimer = null, navBusy = false, activeScreen = null;
  var el = {};

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function readPos(id) {
    var raw = ls(K_POS + id);
    if (!raw) return null;
    try { var o = JSON.parse(raw); return typeof o.pct === 'number' ? o : null; } catch (e) { return null; }
  }

  function url(p) { return new URL(p, location.href).href; }

  function fetchJSON(p) {
    return fetch(url(p)).then(function (r) {
      if (!r.ok) { var e = new Error('http ' + r.status); e.net = true; throw e; }
      return r.json();
    }, function (err) { var e = new Error('net'); e.net = true; e.cause = err; throw e; });
  }

  /* ─────────── 引导 ─────────── */

  function boot() {
    // 不安全上下文没有 crypto.subtle，整个阅读器无法工作 → 先升到 https
    if (location.protocol === 'http:' &&
        location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      location.replace('https://' + location.host + location.pathname + location.search + location.hash);
      return;
    }
    el.unlock = document.getElementById('scrUnlock');
    el.shelf = document.getElementById('scrShelf');
    el.read = document.getElementById('scrRead');
    el.doc = document.getElementById('doc');
    el.pin = document.getElementById('pin');
    el.pinForm = document.getElementById('pinForm');
    el.unlockBox = document.querySelector('.unlock-box');
    el.books = document.getElementById('books');
    el.chrome = document.getElementById('chrome');
    el.topbar = document.getElementById('topbar');
    el.btnBack = document.getElementById('btnBack');
    el.btnToc = document.getElementById('btnToc');
    el.btnFontDown = document.getElementById('btnFontDown');
    el.btnFontUp = document.getElementById('btnFontUp');
    el.pctLabel = document.getElementById('pctLabel');
    el.sheetWrap = document.getElementById('sheetWrap');
    el.sheetList = document.getElementById('sheetList');
    el.sheetBackdrop = document.getElementById('sheetBackdrop');

    var f = parseInt(ls(K_FONT), 10);
    fontIdx = (f >= 0 && f < FONT_STEPS.length) ? f : FONT_DEFAULT;
    el.doc.style.fontSize = FONT_STEPS[fontIdx] + 'px';

    wire();
    registerSW();
    resume();
  }

  function wire() {
    el.pinForm.addEventListener('submit', function (e) {
      e.preventDefault();
      clearTimeout(pinTimer);
      attempt();
    });
    el.pin.addEventListener('input', function () {
      clearTimeout(pinTimer);
      var v = el.pin.value.replace(/\D/g, '');
      if (v !== el.pin.value) el.pin.value = v;
      if (v.length >= PIN_MIN) pinTimer = setTimeout(attempt, PIN_IDLE);
    });

    el.btnBack.addEventListener('click', function () { bumpChrome(); location.hash = '#/'; });
    el.btnToc.addEventListener('click', function () { bumpChrome(); openSheet(); });
    el.btnFontDown.addEventListener('click', function () { bumpChrome(); setFont(fontIdx - 1); });
    el.btnFontUp.addEventListener('click', function () { bumpChrome(); setFont(fontIdx + 1); });
    el.sheetBackdrop.addEventListener('click', closeSheet);

    el.doc.addEventListener('click', onDocClick);
    window.addEventListener('hashchange', route);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { if (view === 'read') paintPct(); });
    document.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pagehide', flushPos);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushPos();
    });
  }

  /* ─────────── 解锁 ─────────── */

  function ensureMeta() {
    if (META) return Promise.resolve(META);
    return fetchJSON('data/meta.json').then(function (m) { META = m; return m; });
  }

  // true=口令对；false=口令错；抛错=网络问题
  function verifyKey(key) {
    return fetchJSON('data/check.json').then(function (box) {
      return decryptText(box, key).then(function (t) { return t === CHECK_PLAIN; },
        function () { return false; });
    });
  }

  function loadManifest() {
    return fetchJSON('data/manifest.json').then(function (box) {
      return decryptText(box, KEY);
    }).then(function (txt) {
      var m = JSON.parse(txt);
      BOOKS = m.books || [];
      BY_ID = {}; SRC_INDEX = {};
      for (var i = 0; i < BOOKS.length; i++) {
        BY_ID[BOOKS[i].id] = BOOKS[i];
        SRC_INDEX[BOOKS[i].src] = BOOKS[i].id;
      }
      return m;
    });
  }

  function setBusy(on) {
    busy = on;
    el.unlock.classList.toggle('is-busy', !!on);
    el.pin.readOnly = !!on;
  }

  function shakeAndClear() {
    el.pin.value = '';
    el.unlockBox.classList.remove('is-shake');
    void el.unlockBox.offsetWidth;
    el.unlockBox.classList.add('is-shake');
    setTimeout(function () { el.unlockBox.classList.remove('is-shake'); }, 340);
    try { el.pin.focus(); } catch (e) {}
  }

  function attempt() {
    if (busy) return;
    var pin = el.pin.value;
    if (!pin) return;
    setBusy(true);
    ensureMeta()
      .then(function (meta) { return deriveBits(pin, b64ToBytes(meta.salt), meta.iters); })
      .then(function (bits) {
        return importAesKey(bits).then(function (key) {
          return verifyKey(key).then(function (ok) {
            if (!ok) { var e = new Error('pin'); e.pin = true; throw e; }
            KEY = key;
            lsSet(K_KEY, JSON.stringify({ v: META.v, salt: META.salt, iters: META.iters, k: bytesToB64(bits) }));
            return loadManifest();
          });
        });
      })
      .then(function () {
        setBusy(false);
        el.pin.value = '';
        try { el.pin.blur(); } catch (e) {}
        enter(true);
      })
      .catch(function (err) {
        setBusy(false);
        if (err && err.net) { try { el.pin.focus(); } catch (e) {} return; }
        shakeAndClear();
      });
  }

  // 已存密钥 → 免输
  function resume() {
    var raw = ls(K_KEY), saved = null;
    try { saved = raw ? JSON.parse(raw) : null; } catch (e) { saved = null; }
    if (!saved || !saved.k) { showUnlock(); return; }
    ensureMeta().then(function (meta) {
      if (saved.v !== meta.v || saved.salt !== meta.salt || saved.iters !== meta.iters) {
        lsDel(K_KEY); showUnlock(); return null;
      }
      return importAesKey(b64ToBytes(saved.k)).then(function (key) {
        return verifyKey(key).then(function (ok) {
          if (!ok) { lsDel(K_KEY); showUnlock(); return null; }
          KEY = key;
          return loadManifest().then(function () { enter(false); });
        }, function () {                       // 离线：无法校验，直接试用
          KEY = key;
          return loadManifest().then(function () { enter(false); }, function () { showUnlock(); });
        });
      });
    }).catch(function () { showUnlock(); });
  }

  function showUnlock() {
    view = 'unlock';
    el.unlock.hidden = false;
    setTimeout(function () { try { el.pin.focus(); } catch (e) {} }, 60);
  }

  // 解锁成功 → 进入路由目标（400ms 淡出）
  function enter(fromUnlock) {
    var h = parseHash();
    if (h.id && BY_ID[h.id]) {
      openBook(h.id, el.unlock, !!fromUnlock);
    } else {
      if (h.id) location.replace('#/');
      renderShelf();
      crossFade(el.unlock, el.shelf, function () { window.scrollTo(0, 0); }, !!fromUnlock);
      view = 'shelf';
    }
    schedulePrefetch();
  }

  /* ─────────── 路由 ─────────── */

  function parseHash() {
    var m = /^#\/read\/([0-9a-f]{4,})$/.exec(location.hash || '');
    return { id: m ? m[1] : null };
  }

  function route() {
    if (!KEY) return;
    var h = parseHash();
    if (h.id && BY_ID[h.id]) {
      if (view === 'read' && cur && cur.id === h.id) return;
      openBook(h.id, view === 'shelf' ? el.shelf : el.read, false);
    } else {
      if (view === 'shelf') return;
      backToShelf();
    }
  }

  /* ─────────── 书架 ─────────── */

  function renderShelf() {
    el.books.textContent = '';
    var secs = shelfSections(BOOKS);
    for (var s = 0; s < secs.length; s++) {
      if (secs[s].group) {
        var head = document.createElement('div');
        head.className = 'sec-head';
        head.textContent = secs[s].group;
        el.books.appendChild(head);
      }
      var grid = document.createElement('div');
      grid.className = 'grid';
      var items = secs[s].items;
      for (var i = 0; i < items.length; i++) {
        (function (b) {
          var pos = readPos(b.id);
          var cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'cell';
          var cover = document.createElement('div');
          cover.className = 'cover';
          var parts = splitTitle(b);
          var t = document.createElement('div');
          t.className = 'cover-t';
          t.textContent = parts.main;
          cover.appendChild(t);
          if (parts.sub) {
            var sb = document.createElement('div');
            sb.className = 'cover-s';
            sb.textContent = parts.sub;
            cover.appendChild(sb);
          }
          cell.appendChild(cover);
          if (pos) {
            var p = document.createElement('div');
            p.className = 'cell-pct';
            p.textContent = fmtPct(pos.pct);
            cell.appendChild(p);
          }
          cell.addEventListener('click', function () { go(b.id); });
          grid.appendChild(cell);
        })(items[i]);
      }
      el.books.appendChild(grid);
    }
  }

  function go(id) { location.hash = '#/read/' + id; }

  function backToShelf() {
    flushPos();
    hideChrome(true);
    closeSheet();
    renderShelf();
    var y = 0;
    try { y = parseInt(sessionStorage.getItem(K_SHELF_Y) || '0', 10) || 0; } catch (e) { y = 0; }
    crossFade(el.read, el.shelf, function () {
      var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.min(y, max));
    }, false);
    view = 'shelf';
    cur = null;
  }

  /* ─────────── 阅读 ─────────── */

  function loadMd(id) {
    if (MD_CACHE[id]) return Promise.resolve(MD_CACHE[id]);
    return fetchJSON('data/' + id + '.json')
      .then(function (box) { return decryptText(box, KEY); })
      .then(function (md) { MD_CACHE[id] = md; return md; });
  }

  function openBook(id, fromEl, slow) {
    if (navBusy) return;
    var b = BY_ID[id];
    if (!b) { location.replace('#/'); return; }
    navBusy = true;
    if (view === 'shelf') { clearTimeout(shelfTimer); saveShelfY(); }
    if (view === 'read') flushPos();
    loadMd(id).then(function (md) {
      cur = b;
      paintDoc(b, md);
      var pos = readPos(id);
      var pct = pos ? pos.pct : 0;
      crossFade(fromEl, el.read, function () {
        window.scrollTo(0, pctToY(pct, document.documentElement.scrollHeight, window.innerHeight));
      }, !!slow);
      view = 'read';
      lsSet(K_LAST, id);
      paintPct();
      showChrome(CHROME_INTRO);
      navBusy = false;
    }).catch(function () {
      navBusy = false;
      if (view === 'unlock') { renderShelf(); crossFade(el.unlock, el.shelf, null, !!slow); view = 'shelf'; }
      else location.replace('#/');
    });
  }

  function paintDoc(b, md) {
    var host = document.createElement('div');
    host.innerHTML = window.marked.parse(fixCjkStrong(md), { gfm: true, breaks: false, pedantic: false });

    var slug = makeSlugger();
    var ids = {};
    curChapters = [];
    var hs = host.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < hs.length; i++) {
      var id = slug(hs[i].textContent || '');
      hs[i].id = id;
      ids[id] = true;
      if (hs[i].tagName === 'H2' && !isQuotedHeading(hs[i])) {
        var htext = (hs[i].textContent || '').trim();
        if (isChapterHeading(htext)) curChapters.push({ id: id, text: htext });
      }
    }

    var h1 = host.querySelector('h1');
    if (h1 && b.date) {
      var d = document.createElement('div');
      d.className = 'doc-date';
      d.textContent = b.date;
      if (h1.nextSibling) h1.parentNode.insertBefore(d, h1.nextSibling);
      else h1.parentNode.appendChild(d);
    }

    var hrs = host.querySelectorAll('hr');
    for (var j = 0; j < hrs.length; j++) {
      var dots = document.createElement('div');
      dots.className = 'hr-dots';
      dots.textContent = '· · ·';
      hrs[j].parentNode.replaceChild(dots, hrs[j]);
    }

    var tables = host.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var wrap = document.createElement('div');
      wrap.className = 'tw';
      tables[t].parentNode.insertBefore(wrap, tables[t]);
      wrap.appendChild(tables[t]);
    }

    var as = host.querySelectorAll('a');
    for (var a = 0; a < as.length; a++) fixLink(as[a], b, ids);

    var end = document.createElement('div');
    end.className = 'doc-end';
    end.textContent = '— 完 —';
    host.appendChild(end);
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'doc-back';
    back.textContent = '返回书架';
    back.addEventListener('click', function () { location.hash = '#/'; });
    host.appendChild(back);

    el.doc.textContent = '';
    while (host.firstChild) el.doc.appendChild(host.firstChild);
    el.doc.style.fontSize = FONT_STEPS[fontIdx] + 'px';
    updateFontBtns();
    updateTocBtn();
  }

  function fixLink(a, b, ids) {
    var r = mapHref(b.src, a.getAttribute('href'), SRC_INDEX);
    if (r.type === 'external') {
      a.target = '_blank';
      a.rel = 'noopener';
      return;
    }
    if (r.type === 'book') {
      a.setAttribute('href', '#/read/' + r.id);
      a.setAttribute('data-nav', r.id);
      return;
    }
    if (r.type === 'anchor') {
      var target = r.hash;
      if (target && !ids[target]) {
        var alt = slugify(a.textContent || '');
        if (alt && ids[alt]) target = alt;
        else {
          var hit = '';
          for (var k in ids) {
            if (k.length >= 6 && (k.indexOf(target) === 0 || target.indexOf(k) === 0)) { hit = k; break; }
          }
          target = hit;
        }
      }
      if (!target) { unwrap(a); return; }
      if (!ids[target]) { unwrap(a); return; }
      a.setAttribute('href', '#' + encodeURIComponent(target));
      a.setAttribute('data-anchor', target);
      return;
    }
    unwrap(a);
  }

  function unwrap(a) {
    while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
    a.parentNode.removeChild(a);
  }

  function onDocClick(e) {
    var a = e.target.closest ? e.target.closest('a[data-anchor]') : null;
    if (!a) return;
    e.preventDefault();
    jumpTo(a.getAttribute('data-anchor'));
  }

  function jumpTo(id) {
    var node = id ? document.getElementById(id) : null;
    if (!node) { window.scrollTo(0, 0); return; }
    var off = chromeOn ? (el.topbar.getBoundingClientRect().height + 8) : 12;
    var y = node.getBoundingClientRect().top + (window.pageYOffset || 0) - off;
    window.scrollTo(0, Math.max(0, Math.round(y)));
    node.classList.remove('hl');
    void node.offsetWidth;
    node.classList.add('hl');
    setTimeout(function () { node.classList.remove('hl'); }, 640);
    savePos();
  }

  /* ─────────── 进度 / 位置 ─────────── */

  function curPct() {
    return yToPct(window.pageYOffset || 0, document.documentElement.scrollHeight, window.innerHeight);
  }

  function onScroll() {
    if (view === 'read') {
      if (chromeOn && !rafPending) {
        rafPending = true;
        requestAnimationFrame(function () { rafPending = false; paintPct(); });
      }
      clearTimeout(posTimer);
      posTimer = setTimeout(savePos, POS_DEBOUNCE);
    } else if (view === 'shelf') {
      clearTimeout(shelfTimer);
      shelfTimer = setTimeout(saveShelfY, 150);
    }
  }

  function saveShelfY() {
    try { sessionStorage.setItem(K_SHELF_Y, String(window.pageYOffset || 0)); } catch (e) {}
  }

  function paintPct() { el.pctLabel.textContent = fmtPct(curPct()); }

  function savePos() {
    if (view !== 'read' || !cur) return;
    var pct = curPct();
    lsSet(K_LAST, cur.id);
    if (pct >= DONE_PCT) lsDel(K_POS + cur.id);
    else lsSet(K_POS + cur.id, JSON.stringify({ pct: pct, t: Date.now() }));
  }

  function flushPos() { clearTimeout(posTimer); savePos(); }

  /* ─────────── 字号 ─────────── */

  function setFont(i) {
    var next = clamp(i, 0, FONT_STEPS.length - 1);
    if (next === fontIdx) { updateFontBtns(); return; }
    var pct = curPct();
    fontIdx = next;
    lsSet(K_FONT, String(fontIdx));
    el.doc.style.fontSize = FONT_STEPS[fontIdx] + 'px';
    updateFontBtns();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        window.scrollTo(0, pctToY(pct, document.documentElement.scrollHeight, window.innerHeight));
        paintPct();
        savePos();
      });
    });
  }

  function updateFontBtns() {
    el.btnFontDown.disabled = fontIdx <= 0;
    el.btnFontUp.disabled = fontIdx >= FONT_STEPS.length - 1;
  }

  // 无章节可列 → 目录按钮置灰禁用（三级色）
  function updateTocBtn() {
    var off = curChapters.length === 0;
    el.btnToc.disabled = off;
    el.btnToc.style.color = off ? 'var(--label-3)' : '';
  }

  /* ─────────── Chrome ─────────── */

  function showChrome(ms) {
    el.chrome.hidden = false;
    if (!chromeOn) {
      void el.chrome.offsetWidth;
      el.chrome.classList.add('is-on');
      chromeOn = true;
    }
    paintPct();
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () { hideChrome(false); }, ms || CHROME_HIDE);
  }

  function hideChrome(instant) {
    clearTimeout(chromeTimer);
    if (!chromeOn) { if (instant) el.chrome.hidden = true; return; }
    chromeOn = false;
    el.chrome.classList.remove('is-on');
    setTimeout(function () { if (!chromeOn) el.chrome.hidden = true; }, instant ? 0 : 280);
  }

  function toggleChrome() {
    if (chromeOn) hideChrome(false); else showChrome(CHROME_HIDE);
  }

  function bumpChrome() {
    if (!chromeOn) return;
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () { hideChrome(false); }, CHROME_HIDE);
  }

  var dx0 = 0, dy0 = 0, dt0 = 0, tapArmed = false;

  function onDown(e) {
    tapArmed = false;
    if (view !== 'read') return;
    if (el.sheetWrap.hidden === false) return;
    var t = e.target;
    if (t && t.closest && t.closest('a,button,.topbar,.bottombar,.sheet,.sheet-backdrop')) return;
    dx0 = e.clientX; dy0 = e.clientY; dt0 = Date.now();
    tapArmed = true;
  }

  function onUp(e) {
    if (!tapArmed) return;
    tapArmed = false;
    if (Math.abs(e.clientX - dx0) > 10 || Math.abs(e.clientY - dy0) > 10) return;
    if (Date.now() - dt0 > 500) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.toString && sel.toString().length > 0) return;
    var h = window.innerHeight;
    var half = (h * TAP_BAND) / 2;
    if (e.clientY < h / 2 - half || e.clientY > h / 2 + half) return;
    toggleChrome();
  }

  /* ─────────── 章节 sheet ─────────── */

  function openSheet() {
    el.sheetList.textContent = '';
    if (!curChapters.length) {
      var em = document.createElement('div');
      em.className = 'sheet-empty';
      em.textContent = '本册无章节';
      el.sheetList.appendChild(em);
    } else {
      var curId = currentChapterId();
      for (var i = 0; i < curChapters.length; i++) {
        (function (c) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'sheet-item' + (c.id === curId ? ' is-cur' : '');
          b.textContent = c.text;
          b.addEventListener('click', function () { closeSheet(); jumpTo(c.id); });
          el.sheetList.appendChild(b);
        })(curChapters[i]);
      }
    }
    el.sheetWrap.hidden = false;
    void el.sheetWrap.offsetWidth;
    el.sheetWrap.classList.add('is-on');
    var active = el.sheetList.querySelector('.is-cur');
    if (active) {
      var sheet = el.sheetList.parentNode;
      sheet.scrollTop = Math.max(0, active.offsetTop - sheet.clientHeight / 3);
    }
  }

  function closeSheet() {
    if (el.sheetWrap.hidden) return;
    el.sheetWrap.classList.remove('is-on');
    setTimeout(function () {
      if (!el.sheetWrap.classList.contains('is-on')) el.sheetWrap.hidden = true;
    }, 280);
    bumpChrome();
  }

  function currentChapterId() {
    var found = '';
    for (var i = 0; i < curChapters.length; i++) {
      var n = document.getElementById(curChapters[i].id);
      if (!n) continue;
      if (n.getBoundingClientRect().top <= 80) found = curChapters[i].id;
      else break;
    }
    return found || (curChapters.length ? curChapters[0].id : '');
  }

  /* ─────────── 屏幕切换 ─────────── */

  function crossFade(outEl, inEl, prep, slow) {
    var dur = slow ? 400 : 200;
    // 快速连点：旧定时器不得藏掉新页面，但仍要把真正退场的那屏收拾干净
    activeScreen = inEl;
    if (outEl) outEl.style.cssText = '';
    inEl.style.cssText = '';
    if (!outEl || outEl === inEl) {
      inEl.hidden = false;
      if (prep) prep();
      return;
    }
    var y = window.pageYOffset || 0;
    outEl.style.position = 'fixed';
    outEl.style.left = '0';
    outEl.style.right = '0';
    outEl.style.top = (-y) + 'px';
    outEl.style.zIndex = '5';
    outEl.style.pointerEvents = 'none';
    outEl.style.transition = 'opacity ' + dur + 'ms ease';
    inEl.hidden = false;
    inEl.style.transition = 'none';
    inEl.style.opacity = '0';
    if (prep) prep();
    void inEl.offsetHeight;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        outEl.style.opacity = '0';
        inEl.style.transition = 'opacity ' + dur + 'ms ease';
        inEl.style.opacity = '1';
      });
    });
    setTimeout(function () {
      if (outEl !== activeScreen) {     // outEl 已被新切换重新启用时不能藏
        outEl.hidden = true;
        outEl.style.cssText = '';
      }
      if (inEl === activeScreen) {
        inEl.style.transition = '';
        inEl.style.opacity = '';
      }
    }, dur + 40);
  }

  /* ─────────── Service Worker / 预取 ─────────── */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  function schedulePrefetch() {
    if (!('serviceWorker' in navigator) || !BOOKS.length) return;
    var fired = false;
    var go = function () {
      if (fired) return;
      fired = true;
      var list = [];
      for (var i = 0; i < BOOKS.length; i++) list.push(url('data/' + BOOKS[i].id + '.json'));
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg && reg.active) reg.active.postMessage({ type: 'museum-prefetch', urls: list });
      }).catch(function () {});
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 6000 });
    else setTimeout(go, 3000);
  }

  /* ─────────── go ─────────── */

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
