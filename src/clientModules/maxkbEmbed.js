// 全局: 注入 MaxKB 智能小助手(浮窗模式), 全站生效(首页 + 各产品文档页)。
//
// MAXKB_EMBED_SRC 是 MaxKB 控制台"嵌入第三方网站-浮窗模式"生成的 script 地址, 原样 copy。
// 注意: 不能用 <script> 标签静态写进页面, 必须用 DOM API 动态创建才能保证可控重试。
//
// 为什么放在 clientModule 而不是首页组件:
//   clientModule 被打进客户端入口 main.js, 而 main.js 是 defer 加载 —— defer 脚本在文档
//   解析完成后、DOMContentLoaded 之前执行, 且会推迟 window load, 因此这里注册的 load
//   监听一定早于 window load 触发。首页组件则是懒加载 chunk(挂载时机晚于 window load),
//   只能靠"补发 load"唤醒, 是个不确定环节。提前到此可让 embed.js 走自然 load 路径。
//
// embed.js 的三个关键特性(已读源码确认, 约 13KB, 由服务端动态生成, 每次返回的
// maxkb-<hash> 都不同):
//   ① 唯一初始化入口是脚本末尾的 window.addEventListener('load', embedChatbot), 没有 once;
//   ② initMaxkb() 完全不幂等 —— 直接 createElement + appendChild, 无"已存在则跳过"检查;
//   ③ 加载器在 ① 与 ② 之间没有留下任何可注销/可复用的句柄。
// 合起来意味着: 重复派发 load 必然挂出第二份浮窗, 而重新注入脚本时旧的 load 监听**无法注销**
// (见 dedupeMaxkbWindows)。这是本文件所有时序处理的前提。
const MAXKB_EMBED_SRC =
  'https://maxkb-internal.fit2cloud.com/chat/api/embed?protocol=https&host=maxkb-internal.fit2cloud.com&token=d876eead1840ecc7';

const SCRIPT_ID = 'maxkb-embed-script';

/* ------------------------------------------------------------------
 * 向 MaxKB 工作流传参: 让工作流按当前页面所属产品走不同分支。
 *
 * 机制(已实测跑通): 浮窗的 iframe 由 embed.js 用字符串模板生成
 *     <iframe id="maxkb-chat" src=${protocol}://${host}${prefix}/${token}?mode=embed${query}>
 * 我们是碰不到这个 iframe 的; 但把参数加在 **embed 脚本自己的 URL** 上, 服务端会按白名单
 * 过滤后拼进 iframe 的 query 位置, 最终变成:
 *     https://<host>/chat/<token>?mode=embed&product=jumpserver
 *
 * ⚠️ 白名单 = 该应用「开始节点」里定义的 API 输入字段 + MaxKB 内置的 asker。
 *    未定义的参数名会被**静默丢弃、不报错**(实测一次枚举: product / source_url / ak / sk
 *    等 27 个常见名字全部被丢弃, 只有 asker 通过)。所以 PRODUCT_PARAM 必须与 MaxKB 侧
 *    定义的字段名逐字一致, 否则传了等于没传。
 *    先例: Cordys CRM 官方文档即用同一机制, 在嵌入脚本 src 上追加 ak / sk / asker。
 * ------------------------------------------------------------------ */
const PRODUCT_PARAM = 'product';
// 传参范围: 与 docusaurus.config.js 中挂了文档插件的产品一一对应(共 8 个),
// 首页及非产品页面(如 /docs/)不带该参数。
// 匹配产品在**路径段**上的位置, 兼容 i18n 的 /en/ 前缀(如 /en/jumpserver/...),
// 同时避免 /jumpserverfoo 这类误命中。
// 新增产品时只需在此追加 id —— 传出去的值就是 id 本身, MaxKB 侧需有对应分支。
const PRODUCT_IDS = [
  'jumpserver',
  'maxkb',
  'dataease',
  '1panel',
  'sqlbot',
  'cordys',
  'ai-gateway',
  'halo',
];
const PRODUCT_RE = new RegExp(`(?:^|/)(${PRODUCT_IDS.join('|')})(?:/|$)`);

/* ------------------------------------------------------------------
 * 第二个参数: 历史版本。
 *
 * 各产品的「当前版」URL 上不带版本段(/maxkb/ 就是最新版), 只有历史版本才带
 * (/maxkb/v1/、/jumpserver/v4/、/dataease/v2/、/1panel/v1/) —— 依据是 docusaurus.config.js
 * 里各插件的 lastVersion: 'current' 与 versions 配置。因此策略是:
 *   最新版 → 不传 version, MaxKB 侧走默认(最新版)子智能体;
 *   历史版 → 传 URL 上的版本段原文(如 v1 / v4), 供工作流切到对应版本的子智能体。
 *
 * 不用"产品段后面任意一段都当版本"的宽松匹配: 文档里完全可能有个叫 v1 的普通目录,
 * 那样会把正常页面误判成历史版本。这里按历史版本白名单校验, 名单与各产品根目录下的
 * <product>_versions.json 一致(也与 docusaurus.config.js 的 versions 配置对应)。
 * 没有历史版本的产品(当前 sqlbot / cordys / ai-gateway)不在表中, 永远不传 version。
 * 新增历史版本快照时同步这里。
 * ------------------------------------------------------------------ */
const VERSION_PARAM = 'version';
const PRODUCT_HISTORY_VERSIONS = {
  '1panel': ['v1'],
  jumpserver: ['v4', 'v3'],
  dataease: ['v2'],
  maxkb: ['v1'],
};

// embed.js 是内部服务(偶发抖动/5xx), 下载失败时重试自愈。
// 重试只发生在脚本从未执行成功时 —— 此时页面还没有浮窗, 因此安全无副作用。
const MAXKB_RETRY_MAX = 2;
const MAXKB_RETRY_DELAY = 3000;
// 脚本已执行后, 再等多久复查一次浮窗是否真的挂出来了(毫秒)
const MAXKB_FALLBACK_DELAY = 6000;

// 当前已经生效的「产品|版本」组合('' 表示不带参数); null 表示还没注入过。
// 供 onRouteDidUpdate 判断是否需要重建浮窗: 同一产品的同一版本内部翻页不重建,
// 跨产品、或同产品跨版本(切 /maxkb/ ⇄ /maxkb/v1/)都要重建。
let appliedKey = null;

// 从路径解析出 {product, version}。无产品时为 ''/'', 最新版时 version 为 ''。
function detectRoute(pathname) {
  const p = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
  const m = p.match(PRODUCT_RE);
  if (!m) {
    return {product: '', version: ''};
  }
  const product = m[1];
  // 产品段之后的第一个路径段, 如 /maxkb/v1/user_manual → 'v1'。
  // m[0] 对 '/maxkb/v1/...' 是 '/maxkb/', 故 index+length 正好指向 'v1' 开头。
  const seg = p.slice(m.index + m[0].length).split('/')[0];
  const versions = PRODUCT_HISTORY_VERSIONS[product];
  return {
    product,
    version: versions && versions.includes(seg) ? seg : '',
  };
}

function buildEmbedSrc(product, version) {
  const params = [];
  if (product) {
    params.push(`${PRODUCT_PARAM}=${encodeURIComponent(product)}`);
  }
  // version 只在确认是历史版本时才带上; 最新版不传, 由工作流默认走最新子智能体。
  if (version) {
    params.push(`${VERSION_PARAM}=${encodeURIComponent(version)}`);
  }
  return params.length ? `${MAXKB_EMBED_SRC}&${params.join('&')}` : MAXKB_EMBED_SRC;
}

// 浮窗 DOM 是否已存在。必须排除 script 自身: 注入的 script 带 id="maxkb-embed-script",
// 同样命中 [id^="maxkb-"], 不过滤会导致"浮窗不存在"恒为 false。
function hasMaxkbWindow() {
  return Boolean(document.querySelector('[id^="maxkb-"]:not(script)'));
}

// 取浮窗的「最外层容器」。
// embed.js 生成的结构: body > div(无 id 的容器) > [style, div#maxkb-<hash>(浮窗根)]
// 根节点 id 里的 hash 由服务端每次随机生成, 所以只能按前缀找;
// 内部还有 #maxkb-chat-container / #maxkb-chat 也命中同一前缀, 用"祖先里没有别的命中项"
// 筛掉它们, 只留下最外层那个, 再向上取到容器节点(连 <style> 一起)。
function maxkbBoxes() {
  const roots = Array.from(document.querySelectorAll('[id^="maxkb-"]:not(script)')).filter(
    (el) => !el.parentElement || !el.parentElement.closest('[id^="maxkb-"]'),
  );
  return roots.map((el) =>
    el.parentElement && el.parentElement !== document.body ? el.parentElement : el,
  );
}

// embed.js 的 initMaxkb() 非幂等, 而我们重新注入脚本时, 上一份 embed.js 注册在 window 上的
// load 监听**没有任何句柄可以注销**。于是"补发 load"会把新旧两份 embedChatbot 一起唤醒,
// 各挂一份浮窗。这里按 DOM 顺序保留最后出现的那份(最新注入的), 移除更早的。
function dedupeMaxkbWindows() {
  const boxes = maxkbBoxes();
  boxes.slice(0, -1).forEach((box) => box.remove());
}

// 移除 embed.js 的全部产物, 以便带新参数重新注入。
function removeMaxkbEmbed() {
  maxkbBoxes().forEach((box) => box.remove());
  const script = document.getElementById(SCRIPT_ID);
  if (script) {
    script.remove();
  }
}

/* ------------------------------------------------------------------
 * 移动端: 屏蔽 embed.js 的 touch 拖拽, 换成我们自己的「阈值判定」拖拽。
 *
 * 根因(2026-09-30 真机复现): embed.js 给浮窗图标绑了 touchstart/touchmove 做拖拽
 * (桌面只绑 drag 系列, 所以电脑上正常)。它的 drag() 处理函数在 touchstart 那一刻
 * 就把图标 inline 样式改成
 *   top/left = 触点坐标 - naturalWidth/2,  width/height = naturalWidth(250px)
 * 没有任何「移动超过阈值才算拖拽」的判断, 于是手机浏览器按下→抬起之间的微抖动
 * 就足以让图标从右下角瞬移到触点左上 ~125px 处(即「往左上方瞬移」), touchend
 * 落点脱离图标, 浏览器不再合成 click → 对话框打不开; 再点再跳一次。
 * 我们 custom.css 里 62px !important 只压住了显示尺寸, 压不住 JS 用 250 计算的偏移。
 *
 * 修法: 捕获阶段 stopImmediatePropagation 拦掉 embed.js 的两个监听(它注册在冒泡阶段),
 * 然后由 guardTouchDrag 自己实现一套正常的触摸交互:
 *   - 手指移动 < 10px  → 视为点击: 图标纹丝不动, 默认行为(合成 click)照常打开对话框;
 *   - 手指移动 ≥ 10px → 视为拖拽: 图标跟随手指, 按 62px 显示尺寸居中于触点,
 *     并 clamp 在视口内; touchmove 里 preventDefault 抑制页面滚动,
 *     拖拽结束时再 preventDefault touchend 阻止 click 合成(松手不误开对话框)。
 *     (preventDefault 能阻断 click 合成, 已在 Chromium 真机验证。)
 * 桌面端 touch 事件不存在, 原生 drag 拖拽原样保留。
 *
 * 时机: embed.js 在 window load 时挂浮窗, 用 MutationObserver 盯 body 直接子节点,
 * 图标一出现就装守卫; 路由切换重建浮窗(removeMaxkbEmbed → 重新注入)时同样命中。
 * 守卫随图标 DOM 一起被销毁, 无需注销。
 * ------------------------------------------------------------------ */
// 判定「拖拽 vs 点击」的移动阈值(px): 小于它视为手指抖动, 走点击
const DRAG_THRESHOLD = 10;

function guardTouchDrag(button) {
  // 图标显示尺寸与 custom.css 的 62px !important 对应;
  // embed.js 用 naturalWidth(250) 算抓取偏移才导致瞬移, 我们按真实显示尺寸算。
  const SIZE = 62;
  const MARGIN = 8; // 拖拽时距视口边缘的最小间距
  let startX = 0;
  let startY = 0;
  let dragging = false;

  const block = (e) => e.stopImmediatePropagation();
  button.addEventListener(
    'touchstart',
    (e) => {
      block(e);
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dragging = false;
    },
    {capture: true},
  );
  button.addEventListener(
    'touchmove',
    (e) => {
      block(e);
      const t = e.touches[0];
      if (!dragging && Math.hypot(t.clientX - startX, t.clientY - startY) < DRAG_THRESHOLD) {
        return; // 还在阈值内: 不 preventDefault, 保留页面滚动与 click 合成
      }
      dragging = true;
      e.preventDefault(); // 拖拽中: 抑制页面跟随滚动
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.min(Math.max(t.clientX - SIZE / 2, MARGIN), vw - SIZE - MARGIN);
      const top = Math.min(Math.max(t.clientY - SIZE / 2, MARGIN), vh - SIZE - MARGIN);
      // right/bottom 与 top/left 同时存在时浏览器会忽略 right/bottom, 无需显式清除
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
    },
    {capture: true},
  );
  button.addEventListener(
    'touchend',
    (e) => {
      block(e);
      if (dragging) {
        // 刚完成一次拖拽: 阻止浏览器合成 click, 否则松手瞬间会误开对话框
        e.preventDefault();
        dragging = false;
      }
    },
    {capture: true},
  );
}

function guardMobileDrag(root) {
  const button = root.querySelector('.maxkb-chat-button');
  if (!button || button.dataset.touchGuarded) {
    return;
  }
  button.dataset.touchGuarded = '1';
  guardTouchDrag(button);
}

/* ------------------------------------------------------------------
 * 桌面端拖拽修正: 消除「拖动时图标(阴影)和鼠标不在同一位置」。
 *
 * 根因: 图标原图 250x250, 被 custom.css 的 62px !important 压小显示。embed.js 的
 * 原生 drag 处理不知道这件事, 仍按 naturalWidth/2(125px) 当抓取偏移, 并把 inline
 * 宽高设回 250px —— 于是图标左上角落在「光标 - 125px」处, 而显示只有 62px,
 * 光标总在图标右下方约 94px 处, 拖起来就是阴影跟鼠标分离。
 * (已实测: 浏览器按 computed 62px 渲染 inline width:250px 的盒子, 偏移完全吻合。)
 *
 * 修法: 在 document 冒泡阶段监听 drag/dragend —— embed.js 的监听注册在图标上,
 * 事件冒泡到 document 时它已算完, 我们再把图标纠正为「光标 - 显示尺寸/2」,
 * 图标中心就始终跟住光标; 顺带删掉它写的 250px inline 宽高(反正被 !important 压着)。
 * 用 document 级委托 + closest 判定, 浮窗重建/多实例都天然覆盖, 无需按图标注册。
 * ------------------------------------------------------------------ */
const BUTTON_SIZE = 62; // 与 custom.css 的 .maxkb-chat-button 62px !important 对应

function recenterDraggedButton(e) {
  const button =
    e.target && e.target.closest && e.target.closest('.maxkb-chat-button');
  if (!button) {
    return;
  }
  button.style.removeProperty('width');
  button.style.removeProperty('height');
  button.style.left = `${e.clientX - BUTTON_SIZE / 2}px`;
  button.style.top = `${e.clientY - BUTTON_SIZE / 2}px`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('drag', recenterDraggedButton);
  document.addEventListener('dragend', recenterDraggedButton);
}

function watchForChatButton() {
  const tryGuard = () => {
    document.querySelectorAll('[id^="maxkb-"]:not(script)').forEach((el) => guardMobileDrag(el));
    return Boolean(document.querySelector('.maxkb-chat-button'));
  };
  if (tryGuard()) {
    return;
  }
  const observer = new MutationObserver(tryGuard);
  observer.observe(document.body, {childList: true});
  // embed.js 始终没能挂出浮窗(被插件拦截/服务端异常)时停止观察, 避免 observer 永久空转。
  setTimeout(() => observer.disconnect(), 30000);
}

function loadMaxkbEmbed(attempt = 0, product = '', version = '') {
  if (document.getElementById(SCRIPT_ID)) {
    return;
  }
  appliedKey = `${product}|${version}`;
  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = buildEmbedSrc(product, version);

  // 三种状态都判断过才补发 load: 自然 load 已发生 + embed.js 已执行 + 浮窗 DOM 还不存在。
  // 同时满足才补发, 避免"自然 load 与补发 load 各触发一次 embedChatbot"挂出双浮窗。
  // 正常路径下 embed.js 在 load 之前执行, 由自然 load 唤醒, 这里不会触发;
  // 它覆盖的是 embed.js 下载/执行慢于 load 的时序(网络慢、服务端刚冷启),
  // 以及 SPA 路由切换后重新注入的场景(那时 load 早已发生)。
  let naturalLoaded = document.readyState === 'complete';
  let executed = false;
  const replayIfMissing = () => {
    if (naturalLoaded && executed && !hasMaxkbWindow()) {
      window.dispatchEvent(new Event('load'));
      // 上面那次补发会同时唤醒历史遗留的 load 监听(见 dedupeMaxkbWindows 注释),
      // 它们各自挂出的浮窗在此清掉, 只留最新这一份。
      dedupeMaxkbWindows();
      return true;
    }
    return false;
  };
  window.addEventListener(
    'load',
    () => {
      naturalLoaded = true;
      // 等本轮事件派发结束(embed.js 自己的 load 监听也在本轮执行)再判断
      setTimeout(replayIfMissing, 0);
    },
    {once: true},
  );
  script.onload = () => {
    executed = true;
    replayIfMissing();
    // 浮窗图标出现后给移动端装拖拽守卫(见 guardMobileDrag 注释)。
    watchForChatButton();
    // 兜底复查: 此刻 window load 必已发生(naturalLoaded 为 true), 若浮窗仍没挂出来,
    // 可能只是上一轮时机没对上, 再补发一次(浮窗不存在时补发是安全的)。
    setTimeout(() => {
      if (!replayIfMissing()) {
        // 走到这里: 脚本已执行 + load 已发生 + 浮窗仍不存在。
        // 通常是浏览器插件/隐私模式拦截了 embed iframe, 或 embed 服务端异常。
        // 此处只告警、不再重复补发 —— embed.js 的 embedChatbot 非幂等,
        // 浮窗已存在时重复补发会挂出第二份浮窗。
        console.warn(
          '[maxkb-embed] embed.js 已执行但浮窗未出现, 请检查网络或浏览器拦截策略',
        );
      }
    }, MAXKB_FALLBACK_DELAY);
  };
  // embed.js 下载失败(网络抖动 / 服务端 5xx): 若不处理, 浮窗会永久缺失。
  // 此刻脚本从未执行、页面也没有浮窗, 因此重试是安全的。
  script.onerror = () => {
    script.remove();
    if (attempt < MAXKB_RETRY_MAX) {
      console.warn(
        `[maxkb-embed] embed.js 加载失败, ${MAXKB_RETRY_DELAY / 1000}s 后第 ${
          attempt + 1
        }/${MAXKB_RETRY_MAX} 次重试`,
      );
      setTimeout(() => loadMaxkbEmbed(attempt + 1, product, version), MAXKB_RETRY_DELAY);
    } else {
      console.warn('[maxkb-embed] 重试已耗尽, 本次浮窗不可用');
    }
  };

  // clientModule 在 defer 的 main.js 中执行, 此时 body 必已存在; 兜底一次以防时序变化。
  const mount = () => (document.body || document.documentElement).appendChild(script);
  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, {once: true});
  }
}

// SPA 路由切换: 产品或版本变了就必须重建浮窗 —— iframe 上的 product/version 参数是注入时
// 定死的, 而参数由服务端按白名单拼进 iframe src, 我们无法只改 iframe.src 就保证它生效;
// 因此走"移除 + 重新注入"这条与首次加载完全相同的路径。
// 代价: iframe 会重载, 当前对话上下文丢失 —— 所以只在「产品|版本」组合真的变化时才做,
// 同一产品的同一版本内部翻页不受影响、不打断会话。
export function onRouteDidUpdate({location}) {
  const {product, version} = detectRoute(location && location.pathname);
  const key = `${product}|${version}`;
  if (key === appliedKey) {
    return;
  }
  removeMaxkbEmbed();
  loadMaxkbEmbed(0, product, version);
}

// 构建期 SSR 会执行本模块, 需保证无 document/window 时不报错。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const {product, version} = detectRoute();
  loadMaxkbEmbed(0, product, version);
}
