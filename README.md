# AlphaPulse · 阿尔法脉冲

Binance Alpha（BSC）链上异动监控控制台第一版。它通过 Binance Alpha 官方 WebSocket 接收实时价格，并每 5 秒校准完整市场快照，根据价格、成交额、市值、流动性、交易数、持币地址与 FDV 计算研究型信号。

## 启动

需要 Node.js 22 或更高版本，无需安装第三方依赖：

```powershell
cd D:\codex\2026-09-21\z\outputs\alpha-radar
npm start
```

浏览器打开：<http://127.0.0.1:4173>

## 当前能力

- 自动读取 Binance Alpha 官方完整代币池；默认筛选 BSC（Chain 56）
- Binance Alpha 官方 WebSocket 实时价格推送，断线自动重连
- 5 秒完整行情快照、指标校准与 REST 备用数据源
- 异动优先、拉升榜、资金热度、风险榜
- 试仓、重点观察、减仓、回避四级建议
- 单币详情、24 小时区间、评分正负因素
- 信号复盘面板：15 分钟价格轨迹、首次异动价、信号后涨跌与最近 6 条异动事件时间线
- SQLite 策略数据库：分钟快照保留 7 天，信号与结果保留 90 天
- 自动记录每次信号在 5 分钟、15 分钟、1 小时和 4 小时后的价格表现
- 策略验证中心：规则样本量、方向胜率、平均效果、有利波动和不利波动
- OKX Onchain OS WebSocket 链上资金层：Smart Money、KOL、大额 Swap 与池子流动性变化
- Top10 持仓集中度、Smart Money 净流入、大额成交净流入参与评分和风险过滤
- 链上资金确认预设，以及 Smart Money/大额 Swap/池子变化/Top10 四项高级筛选
- 搜索、建议筛选、分页和手动刷新
- 高级筛选规则与四套策略预设
- 1/5/15 分钟多周期动量、5 分钟资金强度与成交增量加速
- 潜伏、启动、确认、过热、衰竭五阶段识别及样本置信度
- 资金启动、多周期确认、防追高三套专业预设
- 异动提醒中心：多周期确认、资金加速、启动、强信号与动量衰竭
- 首次异动时间、30 分钟重复提醒抑制和最近 300 条告警持久化
- 可选浏览器桌面通知（需在页面中手动授权）
- 按币种合并提醒、高优先级筛选、全部已读、币种/规则静音
- 可记忆的紧凑监控模式与榜单 5 分钟迷你价格曲线
- 100,000 USDT 本地模拟仓、实时估值、持仓均价和浮动盈亏
- 服务端持续接收实时行情并每 5 秒主动校准，网页关闭后仍持续监控
- Windows 登录自启、异常自动重启和历史状态落盘

## Windows 常驻监控

计划任务名称：`AlphaPulse Monitor`。登录 Windows 后自动启动；电脑需保持开机、联网且不进入睡眠。

检查后台状态：

```powershell
cd D:\codex\2026-09-21\z\outputs\alpha-radar
.\scripts\status-alphapulse.ps1
```

运行日志位于 `logs\service.log`，快速恢复状态位于 `data\monitor-state.json`，策略分析数据库位于 `data\alphapulse.db`。

## OKX 链上资金数据

Smart Money 和逐笔 Swap 数据通过 OKX Onchain OS 官方 WebSocket 接入，需要在 OKX Developer Portal 创建 Market API 凭据。凭据只保存在本机 `.env`，不会发送到网页或写入数据库。

在 PowerShell 中运行交互式配置：

```powershell
cd D:\codex\2026-09-21\z\outputs\alpha-radar
.\scripts\configure-okx-chain-intel.ps1
```

配置后重新启动 `AlphaPulse Monitor` 计划任务。系统会全局监听 BSC Smart Money/KOL 活动，并动态订阅评分最高或近期触发提醒的 24 个币种的逐笔成交与池子指标。未配置凭据时，Binance Alpha 行情监控会继续正常运行，链上资金卡片显示“待配置”。

## MVP 边界

- 不连接钱包，不执行真实交易；模拟仓不计手续费与滑点
- 模拟仓默认持久化到服务端 `data/paper-portfolio.json`，浏览器同时保留本地缓存；可在页面导入/导出模拟仓
- 桌面通知仅在监控页面运行时显示；后台服务会持续记录告警历史
- 暂未接入 Smart Money 地址标签、逐笔 Swap、CEX 充值地址与对敲聚类
- 进程重启后短时快照会重新建立基线
- 所有建议仅用于研究和风险筛查，不构成投资建议

## 下一阶段

1. 按策略胜率自动调整评分权重，并增加样本置信区间。
2. 接入 OKX Smart Money WebSocket、BSC 归档 RPC 和 GoPlus 安全扫描。
3. 增加 Telegram/飞书推送和模拟仓自动止盈止损。
4. 加入 Binance Alpha 新增/下线监控与四小时倒计时提醒。
