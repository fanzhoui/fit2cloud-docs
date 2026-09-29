/**
 * Rspress 专有组件 shim: Tabs / Tab。
 *
 * Rspress 的 <Tabs><Tab label="...">content</Tab>...</Tabs> 渲染成标签页。
 * 这里用内部状态 activeIndex 实现一个小型标签面板:
 * - Tab 的 label 作标签文字;
 * - 只有一个 Tab 时直接渲染内容, 不显示标签条。
 */
import React, {useState} from 'react';
import styles from './styles.module.css';

export function Tab({children}) {
  // Tab 的实际内容由 Tabs 侧渲染; 这里仅作为数据载体(标签 + 内容)。
  // 兼容直接渲染(极少见)时原样输出。
  return <div className={styles.tabStandalone}>{children}</div>;
}

export default function Tabs({children}) {
  const tabs = React.Children.toArray(children).filter(
    (c) => React.isValidElement(c),
  );
  if (tabs.length === 0) return null;

  // 提取标签
  const labels = tabs.map((t) => {
    const props = t.props || {};
    return props.label !== undefined ? String(props.label) : '默认';
  });

  const [active, setActive] = useState(0);
  const safeActive = Math.min(active, labels.length - 1);

  if (tabs.length === 1) {
    return <div className={styles.tabsSingle}>{tabs[0]}</div>;
  }

  return (
    <div className={styles.tabs}>
      <div className={styles.tabsBar} role="tablist">
        {labels.map((label, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === safeActive}
            className={`${styles.tabsTab} ${i === safeActive ? styles.tabsTabActive : ''}`}
            onClick={() => setActive(i)}>
            {label}
          </button>
        ))}
      </div>
      <div className={styles.tabsPanel} role="tabpanel">
        {tabs[safeActive]}
      </div>
    </div>
  );
}
