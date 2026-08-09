# TASK-D-UX-004：完整弹窗可访问性专项设计

> 状态：IMPLEMENTED
> 日期：2026-08-09
> 数据边界：纯前端交互；不修改 SQLite、同步 payload、业务记录或设置值

## 1. 目标

为 RecordForm、SettingsModal 和 Dashboard 建立同一套弹窗契约：

1. 根容器使用 `role="dialog"`、`aria-modal="true"`，并通过 `aria-labelledby` 关联唯一可见标题。
2. 打开时保存触发元素；焦点进入显式初始目标，否则进入第一个可操作控件，再否则落在弹窗容器。
3. Tab 与 Shift+Tab 只能在最上层弹窗内循环；后台页面不能通过键盘操作。
4. Escape 只交给最上层弹窗。Settings 批量任务运行时保持原有“安全停止”语义，不直接关闭。
5. 关闭或卸载后，焦点恢复到仍存在且可聚焦的原触发元素。
6. 任意弹窗打开期间锁定页面滚动；多个弹窗同时存在时使用引用计数，最后一个关闭后才恢复原样式。

## 2. 实现边界

- 使用共享 `useAccessibleDialog` Hook，集中维护焦点列表、顶层栈、Escape、Tab 循环、滚动锁定和焦点恢复。
- 不引入第三方弹窗库，不把现有三个大型组件整体重写，也不改变视觉布局。
- RecordForm 初始焦点放在“中文名”；Settings 放在当前第一个可用导航按钮；Dashboard 放在关闭按钮。
- RecordForm 保留点击遮罩关闭；全屏 Settings 与 Dashboard 不新增点击背景关闭。
- 浏览器原生 `confirm` 不纳入 React 弹窗栈，由浏览器继续独占焦点。
- Dashboard 的条目摘要是页面内 region，不升级成第二层 dialog。

## 3. 最上层规则

每个弹窗挂载时取得唯一 token 并压入模块级栈。只有栈顶 token 可以处理 Escape 与 Tab；卸载时移除自身 token，即使卸载顺序异常也不得遗留失效项。这为未来真正的嵌套 React 弹窗保留正确行为。

## 4. 验收

- 三个弹窗均能按可见名称被 `getByRole('dialog')` 定位。
- RecordForm 打开后焦点位于中文名输入框。
- Settings 与 Dashboard 打开后焦点进入弹窗。
- 从首个控件 Shift+Tab、从末个控件 Tab 都留在弹窗内。
- Escape 关闭后焦点回到对应触发按钮。
- Settings 批量任务运行时 Escape 只请求安全停止。
- typecheck、lint、Node、Playwright、生产 build、Rust 回归全部通过。

## 5. 实施结果

- 新增共享 `useAccessibleDialog` Hook，以顶层栈统一处理初始焦点、Tab/Shift+Tab 循环、Escape、焦点恢复和页面滚动锁定。
- RecordForm、SettingsModal、Dashboard 均已接入统一 dialog 语义和标题关联，并保留各自既有关闭与安全停止规则。
- 新增浏览器端可访问性回归，覆盖三个弹窗的语义、初始焦点、焦点陷阱、Escape、焦点恢复和滚动锁定。
- 2026-08-09 验收通过：Node 93/93、Playwright 68/68、Rust 75/75，以及 typecheck、lint、生产 build、rustfmt 和严格 Clippy。
