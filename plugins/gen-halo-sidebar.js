/**
 * 一次性生成 halo-docs/sidebars.js。
 *
 * 输入: halo-docs/ 下 26 个 _meta.json(Rspress 侧栏配置)与目录文件。
 * 规则(对应 Rspress 语义):
 *   - 字符串 name        -> {type:'doc', id:<相对源路径去扩展名>, label, key}
 *   - {type:'file',name} -> 该目录 index 的 doc(放在分类首项)
 *   - {type:'section-header'}       -> category(collapsed:false) 聚合后续条目(直到下个 section-header/结束)
 *   - {type:'dir-section-header'}   -> category(collapsed:false)
 *   - {type:'dir'}                  -> 递归 category(尊重 collapsed)
 *   - {type:'custom-link'}          -> {type:'link', href}
 *   - 目录无 _meta.json 时 -> 自动列出其 .md/.mdx(排除 _ 前缀与 index)
 * 每个 id 断言存在对应源文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve('halo-docs');
const OUT = path.join(ROOT, 'sidebars.js');

// 收集所有内容文档的相对路径(相对 halo-docs/, 去扩展名), 排除 _ 前缀片段
function collectFiles(dir) {
  const res = new Set();
  const raw = fs.readdirSync(dir, {withFileTypes: true});
  for (const ent of raw) {
    if (ent.name.startsWith('_')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(full).forEach((x) => res.add(x));
    else if (/\.mdx?$/.test(ent.name)) {
      let rel = path.relative(ROOT, full).split(path.sep).join('/');
      rel = rel.replace(/\.mdx?$/, '');
      res.add(rel);
    }
  }
  return res;
}

const ALL = collectFiles(ROOT);
const missing = new Set();

function docEntry(folderRel, name, label) {
  const id = folderRel ? `${folderRel}/${name}` : name;
  const out = {type: 'doc', id};
  // key 用 doc id(全局唯一), 避免多个同名 label(如多个"内容导航")触发
  // Docusaurus 侧栏翻译 key 冲突。
  if (label) {
    out.label = label;
  }
  out.key = `doc:${id}`;
  return out;
}

function readMeta(folder) {
  const meta = path.join(folder, '_meta.json');
  if (fs.existsSync(meta)) {
    return {meta: JSON.parse(fs.readFileSync(meta, 'utf8')), haveMeta: true};
  }
  return {meta: null, haveMeta: false};
}

// 目录内不含 _meta.json 时: 自动列出文件(index 置顶, 其余按字母序)
function autoList(folder) {
  const rels = fs
    .readdirSync(folder, {withFileTypes: true})
    .filter((e) => !e.isDirectory() && /\.mdx?$/.test(e.name) && !e.name.startsWith('_'))
    .map((e) => e.name.replace(/\.mdx?$/, ''));
  const idx = rels.filter((r) => r === 'index');
  const rest = rels.filter((r) => r !== 'index').sort();
  // 不设 label, 交给 Docusaurus 用文档标题
  return [...idx, ...rest].map((name) => ({type: 'file', name}));
}

function dirId(folder) {
  const rel = path.relative(ROOT, folder).split(path.sep).join('/');
  return rel === '.' ? '' : rel;
}

// 把一个 _meta 条目数组转成 items。
// section-header / dir-section-header 会开启一个新的 category, 聚合其后条目
// 直到下一个 section-header 或数组结束。
function buildItems(entries, folder) {
  const folderRel = dirId(folder);
  const items = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (typeof entry === 'string') {
      items.push(docEntry(folderRel, entry));
      continue;
    }

    switch (entry.type) {
      case 'file':
        if (entry.name === 'index') {
          // index 文档: 作为普通 doc 放在该分类里
          items.push(docEntry(folderRel, 'index', entry.label || '内容导航'));
        } else {
          items.push(docEntry(folderRel, entry.name, entry.label));
        }
        break;

      case 'section-header':
      case 'dir-section-header': {
        // dir-section-header: 指向一个有 _meta.json 的子目录, 作为该目录的分类
        // (递归渲染其内容), 不聚合后续条目。
        if (entry.type === 'dir-section-header') {
          items.push(dirCategory(entry, folder));
          break;
        }
        // section-header: 纯聚合标签, 聚合到下一个 section-header 或数组结束。
        const groupLabel = entry.label;
        const group = [];
        let j = i + 1;
        for (; j < entries.length; j++) {
          const e = entries[j];
          if (typeof e === 'string') {
            group.push(docEntry(folderRel, e));
          } else if (e.type === 'section-header' || e.type === 'dir-section-header') {
            break;
          } else if (e.type === 'dir') {
            group.push(dirCategory(e, folder));
          } else if (e.type === 'file') {
            group.push(docEntry(folderRel, e.name, e.label));
          } else if (e.type === 'custom-link') {
            group.push({
              type: 'link',
              label: e.label,
              href: e.link,
              key: `link:${folderRel}#${e.label}`,
            });
          }
        }
        items.push({
          type: 'category',
          label: groupLabel,
          key: `cat:${folderRel}#${i}:${groupLabel}`,
          collapsed: false,
          items: group,
        });
        i = j - 1;
        break;
      }

      case 'dir':
        items.push(dirCategory(entry, folder));
        break;

      case 'custom-link':
        items.push({
          type: 'link',
          label: entry.label,
          href: entry.link,
          key: `link:${folderRel}#${entry.label}`,
        });
        break;

      default:
        console.error(`未知 entry 类型: ${JSON.stringify(entry)} in ${folderRel}`);
    }
  }

  return items;
}

function dirCategory(entry, parentFolder) {
  const dirPath = path.join(parentFolder, entry.name);
  const relId = dirId(dirPath);
  return {
    type: 'category',
    label: entry.label || entry.name,
    key: `cat:${relId}`,
    collapsed: entry.collapsed === true,
    items: buildItems(readMeta(dirPath).haveMeta ? readMeta(dirPath).meta : autoList(dirPath), dirPath),
  };
}

// 顶层: guide / developer-guide 各成为一个根分类
const guide = {
  type: 'category',
  label: '使用指南',
  key: 'cat:guide',
  items: buildItems(readMeta(path.join(ROOT, 'guide')).meta, path.join(ROOT, 'guide')),
};
const dev = {
  type: 'category',
  label: '开发者指南',
  key: 'cat:developer-guide',
  items: buildItems(readMeta(path.join(ROOT, 'developer-guide')).meta, path.join(ROOT, 'developer-guide')),
};

// 断言所有 doc id 存在
function assertIds(items) {
  items.forEach((it) => {
    if (it.type === 'doc' && !ALL.has(it.id)) missing.add(it.id);
    if (it.type === 'category') assertIds(it.items);
  });
}
assertIds(guide.items);
assertIds(dev.items);

if (missing.size) {
  console.error('以下 doc id 找不到源文件:');
  missing.forEach((m) => console.error(' -', m));
  process.exit(1);
}

const sidebars = {halo: [
  // 首项: 产品介绍(与 cordys/sqlbot 一致, /halo/ 直接打开它)
  docEntry('', 'index', '产品介绍'),
  guide,
  dev,
]};
const out = `// @ts-check
// 由 plugins/gen-halo-sidebar.js 从 26 个 _meta.json 生成, 请勿手改。
/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = ${JSON.stringify(sidebars, null, 2)};
export default sidebars;
`;
fs.writeFileSync(OUT, out, 'utf8');
console.log(`写入 ${OUT}`);
console.log(`guide 顶层条目: ${guide.items.length}, dev 顶层条目: ${dev.items.length}`);
