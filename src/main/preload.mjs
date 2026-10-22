// 纯看盘版 preload：只暴露「行情 / 窗口 / 桌面 / 看盘截图 / 自选 / 本地文件 / 通用设置」相关能力。
// AI、工作流、交易分析、策略、预警、云服务、语音、视频、社交、支付、消费上报等通道一律不再暴露。
// 注意：全局对象名必须保持 window.veluneDesktop（渲染层写死了这个名字）。
import { contextBridge, ipcRenderer, webUtils } from "electron/renderer";
import { randomUUID } from "node:crypto";

const on = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

// ---- Binance 行情流：订阅/退订 + 事件分发 ----
const binanceMarketStreamCallbacks = new Map();
ipcRenderer.on("binanceMarket:streamEvent", (_event, payload = {}) => {
  const callback = binanceMarketStreamCallbacks.get(String(payload.subscriptionId || ""));
  if (callback) callback(payload.event);
});

async function subscribeBinanceMarketStreams(params, callback) {
  if (typeof callback !== "function") throw new TypeError("Binance market stream callback is required");
  const subscriptionId = `renderer-market-${randomUUID()}`;
  binanceMarketStreamCallbacks.set(subscriptionId, callback);
  try {
    await ipcRenderer.invoke("binanceMarket:streamSubscribe", { ...params, subscriptionId });
    return { subscriptionId };
  } catch (error) {
    binanceMarketStreamCallbacks.delete(subscriptionId);
    throw error;
  }
}

async function unsubscribeBinanceMarketStreams(params = {}) {
  const subscriptionId = String(params.subscriptionId || "");
  binanceMarketStreamCallbacks.delete(subscriptionId);
  return ipcRenderer.invoke("binanceMarket:streamUnsubscribe", { subscriptionId });
}

// ---- 兼容占位：渲染层（ui-dev 正在清理）仍可能调用的旧 AI 方法 ----
// 一律在本进程内安静返回空结果，绝不发 IPC、绝不抛错，避免 TypeError / No handler registered 噪声。
const noopOk = async () => ({ ok: true, local: true });
const noopEmptyList = async () => ({ ok: true, local: true, items: [], data: [], list: [], total: 0 });
const noopEmptyObject = async () => ({ ok: true, local: true, data: {}, item: null, snapshot: null });
const noopNothing = async () => null;
const noopOff = () => () => {};

contextBridge.exposeInMainWorld("veluneDesktop", {
  // ===== 窗口与桌面 =====
  windowControl: (action) => ipcRenderer.invoke("window:control", action),
  windowResize: (params) => ipcRenderer.invoke("window:resize", params),
  windowResizeLive: (params) => ipcRenderer.send("window:resize-live", params),
  setWindowMode: (mode, options) => ipcRenderer.invoke("window:setMode", mode, options),
  getWindowState: () => ipcRenderer.invoke("window:getState"),
  revealWindowModeTransition: () => ipcRenderer.invoke("window:revealModeTransition"),
  onWindowState: (callback) => on("window:state", callback),
  getSystemIntegrationState: () => ipcRenderer.invoke("desktop:getSystemIntegrationState"),
  setSystemIntegration: (params) => ipcRenderer.invoke("desktop:setSystemIntegration", params),

  // ===== 通用设置 =====
  setAppTheme: (params) => ipcRenderer.invoke("app:setTheme", params),
  setAppLanguage: (params) => ipcRenderer.invoke("app:setLanguage", params),
  setTaskbarUnreadCount: (params) => ipcRenderer.invoke("app:setTaskbarUnreadCount", params),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  onOpenSettings: (callback) => on("app:openSettings", callback),

  // ===== 启动会话 =====
  getVeluneSession: () => ipcRenderer.invoke("velune:getSession"),
  refreshVeluneSession: (params) => ipcRenderer.invoke("velune:refreshSession", params),
  refreshProfile: () => ipcRenderer.invoke("velune:refreshProfile"),
  onProfileUpdated: (callback) => on("velune:profileUpdated", callback),
  onAuthExpired: (callback) => on("velune:authExpired", callback),
  debugLog: (params) => ipcRenderer.invoke("velune:debugLog", params),

  // ===== 行情：公共指数 / 综合图表 =====
  getPublicMarketIndices: () => ipcRenderer.invoke("marketData:getPublicIndices"),
  getIndexChart: (params) => ipcRenderer.invoke("marketData:getIndexChart"),
  getPublicMarketCandles: (params) => ipcRenderer.invoke("marketData:getPublicCandles", params),
  getPublicMarketQuotes: (params) => ipcRenderer.invoke("marketData:getPublicQuotes", params),
  getPublicMarketInstruments: (params) => ipcRenderer.invoke("marketData:getPublicMarkets", params),
  // ===== 行情：Finnhub =====
  getFinnhubMarketDataStatus: () => ipcRenderer.invoke("marketData:getFinnhubStatus"),
  searchFinnhubMarkets: (params) => ipcRenderer.invoke("marketData:searchFinnhub", params),
  getFinnhubMarketQuotes: (params) => ipcRenderer.invoke("marketData:getFinnhubQuotes", params),
  getFinnhubMarketSnapshot: (params) => ipcRenderer.invoke("marketData:getFinnhubSnapshot", params),
  getFinnhubMarketCandles: (params) => ipcRenderer.invoke("marketData:getFinnhubCandles", params),
  // ===== 行情：同花顺 iFinD =====
  searchIfindMarkets: (params) => ipcRenderer.invoke("marketData:searchIfind", params),
  getIfindMarketQuotes: (params) => ipcRenderer.invoke("marketData:getIfindQuotes", params),
  getIfindMarketSnapshot: (params) => ipcRenderer.invoke("marketData:getIfindSnapshot", params),
  getIfindMarketCandles: (params) => ipcRenderer.invoke("marketData:getIfindCandles", params),
  // ===== 行情：Binance 公共数据 + 实时流 =====
  getBinancePublicMarketData: (params) => ipcRenderer.invoke("binanceMarket:publicGet", params),
  cancelBinancePublicMarketData: (params) => ipcRenderer.invoke("binanceMarket:publicCancel", params),
  subscribeBinanceMarketStreams: (params, callback) => subscribeBinanceMarketStreams(params, callback),
  unsubscribeBinanceMarketStreams: (params) => unsubscribeBinanceMarketStreams(params),
  // ===== 行情：Hyperliquid =====
  getHyperliquidPublicCandles: (params) => ipcRenderer.invoke("hyperliquidMarket:candles", params),

  // ===== 看盘截图 =====
  captureTradingChart: (params) => ipcRenderer.invoke("trading:captureChart", params),

  // ===== 自选 =====
  listTradingFavorites: () => ipcRenderer.invoke("velune:listTradingFavorites"),
  addTradingFavorite: (params) => ipcRenderer.invoke("velune:addTradingFavorite", params),
  removeTradingFavorite: (params) => ipcRenderer.invoke("velune:removeTradingFavorite", params),
  reorderTradingFavorites: (params) => ipcRenderer.invoke("velune:reorderTradingFavorites", params),

  // ===== 本地文件 / 剪贴板 / 拖拽 =====
  localFileInfo: (params) => ipcRenderer.invoke("velune:localFileInfo", params),
  localPathInfo: (params) => ipcRenderer.invoke("velune:localPathInfo", params),
  openLocalFile: (params) => ipcRenderer.invoke("velune:openLocalFile", params),
  revealLocalFile: (params) => ipcRenderer.invoke("velune:revealLocalFile", params),
  readLocalFile: (params) => ipcRenderer.invoke("velune:readLocalFile", params),
  previewFile: (params) => ipcRenderer.invoke("velune:previewFile", params),
  previewImageFile: (params) => ipcRenderer.invoke("velune:previewImageFile", params),
  readClipboardForComposer: () => ipcRenderer.invoke("velune:readClipboardForComposer"),
  pasteFocusedElement: () => ipcRenderer.invoke("velune:pasteFocusedElement"),
  startFileDrag: (params) => ipcRenderer.send("velune:startFileDrag", params),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke("velune:openExternal", url),
  openBlockchainTransaction: (params) => ipcRenderer.invoke("velune:openBlockchainTransaction", params),

  // ===== 兼容占位（本地空实现，不发 IPC；ui-dev 清理渲染层调用点后可整体删除）=====
  // 设置同步后端已移除：保持与旧版一致的「不可用」语义，让渲染层走既有的优雅降级分支。
  clientSettings: async () => {
    const error = new Error("SETTINGS_UNAVAILABLE");
    error.name = "SettingsUnavailableError";
    throw error;
  },
  start: noopOk,
  getDefaults: noopEmptyObject,
  getStatus: noopEmptyObject,
  listTradingStrategies: noopEmptyList,
  listPersonalStrategies: noopEmptyList,
  listThreads: noopEmptyList,
  modelList: noopEmptyList,
  skillsList: noopEmptyList,
  startThread: noopEmptyObject,
  sendMessage: noopOk,
  steerTurn: noopOk,
  interruptTurn: noopOk,
  sendProviderChat: noopOk,
  interruptProviderChat: noopOk,
  reportConsumptionAppEntry: noopOk,
  reportConsumptionEvent: noopOk,
  getConsumptionOverview: noopEmptyObject,
  getCurrentModelCatalog: noopEmptyObject,
  getExternalModelCatalog: noopEmptyObject,
  listExternalModelProviders: noopEmptyList,
  onExternalModelCatalogChanged: noopOff,
  getTradingPreferenceProfile: noopEmptyObject,
  saveTradingPreferenceProfile: noopOk,
  tradingAlertsSnapshot: noopEmptyObject,
  tradingAlertsSyncDrawings: noopOk,
  runTradingStrategyAnalysis: noopEmptyObject,
  runTradingGeneralAnalysis: noopEmptyObject,
  cancelTradingAnalysis: noopOk,
  recordTradingAnalysisFailure: noopOk,
  getTradingXPost: noopNothing,
  annotateImage: noopNothing,
  getBinanceAccountSnapshot: noopEmptyObject,
  getBinanceAccountStatus: noopEmptyObject,
  getBinanceAccountProfitCalendar: noopEmptyObject,
  listExternalChannels: noopEmptyList,
  startExternalChannelLogin: noopOk,
  replyExternalChannelMessage: noopOk,
  disconnectExternalChannel: noopOk,
  listExternalChannelMessages: noopEmptyList,
  bindExternalChannelThread: noopOk,
  startExternalChannelEvents: noopOk,
  stopChannelEvents: noopOk,
  listContacts: noopEmptyList,
  searchContacts: noopEmptyList,
  listContactRequests: noopEmptyList,
  createContactRequest: noopOk,
  acceptContactRequest: noopOk,
  rejectContactRequest: noopOk,
  cancelContactRequest: noopOk,
  deleteContact: noopOk,
  listMaterials: noopEmptyList,
  listArtifacts: noopEmptyList,
  listMarketplaceSkills: noopEmptyList,
  listMySkills: noopEmptyList,
  listSkillCategories: noopEmptyList,
  installMarketplaceSkill: noopOk,
  uninstallMarketplaceSkill: noopOk,
  getWeb3PaymentOrder: noopEmptyObject,
  createWeb3PaymentOrder: noopOk,
  listWeb3RechargeHistory: noopEmptyList,
  getVoiceTranscriptionAvailability: noopEmptyObject,
  startVoiceTranscription: noopOk,
  sendVoiceAudioChunk: noopOk,
  finishVoiceTranscription: noopOk,
  cancelVoiceTranscription: noopOk,
  generateVideo: noopOk,
  resumeVideo: noopOk,
  interruptVideoGeneration: noopOk,
  listVideoExpertModels: noopEmptyList,
  listAutoTasks: noopEmptyList,
  saveAutoTasks: noopOk,
  runAutoTask: noopOk,
  listPromptFavorites: noopEmptyList,
  createPromptFavorite: noopOk,
  updatePromptFavorite: noopOk,
  deletePromptFavorite: noopOk,
  patchConversationPreferences: noopOk,
  prepareGroupChatContext: noopEmptyObject,
  stageContinuationPrompt: noopOk,
  persistTradingTranscript: noopOk,
  resolveAppConfirmation: noopOk,
  onStatus: noopOff,
  onLog: noopOff,
  onNotification: noopOff,
  onSkills: noopOff,
  onError: noopOff,
  onServerRequest: noopOff,
  onTradingAlertsChanged: noopOff,
  onTradingAlertTriggered: noopOff,
  onTradingAlertOpen: noopOff,
  onTradingAlertMarketData: noopOff,
  onTradingAlertIntentProgress: noopOff,
  onTradingStrategyProgress: noopOff,
  onCloudAlertFeed: noopOff,
  onChannelEvent: noopOff,
  onExternalChannelsBackendReady: noopOff,
  onVoiceInputStop: noopOff,
  onVoiceTranscriptionResult: noopOff,
  onAutoTasksChanged: noopOff,
  onLocalArtifactsChanged: noopOff,
  onWorkflowEvent: noopOff,
  onQuestionAnswerProgress: noopOff,
  onQuestionAnswerStream: noopOff,
  onAutomationOpenThread: noopOff,
  onAutomationThreadNotification: noopOff,
  onAppConfirmationRequested: noopOff,
});