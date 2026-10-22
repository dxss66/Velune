# Velune

Velune 是一个基于 Electron 的桌面行情看盘工具，聚合多个公开行情源，提供统一的 K 线图表、技术指标、绘图工具和多窗口分屏。

项目不依赖账号或私有 API Key，安装后即可浏览加密货币、A 股、港股、美股、韩股、日股/欧股、ETF、指数、期货、外汇、债券与宏观经济数据。

## 功能

- 多市场浏览：股票、基金/ETF、期货、外汇、加密货币、指数、债券、经济数据
- 多数据源：Binance、Gate、Bybit、OKX、Yahoo Finance、东方财富、新浪财经、Naver、SEC、FRED
- 国家 / 来源 / 类型 / 交易所四维筛选与关键词搜索
- K 线图表：多周期、历史向前分页加载、技术指标、绘图工具、多窗口分屏
- 收藏交易对：标题栏实时价格、1 秒轮询、拖拽排序
- 启动时批量拉取市场目录与行情快照，列表滚动按需渲染
- 本地持久化：主题、字体、语言、指标设置、图表设置、分屏布局、收藏

## 支持的市场

| 类别 | 数据来源 | 说明 |
| --- | --- | --- |
| 加密货币 | Binance、Gate、Bybit、OKX | 现货与合约，交易对由交易所接口动态获取 |
| A 股 / ETF / 指数 | 东方财富、新浪财经 | 全市场股票、ETF、指数，K 线支持长历史 |
| 港股 | 东方财富、Yahoo Finance | 港股全量证券列表，失败时自动回退 |
| 美股 | SEC、Yahoo Finance、新浪财经 | SEC 公司目录 + Yahoo 行情 |
| 韩股 | Naver、Yahoo Finance | KOSPI / KOSDAQ |
| 日股 / 欧股 | Yahoo Finance | 常用标的与指数 |
| 期货 | Yahoo Finance、新浪财经 | 商品、股指、利率、外汇期货 |
| 外汇 | Yahoo Finance、新浪财经 | 主要/次要货币对，USD/CNH 提供长历史 |
| 债券 / 利率 | FRED、Yahoo Finance | 美债收益率、债券 ETF、部分国家国债收益率 |
| 经济数据 | FRED | 通胀、就业、GDP、货币供应、房地产等 |

> 公开接口可能会调整、限流或暂时不可用。部分市场（例如期权链、FRED 盘中价）没有免费公开数据，界面上会显示为空或延迟数据。

## 技术栈

- Electron 33
- Node.js 20+
- 原生 JavaScript / CSS 渲染层
- lightweight-charts 图表引擎
- 无前端构建步骤：`dist/renderer` 中的资源直接由 Electron 加载

## 目录结构

```text
.
├─ src/
│  ├─ main/                     Electron 主进程
│  │  ├─ main.mjs               窗口、IPC、应用生命周期
│  │  ├─ preload.mjs            渲染层安全桥
│  │  ├─ public-market-data.mjs 多源公开行情服务
│  │  ├─ market-indices.mjs     指数服务
│  │  └─ ...                    网络、代理、收藏、系统集成
│  └─ shared/                   共享目录/枚举
├─ dist/renderer/               渲染层页面与静态资源
│  ├─ index.html
│  └─ assets/
│     ├─ app.js                 渲染层逻辑（单一 bundle）
│     └─ app.css                渲染层样式
├─ resources/                   应用图标等资源
├─ package.json
└─ package-lock.json
```

## 本地开发

```bash
git clone https://github.com/DXSS66/Velune.git
cd Velune
npm install
npm start
```

要求：

- Windows 10/11 x64
- Node.js 20 或更高版本
- npm 10 或更高版本

## 打包

```bash
npm run dist
```

产物输出到 `release/`：

- `release/Velune-1.0.0-Setup.exe`
- `release/win-unpacked/`

安装包默认不包含代码签名证书。正式分发时请配置自己的 Authenticode 证书，不要将 `.pfx` 私钥提交到仓库。

## 行情数据说明

所有行情均来自公开、免登录接口，例如：

- Binance / Gate / Bybit / OKX 公共行情接口
- Yahoo Finance Chart / Quote 接口
- 东方财富、新浪财经公开行情接口
- Naver 韩国市场公开接口
- SEC 公司代码目录
- FRED CSV 数据

请求会在主进程统一处理并做内存缓存。不同数据源的可用性、延迟、历史深度和品种覆盖范围不同；本项目不保证数据的完整性或实时性。

## 隐私

应用默认不需要登录，不上传本地收藏、指标设置或图表数据。所有设置保存在本机用户目录。

## 免责声明

本项目仅用于行情查看、图表技术研究与界面开发学习，不构成任何投资建议。使用公开行情接口前，请自行确认其服务条款与所在地区的合规要求。

## 许可证

[MIT](LICENSE)