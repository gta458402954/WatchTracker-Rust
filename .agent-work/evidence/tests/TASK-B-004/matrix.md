# TASK-B-004 地区测试矩阵

本矩阵以正式集成线 `9255c8f` 为基线。Node 测试证明纯函数规则；Playwright 证明浏览器 UI 与 mock IPC/payload 边界；不把这些结果表述为真实桌面、SQLite 或外部 WebDAV 验证。

## REQUEST 7.2 单元测试

| 场景 | 覆盖测试 |
|---|---|
| 单一国家代码规范化、显示、筛选 | `classification.test.mjs` / `country-code normalization`; `filtering.test.mjs` / `combined record filters` |
| 多国解析、去重、统计、筛选 | `classification.test.mjs` / aggregation; `filtering.test.mjs` / multi-country options |
| 小写、空格、中英文逗号、重复 | `classification.test.mjs` / normalization |
| UK→GB，新旧写法一致 | `classification.test.mjs`; `filtering.test.mjs` / GB alias |
| CN/HK/TW 独立 | `classification.test.mjs`; `regions.spec.ts` / dynamic counts |
| originCountry 优先 | `classification.test.mjs` / region source priority |
| 旧中文标签回退 | `classification.test.mjs` / region source priority |
| 缺失或脏数据归入未知 | `classification.test.mjs`; `filtering.test.mjs` |
| 未映射有效两位代码保留并显示代码 | `classification.test.mjs`; `regions.spec.ts` |
| 仅生成实际地区并正确计算多国数量 | `filtering.test.mjs`; `regions.spec.ts` |
| TMDB 更新保留用户标签 | `classification.test.mjs` / TASK-B-003 rules; `b003-roundtrip.spec.ts` |

## REQUEST 7.3 端到端测试

| 场景 | 覆盖测试 |
|---|---|
| 常见国家、多国、UK、旧标签、未知夹具 | `regions.spec.ts` / dynamic counts; `b003-roundtrip.spec.ts` |
| 只显示实际存在选项 | `regions.spec.ts` / dynamic counts and empty data |
| CN/HK/TW 互不混淆 | `regions.spec.ts` / filters by code |
| 英国同时命中 GB 与 UK | `regions.spec.ts` / aliases and sentinels |
| 多国作品命中任一所属地区 | `regions.spec.ts` / aliases and sentinels |
| 未知地区只显示无法识别记录 | `regions.spec.ts` / aliases and sentinels |
| media/status/search/lock/sort/current-region 组合 | `regions.spec.ts` / media/status scope; `filtering.test.mjs` / combined filters |
| 新增、编辑、删除、整体替换动态更新 | `regions.spec.ts` / dynamic options react |
| 导入、同步、冲突恢复字段保真 | `b003-roundtrip.spec.ts` / watchlist boundary tests |
| 多地区换行、aria-pressed、可操作性 | `regions.spec.ts` / many dynamic regions wrap |

## 缺口处置

既有测试已经覆盖业务矩阵。本任务只在 `regions.spec.ts` 增加排序、锁定循环和当前地区选择前后选项集合不变的 UI 断言；评分是记录字段和排序键，不是当前产品的筛选器，因此不虚构“评分筛选”。没有发现需要修改生产代码或 mock IPC 的缺口。
