import React from 'react';
import MDXComponents from '@theme-original/MDXComponents';
import Link from '@docusaurus/Link';

// Rspress 专有组件 shim(迁移自 Halo 文档站的 Rspress 语法)
import Steps from '../components/RspressShims/Steps';
import Tabs, {Tab} from '../components/RspressShims/Tabs';
import PageTabs, {PageTab} from '../components/RspressShims/PageTabs';

// 注册自定义的大写 JSX 组件，用于文档里的"图 + 图注"标准模板。
// - PascalCase 让 MDX 编译期按 JSX 解析，属性里允许写 `style={{...}}` 对象写法；
// - 运行时再渲染成真正的 <img>/<div>，React 在 SSR 阶段也能拿到对象形式 style。
export default {
  ...MDXComponents,
  Img: (props) => <img {...props} />,
  FigCap: ({ children, ...props }) => (
    <div {...props}>{children}</div>
  ),
  // Rspress shim: 兼容 @rspress/core 的 Steps / Tabs / Tab / PageTabs / PageTab / Link
  Steps,
  Tabs,
  Tab,
  PageTabs,
  PageTab,
  // Rspress 的 Link(runtime) 语义即站内导航 -> 直通 Docusaurus Link
  Link,
};

