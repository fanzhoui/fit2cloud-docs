/**
 * Rspress 专有组件 shim: Steps。
 *
 * Rspress 的 <Steps> 把内部的若干个 h3 小节渲染成带编号的步骤列表。
 *
 * 注意: Docusaurus 把 markdown 的 h3 映射成了自定义的 Heading 组件
 * (见 @docusaurus/theme-classic MDXComponents 的 `h3: (props) => <MDXHeading as="h3" .../>`),
 * 所以在 React children 里拿到的不是字符串 'h3', 无法按 type 判断标题。
 * 因此这里不解析 children, 只做一层包裹, 由 CSS(counter)给其中的 h3 编号,
 * 更简单也更稳。
 */
import React from 'react';
import styles from './styles.module.css';

export default function Steps({children}) {
  return <div className={styles.steps}>{children}</div>;
}
