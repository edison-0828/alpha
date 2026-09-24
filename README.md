# AlphaPulse · 阿尔法脉冲

Binance Alpha（BSC）链上异动监控控制台。它通过 Binance Alpha 官方 WebSocket 接收实时价格，对一小部分热池代币即时重算短窗评分和提醒，并每 5 秒用 REST 校准完整市场快照。评分使用价格、成交额、市值、流动性、交易数、持币地址与 FDV。这一阶段只用免费的 Binance Alpha 数据，不需要 OKX。

## 启动

需要 Node.js 22 或更高版本，无需安装第三方依赖：

```powershell
cd D:\Alpha
npm start
```

浏览器打开：<http://127.0.0.1:4173>

## 当前能力

- 自动读取 Binance Alpha 官方完整代币池；默认筛选 BSC（Chain 56）
- Binance Alpha 官方 WebSocket 实时价格推送，断线自动重连
- 热池即时重算：模拟仓、自动管理仓、近 2 小时提醒、评分达到 62 的币，以及评分达到 42 且处于潜伏/启动的早期候选，会在 WebSocket 价格到达后更新短窗指标、评分、阶段和提醒边沿。热池默认最多 48 个，硬上限 64
- 不在热池里的币只更新价格，评分和提醒仍等到 5 秒 REST 快照。即时重算默认每个币 300ms 最多一次
- 5 秒完整行情快照仍是流动性、持币地址、24H 成交和上线信息的准绳，也负责冷币评分
- 异动优先、拉升榜、资金热度、风险榜
- 试仓、重点观察、减仓、回避四级建议
- 单币详情、24 小时区间、评分正负因素
- 信号复盘面板：15 分钟价格轨迹、首次异动价、信号后涨跌与最近 6 条异动事件时间线
- SQLite 策略数据库：分层价格快照保留 2 天，信号与结果保留 90 天
- 自动记录每次信号在 5 分钟、15 分钟、1 小时和 4 小时后的价格表现
- 策略验证中心：规则样本量、方向胜率、平均效果、有利波动和不利波动
- OKX Onchain OS WebSocket 链上资金层：Smart Money、KOL、大额 Swap 与池子流动性变化
- Top10 持仓集中度、Smart Money 净流入、大额成交净流入参与评分和风险过滤
- 链上资金确认预设，以及 Smart Money/大额 Swap/池子变化/Top10 四项高级筛选
- 搜索、建议筛选、分页和手动刷新
- 高级筛选规则与策略预设
- 1/5/15 分钟多周期动量、5 分钟资金强度与成交增量加速
- 早期评分：1 分钟/5 分钟动量、成交增量加速、新上线窗口，以及更低阈值的早期 Smart Money / 大额 Swap 会抬升分数；已经很大的 24H 涨幅不再主导「值得关注」
- 潜伏、启动、确认、过热、衰竭五阶段识别及样本置信度；1 分钟转强也可以进入潜伏，早期链上买盘可以进入启动
- 资金启动、多周期确认、防追高、链上资金确认，以及更激进的「以小博大」（潜伏/启动、更低评分、不追 24H 大涨）
- 异动提醒中心：早期启动、多周期确认、资金加速、启动、强信号与动量衰竭
- 早期启动使用更低分数门槛。5 分钟样本还没形成时，1 分钟涨幅达到 0.4% 也可以先提醒；24H 跌幅超过 15% 或涨幅已经达到 40% 则不报。资金加速与启动阈值略放宽，仍要求信号质量不是「噪声偏高」，并且只在规则从关闭变为打开时触发
- 首次异动时间、30 分钟重复提醒抑制和最近 300 条告警持久化
- `early-launch` / `launch` / `flow-surge` / `smart-money` 的第一次提醒不受 30 分钟冷却限制；同一规则再次打开仍要冷却
- 可选浏览器桌面通知（需在页面中手动授权）
- 按币种合并提醒、高优先级筛选、全部已读、币种/规则静音
- 可记忆的紧凑监控模式与榜单 5 分钟迷你价格曲线
- 100,000 USDT 服务端持久化模拟仓、实时估值、持仓均价、盈亏额与盈亏率
- 带硬风控的模拟自动交易：默认单笔 1,000 USDT、最多 3 个仓位、评分/流动性/持币数/追高过滤
- 自动硬止损、结构性风险退出、单日开仓与亏损上限；价格达到买入均价 2 倍时按实际成本精确卖出并收回本金
- 加仓后按总成本/总数量更新加权均价；自动管理仓位会同步新增本金和新的 2 倍出本价
- 自动交易中心：启停开关、风控参数、当前候选、管理中持仓与执行记录，状态持久化到 `data/auto-trading.json`
- 服务端持续接收实时行情：热池走 WebSocket 即时重算，全市场每 5 秒校准，网页关闭后仍持续监控
- Windows 登录自启、异常自动重启和历史状态落盘
- 分层策略快照：持仓/高评分/近期告警每分钟记录，普通资产每 5 分钟记录
- Gzip 紧凑历史状态、五分钟状态落盘和 15 秒策略结果评估

## Windows 常驻监控

计划任务名称：`AlphaPulse Monitor`。登录 Windows 后自动启动；电脑需保持开机、联网且不进入睡眠。

检查后台状态：

```powershell
cd D:\Alpha
.\scripts\status-alphapulse.ps1
```

运行日志位于 `logs\service.log`，快速恢复状态优先使用 `data\monitor-state.json.gz`（旧版 `monitor-state.json` 可自动迁移），策略分析数据库位于 `data\alphapulse.db`。

## Grok Bot 云端常驻

项目目录为 `/workspace/alphapulse`。更新并重启：

```bash
cd /workspace/alphapulse
git pull --ff-only origin main
bash scripts/cloud-service.sh restart
bash scripts/cloud-service.sh status
```

云端守护脚本会使用 Node 22、记录独立 PID、异常退出后 5 秒重启，并在正常停止时保存状态。健康检查与一致性备份：

```bash
bash /workspace/alphapulse/scripts/cloud-healthcheck.sh
bash /workspace/alphapulse/scripts/backup-cloud.sh
```

备份默认保存在 `/workspace/alphapulse-backups/<UTC时间>/`，包含模拟仓、自动交易状态、压缩监控状态和通过 SQLite `VACUUM INTO` 生成的一致性数据库副本；默认保留 14 天。建议在 Grok Bot 中创建两个 Routine：每 5 分钟运行健康检查（成功时保持静默，恢复失败时通知），每天运行一次备份。

`/api/health` 的 `memory` 给出 RSS、堆占用和是否处于内存承压；`hotPool.size` 是当前热池大小，`hotPool.max` 是当前上限。健康检查脚本只判断 `"ok":true`，这些字段给运维看压力用。

## 热池与内存（Phase 2，仅免费数据）

即时路径只服务热池，避免 600 多个币每个 ticker 都重算。成员按这个顺序挤进上限：模拟仓、自动管理仓、近 2 小时提醒、高分观察、早期阶段。同一币占一个名额。

历史点仍主要由 5 秒 REST 写入。热池只有在距离上一个历史点至少 5 秒时才补一个点，因此不会每个 tick 追加一行，15 分钟窗口也不会被 1 秒级数据挤掉。承压时连这个补点也停掉。

OKX 仍然可选。不配置凭据、不设置 `OKX_CHAIN_INTEL_ENABLED=true` 时，热池即时重算照常工作。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `ALPHAPULSE_HOT_POOL_MAX` | 48 | 热池上限，允许 8–64 |
| `ALPHAPULSE_HOT_DEBOUNCE_MS` | 300 | 单币重算间隔，限制在 200–500 |
| `ALPHAPULSE_HOT_HISTORY_SAMPLE_MS` | 5000 | 热池补历史点的最小间隔 |
| `ALPHAPULSE_HOT_ALERT_WINDOW_MS` | 7200000 | 最近提醒进入热池的时间窗 |
| `ALPHAPULSE_HOT_SCORE` | 62 | 高分观察门槛 |
| `ALPHAPULSE_HOT_EARLY_SCORE` | 42 | 潜伏/启动进入热池的分数门槛 |
| `ALPHAPULSE_MAX_HISTORY` | 240 | 单币历史长度，不能超过原来的 240，最低 30 |
| `ALPHAPULSE_RSS_SOFT_MB` | 512 | RSS 达到后缩小热池、缩短历史，并跳过非持仓/非提醒的即时重算。设为 0 关闭 |
| `ALPHAPULSE_PRESSURE_HOT_POOL_MAX` | 16 | 承压时的热池上限 |
| `ALPHAPULSE_PRESSURE_HISTORY_CAP` | 120 | 承压时的单币历史长度 |
| `ALPHAPULSE_MAX_TRACKED_HISTORIES` | 900 | 内存里保留价格历史的币种数 |
| `ALPHAPULSE_PRESSURE_MAX_HISTORIES` | 180 | 承压时保留的历史币种数，热池优先留下 |
| `ALPHAPULSE_MAX_CHAIN_TOKENS` | 400 | 链上事件缓存的币种数 |
| `ALPHAPULSE_PRESSURE_MAX_CHAIN_TOKENS` | 24 | 承压时的链上缓存币种数 |

承压只降级，不让进程崩溃。持仓和近 2 小时提醒仍会即时重算。

## OKX 链上资金数据

Smart Money 和逐笔 Swap 数据通过 OKX Onchain OS 官方 WebSocket 接入，需要在 OKX Developer Portal 创建 Market API 凭据。凭据只保存在本机 `.env`，不会发送到网页或写入数据库。

在 PowerShell 中运行交互式配置：

```powershell
cd D:\Alpha
.\scripts\configure-okx-chain-intel.ps1
```

配置后重新启动 `AlphaPulse Monitor` 计划任务。系统会全局监听 BSC Smart Money/KOL 活动，并动态订阅评分最高或近期触发提醒的 24 个币种的逐笔成交与池子指标。未配置凭据时，Binance Alpha 行情监控和热池即时重算会继续正常运行，链上资金卡片显示“待配置”。OKX 不是 Phase 2 的依赖。

## 自动交易安全边界

- 后台自动执行仅限模拟仓，不连接钱包、不保存私钥/API Key，也不会在无人确认时发送真实交易
- 默认自动交易保持关闭，执行模式固定为模拟，评分门槛仍是 82 且要求高质量。「以小博大」只改变页面筛选，不改这套默认风控
- 真实买入、卖出和条件单必须通过受控钱包逐笔展示报价、安全检查并由用户确认；网页只提供筛选候选
- 模拟仓不计手续费、滑点与实际池子冲击，因此不能等同于真实成交结果
- 模拟仓默认持久化到服务端 `data/paper-portfolio.json`，浏览器同时保留本地缓存；可在页面导入/导出模拟仓
- 桌面通知仅在监控页面运行时显示；后台服务会持续记录告警历史
- 暂未接入 Smart Money 地址标签、逐笔 Swap、CEX 充值地址与对敲聚类
- 进程重启后短时快照会重新建立基线
- 所有建议仅用于研究和风险筛查，不构成投资建议

## 下一阶段

1. Phase 1：提前评分、早期启动提醒和「以小博大」预设已经接上。自动执行仍然只做模拟仓，默认关闭，不会因为这套更早的研究信号而改成激进实盘。
2. Phase 2（当前）：热池内用免费 Binance Alpha WebSocket 即时重算短窗评分、阶段和提醒。不全市场逐笔重算，也不接入 OKX 付费接口。
3. Telegram / 飞书推送。
4. Phase 3：Binance Alpha 新增/下线事件流、四小时倒计时，以及 GoPlus 安全扫描。
5. 按策略胜率自动调整评分权重，并增加样本置信区间。
6. 真实订单的待确认队列和执行回执。不保存私钥，也不做无人值守的真实下单。
