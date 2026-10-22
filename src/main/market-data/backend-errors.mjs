const MARKET_DATA_MESSAGES = Object.freeze({
  FINNHUB_DISABLED: "全球行情服务尚未启用。",
  FINNHUB_NOT_CONFIGURED: "全球行情服务尚未完成后台配置。",
  FINNHUB_UNAUTHORIZED: "目前版本此交易对数据还未接入",
  FINNHUB_RATE_LIMITED: "全球行情请求较多，请稍等片刻再试。",
  FINNHUB_TIMEOUT: "全球行情服务响应超时，请稍后重试。",
  FINNHUB_NETWORK_ERROR: "全球行情网络暂时不可用。",
  FINNHUB_UPSTREAM_ERROR: "全球行情服务暂时不可用。",
  FINNHUB_PLAN_REQUIRED: "当前行情套餐不包含这项数据。",
  FINNHUB_NO_CANDLE_DATA: "该品种或周期暂无 K 线数据。",
  FINNHUB_HISTORY_UNAVAILABLE: "当前行情套餐未提供该品种的历史 K 线。",
  FINNHUB_RESOLUTION_UNSUPPORTED: "当前行情周期暂不支持。",
  IFIND_DISABLED: "A 股行情服务尚未启用。",
  IFIND_NOT_CONFIGURED: "A 股行情服务尚未完成后台配置。",
  IFIND_UNAUTHORIZED: "A 股行情后台凭据无效，请联系管理员。",
  IFIND_RATE_LIMITED: "A 股行情请求较多，请稍等片刻再试。",
  IFIND_QUOTA_EXCEEDED: "同花顺 A 股行情额度暂不可用，请联系管理员。",
  IFIND_TIMEOUT: "A 股行情服务响应超时，请稍后重试。",
  IFIND_NETWORK_ERROR: "A 股行情网络暂时不可用。",
  IFIND_UPSTREAM_ERROR: "A 股行情服务暂时不可用。",
  IFIND_API_ERROR: "同花顺暂时无法返回该行情数据。",
  IFIND_PLAN_REQUIRED: "当前同花顺账号尚未开通 A 股数据权限。",
  IFIND_NO_DATA: "同花顺暂未返回该 A 股的数据。",
  IFIND_SYMBOL_NOT_FOUND: "同花顺未找到该 A 股标的。",
  IFIND_QUOTE_UNAVAILABLE: "同花顺暂未返回该 A 股的最新行情。",
  IFIND_UPSTREAM_REJECTED: "同花顺不支持该请求参数或标的类型。",
  IFIND_NO_CANDLE_DATA: "同花顺暂未返回该 A 股的历史 K 线。",
  IFIND_RESOLUTION_UNSUPPORTED: "同花顺 A 股当前仅支持日线和周线。",
  IFIND_INVALID_QUERY: "A 股搜索内容格式不正确。",
  IFIND_INVALID_SYMBOL: "A 股代码格式不正确。",
  INVALID_MARKET_QUERY: "搜索内容格式不正确。",
  INVALID_MARKET_SYMBOL: "行情品种代码格式不正确。",
});

export function marketDataBackendErrorPayload(error) {
  const code = String(error?.code || "MARKET_DATA_FAILED").trim().toUpperCase();
  return {
    ok: false,
    code: Object.hasOwn(MARKET_DATA_MESSAGES, code) ? code : "MARKET_DATA_FAILED",
    message: MARKET_DATA_MESSAGES[code] || "全球行情服务暂时不可用，请稍后重试。",
    ...(Number.isFinite(Number(error?.status)) ? { status: Number(error.status) } : {}),
    ...(Number.isFinite(Number(error?.retryAfterMs))
      ? { retryAfterMs: Math.max(0, Number(error.retryAfterMs)) }
      : {}),
  };
}
