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
  var K_TOPIC_Y = 'museum:topic-y';
  var K_MEMOS = 'museum:memos';
  var K_NOTES = 'museum:notes';
  var K_HL = 'museum:highlights';
  var K_MEMO_TS = 'museum:memo-ts';
  var K_PAT = 'museum:pat';
  var CHROME_HIDE = 4000;
  var CHROME_INTRO = 2500;
  var POS_DEBOUNCE = 500;
  var DONE_PCT = 0.98;
  var PIN_MIN = 4;
  var PIN_IDLE = 700;
  var CHECK_PLAIN = 'museum-ok';
  var TAP_BAND = 0.55;                  // 纵向中部 55%
  var CTX_LEN = 20;                     // 锚定上下文长度
  var SNIP_LEN = 18;                    // 命中片段前后长度
  var FIND_WAIT = 150;
  var BAR_HIDE = 4000;                  // 搜索胶囊无交互自隐
  var BAR_THRESH = 4;                   // 手势方向判定阈值（px）
  var ARM_WIN = 2000;                   // 垃圾桶两击确认窗口
  var SYNC_WAIT = 3000;
  var SYNC_REPO = 'TricGrizen/museum-sync';
  var SYNC_API = 'https://api.github.com/repos/' + SYNC_REPO + '/contents/';
  var SYNC_FILE = { memos: 'memos.json', notes: 'notes.json', highlights: 'highlights.json' };
  var HL_KEYS = ['y', 'g', 'b', 'p', 'v'];

  // 与顶栏返回键同一字形（静态常量，无外部输入）
  var CHEVRON_SVG =
    '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M15.5 4.5 8 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHEVRON_R_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M9 4.5 16.5 12 9 19.5" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

  function fmtWan(chars) { return (Math.max(0, chars || 0) / 10000).toFixed(1); }

  function fmtMD(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    return m ? m[2] + '-' + m[3] : String(date || '');
  }

  // 北京时间（与设备时区无关）：MM-DD HH:mm
  function bjt(ms) {
    var d = new Date(Number(ms) || 0);
    var f = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    var p = {}, parts = f.formatToParts(d);
    for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
    return p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }

  // 条目时间行：北京时间 +（有编辑时）改n
  function stampOf(it) {
    var n = it && it.edits ? it.edits.length : 0;
    return bjt(it ? it.createdAt : 0) + (n > 0 ? ' · 改' + n : '');
  }

  // 列表第二行：裸值元数据。档案 `MM-DD · n问 · x.x万字`（qcount=0 省略 n问 段）；
  // 课程册只给 `x.x万字`（讲次在行首 token，日期不重复）。零描述性文字。
  function rowMeta(b) {
    if (!b) return '';
    var wan = fmtWan(b.chars) + '万字';
    if (b.group) return wan;
    var s = fmtMD(b.date);
    if (b.qcount > 0) s += ' · ' + b.qcount + '问';
    return s + ' · ' + wan;
  }

  // 课程入口行第二行：n讲 · x.x万字（合计）
  function topicMeta(items) {
    var n = (items || []).length, sum = 0;
    for (var i = 0; i < n; i++) sum += (items[i].chars || 0);
    return n + '讲 · ' + fmtWan(sum) + '万字';
  }

  // 弱前缀：本身不成书名的分类/序号段，降级为行首 token 而非主名
  var WEAK_PREFIX = [/^闲聊$/, /^第\s*\d+\s*[课讲]$/, /^\d{4}-\d{2}-\d{2}$/, /^入门课程$/];

  function isWeakPrefix(s) {
    for (var i = 0; i < WEAK_PREFIX.length; i++) if (WEAK_PREFIX[i].test(s)) return true;
    return false;
  }

  // 书名拆分：按首个 「——」或「 · 」拆；左段命中弱前缀 → 左作行首 token、右作主名（无副名），
  // 否则左=主名、右=副名（副名不进列表行）。无分隔符 → 整体主名；h1 为空则退回 title。
  function splitTitle(b) {
    var t = String((b && b.h1) || '').trim();
    if (!t) t = String((b && b.title) || '').trim();
    var iDash = t.indexOf('——');
    var iDot = t.indexOf(' · ');
    var at = -1, len = 0;
    if (iDash >= 0 && (iDot < 0 || iDash < iDot)) { at = iDash; len = 2; }
    else if (iDot >= 0) { at = iDot; len = 3; }
    if (at <= 0) return { over: '', main: t, sub: '' };
    var left = t.slice(0, at).trim();
    var right = t.slice(at + len).trim();
    if (right && isWeakPrefix(left)) return { over: left, main: right, sub: '' };
    return { over: '', main: left, sub: right };
  }

  // 闲聊册：不出 token，书名走略斜体
  function isChatBook(b) { return splitTitle(b).over === '闲聊'; }

  // 行首 token：闲聊的分类词与日期前缀都不渲染（拆分照旧剥离它们，只是不上行）
  var RE_DATE_OVER = /^\d{4}-\d{2}-\d{2}$/;

  function rowToken(b) {
    var o = splitTitle(b).over;
    if (o === '闲聊' || RE_DATE_OVER.test(o)) return '';
    return o;
  }

  // 课程入口行的合计进度：按字数加权（读完 p=1、在读取存档 pct、未读 p=0）
  function topicPct(items, posOf) {
    var sum = 0, acc = 0;
    for (var i = 0; i < (items || []).length; i++) {
      var c = Math.max(0, (items[i] && items[i].chars) || 0);
      var p = posOf ? posOf(items[i].id) : null;
      var v = !p ? 0 : (p.done ? 1 : clamp(Number(p.pct) || 0, 0, 1));
      sum += c;
      acc += c * v;
    }
    return sum > 0 ? clamp(acc / sum, 0, 1) : 0;
  }

  // 分节：无 group 的档案在前，其后按出现顺序每个 group 一节（key 取源前缀，供二级页路由）
  function shelfSections(books) {
    var plain = [], byGroup = {}, order = [], i;
    for (i = 0; i < (books || []).length; i++) {
      var b = books[i];
      if (!b.group) { plain.push(b); continue; }
      if (!byGroup[b.group]) { byGroup[b.group] = []; order.push(b.group); }
      byGroup[b.group].push(b);
    }
    var out = [];
    if (plain.length) out.push({ group: null, key: '', items: plain });
    for (i = 0; i < order.length; i++) {
      var items = byGroup[order[i]];
      out.push({ group: order[i], key: String(items[0].src || '').split('/')[0], items: items });
    }
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

  /* ── 标注：锚定、检索、合并 ── */

  function headLen(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charAt(i) === b.charAt(i)) i++;
    return i;
  }

  function tailLen(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)) i++;
    return i;
  }

  // quote + 前后文重定位：同段多命中时取上下文吻合度最高者；找不到返回 -1（orphan，不渲染不丢数据）
  function locateQuote(text, h) {
    var s = String(text == null ? '' : text);
    var q = h && h.quote ? String(h.quote) : '';
    if (!q) return -1;
    var pre = String((h && h.prefix) || ''), suf = String((h && h.suffix) || '');
    var best = -1, bestScore = -1, from = 0;
    for (;;) {
      var i = s.indexOf(q, from);
      if (i < 0) break;
      var score = tailLen(s.slice(Math.max(0, i - pre.length), i), pre) +
                  headLen(s.slice(i + q.length, i + q.length + suf.length), suf);
      if (score > bestScore) { bestScore = score; best = i; }
      from = i + 1;
    }
    return best;
  }

  // 命中片段：前后各 SNIP_LEN 字，越界加省略号
  function makeSnippet(text, at, qlen, ctx) {
    var s = String(text == null ? '' : text);
    var c = ctx == null ? SNIP_LEN : ctx;
    var a = Math.max(0, at - c), b = Math.min(s.length, at + qlen + c);
    return {
      before: (a > 0 ? '…' : '') + s.slice(a, at),
      hit: s.slice(at, at + qlen),
      after: s.slice(at + qlen, b) + (b < s.length ? '…' : '')
    };
  }

  // md → 供检索与滚动定位的纯文本（与渲染后 textContent 近似）
  function plainOf(md) {
    var t = String(md == null ? '' : md);
    t = t.replace(/```[\s\S]*?```/g, ' ');
    t = t.replace(/`([^`\n]*)`/g, '$1');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    t = t.replace(/^\s{0,3}>\s?/gm, '');
    t = t.replace(/^\s{0,3}(?:[-*_][ \t]*){3,}$/gm, ' ');
    t = t.replace(/\*\*|__|~~/g, '');
    t = t.replace(/\|/g, ' ');
    t = t.replace(/\s+/g, ' ');
    return t.trim();
  }

  function itemTime(it) {
    if (!it) return 0;
    return it.deletedAt || it.updatedAt || it.createdAt || 0;
  }

  // 按 id 合并两侧条目：updatedAt/deletedAt 新者胜；墓碑保留以传播删除
  function mergeItems(a, b) {
    var map = {}, out = [], i, k;
    var add = function (it) {
      if (!it || !it.id) return;
      var cur0 = map[it.id];
      if (!cur0 || itemTime(it) > itemTime(cur0)) map[it.id] = it;
    };
    for (i = 0; i < (a || []).length; i++) add(a[i]);
    for (i = 0; i < (b || []).length; i++) add(b[i]);
    for (k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]);
    out.sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0); });
    return out;
  }

  function liveOf(items) {
    var out = [];
    for (var i = 0; i < (items || []).length; i++) {
      if (items[i] && items[i].id && !items[i].deletedAt) out.push(items[i]);
    }
    return out;
  }

  /* ── 编辑器语义 / 两击确认 / 手势方向（纯函数） ── */

  // 返回时如何落盘：新建且空 → 丢弃；既有清空 → 墓碑删除；无改动 → 不记 edits
  function editorAction(o) {
    var isNew = !!(o && o.isNew);
    var text = String((o && o.text) || '').trim();
    var orig = String((o && o.original) || '').trim();
    if (isNew) return text ? { action: 'create', text: text } : { action: 'discard', text: '' };
    if (!text) return { action: 'delete', text: '' };
    if (text === orig) return { action: 'noop', text: text };
    return { action: 'update', text: text };
  }

  // 垃圾桶两击确认：首击进入待确认（保持 win 毫秒），窗口内再击执行，超时复原
  function armStep(armedAt, now, win) {
    var w = win == null ? ARM_WIN : win;
    if (armedAt && (now - armedAt) <= w) return { fire: true, armed: false, armedAt: 0 };
    return { fire: false, armed: true, armedAt: now };
  }

  // 滚动方向 → 搜索胶囊显隐：向上滑动（scrollY 增大）显，向下滑动隐，抖动不动作
  function barMove(dy, thresh) {
    var t = thresh == null ? BAR_THRESH : thresh;
    if (dy > t) return 'show';
    if (dy < -t) return 'hide';
    return 'keep';
  }

  function syncUrl(file) { return SYNC_API + file; }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ─────────── base64 ─────────── */

  function b64ToBytes(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function bytesToB64(u) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(s);
  }

  function utf8ToB64(str) { return bytesToB64(new TextEncoder().encode(String(str))); }
  function b64ToUtf8(b64) { return new TextDecoder('utf-8').decode(b64ToBytes(b64)); }

  /* 同步一次：GET（取 sha + 远端）→ 合并 → PUT（带 sha 乐观并发）；409/422 → 重取重试。
     依赖注入（fetchFn/pat/items），便于在 node 里用 mock fetch 直测。 */
  function pushFile(o) {
    var f = o.fetchFn, tries = 0, maxTry = o.maxTry == null ? 3 : o.maxTry;
    var head = {
      'Authorization': 'Bearer ' + o.pat,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    var attemptOnce = function () {
      tries++;
      return f(o.url, { method: 'GET', headers: head, cache: 'no-store' })
        .then(function (r) {
          if (r.status === 404) return { sha: null, items: [] };
          if (!r.ok) throw new Error('get ' + r.status);
          return r.json().then(function (j) {
            var items = [];
            try { items = (JSON.parse(b64ToUtf8(j.content)) || {}).items || []; } catch (e) { items = []; }
            return { sha: j.sha, items: items };
          });
        })
        .then(function (remote) {
          var merged = mergeItems(o.items, remote.items);
          var body = {
            message: o.message,
            content: utf8ToB64(JSON.stringify({ v: 1, items: merged }, null, 1) + '\n')
          };
          if (remote.sha) body.sha = remote.sha;
          return f(o.url, { method: 'PUT', headers: head, body: JSON.stringify(body) })
            .then(function (r) {
              if (r.ok) return { ok: true, items: merged, tries: tries };
              if ((r.status === 409 || r.status === 422) && tries < maxTry) return attemptOnce();
              return { ok: false, status: r.status, items: merged, tries: tries };
            });
        });
    };
    return attemptOnce();
  }

  var TEST = {
    slugify: slugify, makeSlugger: makeSlugger, isExternal: isExternal,
    splitHash: splitHash, resolvePath: resolvePath, mapHref: mapHref,
    pctToY: pctToY, yToPct: yToPct, fmtPct: fmtPct, fmtWan: fmtWan, fmtMD: fmtMD,
    rowMeta: rowMeta, topicMeta: topicMeta, topicPct: topicPct,
    splitTitle: splitTitle, shelfSections: shelfSections,
    isChatBook: isChatBook, rowToken: rowToken,
    fixCjkStrong: fixCjkStrong, fixInlineLine: fixInlineLine, fenceOf: fenceOf,
    isChapterHeading: isChapterHeading, isQuotedHeading: isQuotedHeading,
    bjt: bjt, stampOf: stampOf, locateQuote: locateQuote, makeSnippet: makeSnippet,
    plainOf: plainOf, mergeItems: mergeItems, liveOf: liveOf, itemTime: itemTime,
    editorAction: editorAction, armStep: armStep, barMove: barMove,
    syncUrl: syncUrl, pushFile: pushFile, utf8ToB64: utf8ToB64, b64ToUtf8: b64ToUtf8,
    HL_KEYS: HL_KEYS, FONT_STEPS: FONT_STEPS
  };
  if (typeof window !== 'undefined') window.__museum_test = TEST;
  else if (typeof globalThis !== 'undefined') globalThis.__museum_test = TEST;

  if (typeof document === 'undefined') return;      // node 直测：纯函数就位，UI 不启动

  /* ─────────── 加密 ─────────── */

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
  var MD_CACHE = {}, PLAIN_CACHE = {};
  var view = 'unlock';                  // unlock | shelf | topic | memo | read
  var cur = null;                       // 当前书 meta
  var curChapters = [], curTopic = null;
  var fontIdx = FONT_DEFAULT;
  var chromeOn = false, chromeTimer = null;
  var posTimer = null, rafPending = false, shelfTimer = null, topicTimer = null;
  var busy = false, pinTimer = null, navBusy = false, activeScreen = null;
  var findTimer = null, findQuery = '', pendingFind = null, searching = false, noteAfterOpen = false;
  var syncTimer = {}, patAsked = false;
  var capSel = null, capId = null, hlOrphans = 0;
  var edCtx = null;                     // {kind:'memo'|'note', id, bookId, original, isNew}
  var edArmed = 0, edArmTimer = null;
  var barOn = false, barTimer = null, barLastY = 0, searchOn = false;
  var el = {};

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function loadStore(k) {
    var raw = ls(k);
    if (!raw) return { v: 1, items: [] };
    try {
      var o = JSON.parse(raw);
      return (o && Array.isArray(o.items)) ? o : { v: 1, items: [] };
    } catch (e) { return { v: 1, items: [] }; }
  }

  function saveStore(k, store) { lsSet(k, JSON.stringify(store)); }

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
    var $ = function (id) { return document.getElementById(id); };
    el.unlock = $('scrUnlock'); el.shelf = $('scrShelf'); el.read = $('scrRead');
    el.topic = $('scrTopic'); el.memo = $('scrMemo');
    el.doc = $('doc'); el.pin = $('pin'); el.pinForm = $('pinForm');
    el.unlockBox = document.querySelector('.unlock-box');
    el.books = $('books'); el.hits = $('hits');
    el.searchBar = $('searchBar'); el.searchPill = $('searchPill');
    el.searchInput = $('searchInput'); el.searchClear = $('searchClear');
    el.topicList = $('topicList'); el.topicBack = $('topicBack');
    el.memoDoc = $('memoDoc'); el.memoBack = $('memoBack'); el.memoBar = $('memoBar');
    el.btnClock = $('btnClock'); el.btnMemoNew = $('btnMemoNew');
    el.chrome = $('chrome'); el.topbar = $('topbar');
    el.btnBack = $('btnBack'); el.btnToc = $('btnToc'); el.btnNote = $('btnNote');
    el.btnFontDown = $('btnFontDown'); el.btnFontUp = $('btnFontUp'); el.pctLabel = $('pctLabel');
    el.sheetWrap = $('sheetWrap'); el.sheetList = $('sheetList'); el.sheetBackdrop = $('sheetBackdrop');
    el.noteWrap = $('noteWrap'); el.noteList = $('noteList'); el.noteBackdrop = $('noteBackdrop');
    el.btnNoteNew = $('btnNoteNew');
    el.editor = $('editor'); el.edArea = $('edArea'); el.edBack = $('edBack'); el.edDel = $('edDel');
    el.cap = $('cap'); el.capDel = $('capDel');

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
    el.btnNote.addEventListener('click', function () { bumpChrome(); openNotes(); });
    el.btnFontDown.addEventListener('click', function () { bumpChrome(); setFont(fontIdx - 1); });
    el.btnFontUp.addEventListener('click', function () { bumpChrome(); setFont(fontIdx + 1); });
    el.sheetBackdrop.addEventListener('click', closeSheet);
    el.noteBackdrop.addEventListener('click', closeNotes);

    el.topicBack.addEventListener('click', function () { location.hash = '#/'; });
    el.memoBack.addEventListener('click', function () { location.hash = '#/'; });

    el.searchPill.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.search-x')) return;
      enterSearch();
    });
    el.searchInput.addEventListener('focus', enterSearch);
    el.searchInput.addEventListener('input', onSearchInput);
    el.searchClear.addEventListener('click', function (e) { e.stopPropagation(); clearSearch(); });

    el.btnClock.addEventListener('click', toggleStamps);
    el.btnMemoNew.addEventListener('click', function () { openEditor('memo', null, ''); });
    el.btnNoteNew.addEventListener('click', function () {
      if (cur) openEditor('note', null, cur.id);
    });
    el.edBack.addEventListener('click', onEdBack);
    el.edDel.addEventListener('click', onEdDel);

    var dots = el.cap.querySelectorAll('.cap-dot');
    for (var i = 0; i < dots.length; i++) {
      (function (d) { d.addEventListener('click', function () { pickColor(d.getAttribute('data-c')); }); })(dots[i]);
    }
    el.capDel.addEventListener('click', dropHighlight);

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
    if (h.view === 'read' && BY_ID[h.id]) {
      openBook(h.id, el.unlock, !!fromUnlock);
    } else if (h.view === 'topic' && topicOf(h.key)) {
      renderTopic(h.key);
      crossFade(el.unlock, el.topic, function () { window.scrollTo(0, 0); }, !!fromUnlock);
      view = 'topic';
    } else if (h.view === 'memo') {
      renderMemo();
      crossFade(el.unlock, el.memo, function () { window.scrollTo(0, 0); }, !!fromUnlock);
      view = 'memo';
      el.memoBar.hidden = false;
    } else {
      if (h.view !== 'shelf') location.replace('#/');
      renderShelf();
      crossFade(el.unlock, el.shelf, function () { window.scrollTo(0, 0); barLastY = 0; }, !!fromUnlock);
      view = 'shelf';
    }
    schedulePrefetch();
    syncPullAll();
  }

  /* ─────────── 路由 ─────────── */

  function parseHash() {
    var h = location.hash || '';
    var m = /^#\/read\/([0-9a-f]{4,})$/.exec(h);
    if (m) return { view: 'read', id: m[1] };
    m = /^#\/topic\/([A-Za-z0-9_-]+)$/.exec(h);
    if (m) return { view: 'topic', key: m[1] };
    if (/^#\/memo$/.test(h)) return { view: 'memo' };
    return { view: 'shelf' };
  }

  function topicOf(key) {
    var secs = shelfSections(BOOKS);
    for (var i = 0; i < secs.length; i++) if (secs[i].group && secs[i].key === key) return secs[i];
    return null;
  }

  function screenOf(v) {
    return v === 'read' ? el.read : v === 'topic' ? el.topic : v === 'memo' ? el.memo :
      v === 'unlock' ? el.unlock : el.shelf;
  }

  function leaveCur() {
    if (view === 'read') { flushPos(); hideChrome(true); closeSheet(); closeNotes(); hideCap(); }
    if (view === 'topic') { clearTimeout(topicTimer); saveTopicY(); }
    if (view === 'memo') el.memoBar.hidden = true;
    if (view === 'shelf') { clearTimeout(shelfTimer); saveShelfY(); killBar(); }   // 搜索胶囊仅首页
  }

  function route() {
    if (!KEY) return;
    var h = parseHash();
    if (h.view === 'read' && BY_ID[h.id]) {
      if (view === 'read' && cur && cur.id === h.id) return;
      openBook(h.id, screenOf(view), false);
      return;
    }
    if (h.view === 'topic' && topicOf(h.key)) {
      if (view === 'topic' && curTopic === h.key) return;
      var from = view;
      leaveCur();
      renderTopic(h.key);
      crossFade(screenOf(from), el.topic, function () {
        var y = 0;
        if (from !== 'shelf') {
          try { y = parseInt(sessionStorage.getItem(K_TOPIC_Y) || '0', 10) || 0; } catch (e) { y = 0; }
        }
        window.scrollTo(0, y);
      }, false);
      view = 'topic';
      return;
    }
    if (h.view === 'memo') {
      if (view === 'memo') return;
      var from2 = view;
      leaveCur();
      renderMemo();
      crossFade(screenOf(from2), el.memo, function () { window.scrollTo(0, 0); }, false);
      view = 'memo';
      el.memoBar.hidden = false;
      return;
    }
    if (view === 'shelf') return;
    backToShelf();
  }

  /* ─────────── 首页 ─────────── */

  function mkRow(opt) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'row' + (opt.single ? ' row-single' : '');
    var l1 = document.createElement('div');
    l1.className = 'row-1';
    if (opt.token) {
      var tk = document.createElement('span');
      tk.className = 'row-token';
      tk.textContent = opt.token;
      l1.appendChild(tk);
    }
    var t = document.createElement('span');
    t.className = 'row-title' + (opt.slant ? ' is-slant' : '');
    t.textContent = opt.title;
    l1.appendChild(t);
    if (opt.pct) {
      var p = document.createElement('span');
      p.className = 'row-pct';
      p.textContent = opt.pct;
      l1.appendChild(p);
    }
    if (opt.chevron) {
      var g = document.createElement('span');
      g.className = 'row-chev';
      g.innerHTML = CHEVRON_R_SVG;
      l1.appendChild(g);
    }
    row.appendChild(l1);
    if (opt.meta) {
      var l2 = document.createElement('div');
      l2.className = 'row-2';
      l2.textContent = opt.meta;
      row.appendChild(l2);
    }
    row.addEventListener('click', opt.onTap);
    return row;
  }

  function bookRow(b) {
    var pos = readPos(b.id);
    return mkRow({
      token: rowToken(b), title: splitTitle(b).main, slant: isChatBook(b),
      pct: (pos && !pos.done) ? fmtPct(pos.pct) : '', meta: rowMeta(b),
      onTap: function () { go(b.id); }
    });
  }

  function renderShelf() {
    el.books.textContent = '';
    var list = document.createElement('div');
    list.className = 'list';

    list.appendChild(mkRow({
      title: '备忘录', single: true,
      onTap: function () { location.hash = '#/memo'; }
    }));

    var secs = shelfSections(BOOKS), i, j;
    for (i = 0; i < secs.length; i++) {
      if (secs[i].group) continue;
      for (j = 0; j < secs[i].items.length; j++) list.appendChild(bookRow(secs[i].items[j]));
    }
    for (i = 0; i < secs.length; i++) {
      if (!secs[i].group) continue;
      (function (sec) {
        var tp = topicPct(sec.items, readPos);
        list.appendChild(mkRow({
          title: sec.group, meta: topicMeta(sec.items), chevron: true,
          pct: tp > 0 ? fmtPct(tp) : '',
          onTap: function () { location.hash = '#/topic/' + sec.key; }
        }));
      })(secs[i]);
    }
    el.books.appendChild(list);
  }

  function renderTopic(key) {
    curTopic = key;
    var sec = topicOf(key);
    el.topicList.textContent = '';
    if (!sec) return;
    var list = document.createElement('div');
    list.className = 'list';
    for (var i = 0; i < sec.items.length; i++) list.appendChild(bookRow(sec.items[i]));
    el.topicList.appendChild(list);
  }

  function go(id) { location.hash = '#/read/' + id; }

  function backToShelf() {
    var from = view;
    leaveCur();
    el.searchInput.value = '';
    el.searchClear.hidden = true;
    searchOn = false;
    showList();
    renderShelf();
    var y = 0;
    try { y = parseInt(sessionStorage.getItem(K_SHELF_Y) || '0', 10) || 0; } catch (e) { y = 0; }
    crossFade(screenOf(from), el.shelf, function () {
      var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.min(y, max));
      barLastY = window.pageYOffset || 0;
    }, false);
    view = 'shelf';
    cur = null;
  }

  /* ─────────── 搜索胶囊（底部浮动，仅首页） ─────────── */

  function showBar() {
    el.searchBar.hidden = false;
    void el.searchBar.offsetWidth;
    el.searchBar.classList.add('is-on');
    barOn = true;
    clearTimeout(barTimer);
    if (!searchOn) barTimer = setTimeout(hideBar, BAR_HIDE);   // 搜索态不自隐
  }

  function hideBar() {
    clearTimeout(barTimer);
    if (!barOn) return;
    barOn = false;
    el.searchBar.classList.remove('is-on');
    setTimeout(function () { if (!barOn) el.searchBar.hidden = true; }, 280);
  }

  function killBar() {
    clearTimeout(barTimer);
    barOn = false;
    el.searchBar.classList.remove('is-on');
    el.searchBar.hidden = true;
  }

  function enterSearch() {
    if (view !== 'shelf') return;
    searchOn = true;
    clearTimeout(barTimer);
    showBar();
    el.searchClear.hidden = false;
    try { el.searchInput.focus(); } catch (e) {}
  }

  /* ─────────── 检索 ─────────── */

  function ensureAllPlain() {
    var jobs = [];
    for (var i = 0; i < BOOKS.length; i++) {
      (function (b) {
        if (PLAIN_CACHE[b.id]) return;
        jobs.push(loadMd(b.id).then(function (md) { PLAIN_CACHE[b.id] = plainOf(md); }, function () {}));
      })(BOOKS[i]);
    }
    return Promise.all(jobs);
  }

  function onSearchInput() {
    var q = el.searchInput.value;
    el.searchClear.hidden = !q;
    clearTimeout(findTimer);
    if (!q.trim()) { showList(); return; }
    findTimer = setTimeout(function () { runSearch(q.trim()); }, FIND_WAIT);
  }

  function showList() {
    findQuery = '';
    searching = false;
    el.hits.hidden = true;
    el.hits.textContent = '';
    el.books.hidden = false;
  }

  function clearSearch() {
    el.searchInput.value = '';
    el.searchClear.hidden = true;
    clearTimeout(findTimer);
    showList();
    searchOn = false;
    try { el.searchInput.blur(); } catch (e) {}
    killBar();
    var y = 0;
    try { y = parseInt(sessionStorage.getItem(K_SHELF_Y) || '0', 10) || 0; } catch (e) { y = 0; }
    window.scrollTo(0, y);
    barLastY = window.pageYOffset || 0;
  }

  function findAll(text, term, limit) {
    var out = [], t = text.toLowerCase(), q = term.toLowerCase(), from = 0;
    while (out.length < limit) {
      var i = t.indexOf(q, from);
      if (i < 0) break;
      out.push(i);
      from = i + q.length;
    }
    return out;
  }

  function runSearch(term) {
    findQuery = term;
    searching = true;
    ensureAllPlain().then(function () {
      if (findQuery !== term) return;
      var rows = [], i, j;
      for (i = 0; i < BOOKS.length; i++) {
        var b = BOOKS[i], text = PLAIN_CACHE[b.id] || '';
        var at = findAll(text, term, 3);
        for (j = 0; j < at.length; j++) {
          rows.push({ kind: 'book', book: b, text: text, at: at[j], len: term.length });
        }
      }
      var memos = liveOf(loadStore(K_MEMOS).items);
      for (i = 0; i < memos.length; i++) {
        var mt = String(memos[i].text || '').replace(/\s+/g, ' ');
        var ma = findAll(mt, term, 1);
        if (ma.length) rows.push({ kind: 'memo', item: memos[i], text: mt, at: ma[0], len: term.length });
      }
      var notes = liveOf(loadStore(K_NOTES).items);
      for (i = 0; i < notes.length; i++) {
        var nt = String(notes[i].text || '').replace(/\s+/g, ' ');
        var na = findAll(nt, term, 1);
        if (na.length) rows.push({ kind: 'note', item: notes[i], text: nt, at: na[0], len: term.length });
      }
      paintHits(rows);
    });
  }

  function paintHits(rows) {
    el.hits.textContent = '';
    el.books.hidden = true;
    el.hits.hidden = false;
    var list = document.createElement('div');
    list.className = 'list';
    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var snip = makeSnippet(r.text, r.at, r.len);
        var name = '', slant = false, tap = null;
        if (r.kind === 'book') {
          name = splitTitle(r.book).main;
          slant = isChatBook(r.book);
          tap = function () {
            pendingFind = {
              quote: snip.hit,
              prefix: snip.before.replace(/^…/, ''),
              suffix: snip.after.replace(/…$/, '')
            };
            go(r.book.id);
          };
        } else if (r.kind === 'memo') {
          name = '备忘录';
          tap = function () { location.hash = '#/memo'; };
        } else {
          var nb = BY_ID[r.item.bookId];
          name = '笔记 · ' + (nb ? splitTitle(nb).main : '');
          tap = function () { if (nb) { noteAfterOpen = true; go(nb.id); } };
        }
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'row';
        var l1 = document.createElement('div');
        l1.className = 'row-1';
        var t = document.createElement('span');
        t.className = 'row-title' + (slant ? ' is-slant' : '');
        t.textContent = name;
        l1.appendChild(t);
        var l2 = document.createElement('div');
        l2.className = 'row-2';
        l2.appendChild(document.createTextNode(snip.before));
        var em = document.createElement('b');
        em.className = 'hit';
        em.textContent = snip.hit;
        l2.appendChild(em);
        l2.appendChild(document.createTextNode(snip.after));
        row.appendChild(l1);
        row.appendChild(l2);
        row.addEventListener('click', tap);
        list.appendChild(row);
      })(rows[i]);
    }
    el.hits.appendChild(list);
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
    leaveCur();
    loadMd(id).then(function (md) {
      cur = b;
      paintDoc(b, md);
      var pos = readPos(id);
      var pct = pos ? pos.pct : 0;
      var find = pendingFind;
      pendingFind = null;
      crossFade(fromEl, el.read, function () {
        window.scrollTo(0, pctToY(pct, document.documentElement.scrollHeight, window.innerHeight));
      }, !!slow);
      view = 'read';
      lsSet(K_LAST, id);
      paintPct();
      showChrome(CHROME_INTRO);
      navBusy = false;
      if (find) setTimeout(function () { jumpToQuote(find); }, 60);
      if (noteAfterOpen) { noteAfterOpen = false; setTimeout(openNotes, 260); }
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
    back.setAttribute('aria-label', 'Back');
    back.innerHTML = CHEVRON_SVG;                       // 纯 ‹ 字形，同顶栏，无文字
    back.addEventListener('click', function () { location.hash = '#/'; });
    host.appendChild(back);

    el.doc.textContent = '';
    while (host.firstChild) el.doc.appendChild(host.firstChild);
    el.doc.style.fontSize = FONT_STEPS[fontIdx] + 'px';
    updateFontBtns();
    updateTocBtn();
    applyHighlights(b.id);
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
    var mk = e.target.closest ? e.target.closest('mark[data-hl]') : null;
    if (mk) { e.preventDefault(); openCapForMark(mk); return; }
    var a = e.target.closest ? e.target.closest('a[data-anchor]') : null;
    if (!a) return;
    e.preventDefault();
    jumpTo(a.getAttribute('data-anchor'));
  }

  function jumpTo(id) {
    var node = id ? document.getElementById(id) : null;
    if (!node) { window.scrollTo(0, 0); return; }
    scrollToNode(node);
    savePos();
  }

  function scrollToNode(node) {
    var off = chromeOn ? (el.topbar.getBoundingClientRect().height + 8) : 12;
    var y = node.getBoundingClientRect().top + (window.pageYOffset || 0) - off;
    window.scrollTo(0, Math.max(0, Math.round(y)));
    node.classList.remove('hl');
    void node.offsetWidth;
    node.classList.add('hl');
    setTimeout(function () { node.classList.remove('hl'); }, 640);
  }

  /* ── 文本节点索引：锚定、命中定位、包裹 ── */

  function docNodes() {
    var out = [];
    var w = document.createTreeWalker(el.doc, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) if (n.nodeValue && n.nodeValue.length) out.push(n);
    return out;
  }

  function nodesText(nodes) {
    var s = '';
    for (var i = 0; i < nodes.length; i++) s += nodes[i].nodeValue;
    return s;
  }

  function offsetOf(nodes, node, off) {
    var pos = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return pos + off;
      pos += nodes[i].nodeValue.length;
    }
    return -1;
  }

  function nodeAt(nodes, at) {
    var pos = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      if (at < pos + len) return { node: nodes[i], off: at - pos };
      pos += len;
    }
    return null;
  }

  function blockOf(node) {
    var n = node;
    while (n && n.parentNode !== el.doc) n = n.parentNode;
    return n;
  }

  function wrapRange(nodes, start, end, cls, id) {
    var pos = 0, made = [];
    for (var i = 0; i < nodes.length && pos < end; i++) {
      var n = nodes[i], len = n.nodeValue.length, s = pos, e = pos + len;
      pos = e;
      if (e <= start) continue;
      var a = Math.max(start, s) - s, b = Math.min(end, e) - s;
      if (b <= a) continue;
      var node = n;
      if (b < len) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      var m = document.createElement('mark');
      m.className = cls;
      m.setAttribute('data-hl', id);
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
      made.push(m);
    }
    return made;
  }

  function clearMarks() {
    var ms = el.doc.querySelectorAll('mark[data-hl]');
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
  }

  function applyHighlights(bookId) {
    clearMarks();
    hlOrphans = 0;
    var all = liveOf(loadStore(K_HL).items);
    for (var i = 0; i < all.length; i++) {
      if (all[i].bookId !== bookId) continue;
      var nodes = docNodes(), text = nodesText(nodes);
      var at = locateQuote(text, all[i]);
      if (at < 0) { hlOrphans++; continue; }
      wrapRange(nodes, at, at + all[i].quote.length, 'hl-' + all[i].color, all[i].id);
    }
  }

  function jumpToQuote(find) {
    var nodes = docNodes(), text = nodesText(nodes);
    var at = locateQuote(text, find);
    if (at < 0) at = text.indexOf(find.quote);
    if (at < 0) return;
    var hit = nodeAt(nodes, at);
    if (!hit) return;
    var host = hit.node.parentNode;
    scrollToNode(host && host.nodeType === 1 ? host : el.doc);
  }

  /* ─────────── 标色 ─────────── */

  function selectionInfo() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var r = sel.getRangeAt(0);
    if (!el.doc.contains(r.startContainer) || !el.doc.contains(r.endContainer)) return null;
    if (blockOf(r.startContainer) !== blockOf(r.endContainer)) return null;   // 跨块级：拒绝
    var q = sel.toString();
    if (!q || !q.trim()) return null;
    var nodes = docNodes(), text = nodesText(nodes);
    var start = offsetOf(nodes, r.startContainer, r.startOffset);
    if (start < 0 || text.substr(start, q.length) !== q) {
      start = text.indexOf(q);
      if (start < 0) return null;
    }
    return {
      quote: q,
      prefix: text.slice(Math.max(0, start - CTX_LEN), start),
      suffix: text.slice(start + q.length, start + q.length + CTX_LEN),
      rect: r.getBoundingClientRect()
    };
  }

  function showCap(rect, withDel) {
    el.capDel.hidden = !withDel;
    el.cap.hidden = false;
    el.cap.classList.add('is-on');
    var w = el.cap.offsetWidth, h = el.cap.offsetHeight;
    var x = clamp(rect.left + rect.width / 2 - w / 2, 8, Math.max(8, window.innerWidth - w - 8));
    var y = rect.top - h - 10;
    if (y < 8) y = rect.bottom + 10;                    // 越界翻到下方
    y = clamp(y, 8, Math.max(8, window.innerHeight - h - 8));
    el.cap.style.left = Math.round(x) + 'px';
    el.cap.style.top = Math.round(y) + 'px';
  }

  function hideCap() {
    el.cap.hidden = true;
    el.cap.classList.remove('is-on');
    capSel = null;
    capId = null;
  }

  function openCapForMark(mk) {
    var all = liveOf(loadStore(K_HL).items), it = null;
    var id = mk.getAttribute('data-hl');
    for (var i = 0; i < all.length; i++) if (all[i].id === id) it = all[i];
    if (!it) return;
    capSel = null;
    capId = id;
    showCap(mk.getBoundingClientRect(), true);
  }

  function pickColor(c) {
    var store = loadStore(K_HL), now = Date.now(), i;
    if (capId) {
      for (i = 0; i < store.items.length; i++) {
        if (store.items[i].id === capId) {
          store.items[i].color = c;
          store.items[i].updatedAt = now;
        }
      }
    } else if (capSel) {
      store.items.push({
        id: newId(), bookId: cur ? cur.id : '', quote: capSel.quote,
        prefix: capSel.prefix, suffix: capSel.suffix, color: c,
        createdAt: now, updatedAt: now
      });
    } else { hideCap(); return; }
    saveStore(K_HL, store);
    try { window.getSelection().removeAllRanges(); } catch (e) {}
    hideCap();
    if (cur) applyHighlights(cur.id);
    queueSync('highlights');
  }

  function dropHighlight() {
    if (!capId) { hideCap(); return; }
    var store = loadStore(K_HL), now = Date.now();
    for (var i = 0; i < store.items.length; i++) {
      if (store.items[i].id === capId) store.items[i] = { id: capId, deletedAt: now };
    }
    saveStore(K_HL, store);
    hideCap();
    if (cur) applyHighlights(cur.id);
    queueSync('highlights');
  }

  /* ─────────── 备忘录 ─────────── */

  function stampsOn() { return ls(K_MEMO_TS) === '1'; }

  function toggleStamps() {
    lsSet(K_MEMO_TS, stampsOn() ? '0' : '1');
    renderMemo();
  }

  function renderMemo() {
    el.memoDoc.textContent = '';
    el.btnClock.classList.toggle('is-on', stampsOn());
    var items = liveOf(loadStore(K_MEMOS).items);
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'memo-empty';
      e.textContent = '——';
      el.memoDoc.appendChild(e);
      return;
    }
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        if (stampsOn()) {
          var ts = document.createElement('div');
          ts.className = 'memo-ts';
          ts.textContent = stampOf(it);
          el.memoDoc.appendChild(ts);
        }
        var p = document.createElement('div');
        p.className = 'memo-item';
        p.textContent = it.text;
        p.addEventListener('click', function () { openEditor('memo', it, ''); });
        el.memoDoc.appendChild(p);
      })(items[i]);
    }
  }

  /* ─────────── 笔记 ─────────── */

  function openNotes() {
    if (!cur) return;
    renderNotes();
    el.noteWrap.hidden = false;
    void el.noteWrap.offsetWidth;
    el.noteWrap.classList.add('is-on');
  }

  function closeNotes() {
    if (el.noteWrap.hidden) return;
    el.noteWrap.classList.remove('is-on');
    setTimeout(function () {
      if (!el.noteWrap.classList.contains('is-on')) el.noteWrap.hidden = true;
    }, 280);
    bumpChrome();
  }

  function renderNotes() {
    el.noteList.textContent = '';
    var all = liveOf(loadStore(K_NOTES).items), n = 0;
    for (var i = 0; i < all.length; i++) {
      if (!cur || all[i].bookId !== cur.id) continue;
      n++;
      (function (it) {
        var p = document.createElement('div');
        p.className = 'note-item';
        p.textContent = it.text;
        p.addEventListener('click', function () { openEditor('note', it, it.bookId); });
        el.noteList.appendChild(p);
      })(all[i]);
    }
    if (!n) {
      var e = document.createElement('div');
      e.className = 'memo-empty';
      e.textContent = '——';
      el.noteList.appendChild(e);
    }
  }

  /* ─────────── 全屏编辑器（备忘录与笔记共用） ─────────── */

  function storeOf(kind) { return kind === 'memo' ? K_MEMOS : K_NOTES; }

  function openEditor(kind, item, bookId) {
    edCtx = {
      kind: kind,
      id: item ? item.id : null,
      isNew: !item,
      bookId: bookId || (item ? item.bookId : ''),
      original: item ? String(item.text || '') : ''
    };
    disarmDel();
    el.edArea.value = edCtx.original;
    el.editor.hidden = false;
    setTimeout(function () {
      try {
        el.edArea.focus();
        var n = el.edArea.value.length;
        el.edArea.setSelectionRange(n, n);      // 光标置文末
      } catch (e) {}
    }, 60);
  }

  // 返回即落盘（语义见 editorAction）
  function onEdBack() {
    if (!edCtx) { finishEditor('', false); return; }
    var r = editorAction({ isNew: edCtx.isNew, original: edCtx.original, text: el.edArea.value });
    var k = storeOf(edCtx.kind), store = loadStore(k), now = Date.now(), i, changed = false;
    if (r.action === 'create') {
      var it = { id: newId(), text: r.text, createdAt: now, edits: [], updatedAt: now };
      if (edCtx.kind === 'note') it.bookId = edCtx.bookId;
      store.items.push(it);
      changed = true;
    } else if (r.action === 'update') {
      for (i = 0; i < store.items.length; i++) {
        if (store.items[i].id !== edCtx.id) continue;
        store.items[i].text = r.text;
        store.items[i].edits = (store.items[i].edits || []).concat([now]);
        store.items[i].updatedAt = now;
        changed = true;
      }
    } else if (r.action === 'delete') {
      for (i = 0; i < store.items.length; i++) {
        if (store.items[i].id === edCtx.id) { store.items[i] = { id: edCtx.id, deletedAt: now }; changed = true; }
      }
    }
    if (changed) saveStore(k, store);
    finishEditor(edCtx.kind, changed);
  }

  // 垃圾桶：两击确认，无文字弹窗
  function onEdDel() {
    var s = armStep(edArmed, Date.now());
    if (s.fire) { hardDelete(); return; }
    edArmed = s.armedAt;
    el.edDel.classList.add('is-armed');
    clearTimeout(edArmTimer);
    edArmTimer = setTimeout(disarmDel, ARM_WIN);
  }

  function disarmDel() {
    clearTimeout(edArmTimer);
    edArmed = 0;
    if (el.edDel) el.edDel.classList.remove('is-armed');
  }

  function hardDelete() {
    if (!edCtx) return;
    var kind = edCtx.kind, changed = false;
    if (!edCtx.isNew && edCtx.id) {
      var k = storeOf(kind), store = loadStore(k), now = Date.now();
      for (var i = 0; i < store.items.length; i++) {
        if (store.items[i].id === edCtx.id) { store.items[i] = { id: edCtx.id, deletedAt: now }; changed = true; }
      }
      if (changed) saveStore(k, store);
    }
    finishEditor(kind, changed);
  }

  function finishEditor(kind, changed) {
    disarmDel();
    el.editor.hidden = true;
    try { el.edArea.blur(); } catch (e) {}
    edCtx = null;
    if (kind === 'memo') {
      renderMemo();
      if (changed) { askPat(); queueSync('memos'); }
    } else if (kind === 'note') {
      renderNotes();
      if (changed) queueSync('notes');
    }
  }

  /* ─────────── 同步（有 PAT 才走网络，无 PAT 则纯本地、不打扰） ─────────── */

  function storeKeyOf(kind) {
    return kind === 'memos' ? K_MEMOS : kind === 'notes' ? K_NOTES : K_HL;
  }

  function queueSync(kind) {
    clearTimeout(syncTimer[kind]);
    syncTimer[kind] = setTimeout(function () { syncPush(kind); }, SYNC_WAIT);
  }

  function syncPush(kind) {
    var pat = ls(K_PAT);
    if (!pat) return Promise.resolve(null);
    var k = storeKeyOf(kind);
    return pushFile({
      fetchFn: function (u, o) { return fetch(u, o); },
      url: syncUrl(SYNC_FILE[kind]),
      pat: pat,
      items: loadStore(k).items,
      message: 'sync ' + kind + ' ' + bjt(Date.now())
    }).then(function (r) {
      if (r && r.ok) saveStore(k, { v: 1, items: r.items });
      return r;
    }, function () { return null; });
  }

  function syncPullAll() {
    if (!ls(K_PAT)) return;
    var kinds = ['memos', 'notes', 'highlights'];
    for (var i = 0; i < kinds.length; i++) syncPush(kinds[i]);
  }

  // 首次在备忘录页写入时给一次性内联输入行；跳过后本会话不再打扰
  function askPat() {
    if (patAsked || ls(K_PAT)) return;
    patAsked = true;
    var row = document.createElement('div');
    row.className = 'pat-row';
    var inp = document.createElement('input');
    inp.className = 'bar-in';
    inp.type = 'password';
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'Token');
    var okb = document.createElement('button');
    okb.type = 'button';
    okb.className = 'bar-btn';
    okb.setAttribute('aria-label', 'Save');
    okb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5 12.5 10 17.5 19 6.5" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var xb = document.createElement('button');
    xb.type = 'button';
    xb.className = 'bar-btn';
    xb.setAttribute('aria-label', 'Skip');
    xb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"/></svg>';
    okb.addEventListener('click', function () {
      var v = inp.value.trim();
      if (v) { lsSet(K_PAT, v); syncPullAll(); }
      if (row.parentNode) row.parentNode.removeChild(row);
    });
    xb.addEventListener('click', function () { if (row.parentNode) row.parentNode.removeChild(row); });
    row.appendChild(inp);
    row.appendChild(okb);
    row.appendChild(xb);
    el.memoDoc.insertBefore(row, el.memoDoc.firstChild);
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
      if (!el.cap.hidden) hideCap();
    } else if (view === 'shelf') {
      var y = window.pageYOffset || 0;
      var d = barMove(y - barLastY);
      if (d !== 'keep') {
        barLastY = y;
        if (!searchOn) { if (d === 'show') showBar(); else hideBar(); }
      }
      if (searching) return;
      clearTimeout(shelfTimer);
      shelfTimer = setTimeout(saveShelfY, 150);
    } else if (view === 'topic') {
      clearTimeout(topicTimer);
      topicTimer = setTimeout(saveTopicY, 150);
    }
  }

  function saveShelfY() {
    try { sessionStorage.setItem(K_SHELF_Y, String(window.pageYOffset || 0)); } catch (e) {}
  }

  function saveTopicY() {
    try { sessionStorage.setItem(K_TOPIC_Y, String(window.pageYOffset || 0)); } catch (e) {}
  }

  function paintPct() { el.pctLabel.textContent = fmtPct(curPct()); }

  function savePos() {
    if (view !== 'read' || !cur) return;
    var pct = curPct();
    lsSet(K_LAST, cur.id);
    // 读完不再抹掉记录：改记 done，行上不显示百分比，但要计入课程合计
    if (pct >= DONE_PCT) lsSet(K_POS + cur.id, JSON.stringify({ pct: 1, done: true, t: Date.now() }));
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
    if (el.sheetWrap.hidden === false || el.noteWrap.hidden === false || el.editor.hidden === false) return;
    var t = e.target;
    if (t && t.closest && t.closest('a,button,mark,.topbar,.bottombar,.sheet,.sheet-backdrop,.cap')) return;
    dx0 = e.clientX; dy0 = e.clientY; dt0 = Date.now();
    tapArmed = true;
  }

  function onUp(e) {
    if (view === 'read') {
      var info = selectionInfo();
      if (info) { capSel = info; capId = null; showCap(info.rect, false); tapArmed = false; return; }
      if (!el.cap.hidden && !(e.target && e.target.closest && e.target.closest('.cap'))) hideCap();
    }
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
    var run = function () {
      if (fired) return;
      fired = true;
      var list = [];
      for (var i = 0; i < BOOKS.length; i++) list.push(url('data/' + BOOKS[i].id + '.json'));
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg && reg.active) reg.active.postMessage({ type: 'museum-prefetch', urls: list });
      }).catch(function () {});
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 6000 });
    else setTimeout(run, 3000);
  }

  /* ─────────── go ─────────── */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
