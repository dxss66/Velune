import { captureTradingChart } from './trading-chart-capture.mjs';

import { clipboard, nativeImage, shell } from "electron/common";
import { app, BrowserWindow, ipcMain, Menu, net, screen, session, Tray } from "electron/main";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket from "ws";
import { createElectronProxyResolver, createVeluneNetworkTransport } from "./velune-network-transport.mjs";

import { blockchainTransactionUrl } from "./blockchain-explorer.mjs";

// VELUNE-TURN-DIAGNOSTICS-BEGIN: removable imports

// VELUNE-TURN-DIAGNOSTICS-END: removable imports

import { stripWindowsLocalFileDescriptionSuffix, stripWindowsSourceLocationSuffix } from "./local-file-reference.mjs";
import { createTaskbarUnreadBadgeBitmap, normalizeTaskbarUnreadCount } from "./taskbar-unread-badge.mjs";

// 群聊与协作功能已移除：以下为本地空实现，保证既有调用点安全返回。

// 云端账号与计费功能已移除：本地空实现。

import { BinancePrivateProxyTransport } from "./binance-private-proxy-fetch.mjs";
import { BinanceRequestGovernor, BINANCE_REQUEST_PRIORITIES } from "./binance-request-governor.mjs";
import { BinancePublicMarketService } from "./binance-public-market-service.mjs";
import { MarketIndicesService } from "./market-indices.mjs";
import { PublicMarketDataService } from "./public-market-data.mjs";
import { BinancePublicRequestCoordinator } from "./binance-public-request-coordinator.mjs";
import { resolveBinanceGatewayConfig } from "./binance-gateway-config.mjs";
import { createBinanceGatewayClient } from "./binance-gateway-client.mjs";
import { developmentDirectNetwork } from "./development-network.mjs";
import { BinanceNetworkRouter } from "./binance-network-router.mjs";
import { BinanceRoutePreferenceStore } from "./binance-route-preference-store.mjs";
import { createBinanceGatewayNetworkFetch } from "./binance-gateway-network.mjs";
import { TradingMarketDataHub } from "./trading-market-data-hub.mjs";
import { TradingFavoritesStore } from "./trading-favorites-store.mjs";
import { createSystemIntegration } from "./system-integration.mjs";
import { createAppPreferences } from "./app-preferences.mjs";

import { marketDataBackendErrorPayload } from "./market-data/backend-errors.mjs";

import {
  LOCAL_FILE_MISSING_ERROR_CODE,
  resolveExistingLocalPath
} from "./local-file-resolver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER_DATA_DIR_NAME = ".Velune";

function configureUserDataPath() {
  const verifyDir = String(process.env.VELUNE_VERIFY_DATA || "").trim();
  const targetDir = verifyDir
    ? path.resolve(verifyDir)
    : path.join(app.getPath("appData"), USER_DATA_DIR_NAME);
  fs.mkdirSync(targetDir, { recursive: true });
  app.setPath("userData", targetDir);
}

app.setName("Velune");
configureUserDataPath();

let mainWindow = null;
let appTray = null;
let taskbarUnreadConversationCount = 0;
const taskbarUnreadBadgeImages = new Map();

let veluneApiClient = null;

let veluneNetworkTransport = null;

let binanceRequestGovernor = null;
let binancePublicMarketService = null;
let binanceGatewayConfig = null;
let binanceGatewayClient = null;
let binancePrivateProxyTransport = null;
let binanceNetworkRouter = null;
let binanceRoutePreferenceStore = null;
let binanceGatewayNetworkFetch = null;
let tradingMarketDataHub = null;
let tradingFavoritesStore = null;

let authChangeRestartPromise = null;

const binanceMarketRendererSubscriptions = new Map();
const binancePublicRequestCoordinator = new BinancePublicRequestCoordinator();


let currentSkillsCwd = null;

let appShuttingDown = false;
let appCleanupStarted = false;

// VELUNE-TURN-DIAGNOSTICS-BEGIN: removable runtime state

// VELUNE-TURN-DIAGNOSTICS-END: removable runtime state

const PREVIEW_FILE_LIMIT_BYTES = 80 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024;

const LEGACY_OFFICE_PREVIEW_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);
const LEGACY_OFFICE_PREVIEW_CONVERT_TIMEOUT_MS = 90_000;
const LEGACY_OFFICE_PREVIEW_CACHE_DIR_NAME = "office-preview-cache";

// Local build: no first-party web origin is used any more.

const VELUNE_APP_ID = "local.velune.desktop";

const VELUNE_DISPLAY_NAME = "Velune";


let cachedSofficeExecutablePath;
const legacyOfficePreviewConversions = new Map();

const THREAD_GROUPS_DIR_NAME = "thread-groups";
const DEFAULT_THREAD_GROUP_ID = "__velune_default_thread_group__";
const DEFAULT_THREAD_GROUP_WORKSPACE_SLUG = "default";

const SHUTDOWN_STEP_TIMEOUT_MS = 8_000;
const WINDOW_ICON_PATH = resolveWindowIconPath();
const SHELL_ICON_PATH = resolveShellIconPath(WINDOW_ICON_PATH);
const APP_AVATAR_ICON_PATH = resolveAppAvatarIconPath();
// Keep every registration/login window at 90% of its previous dimensions.
const LOGIN_WINDOW_BOUNDS = {
  width: 346,
  height: 481,
  minWidth: 346,
  minHeight: 481
};
const LOGIN_ERROR_WINDOW_BOUNDS = {
  ...LOGIN_WINDOW_BOUNDS,
  height: 481,
  minHeight: 481
};
const LOGIN_REGISTER_WINDOW_BOUNDS = {
  ...LOGIN_WINDOW_BOUNDS,
  height: 481,
  minHeight: 481
};
const LOGIN_WECHAT_WINDOW_BOUNDS = {
  ...LOGIN_WINDOW_BOUNDS,
  height: 603,
  minHeight: 603
};
const APP_RESIZE_GUTTER = 8;
const APP_RESIZE_GUTTER_SIZE = APP_RESIZE_GUTTER * 2;
const APP_WINDOW_SCREEN_MARGIN = 24;
const APP_NAV_SIDEBAR_WIDTH = 52;
const APP_CHAT_LIST_WIDTH = 192;
const APP_CHAT_PANEL_MIN_EXPANDED_WIDTH = 560;
const APP_COLLAPSED_RIGHT_PANEL_MIN_WIDTH =
  APP_NAV_SIDEBAR_WIDTH + APP_CHAT_LIST_WIDTH + APP_CHAT_PANEL_MIN_EXPANDED_WIDTH;
const APP_WINDOW_BOUNDS = {
  width: 1280,
  height: 860,
  minWidth: APP_COLLAPSED_RIGHT_PANEL_MIN_WIDTH,
  minHeight: 680
};
const MAXIMIZED_BOUNDS_TOLERANCE = 2;
const LOGIN_TO_APP_REVEAL_FALLBACK_MS = 1200;

const WINDOW_ICON = createInitialWindowIcon();
const APP_AVATAR_WINDOW_ICON = createNativeIconFromPath(APP_AVATAR_ICON_PATH);
const systemIntegration = createSystemIntegration({
  appId: VELUNE_APP_ID,
  displayName: VELUNE_DISPLAY_NAME,
  shellIconPath: SHELL_ICON_PATH
});
const {
  systemIntegrationState,
  setSystemIntegration,
  repairPackagedWindowsShortcuts,
  psQuote,
  powershellExecutablePath
} = systemIntegration;
const appPreferencesApi = createAppPreferences();
const {
  appLanguage,
  appLanguageLocale,
  mainUiText,
  normalizeAppLanguage,
  setAppTheme,
  setAppLanguage
} = appPreferencesApi;
let windowIcon = WINDOW_ICON;
let appWindowRestoreTimer = null;
let desktopNotificationWindow = null;
let desktopNotificationTimer = null;

const gotSingleInstanceLock = process.env.VELUNE_VERIFY_DATA ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  appShuttingDown = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    restoreMainWindowFromSecondInstance();
  });
}

function resolveWindowIconPath() {
  const resourceRuntimeIconPath = process.resourcesPath ? path.join(process.resourcesPath, "velune-runtime-icon.ico") : null;
  const resourceIconPath = process.resourcesPath ? path.join(process.resourcesPath, "velune-logo.ico") : null;
  const resourceSvgPath = process.resourcesPath ? path.join(process.resourcesPath, "velune-logo.svg") : null;
  const candidates = [
    resourceIconPath,
    path.resolve(__dirname, "../../resources/velune-logo.ico"),
    path.join(__dirname, "../renderer/velune-logo.svg"),
    path.resolve(__dirname, "../../resources/velune-logo.svg"),
    resourceSvgPath,
    resourceRuntimeIconPath,
    path.resolve(__dirname, "../../resources/velune-runtime-icon.ico"),
  ];
  return firstExistingPath(candidates);
}

function resolveShellIconPath(fallbackIconPath = null) {
  const resourceRuntimeIconPath = process.resourcesPath ? path.join(process.resourcesPath, "velune-runtime-icon.ico") : null;
  const resourceIconPath = process.resourcesPath ? path.join(process.resourcesPath, "velune-logo.ico") : null;
  const executableDir = currentExecutableDir();
  const candidates = [
    resourceIconPath,
    executableDir && path.join(executableDir, "resources", "velune-logo.ico"),
    executableDir && path.join(executableDir, "velune-logo.ico"),
    path.resolve(__dirname, "../../resources/velune-logo.ico"),
    fallbackIconPath && !isAsarPath(fallbackIconPath) ? fallbackIconPath : null,
    resourceRuntimeIconPath,
    executableDir && path.join(executableDir, "resources", "velune-runtime-icon.ico"),
    executableDir && path.join(executableDir, "velune-runtime-icon.ico"),
    path.resolve(__dirname, "../../resources/velune-runtime-icon.ico"),
  ].filter((candidate) => candidate && !isAsarPath(candidate) && isNativeIconFilePath(candidate));
  return firstExistingPath(candidates);
}

function resolveAppAvatarIconPath() {
  const resourceAvatarPath = process.resourcesPath ? path.join(process.resourcesPath, "velune-app-avatar.png") : null;
  const candidates = [
    resourceAvatarPath,
    path.resolve(__dirname, "../../resources/velune-app-avatar.png"),
    path.resolve(__dirname, "../renderer/assets/velune-app-avatar.png"),
    path.resolve(__dirname, "../../src/renderer/assets/velune-app-avatar.png"),
  ];
  return firstExistingPath(candidates);
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function isAsarPath(candidate) {
  return /\.asar(?:[\\/]|$)/i.test(String(candidate || ""));
}

function isNativeIconFilePath(iconPath) {
  const extension = path.extname(String(iconPath || "")).toLowerCase();
  return extension === ".ico" || extension === ".png";
}

function createNativeIconFromPath(iconPath) {
  if (!iconPath) return null;
  if (!isNativeIconFilePath(iconPath)) return null;
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? null : icon;
}

function createInitialWindowIcon() {
  return createNativeIconFromPath(SHELL_ICON_PATH || WINDOW_ICON_PATH);
}

function currentWindowIcon() {
  return windowIcon || SHELL_ICON_PATH || null;
}

async function createWindowIcon() {
  if (!WINDOW_ICON_PATH || path.extname(WINDOW_ICON_PATH).toLowerCase() !== ".svg") {
    return createNativeIconFromPath(SHELL_ICON_PATH || WINDOW_ICON_PATH) || WINDOW_ICON;
  }
  const svg = fs.readFileSync(WINDOW_ICON_PATH, "utf8");
  const iconWindow = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false
}
});
  try {
    const iconSvg = squareIconSvg(svg);
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            html, body {
              width: 256px;
              height: 256px;
              margin: 0;
              overflow: hidden;
              background: transparent;
            }
          </style>
        </head>
        <body>${iconSvg}</body>
      </html>
    `;
    await iconWindow.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
    await delay(50);
    const icon = await iconWindow.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    return icon.isEmpty() ? null : icon;
  } catch {
    return null;
  } finally {
    iconWindow.destroy();
  }
}

function squareIconSvg(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/i)?.[1]?.split(/\s+/).map(Number) || [0, 0, 593, 434];
  const [minX, minY, width, height] = viewBox;
  const body = svg.replace(/^[\s\S]*?<svg\b[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
  const margin = 24;
  const scale = Math.min((256 - margin * 2) / width, (256 - margin * 2) / height);
  const x = (256 - width * scale) / 2;
  const y = (256 - height * scale) / 2;
  return `
    <svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(${x} ${y}) scale(${scale}) translate(${-minX} ${-minY})">
        ${body}
      </g>
    </svg>
  `;
}


function currentExecutableDir() {
  const exePath = app.getPath("exe") || process.execPath;
  return exePath ? path.dirname(exePath) : "";
}
function desktopWorkspace() {
  if (process.env.VELUNE_DESKTOP_WORKSPACE || process.env.VELUNE_DESKTOP_WORKSPACE) {
    return path.join(app.getPath("home"), "VeluneWorkspace");
  }

  return resolveThreadGroupWorkspacePath({
    groupId: DEFAULT_THREAD_GROUP_ID,
    workspaceSlug: DEFAULT_THREAD_GROUP_WORKSPACE_SLUG
});
}

function threadGroupsRootPath() {
  return path.join(app.getPath("userData"), THREAD_GROUPS_DIR_NAME);
}

function safeThreadGroupWorkspaceSlug(value, fallback = DEFAULT_THREAD_GROUP_WORKSPACE_SLUG) {
  const text = String(value || fallback || DEFAULT_THREAD_GROUP_WORKSPACE_SLUG)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return text || DEFAULT_THREAD_GROUP_WORKSPACE_SLUG;
}

function resolveThreadGroupWorkspacePath(params = {}) {
  const externalPath = String(params.externalPath || params.external_path || params.cwd || params.path || "").trim();
  if (externalPath) return path.resolve(externalPath);
  const groupId = String(params.groupId || params.id || "").trim();
  const fallbackSlug =
    groupId === DEFAULT_THREAD_GROUP_ID || !groupId
      ? DEFAULT_THREAD_GROUP_WORKSPACE_SLUG
      : `group-${shortThreadGroupFolderId(groupId)}`;
  const workspaceSlug = safeThreadGroupWorkspaceSlug(params.workspaceSlug || params.workspace_slug, fallbackSlug);
  return path.join(threadGroupsRootPath(), workspaceSlug);
}


function createAppTray() {
  const icon = currentWindowIcon();
  if (appTray || !icon) return;
  appTray = new Tray(icon);
  appTray.setToolTip(appTrayToolTip());
  appTray.setContextMenu(appTrayMenu());
  appTray.on("click", () => {
    restoreMainWindowFromSecondInstance();
  });
  appTray.on("double-click", () => {
    stopWechatMessageAttention();
    restoreMainWindowFromSecondInstance();
  });
}

function appTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: `打开${VELUNE_DISPLAY_NAME}客户端`,
      click: () => restoreMainWindowFromSecondInstance()
},
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        void cleanupAndExit(0);
      }
},
  ]);
}

function updateAppTrayIcon(icon = currentWindowIcon()) {
  if (!appTray || !icon) return;
  appTray.setImage(icon);
  appTray.setToolTip(appTrayToolTip());
  appTray.setContextMenu(appTrayMenu());
}

function appTrayToolTip() {
  return taskbarUnreadConversationCount
    ? `${VELUNE_DISPLAY_NAME}（${taskbarUnreadConversationCount} 个未读会话）`
    : VELUNE_DISPLAY_NAME;
}

function stopWechatMessageAttention() {
  restoreTaskbarAppearance();
  if (appTray) updateAppTrayIcon(currentWindowIcon());
}

function restoreTaskbarAppearance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.flashFrame(false);
  } catch {}
  try {
    const badgeImage = taskbarUnreadBadgeImage(taskbarUnreadConversationCount);
    mainWindow.setOverlayIcon(
      badgeImage,
      badgeImage ? `${taskbarUnreadConversationCount} 个未读会话` : "",
    );
  } catch {}
  try {
    mainWindow.setProgressBar(-1);
  } catch {}
  try {
    app.setBadgeCount(taskbarUnreadConversationCount);
  } catch {}
  const icon = currentWindowIcon();
  if (icon) {
    try {
      mainWindow.setIcon(icon);
    } catch {}
  }
}

function taskbarUnreadBadgeImage(count) {
  if (process.platform !== "win32" || count <= 0) return null;
  const badge = createTaskbarUnreadBadgeBitmap(count);
  if (!badge) return null;
  const cached = taskbarUnreadBadgeImages.get(badge.label);
  if (cached) return cached;
  const image = nativeImage.createFromBitmap(badge.buffer, {
    width: badge.width,
    height: badge.height,
    scaleFactor: badge.scaleFactor
});
  if (image.isEmpty()) return null;
  taskbarUnreadBadgeImages.set(badge.label, image);
  return image;
}

function setTaskbarUnreadConversationCount(value) {
  taskbarUnreadConversationCount = normalizeTaskbarUnreadCount(value);
  restoreTaskbarAppearance();
  if (appTray) appTray.setToolTip(appTrayToolTip());
  return taskbarUnreadConversationCount;
}

// Electron 在 transparent: true 的窗口上不会应用 thickFrame，导致窗口缺少
// WS_THICKFRAME，Windows 因此不会把标题栏拖动当作原生标题栏：贴边分屏、
// 拖到顶部最大化、拖离还原全部失效。这里补回标准的窗口样式位，之后完全交给
// Windows 的窗口管理器处理，不做任何场景判断。
const WS_THICKFRAME = 0x00040000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

function ensureNativeThickFrame(window) {
  if (process.platform !== "win32") return;
  if (!window || window.isDestroyed() || window.veluneThickFrameApplied) return;
  let handle;
  try {
    handle = window.getNativeWindowHandle();
  } catch {
    return;
  }
  if (!handle || handle.length < 4) return;
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  if (!hwnd) return;
  window.veluneThickFrameApplied = true;
  const flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;
  const script = [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class VeluneWindowFrame {",
    ' [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);',
    ' [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);',
    ' [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
    "}",
    "'@",
    `$h = [IntPtr][Int64](${hwnd.toString()})`,
    "$s = [VeluneWindowFrame]::GetWindowLongPtr($h, -16).ToInt64()",
    "if (($s -band 0x00040000) -eq 0) {",
    "  [void][VeluneWindowFrame]::SetWindowLongPtr($h, -16, [IntPtr]($s -bor 0x00040000))",
    `  [void][VeluneWindowFrame]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, ${flags})`,
    "}",
  ].join("\n");
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", () => {
      window.veluneThickFrameApplied = false;
    });
    child.unref();
  } catch {
    window.veluneThickFrameApplied = false;
  }
}

function createWindow() {
  const icon = currentWindowIcon();
  const devServerUrl = process.env.VELUNE_DESKTOP_DEV_SERVER_URL || process.env.VELUNE_DESKTOP_DEV_SERVER_URL;
  const windowOptions = {
    width: LOGIN_WINDOW_BOUNDS.width,
    height: LOGIN_WINDOW_BOUNDS.height,
    minWidth: LOGIN_WINDOW_BOUNDS.minWidth,
    minHeight: LOGIN_WINDOW_BOUNDS.minHeight,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    thickFrame: true,
    hasShadow: false,
    roundedCorners: false,
    resizable: true,
    maximizable: true,
    show: false,
    title: "",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
}
};
  if (icon) {
    windowOptions.icon = icon;
  }

  mainWindow = new BrowserWindow({
    ...windowOptions
});
  const mainWebContentsId = mainWindow.webContents.id;

  if (icon) {
    mainWindow.setIcon(icon);
  }
  restoreTaskbarAppearance();
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    restoreTaskbarAppearance();
    mainWindow.show();
    mainWindow.focus();
  });
  applyWindowMode(mainWindow, "app");
  ensureNativeThickFrame(mainWindow);
  mainWindow.removeMenu();
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle("");
  });
  mainWindow.on("maximize", () => sendWindowState(mainWindow));
  mainWindow.on("unmaximize", () => sendWindowState(mainWindow));
  mainWindow.on("restore", () => sendWindowState(mainWindow));
  mainWindow.on("resize", () => {
    if (mainWindow?.veluneLiveResizing) return;
    rememberNormalWindowBounds(mainWindow);
    sendWindowState(mainWindow);
  });
  mainWindow.on("move", () => {
    if (mainWindow?.veluneLiveResizing) return;
    rememberNormalWindowBounds(mainWindow);
  });
  mainWindow.on("close", (event) => {
    if (appShuttingDown || appCleanupStarted) return;
    event.preventDefault();
    applyWindowControl(mainWindow, "hide");
  });
  mainWindow.webContents.once("did-finish-load", () => sendWindowState(mainWindow));
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[main-window] did-fail-load", { errorCode, errorDescription, validatedURL });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main-window] render-process-gone", details);
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("[main-window] renderer became unresponsive");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url || ""))) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedMainWindowNavigation(url, devServerUrl)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(String(url || ""))) {
      void shell.openExternal(url);
    }
  });

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/renderer/index.html"));
  }
}

function isAllowedMainWindowNavigation(url, devServerUrl = "") {
  try {
    const target = new URL(String(url || ""));
    if (devServerUrl) {
      return target.origin === new URL(devServerUrl).origin;
    }
    if (target.protocol !== "file:") return false;
    const rendererRoot = path.resolve(__dirname, "../../dist/renderer");
    const targetPath = path.resolve(fileURLToPath(target));
    const relativePath = path.relative(rendererRoot, targetPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  } catch {
    return false;
  }
}

function restoreMainWindowFromSecondInstance() {
  stopWechatMessageAttention();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    void refreshWindowIcon();
    return;
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
  mainWindow.moveTop();
  sendWindowState(mainWindow);
}

const APP_SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;
let appServerLogPath = null;

function appendAppServerLogLine(stream, line) {
  // Renderer-only velune:log entries vanish with the window; keep a disk copy so
  // silent backend failures (e.g. a turn ending with no agent reply) stay diagnosable.
  try {
    if (!appServerLogPath) {
      const dir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(dir, { recursive: true });
      appServerLogPath = path.join(dir, "app-server.log");
    }
    try {
      if (fs.statSync(appServerLogPath).size > APP_SERVER_LOG_MAX_BYTES) {
        fs.rmSync(`${appServerLogPath}.1`, { force: true });
        fs.renameSync(appServerLogPath, `${appServerLogPath}.1`);
      }
    } catch {
      // First write or rotation race; appendFileSync below creates the file.
    }
    fs.appendFileSync(appServerLogPath, `${new Date().toISOString()} [${stream}] ${line}\n`);
  } catch {
    // Logging must never break the app-server pipeline.
  }
}

// VELUNE-TURN-DIAGNOSTICS-BEGIN: removable recorder integration

// VELUNE-TURN-DIAGNOSTICS-END: removable recorder integration

const LOCAL_NOOP_SESSION = {
  sessionSummary: () => ({
    authenticated: true,
    baseUrl: "local",
    profile: { id: "local-user", nickname: "本地用户", email: "local@localhost" }
})
};

function createLocalNoopApiClient() {
  const noop = () => Promise.resolve({ ok: true, local: true, items: [], data: [], list: [], total: 0 });
  return new Proxy(LOCAL_NOOP_SESSION, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      if (prop === "businessModelCredential") return () => null;
      if (prop === "baseUrl" || prop === "baseURL" || prop === "apiBaseUrl" || prop === "origin") return "local";
      if (prop === "baseName" || prop === "channel" || prop === "state") return "local";
      if (prop === "storagePath" || prop === "authPath" || prop === "logPath") return "";
      if (prop === "load" || prop === "save" || prop === "logout" || prop === "clearModelAuth") return () => {};
      return noop;
    }
});
}

function getVeluneApiClient() {
  if (!veluneApiClient) veluneApiClient = createLocalNoopApiClient();
  return veluneApiClient;
}

function getTradingFavoritesStore() {
  if (!tradingFavoritesStore) {
    tradingFavoritesStore = new TradingFavoritesStore({
      filePath: path.join(app.getPath("userData"), "trading-favorites.json")
    });
  }
  return tradingFavoritesStore;
}

/**
 * 给普通对话提供「设置 → 交易偏好」的已保存配置。
 * 只读缓存、不触发网络；未保存过（completed !== true）时 local-ai 侧不会注入任何内容。
 */

// 本机直连模型：不启动原厂 app-server，全部走本地行情 + 本地提示词 + DeepSeek API。

function getBinanceRequestGovernor() {
  if (!binanceRequestGovernor) {
    binanceRequestGovernor = new BinanceRequestGovernor({
      statePath: path.join(app.getPath("userData"), "binance-request-governor.json"),
      maxConcurrency: 6,
      onDiagnostic: (diagnostic) => {
        if (!["local_budget", "direct_binance", "gateway_downstream", "gateway_upstream"].includes(diagnostic?.origin)) return;
        console.warn("[binance-rate-limit]", diagnostic);
      }
});
  }
  return binanceRequestGovernor;
}

function getBinanceGatewayConfig() {
  if (!binanceGatewayConfig) {
    const explicitPath = String(process.env.VELUNE_BINANCE_GATEWAY_CONFIG_PATH || "").trim();
    // The Windows development executable is a renamed Electron binary so it
    // can carry the real app icon. Electron may consequently report
    // app.isPackaged=true even though Vite is serving the development app.
    // Prefer the workspace resource whenever a desktop dev-server URL exists;
    // otherwise this silently falls back to direct-only Binance networking.
    const developmentRuntime = Boolean(
      process.env.VELUNE_DESKTOP_DEV_SERVER_URL
      || process.env.VELUNE_DESKTOP_DEV_SERVER_URL
      || process.env.VELUNE_DESKTOP_DEV_SERVER_URL,
    );
    const deploymentPath = explicitPath || (app.isPackaged && !developmentRuntime
      ? path.join(process.resourcesPath, "binance-gateway.json")
      : path.join(app.getAppPath(), "resources", "binance-gateway.json"));
    let deployment = {};
    if (fs.existsSync(deploymentPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("configuration must be an object");
        deployment = parsed;
      } catch (error) {
        throw new TypeError(`Binance gateway deployment config is invalid: ${error?.message || error}`);
      }
    } else if (explicitPath) {
      throw new TypeError("VELUNE_BINANCE_GATEWAY_CONFIG_PATH does not exist");
    } else if (developmentRuntime) {
      throw new TypeError(`Development Binance gateway config does not exist: ${deploymentPath}`);
    }
    binanceGatewayConfig = resolveBinanceGatewayConfig(process.env, deployment);
    console.info("[binance-network] gateway configuration", {
      deploymentPath,
      developmentRuntime,
      routingMode: binanceGatewayConfig.routingMode,
      marketGatewayEnabled: binanceGatewayConfig.marketGatewayEnabled,
      privateProxyEnabled: binanceGatewayConfig.privateProxyEnabled
});
  }
  return binanceGatewayConfig;
}

function getBinanceGatewayClient() {
  if (!binanceGatewayClient) {
    const config = getBinanceGatewayConfig();
    if (!binanceGatewayNetworkFetch) {
      binanceGatewayNetworkFetch = createBinanceGatewayNetworkFetch(config, { network: getVeluneNetworkTransport() });
    }
    binanceGatewayClient = createBinanceGatewayClient({
      config,
      apiClient: getVeluneApiClient(),
      fetchImpl: binanceGatewayNetworkFetch
});
  }
  return binanceGatewayClient;
}

function getTradingMarketDataHub() {
  if (!tradingMarketDataHub) {
    const router = getBinanceNetworkRouter();
    tradingMarketDataHub = new TradingMarketDataHub({
      endpointProvider: (params) => router.marketStreamEndpoint(params),
      endpointFailureReporter: (outcome) => router.reportMarketStreamOutcome(outcome),
      lookupProvider: ({ route }) => route === "gateway" ? binanceGatewayNetworkFetch?.lookup : null,
      WebSocketImpl: WebSocket
});
  }
  return tradingMarketDataHub;
}

function getBinancePrivateProxyTransport() {
  const config = getBinanceGatewayConfig();
  if (!config.privateProxyEnabled) return null;
  if (!binancePrivateProxyTransport) {
    const gatewayClient = getBinanceGatewayClient();
    binancePrivateProxyTransport = new BinancePrivateProxyTransport({
      proxyUrl: config.privateProxyUrl,
      permitProvider: (url, options) => gatewayClient.privateRequestPermit(url, options),
      usageReporter: (report) => gatewayClient.reportPrivateUsage(report),
      lookup: binanceGatewayNetworkFetch?.lookup,
      connectOuter: (url, options) => getVeluneNetworkTransport().connect(url, options)
});
  }
  return binancePrivateProxyTransport;
}

function getBinanceNetworkRouter() {
  if (!binanceNetworkRouter) {
    const config = getBinanceGatewayConfig();
    const privateTransport = getBinancePrivateProxyTransport();
    if (!binanceRoutePreferenceStore) {
      binanceRoutePreferenceStore = new BinanceRoutePreferenceStore({
        storagePath: path.join(app.getPath("userData"), "binance-route-preferences.json")
});
    }
    binanceNetworkRouter = new BinanceNetworkRouter({
      config,
      directFetch: appNetworkFetch,
      gatewayClient: config.marketGatewayEnabled ? getBinanceGatewayClient() : null,
      privateProxyFetch: privateTransport ? privateTransport.fetch.bind(privateTransport) : null,
      initialState: binanceRoutePreferenceStore.load(),
      onStateChange: (state) => binanceRoutePreferenceStore?.schedule(state),
      directCooldownRemaining: (marketType) => getBinanceRequestGovernor().cooldownRemaining(marketType, Date.now()),
      onDirectRateLimit: (marketType, response, nowMs) => getBinanceRequestGovernor().observeResponse(marketType, response, nowMs)
});
    binanceNetworkRouter.startBackgroundProbes();
  }
  return binanceNetworkRouter;
}

function getBinancePublicMarketService() {
  if (!binancePublicMarketService) {
    const gatewayConfig = getBinanceGatewayConfig();
    const router = getBinanceNetworkRouter();
    binancePublicMarketService = new BinancePublicMarketService({
      fetch: (url, init) => {
        const requestUrl = new URL(String(url));
        const pathname = requestUrl.pathname;
        const chartRequest = /\/(?:fapi\/v\d+|api\/v3)\/(?:klines|aggTrades)$/.test(pathname);
        const prefetchRequest = new Headers(init?.headers).get("x-velune-market-demand") === "prefetch";
        const metadataRequest = pathname.endsWith("/exchangeInfo")
          || (pathname.endsWith("/ticker/24hr") && !requestUrl.searchParams.has("symbol"));
        return getBinanceRequestGovernor().fetch(
          router.publicFetch.bind(router),
          url,
          init,
          {
            source: prefetchRequest ? "prefetch" : metadataRequest ? "metadata" : "market",
            publicFallbackFetch: router.canUsePublicGateway() ? router.publicGatewayOnlyFetch.bind(router) : null,
            priority: prefetchRequest ? BINANCE_REQUEST_PRIORITIES.metadata : metadataRequest
              ? BINANCE_REQUEST_PRIORITIES.metadata
              : chartRequest
                ? BINANCE_REQUEST_PRIORITIES.chart
                : BINANCE_REQUEST_PRIORITIES.market,
            // Start this deadline only after the governor admits the request.
            // The 1 MB exchange catalog is slower than a chart request through
            // the domestic gateway, so it gets an independent cold-start budget.
            timeoutMs: metadataRequest ? 50_000 : chartRequest ? 50_000 : 30_000
},
        );
      },
      // The governor and each concrete route own execution deadlines. An outer
      // timer here would start too early while the request is still queued.
      timeoutMs: 0,
      baseUrls: gatewayConfig.publicRest
});
  }
  return binancePublicMarketService;
}

// 交易偏好段落是「字段化的单行条目」：每条一行、以 `- ` 开头、冒号后是取值。
// 同样的条目分散写在 buildPersonalTradingPreferenceDeveloperInstructions（developer
// instructions，普通对话用）和 renderTradingPreferences（盘面分析 prompt，@策略 用）两处。
// 两处措辞不同（英文长句 / 中文短条目），所以指纹只取「字段名」：中文条目的冒号
// 前缀先归一成英文字段名，英文条目按特征词判定字段，取值不参与比较。

// 合并 desktop / skills / 交易偏好三段 developer instructions，并保证同一份偏好
// 在一条请求里只出现一次：先按整段去重（同一个字符串出现两次），再按条目指纹去重
// （@策略 路径已把偏好渲染进盘面分析 prompt 时，这里不再重复注入同一批条目）。

// 本地版：不再读取云端会话，固定使用本机身份。账户、计划、交易偏好都基于它。

async function waitForAuthChangeRestart() {
  while (authChangeRestartPromise) await authChangeRestartPromise;
}

function appendExternalChannelDebugLog(eventType, payload = {}) {
  try {
    const logPath = path.join(app.getPath("userData"), "logs", "external-channel-reply-debug.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event: eventType,
        ...payload
})}\n`,
      "utf8",
    );
  } catch {
    // Debug logging must not affect message delivery.
  }
}

function closeDesktopNotificationWindow() {
  if (desktopNotificationTimer) {
    clearTimeout(desktopNotificationTimer);
    desktopNotificationTimer = null;
  }
  if (desktopNotificationWindow && !desktopNotificationWindow.isDestroyed()) {
    desktopNotificationWindow.close();
  }
  desktopNotificationWindow = null;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function htmlEscape(value) {
  return xmlEscape(value);
}


function windowState(window) {
  const mode =
    window?.veluneWindowMode === "app" ||
    window?.veluneWindowMode === "loginError" ||
    window?.veluneWindowMode === "loginRegister" ||
    window?.veluneWindowMode === "loginWechat"
      ? window.veluneWindowMode
      : "app";
  const bounds = window && !window.isDestroyed() ? window.getBounds() : null;
  const appMinimumSize = window && !window.isDestroyed() ? effectiveAppWindowMinimumOuterSize(window) : null;
  return {
    mode,
    maximized: isWindowMaximizedLike(window),
    nativeMaximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
    pinned: Boolean(window && !window.isDestroyed() && window.isAlwaysOnTop()),
    bounds,
    appMinimumSize
};
}

function sendWindowState(window) {
  if (window && !window.isDestroyed()) {
    window.webContents.send("window:state", windowState(window));
  }
}

function markWindowLiveResize(window) {
  if (!window || window.isDestroyed()) return;
  window.veluneLiveResizing = true;
  if (window.veluneCanResize === true && !window.isResizable()) {
    window.setResizable(true);
  }
  if (window.veluneLiveResizeTimer) {
    clearTimeout(window.veluneLiveResizeTimer);
  }
  window.veluneLiveResizeTimer = setTimeout(() => {
    if (!window || window.isDestroyed()) return;
    window.veluneLiveResizing = false;
    window.veluneLiveResizeTimer = null;
    if (window.veluneCanResize === true && !window.isResizable()) {
      window.setResizable(true);
    }
  }, 250);
}

function finishWindowLiveResize(window) {
  if (!window || window.isDestroyed()) return;
  if (window.veluneLiveResizeTimer) {
    clearTimeout(window.veluneLiveResizeTimer);
    window.veluneLiveResizeTimer = null;
  }
  window.veluneLiveResizing = false;
  if (window.veluneCanResize === true && !window.isResizable()) {
    window.setResizable(true);
  }
}

function rememberNormalWindowBounds(window) {
  if (!window || window.isDestroyed() || window.isMinimized() || isWindowMaximizedLike(window)) return;
  window.veluneNormalBounds = window.getBounds();
}

function windowWorkArea(window) {
  const bounds = window?.isDestroyed?.() ? null : window.getBounds();
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return (display || screen.getPrimaryDisplay()).workArea;
}



function boundsApproximatelyEqual(a, b, tolerance = MAXIMIZED_BOUNDS_TOLERANCE) {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function isWindowMaximizedLike(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMaximized()) return true;
  return boundsApproximatelyEqual(window.getBounds(), windowWorkArea(window));
}

function fallbackNormalBounds(window) {
  return appWindowLayout(window).bounds;
}

function centeredWindowBounds(window, width, height) {
  const workArea = windowWorkArea(window);
  return centeredBoundsInWorkArea(workArea, width, height);
}

function centeredBoundsInWorkArea(workArea, width, height) {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height)
};
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shouldConcealLoginToAppTransition(window, targetBounds) {
  if (!window || window.isDestroyed() || !window.isVisible()) return false;
  const currentBounds = window.getBounds();
  if (boundsApproximatelyEqual(currentBounds, targetBounds)) return false;
  const nearLoginSize =
    currentBounds.width <= LOGIN_REGISTER_WINDOW_BOUNDS.width + 64 &&
    currentBounds.height <= LOGIN_REGISTER_WINDOW_BOUNDS.height + 64;
  const growingToApp =
    targetBounds.width >= currentBounds.width + 240 &&
    targetBounds.height >= currentBounds.height + 120;
  return nearLoginSize && growingToApp;
}

function setBoundsForLoginToAppTransition(window, targetBounds) {
  if (!window || window.isDestroyed()) return;
  const conceal = shouldConcealLoginToAppTransition(window, targetBounds);
  if (!conceal) {
    window.setBounds(targetBounds, false);
    return;
  }

  if (window.veluneLoginToAppRevealFallbackTimer) {
    clearTimeout(window.veluneLoginToAppRevealFallbackTimer);
    window.veluneLoginToAppRevealFallbackTimer = null;
  }
  window.veluneLoginToAppPendingReveal = true;
  window.veluneLoginToAppShouldRefocus = window.isFocused();
  window.veluneLoginToAppPreviousOpacity = typeof window.getOpacity === "function" ? window.getOpacity() : 1;
  window.setOpacity(0);
  window.veluneLoginToAppRevealFallbackTimer = setTimeout(() => {
    revealPendingWindowModeTransition(window);
  }, LOGIN_TO_APP_REVEAL_FALLBACK_MS);
  window.setBounds(targetBounds, false);
}

function revealPendingWindowModeTransition(window) {
  if (!window || window.isDestroyed()) return { ok: false };
  const pendingReveal = Boolean(window.veluneLoginToAppPendingReveal);
  if (!pendingReveal) return { ok: true, revealed: false };
  if (window.veluneLoginToAppRevealFallbackTimer) {
    clearTimeout(window.veluneLoginToAppRevealFallbackTimer);
    window.veluneLoginToAppRevealFallbackTimer = null;
  }
  const previousOpacity = Number.isFinite(window.veluneLoginToAppPreviousOpacity) ? window.veluneLoginToAppPreviousOpacity : 1;
  const opacity = previousOpacity > 0.01 ? previousOpacity : 1;
  window.setOpacity(opacity);
  if (window.veluneLoginToAppShouldRefocus) {
    window.focus();
  }
  window.veluneLoginToAppPendingReveal = false;
  window.veluneLoginToAppShouldRefocus = false;
  window.veluneLoginToAppPreviousOpacity = null;
  return { ok: true, revealed: true, ...windowState(window) };
}

function appWindowOuterSize(size) {
  return size + APP_RESIZE_GUTTER_SIZE;
}

function appWindowAvailableOuterSize(workArea) {
  return {
    width: Math.max(1, Math.round((Number(workArea?.width) || 0) - APP_WINDOW_SCREEN_MARGIN * 2)),
    height: Math.max(1, Math.round((Number(workArea?.height) || 0) - APP_WINDOW_SCREEN_MARGIN * 2))
};
}

function appWindowPreferredOuterSize() {
  return {
    width: appWindowOuterSize(APP_WINDOW_BOUNDS.width),
    height: appWindowOuterSize(APP_WINDOW_BOUNDS.height)
};
}

function appWindowMinimumOuterSize(workArea = null) {
  const minimumOuterSize = {
    width: appWindowOuterSize(APP_WINDOW_BOUNDS.minWidth),
    height: appWindowOuterSize(APP_WINDOW_BOUNDS.minHeight)
};
  if (!workArea) return minimumOuterSize;
  const availableOuterSize = appWindowAvailableOuterSize(workArea);
  return {
    width: Math.min(minimumOuterSize.width, availableOuterSize.width),
    height: Math.min(minimumOuterSize.height, availableOuterSize.height)
};
}

function effectiveAppWindowMinimumOuterSize(window) {
  const size = window?.veluneAppMinimumOuterSize;
  if (Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height))
};
  }
  return appWindowMinimumOuterSize();
}

function appWindowLayout(window) {
  const workArea = windowWorkArea(window);
  const availableOuterSize = appWindowAvailableOuterSize(workArea);
  const preferredOuterSize = appWindowPreferredOuterSize();
  const minimumOuterSize = appWindowMinimumOuterSize(workArea);
  const width = Math.max(minimumOuterSize.width, Math.min(preferredOuterSize.width, availableOuterSize.width));
  const height = Math.max(minimumOuterSize.height, Math.min(preferredOuterSize.height, availableOuterSize.height));
  return {
    bounds: centeredBoundsInWorkArea(workArea, width, height),
    minimumOuterSize
};
}

function constrainAppWindowBoundsToWorkArea(window, bounds) {
  const workArea = windowWorkArea(window);
  const availableOuterSize = appWindowAvailableOuterSize(workArea);
  const minimumOuterSize = appWindowMinimumOuterSize(workArea);
  const width = Math.max(
    minimumOuterSize.width,
    Math.min(Number(bounds?.width) || availableOuterSize.width, availableOuterSize.width),
  );
  const height = Math.max(
    minimumOuterSize.height,
    Math.min(Number(bounds?.height) || availableOuterSize.height, availableOuterSize.height),
  );
  const minX = workArea.x + APP_WINDOW_SCREEN_MARGIN;
  const maxX = workArea.x + workArea.width - width - APP_WINDOW_SCREEN_MARGIN;
  const minY = workArea.y + APP_WINDOW_SCREEN_MARGIN;
  const maxY = workArea.y + workArea.height - height - APP_WINDOW_SCREEN_MARGIN;
  const centered = centeredBoundsInWorkArea(workArea, width, height);
  return {
    x: Math.round(maxX >= minX ? clampNumber(Number(bounds?.x) || centered.x, minX, maxX) : centered.x),
    y: Math.round(maxY >= minY ? clampNumber(Number(bounds?.y) || centered.y, minY, maxY) : centered.y),
    width: Math.round(width),
    height: Math.round(height)
};
}

function restoreWindowFromMaximized(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) {
    window.restore();
    return;
  }
  if (window.isMaximized()) {
    window.unmaximize();
  }
  if (isWindowMaximizedLike(window)) {
    const restoreBounds = window.veluneNormalBounds
      ? constrainAppWindowBoundsToWorkArea(window, window.veluneNormalBounds)
      : fallbackNormalBounds(window);
    window.setBounds(restoreBounds, true);
  }
  rememberNormalWindowBounds(window);
}

function applyWindowMode(window, mode) {
  if (!window || window.isDestroyed()) return { ok: false };
  const normalizedMode =
    mode === "app"
      ? "app"
      : mode === "loginError"
        ? "loginError"
        : mode === "loginRegister"
          ? "loginRegister"
          : mode === "loginWechat"
            ? "loginWechat"
            : "login";
  window.veluneWindowMode = normalizedMode;
  if (window.isMaximized()) {
    window.unmaximize();
  }

  if (normalizedMode === "app") {
    window.veluneCanResize = true;
    window.setResizable(true);
    window.veluneThickFrameApplied = false;
    ensureNativeThickFrame(window);
    window.setMaximizable(true);
    window.setHasShadow?.(false);
    const { bounds: targetBounds, minimumOuterSize } = appWindowLayout(window);
    window.veluneAppMinimumOuterSize = minimumOuterSize;
    window.setMinimumSize(minimumOuterSize.width, minimumOuterSize.height);
    setBoundsForLoginToAppTransition(window, targetBounds);
    rememberNormalWindowBounds(window);
  } else {
    const bounds =
      normalizedMode === "loginError"
        ? LOGIN_ERROR_WINDOW_BOUNDS
        : normalizedMode === "loginWechat"
          ? LOGIN_WECHAT_WINDOW_BOUNDS
        : normalizedMode === "loginRegister"
          ? LOGIN_REGISTER_WINDOW_BOUNDS
          : LOGIN_WINDOW_BOUNDS;
    window.veluneCanResize = false;
    window.veluneAppMinimumOuterSize = null;
    window.setResizable(false);
    window.setMaximizable(false);
    window.setHasShadow?.(true);
    window.setMinimumSize(bounds.minWidth, bounds.minHeight);
    const targetBounds = centeredWindowBounds(window, bounds.width, bounds.height);
    window.setBounds(targetBounds, false);
  }

  rememberNormalWindowBounds(window);
  sendWindowState(window);
  return { ok: true, mode: normalizedMode, pendingReveal: Boolean(window.veluneLoginToAppPendingReveal), ...windowState(window) };
}

ipcMain.handle("desktop:getSystemIntegrationState", async () => {
  return systemIntegrationState();
});

ipcMain.handle("desktop:setSystemIntegration", async (_event, params = {}) => {
  return setSystemIntegration(params);
});


ipcMain.handle("app:setTheme", async (_event, params = {}) => {
  return setAppTheme(params.theme);
});

ipcMain.handle("app:setLanguage", async (_event, params = {}) => {
  return setAppLanguage(params.language);
});

// 本地离线会话：不走 velune 服务器登录，直接以本地用户身份进入主界面。
const LOCAL_SESSION_PROFILE = Object.freeze({
  id: "local-user",
  nickname: "本地用户",
  email: "",
  avatar_url: "",
  avatar_style: "nft-rose"
});
function localSessionSummary() {
  return {
    authenticated: true,
    baseUrl: "",
    profile: { ...LOCAL_SESSION_PROFILE },
    expiresAt: null,
    refreshExpiresAt: null,
    sessionId: "local-session",
    hasRefreshSession: false,
    hasModelApiKey: Boolean(process.env.DEEPSEEK_API_KEY),
    modelBaseUrl: "https://api.deepseek.com/v1",
    modelProviders: ["deepseek"]
};
}

ipcMain.handle("velune:getSession", async () => {
  return localSessionSummary();
});

ipcMain.handle("velune:refreshSession", async () => {
  return localSessionSummary();
});

ipcMain.handle("velune:refreshProfile", async () => {
  return getVeluneApiClient().refreshProfile();
});

ipcMain.handle("velune:debugLog", async (_event, params = {}) => {
  const eventType = String(params.event || params.eventType || "renderer.debug").trim() || "renderer.debug";
  const payload = params.payload && typeof params.payload === "object" ? params.payload : {};
  appendExternalChannelDebugLog(eventType, {
    source: "renderer",
    payload
});
  return { ok: true };
});

const publicMarketIndices = new MarketIndicesService({
  indicesRequest: () => getVeluneApiClient().getMarketIndices(),
  fetch: (url, init) => appNetworkFetch(url, init),
  binanceRequest: (params, options) => getBinancePublicMarketService().request(params, options)
});
ipcMain.handle("marketData:getPublicIndices", async (event) => {
  assertExternalModelsIpcSender(event);
  return publicMarketIndices.snapshot();
});
ipcMain.handle("marketData:getIndexChart", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  return getVeluneApiClient().getIndexChart(params);
});

const publicMarketData = new PublicMarketDataService({
  fetchImpl: (url, init) => appNetworkFetch(url, init)
});
ipcMain.handle("marketData:getPublicCandles", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  return publicMarketData.getCandles(params);
});
ipcMain.handle("marketData:getPublicQuotes", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  return publicMarketData.getQuotes(params);
});
ipcMain.handle("marketData:getPublicMarkets", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  return publicMarketData.getMarkets(params);
});

ipcMain.handle("binanceMarket:publicGet", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  await waitForAuthChangeRestart();
  const requestId = String(params.requestId || "").trim();
  if (!requestId) return getBinancePublicMarketService().request(params);
  const ownerId = event.sender.id;
  const operation = binancePublicRequestCoordinator.begin(ownerId, requestId);
  const abortOwner = () => binancePublicRequestCoordinator.cancelOwner(ownerId);
  event.sender.once("destroyed", abortOwner);
  try {
    return await getBinancePublicMarketService().request(params, { signal: operation.signal });
  } catch (error) {
    // 渲染进程销毁或主动取消时中断请求属于正常流程，不应作为 IPC 错误上报。
    if (error?.name === "AbortError") return { cancelled: true };
    throw error;
  } finally {
    operation.finish();
    event.sender.removeListener("destroyed", abortOwner);
  }
});
ipcMain.handle("binanceMarket:publicCancel", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  return {
    cancelled: binancePublicRequestCoordinator.cancel(event.sender.id, params.requestId)
};
});
ipcMain.handle("binanceMarket:streamSubscribe", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  await waitForAuthChangeRestart();
  const subscriptionId = String(params.subscriptionId || "").trim();
  if (!/^renderer-market-[a-z0-9-]{8,80}$/i.test(subscriptionId)) throw new TypeError("invalid market subscription id");
  const existing = binanceMarketRendererSubscriptions.get(subscriptionId);
  if (existing) {
    if (existing.ownerId !== event.sender.id) throw new TypeError("market subscription owner mismatch");
    return { subscriptionId };
  }
  const subscription = getTradingMarketDataHub().subscribe(
    { marketType: params.marketType, streams: params.streams },
    (marketEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("binanceMarket:streamEvent", { subscriptionId, event: marketEvent });
    },
    (healthEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("binanceMarket:streamEvent", { subscriptionId, event: healthEvent });
    },
  );
  const cleanup = () => {
    const current = binanceMarketRendererSubscriptions.get(subscriptionId);
    if (!current) return;
    binanceMarketRendererSubscriptions.delete(subscriptionId);
    void current.dispose();
  };
  event.sender.once("destroyed", cleanup);
  binanceMarketRendererSubscriptions.set(subscriptionId, {
    ownerId: event.sender.id,
    sender: event.sender,
    cleanup,
    dispose: subscription.dispose
});
  return { subscriptionId };
});
ipcMain.handle("binanceMarket:streamUnsubscribe", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  const subscriptionId = String(params.subscriptionId || "").trim();
  const record = binanceMarketRendererSubscriptions.get(subscriptionId);
  if (!record || record.ownerId !== event.sender.id) return { removed: false };
  binanceMarketRendererSubscriptions.delete(subscriptionId);
  record.sender.removeListener?.("destroyed", record.cleanup);
  await record.dispose();
  return { removed: true };
});

ipcMain.handle("velune:listTradingFavorites", async () => {
  return getTradingFavoritesStore().list();
});

ipcMain.handle("velune:addTradingFavorite", async (_event, params = {}) => {
  return getTradingFavoritesStore().add(params);
});

ipcMain.handle("velune:removeTradingFavorite", async (_event, params = {}) => {
  return getTradingFavoritesStore().remove(params);
});

ipcMain.handle("velune:reorderTradingFavorites", async (_event, params = {}) => {
  return getTradingFavoritesStore().reorder(params);
});

// 本地版：以下通道的远端后端已移除，保留最小闭合 stub 以维持界面可交互（返回空成功结构，不暴露实现细节）

// 本地版：币安账号绑定与技能市场安装的后端已移除，保留最小闭合 stub 以免界面报「No handler registered」

function assertExternalModelsIpcSender(event) {
  const webContents = mainWindow?.webContents;
  if (
    !webContents ||
    webContents.isDestroyed() ||
    event.sender !== webContents ||
    event.senderFrame !== webContents.mainFrame
  ) {
    throw new Error("External model settings are only available to the main window.");
  }
}

// 目录变化后广播给所有窗口，渲染层据此重绘菜单/按钮（无需刷新页面）。
// preferred 非空时作为全局 selectedModel 优先值（点选模型时传所点模型），
// 否则 publicModelCatalog 会取「第一个 enabled provider 的 selected」，把选择拉回 deepseek。

// 本地分析流程共用的凭据解析：按「目录当前选中模型」解析所属提供商。
// 不再硬编码 deepseek —— 用户在聊天框模型菜单里选了哪家，分析就走哪家。
// 返回 { providerId, model, apiKey, baseUrl, chatUrl, displayName }；
// 目录为空时返回 null；所选提供商未配置 Key 时抛 PROVIDER_NOT_CONFIGURED（原错误语义）。

// 渲染层启动/窗口加载后拉取同一份目录，模型菜单与按钮文本都从它派生。

ipcMain.handle("marketData:getFinnhubStatus", async (event) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getFinnhubMarketDataStatus();
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:searchFinnhub", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().searchFinnhubMarkets(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:getFinnhubQuotes", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getFinnhubMarketQuotes(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:getFinnhubSnapshot", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getFinnhubMarketSnapshot(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:getFinnhubCandles", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getFinnhubMarketCandles(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});
ipcMain.handle("marketData:searchIfind", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().searchIfindMarkets(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:getIfindQuotes", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getIfindMarketQuotes(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:getIfindSnapshot", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getIfindMarketSnapshot(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("marketData:getIfindCandles", async (event, params = {}) => {
  assertExternalModelsIpcSender(event);
  try {
    return await getVeluneApiClient().getIfindMarketCandles(params);
  } catch (error) {
    return marketDataBackendErrorPayload(error);
  }
});

ipcMain.handle("app:setTaskbarUnreadCount", async (_event, params = {}) => {
  const count = setTaskbarUnreadConversationCount(params.count);
  return { ok: true, count };
});

ipcMain.handle("velune:previewFile", async (_event, params = {}) => {
  return fetchPreviewFile(params);
});

ipcMain.handle("velune:previewImageFile", async (_event, params = {}) => {
  return previewImageFile(params);
});

ipcMain.handle("velune:localFileInfo", async (_event, params = {}) => {
  return localFileInfo(params);
});

ipcMain.handle("velune:localPathInfo", async (_event, params = {}) => {
  return localPathInfo(params);
});

ipcMain.handle("velune:openLocalFile", async (_event, params = {}) => {
  return openLocalFile(params);
});

ipcMain.handle("velune:revealLocalFile", async (_event, params = {}) => {
  return revealLocalFile(params);
});

ipcMain.handle("velune:readLocalFile", async (_event, params = {}) => {
  return readLocalFile(params);
});

ipcMain.handle("velune:openExternal", async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("velune:openBlockchainTransaction", async (_event, params = {}) => {
  const url = blockchainTransactionUrl(params);
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("app:quit", async () => {
  app.quit();
  return { ok: true };
});

ipcMain.handle("window:control", async (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return applyWindowControl(window, action);
});

ipcMain.handle("trading:captureChart", async (event, params = {}) => {
  return captureTradingChart(BrowserWindow.fromWebContents(event.sender), params, { app, clipboard });
});

ipcMain.handle("window:resize", async (event, params) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = applyWindowResize(window, params, { live: false });
  finishWindowLiveResize(window);
  if (window && !window.isDestroyed()) {
    window.veluneResizeSession = null;
    if (result?.ok && !window.webContents.isDestroyed()) {
      window.webContents.invalidate();
    }
  }
  sendWindowState(window);
  return result;
});

ipcMain.on("window:resize-live", (event, params) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  markWindowLiveResize(window);
  applyWindowResize(window, params, { live: true });
});

ipcMain.on("window:control", (event, action) => {
  applyWindowControl(BrowserWindow.fromWebContents(event.sender), action);
});

ipcMain.handle("window:setMode", async (event, mode) => {
  return applyWindowMode(BrowserWindow.fromWebContents(event.sender), mode);
});

ipcMain.handle("window:getState", async (event) => {
  return windowState(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle("window:revealModeTransition", async (event) => {
  return revealPendingWindowModeTransition(BrowserWindow.fromWebContents(event.sender));
});

function applyWindowControl(window, action) {
  if (!window) return { ok: false };
  switch (action) {
    case "pin": {
      const pinned = !window.isAlwaysOnTop();
      window.setAlwaysOnTop(pinned, "floating");
      sendWindowState(window);
      return { ok: true, ...windowState(window) };
    }
    case "minimize":
      window.minimize();
      sendWindowState(window);
      break;
    case "hide":
      window.hide();
      if (!appTray) createAppTray();
      sendWindowState(window);
      break;
    case "maximize":
      rememberNormalWindowBounds(window);
      window.maximize();
      sendWindowState(window);
      break;
    case "restore":
      if (isWindowMaximizedLike(window) || window.isMinimized()) {
        restoreWindowFromMaximized(window);
      } else {
        window.show();
        rememberNormalWindowBounds(window);
      }
      sendWindowState(window);
      break;
    case "close":
      return applyWindowControl(window, "hide");
    default:
      return { ok: false };
  }
  return { ok: true, ...windowState(window) };
}









function normalizeResizePoint(value) {
  const point = value || {};
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function resizeSessionForWindow(window, params, edge) {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "__default";
  if (window.veluneResizeSession?.id === sessionId && window.veluneResizeSession?.edge === edge) {
    return window.veluneResizeSession;
  }
  const fallbackPoint = screen.getCursorScreenPoint();
  const startPoint = normalizeResizePoint(params.startPoint) || normalizeResizePoint(params.point) || fallbackPoint;
  const startBounds = window.getBounds();
  window.veluneResizeSession = {
    id: sessionId,
    edge,
    startPoint,
    startBounds
};
  return window.veluneResizeSession;
}

function applyWindowResize(window, params = {}, options = {}) {
  if (!window || window.isDestroyed() || window.isMaximized() || window.veluneCanResize !== true) return { ok: false };
  const edge = typeof params.edge === "string" ? params.edge : "";
  if (!["n", "s", "e", "w", "ne", "nw", "se", "sw"].includes(edge)) return { ok: false };
  const session = resizeSessionForWindow(window, params, edge);
  const fallbackPoint = screen.getCursorScreenPoint();
  const currentPoint = normalizeResizePoint(params.point) || fallbackPoint;
  const x = currentPoint.x;
  const y = currentPoint.y;
  const startX = Number(session.startPoint.x);
  const startY = Number(session.startPoint.y);
  const original = {
    x: Number(session.startBounds.x),
    y: Number(session.startBounds.y),
    width: Number(session.startBounds.width),
    height: Number(session.startBounds.height)
};
  if (
    !edge ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(startX) ||
    !Number.isFinite(startY) ||
    !Number.isFinite(original.x) ||
    !Number.isFinite(original.y) ||
    !Number.isFinite(original.width) ||
    !Number.isFinite(original.height)
  ) {
    return { ok: false };
  }

  const [windowMinWidth, windowMinHeight] = window.getMinimumSize();
  const appMinimumOuterSize = effectiveAppWindowMinimumOuterSize(window);
  const minWidth = Math.max(windowMinWidth, appMinimumOuterSize.width);
  const minHeight = Math.max(windowMinHeight, appMinimumOuterSize.height);
  const dx = x - startX;
  const dy = y - startY;
  const next = { ...original };
  if (edge.includes("e")) {
    next.width = Math.max(minWidth, original.width + dx);
  }
  if (edge.includes("s")) {
    next.height = Math.max(minHeight, original.height + dy);
  }
  if (edge.includes("w")) {
    const width = Math.max(minWidth, original.width - dx);
    next.x = original.x + original.width - width;
    next.width = width;
  }
  if (edge.includes("n")) {
    const height = Math.max(minHeight, original.height - dy);
    next.y = original.y + original.height - height;
    next.height = height;
  }
  const nextBounds = {
    x: Math.round(next.x),
    y: Math.round(next.y),
    width: Math.round(next.width),
    height: Math.round(next.height)
};
  const currentBounds = window.getBounds();
  if (
    currentBounds.x !== nextBounds.x ||
    currentBounds.y !== nextBounds.y ||
    currentBounds.width !== nextBounds.width ||
    currentBounds.height !== nextBounds.height
  ) {
    window.setBounds(nextBounds);
  }
  if (!options.live) {
    rememberNormalWindowBounds(window);
  }
  return { ok: true };
}

async function previewImageFile(params = {}) {
  const { path: filePath, stats } = await resolveLocalPathForAction(params, "file");
  const name = String(params.name || path.basename(filePath));
  const mime = String(params.mime || mimeFromFilePath(filePath) || "image/png").trim() || "image/png";
  if (!mime.toLowerCase().startsWith("image/")) {
    throw new Error("Only image files can be previewed.");
  }
  const buffer = await fs.promises.readFile(filePath);
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    throw new Error("Image preview failed.");
  }
  return await openImagePreviewWindow({
    image,
    imageSize: image.getSize(),
    name,
    sourceBuffer: buffer,
    sourceMime: mime,
    theme: imagePreviewTheme(params.theme)
});
}

function imagePreviewTheme(value) {
  return value === "dark" ? "dark" : "light";
}

async function openImagePreviewWindow({ image, imageSize, name, sourceBuffer, sourceMime, theme }) {
  const bounds = imagePreviewWindowBounds(imageSize);
  const savePayload = imagePreviewSavePayload({ image, name, sourceBuffer, sourceMime });
  return new Promise((resolve, reject) => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const previewWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height + 36,
      useContentSize: true,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      thickFrame: true,
      minWidth: 320,
      minHeight: 220,
      title: name || "Image preview",
      icon: APP_AVATAR_WINDOW_ICON || currentWindowIcon() || undefined,
      parent,
      modal: Boolean(parent),
      autoHideMenuBar: true,
      show: false,
      backgroundColor: "#000000",
      webPreferences: {
        preload: path.join(__dirname, "image-preview-preload.mjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
}
});
    previewWindow.veluneImagePreviewSavePayload = savePayload;
    wireImagePreviewContextMenu(previewWindow, image);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve({ cancelled: true });
    };

    previewWindow.on("closed", settle);
    loadImagePreviewWindow(previewWindow, { image, name, canSave: Boolean(savePayload?.buffer?.length), theme }).then(() => {
      if (previewWindow.isDestroyed()) return;
      previewWindow.show();
      previewWindow.focus();
    }).catch((error) => {
      if (settled) return;
      settled = true;
      if (!previewWindow.isDestroyed()) previewWindow.close();
      reject(error);
    });
  });
}

function wireImagePreviewContextMenu(window, image) {
  window.webContents.on("context-menu", (event, params) => {
    if (params.mediaType !== "image" || image.isEmpty()) return;
    event.preventDefault();
    const menu = Menu.buildFromTemplate([
      {
        label: mainUiText("copy"),
        click: () => clipboard.writeImage(image)
},
    ]);
    menu.popup({ window });
  });
}

function imagePreviewSavePayload({ image, name, sourceBuffer, sourceMime }) {
  const buffer = Buffer.isBuffer(sourceBuffer) && sourceBuffer.length ? sourceBuffer : image.toPNG();
  const mime = String(sourceMime || "").trim() || "image/png";
  return {
    buffer,
    name: imagePreviewSaveFileName(name, mime),
    mime
};
}

function imagePreviewSaveFileName(name, mime) {
  const fallback = `image-${new Date().toISOString().replace(/[:.]/g, "-")}${imageExtensionFromMime(mime)}`;
  const baseName = String(name || fallback)
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || fallback;
  const cleanName = baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || fallback;
  return path.extname(cleanName) ? cleanName : `${cleanName}${imageExtensionFromMime(mime)}`;
}

function imageExtensionFromMime(mime) {
  const lower = String(mime || "").toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return ".jpg";
  if (lower === "image/webp") return ".webp";
  if (lower === "image/gif") return ".gif";
  if (lower === "image/bmp") return ".bmp";
  if (lower === "image/svg+xml") return ".svg";
  return ".png";
}

function imagePreviewIconAsset() {
  const source = APP_AVATAR_WINDOW_ICON || currentWindowIcon();
  const image = typeof source === "string" ? nativeImage.createFromPath(source) : source;
  if (!image || image.isEmpty?.()) return null;
  return { name: "icon.png", content: image.resize({ width: 32, height: 32 }).toPNG() };
}

async function loadImagePreviewWindow(window, { image, name, canSave, theme }) {
  const iconAsset = imagePreviewIconAsset();
  await loadWindowHtmlFromTemp(window, {
    prefix: "velune-image-preview-",
    assets: [{ name: "preview.png", content: image.toPNG() }, ...(iconAsset ? [iconAsset] : [])],
    html: (assetPaths) =>
      imagePreviewHtml({
        imageSrc: pathToFileURL(assetPaths["preview.png"]).href,
        iconSrc: assetPaths["icon.png"] ? pathToFileURL(assetPaths["icon.png"]).href : "",
        title: name || "Image preview",
        canSave,
        theme: imagePreviewTheme(theme),
        language: appLanguage()
})
});
}

function imagePreviewHtml({ imageSrc, iconSrc, title, canSave, theme, language = appLanguage() }) {
  const normalizedLanguage = normalizeAppLanguage(language);
  const saveImageLabel = mainUiText("saveImage", normalizedLanguage);
  const closeLabel = mainUiText("close", normalizedLanguage);
  return `<!doctype html>
<html lang="${htmlEscape(appLanguageLocale(normalizedLanguage))}" data-theme="${htmlEscape(imagePreviewTheme(theme))}">
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #000;
      }

      html {
        color-scheme: light;
        --titlebar-bg: #f7f8fa;
        --titlebar-fg: #1f2937;
        --titlebar-border: rgba(15, 23, 42, 0.14);
        --titlebar-action-fg: #111827;
        --titlebar-action-hover: rgba(15, 23, 42, 0.08);
        --titlebar-action-disabled: rgba(17, 24, 39, 0.32);
      }

      html[data-theme="dark"] {
        color-scheme: dark;
        --titlebar-bg: #2b2d31;
        --titlebar-fg: #f3f4f6;
        --titlebar-border: #252a31;
        --titlebar-action-fg: #f3f4f6;
        --titlebar-action-hover: rgba(255, 255, 255, 0.08);
        --titlebar-action-disabled: rgba(243, 244, 246, 0.32);
      }

      body {
        display: grid;
        grid-template-rows: 36px minmax(0, 1fr);
      }

      .titlebar {
        -webkit-app-region: drag;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        height: 36px;
        background: var(--titlebar-bg);
        color: var(--titlebar-fg);
        border-bottom: 1px solid var(--titlebar-border);
        font: 13px/1.2 "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif;
        user-select: none;
      }

      .title {
        display: flex;
        align-items: center;
        min-width: 0;
        padding-left: 10px;
        gap: 7px;
      }

      .title img {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        border-radius: 4px;
      }

      .title span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .window-actions {
        -webkit-app-region: no-drag;
        display: flex;
        align-items: stretch;
        height: 100%;
        gap: 1px;
        padding-right: 4px;
      }

      .window-actions button {
        appearance: none;
        width: 38px;
        height: 32px;
        margin-top: 2px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--titlebar-action-fg);
        display: grid;
        place-items: center;
        padding: 0;
      }

      .window-actions button:hover:not(:disabled) {
        background: var(--titlebar-action-hover);
      }

      .window-actions button:disabled {
        color: var(--titlebar-action-disabled);
      }

      .window-actions button.close:hover {
        color: #fff;
        background: #e81123;
      }

      .window-actions svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .viewer {
        min-width: 0;
        min-height: 0;
        display: grid;
        place-items: center;
        background: #000;
        overflow: hidden;
      }

      .viewer > img {
        display: block;
        width: 100vw;
        height: calc(100vh - 36px);
        object-fit: contain;
        user-select: none;
        -webkit-user-drag: none;
      }

      .status {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        padding: 7px 12px;
        border-radius: 8px;
        background: rgba(17, 24, 39, 0.82);
        color: #fff;
        font: 12px/1.2 "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif;
        opacity: 0;
        pointer-events: none;
        transition: opacity 160ms ease;
      }

      .status.show {
        opacity: 1;
      }
    </style>
  </head>
  <body>
    <header class="titlebar">
      <div class="title">
        ${iconSrc ? `<img src="${htmlEscape(iconSrc)}" alt="" draggable="false" />` : ""}
        <span>${htmlEscape(title)}</span>
      </div>
      <div class="window-actions">
        <button type="button" data-action="save" title="${htmlEscape(saveImageLabel)}" aria-label="${htmlEscape(saveImageLabel)}" ${canSave ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v11" />
            <path d="m8 10 4 4 4-4" />
            <path d="M5 14v6h14v-6" />
          </svg>
        </button>
        <button type="button" class="close" data-action="close" title="${htmlEscape(closeLabel)}" aria-label="${htmlEscape(closeLabel)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </button>
      </div>
    </header>
    <main class="viewer">
      <img src="${htmlEscape(imageSrc)}" alt="" draggable="false" />
    </main>
    <div class="status" role="status" aria-live="polite"></div>
    <script>
      const status = document.querySelector(".status");
      const imageSavedText = ${JSON.stringify(mainUiText("imageSaved", normalizedLanguage))};
      const saveFailedText = ${JSON.stringify(mainUiText("saveFailed", normalizedLanguage))};
      const actionFailedText = ${JSON.stringify(mainUiText("actionFailed", normalizedLanguage))};
      let statusTimer = null;
      function showStatus(text) {
        if (!status) return;
        status.textContent = text;
        status.classList.add("show");
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => status.classList.remove("show"), 1600);
      }

      async function runAction(action) {
        try {
          if (action === "save") {
            const result = await window.veluneImagePreview?.save?.();
            if (result?.ok) showStatus(imageSavedText);
            return;
          }
          if (action === "close") await window.veluneImagePreview?.close?.();
        } catch (error) {
          showStatus(action === "save" ? saveFailedText : actionFailedText);
        }
      }

      document.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", () => runAction(button.dataset.action));
      });
    </script>
  </body>
</html>`;
}

function imagePreviewWindowBounds(imageSize) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
  const area = display.workArea || display.bounds;
  const width = Math.max(1, Number(imageSize?.width) || 1);
  const height = Math.max(1, Number(imageSize?.height) || 1);
  const maxWidth = Math.max(320, Math.floor(area.width * 0.72));
  const maxHeight = Math.max(240, Math.floor(area.height * 0.82));
  let scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const minWidth = Math.min(360, maxWidth);
  const minHeight = Math.min(240, maxHeight);
  if (width * scale < minWidth || height * scale < minHeight) {
    scale = Math.min(maxWidth / width, maxHeight / height, Math.max(scale, minWidth / width, minHeight / height));
  }

  const contentWidth = Math.max(1, Math.min(maxWidth, Math.round(width * scale)));
  const contentHeight = Math.max(1, Math.min(maxHeight, Math.round(height * scale)));
  return {
    x: Math.round(area.x + (area.width - contentWidth) / 2),
    y: Math.round(area.y + (area.height - contentHeight) / 2),
    width: contentWidth,
    height: contentHeight
};
}

async function loadWindowHtmlFromTemp(window, { prefix, html, assets = [] }) {
  const tempDir = await fs.promises.mkdtemp(path.join(app.getPath("temp"), prefix));
  let cleanupRegistered = false;
  const cleanup = () => {
    fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const assetPaths = {};
    for (const asset of assets) {
      const assetPath = path.join(tempDir, asset.name);
      await fs.promises.writeFile(assetPath, asset.content);
      assetPaths[asset.name] = assetPath;
    }
    const htmlText = typeof html === "function" ? html(assetPaths) : html;
    const htmlPath = path.join(tempDir, "index.html");
    await fs.promises.writeFile(htmlPath, htmlText, "utf8");
    if (window.isDestroyed()) {
      throw new Error("Window was destroyed before loading HTML.");
    }
    cleanupRegistered = true;
    window.once("closed", cleanup);
    await window.loadFile(htmlPath);
    return { tempDir, htmlPath, assetPaths };
  } catch (error) {
    if (!cleanupRegistered) cleanup();
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchPreviewFile(params = {}) {
  const url = String(params.url || "").trim();
  if (isLocalPreviewPath(url)) {
    return fetchLocalPreviewFile(url, params);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http/https or local file preview URLs are supported.");
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "*/*",
      "User-Agent": "velune_desktop"
}
});

  if (!response.ok) {
    throw new Error(`File preview request failed: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > PREVIEW_FILE_LIMIT_BYTES) {
    throw new Error("The file is too large to preview.");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > PREVIEW_FILE_LIMIT_BYTES) {
    throw new Error("The file is too large to preview.");
  }

  const buffer = Buffer.from(arrayBuffer);
  const name = params.name || fileNameFromPreviewUrl(url) || "";
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || params.mime || "application/octet-stream";
  let legacyOfficeConversionError = null;
  let legacyOfficePdf = null;
  try {
    legacyOfficePdf = await maybeConvertLegacyOfficePreview({
      url,
      name,
      mime,
      buffer,
      sizeBytes: buffer.byteLength
});
  } catch (error) {
    legacyOfficeConversionError = errorMessageText(error);
  }
  if (legacyOfficePdf) {
    return legacyOfficePreviewResponse({ url, name, mime, sizeBytes: buffer.byteLength }, legacyOfficePdf);
  }
  return {
    url,
    name,
    mime,
    sizeBytes: buffer.byteLength,
    legacyOfficeConversionError,
    base64: buffer.toString("base64")
};
}

function appNetworkFetch(url, options = {}) {
  return getVeluneNetworkTransport().fetch(url, options);
}

function getVeluneNetworkTransport() {
  if (!veluneNetworkTransport) {
    const onDiagnostic = (entry) => appendAppServerLogLine("network", JSON.stringify(entry));
    const getSession = () => session.fromPartition("velune-service-network", { cache: false });
    const fallbackFetch = nativeAppNetworkFetch;
    veluneNetworkTransport = createVeluneNetworkTransport({
      resolveProxy: developmentDirectNetwork() ? async () => "DIRECT" : createElectronProxyResolver({ getSession }),
      fallbackFetch,
      onDiagnostic
});
  }
  return veluneNetworkTransport;
}

let developmentDirectSessionReady;
async function nativeAppNetworkFetch(url, options = {}) {
  if (developmentDirectNetwork()) {
    developmentDirectSessionReady ||= (async () => {
      const directSession = session.fromPartition("velune-development-direct-network", { cache: false });
      await directSession.setProxy({ mode: "direct" });
      return directSession;
    })();
    return (await developmentDirectSessionReady).fetch(url, options);
  }
  if (typeof net?.fetch === "function") return net.fetch(url, options);
  return fetch(url, options);
}
function shortThreadGroupFolderId(value) {
  return crypto.createHash("sha1").update(String(value || "thread-group")).digest("hex").slice(0, 8);
}

async function fetchLocalPreviewFile(url, params = {}) {
  let resolution;
  try {
    resolution = await resolveLocalPathForAction({ ...params, path: url }, "file");
  } catch (error) {
    if (error?.code === LOCAL_FILE_MISSING_ERROR_CODE) {
      const missingPath = localPreviewPath(url);
      return {
        url,
        name: params.name || path.basename(missingPath),
        mime: params.mime || mimeFromFilePath(missingPath),
        missing: true
};
    }
    throw error;
  }
  const filePath = resolution.path;
  const ext = path.extname(filePath).toLowerCase();
  if (!isSupportedLocalPreviewExtension(ext)) {
    throw new Error("只支持预览本地图片、文档、视频和文本文件");
  }
  const stats = resolution.stats;
  if (!stats.isFile()) {
    throw new Error("本地预览路径不是文件");
  }
  if (stats.size > PREVIEW_FILE_LIMIT_BYTES) {
    throw new Error("文件过大，暂不支持直接预览");
  }
  const name = params.name || path.basename(filePath);
  const mime = params.mime || mimeFromFilePath(filePath);
  let legacyOfficeConversionError = null;
  let legacyOfficePdf = null;
  try {
    legacyOfficePdf = await maybeConvertLegacyOfficePreview({
      url,
      name,
      mime,
      sourcePath: filePath,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs
});
  } catch (error) {
    legacyOfficeConversionError = errorMessageText(error);
  }
  if (legacyOfficePdf) {
    return legacyOfficePreviewResponse({ url, name, mime, sizeBytes: stats.size }, legacyOfficePdf);
  }
  const textPreview = isTextLocalPreviewExtension(ext);
  const readLimit = textPreview ? Math.min(stats.size, TEXT_PREVIEW_LIMIT_BYTES) : stats.size;
  const buffer = textPreview ? await readFileHead(filePath, readLimit) : await fs.promises.readFile(filePath);
  return {
    url,
    name,
    mime,
    sizeBytes: stats.size,
    previewBytes: buffer.byteLength,
    truncated: textPreview && stats.size > buffer.byteLength,
    legacyOfficeConversionError,
    base64: buffer.toString("base64")
};
}

function legacyOfficePreviewResponse(source, converted) {
  return {
    url: source.url,
    name: source.name || "",
    mime: "application/pdf",
    originalMime: source.mime || null,
    originalName: source.name || "",
    originalSizeBytes: source.sizeBytes ?? null,
    sizeBytes: source.sizeBytes ?? converted.buffer.byteLength,
    previewBytes: converted.buffer.byteLength,
    convertedPreviewKind: "pdf",
    convertedFromExtension: converted.ext,
    base64: converted.buffer.toString("base64")
};
}

async function maybeConvertLegacyOfficePreview(source) {
  const ext = legacyOfficePreviewExtension(source.name, source.sourcePath || source.url, source.mime);
  if (!ext) return null;
  if (await shouldUseRendererLegacyOfficeFallback(source, ext)) return null;

  const sourceSize = Number.isFinite(source.sizeBytes) ? source.sizeBytes : source.buffer?.byteLength ?? 0;
  const contentHash = source.buffer ? crypto.createHash("sha256").update(source.buffer).digest("hex") : "";
  const cacheKey = crypto
    .createHash("sha256")
    .update([source.sourcePath || source.url || source.name || "", ext, String(sourceSize), String(source.mtimeMs || ""), contentHash].join("\0"))
    .digest("hex");
  const cacheDir = path.join(app.getPath("userData"), LEGACY_OFFICE_PREVIEW_CACHE_DIR_NAME);
  const cachePath = path.join(cacheDir, `${cacheKey}.pdf`);
  const cached = await readCachedLegacyOfficePdf(cachePath);
  if (cached) return { buffer: cached, ext, cachePath };

  const existing = legacyOfficePreviewConversions.get(cacheKey);
  if (existing) return existing;

  const conversion = convertLegacyOfficePreviewToPdf({
    ...source,
    ext,
    cachePath
}).finally(() => {
    legacyOfficePreviewConversions.delete(cacheKey);
  });
  legacyOfficePreviewConversions.set(cacheKey, conversion);
  return conversion;
}

function legacyOfficePreviewExtension(name, reference, mime) {
  const values = [name, reference]
    .map((value) => path.extname(String(value || "").split(/[?#]/)[0]).toLowerCase())
    .filter(Boolean);
  for (const ext of values) {
    if (LEGACY_OFFICE_PREVIEW_EXTENSIONS.has(ext)) return ext;
  }
  const lowerMime = String(mime || "").toLowerCase();
  if (lowerMime === "application/msword") return ".doc";
  if (lowerMime === "application/vnd.ms-excel") return ".xls";
  if (lowerMime === "application/vnd.ms-powerpoint") return ".ppt";
  return "";
}

async function shouldUseRendererLegacyOfficeFallback(source, ext) {
  const head = await legacyOfficePreviewHeadBuffer(source);
  const text = head.toString("utf8").trimStart();
  if (ext === ".xls" && /^(?:<\?xml|<Workbook\b|<html\b|<table\b)/i.test(text)) return true;
  if (ext === ".doc" && /^(?:\{\\rtf|<\?xml|<html\b)/i.test(text)) return true;
  return false;
}

async function legacyOfficePreviewHeadBuffer(source) {
  if (source.buffer?.length) return source.buffer.subarray(0, 512);
  if (!source.sourcePath) return Buffer.alloc(0);
  try {
    return await readFileHead(source.sourcePath, Math.min(Number(source.sizeBytes) || 512, 512));
  } catch {
    return Buffer.alloc(0);
  }
}

async function readCachedLegacyOfficePdf(cachePath) {
  try {
    const stats = await fs.promises.stat(cachePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > PREVIEW_FILE_LIMIT_BYTES) return null;
    return await fs.promises.readFile(cachePath);
  } catch {
    return null;
  }
}

async function convertLegacyOfficePreviewToPdf(source) {
  const inputTempDir = source.sourcePath ? "" : await fs.promises.mkdtemp(path.join(os.tmpdir(), "velune-office-input-"));
  const inputPath =
    source.sourcePath ||
    path.join(inputTempDir, `${safeLegacyOfficePreviewStem(source.name || source.url || "preview")}${source.ext}`);
  if (!source.sourcePath) {
    if (!source.buffer?.length) throw new Error("旧版 Office 文件内容为空，无法生成预览");
    await fs.promises.writeFile(inputPath, source.buffer);
  }

  const outputTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "velune-office-pdf-"));
  try {
    const pdfPath = await convertOfficeFileToPdf(inputPath, source.ext, outputTempDir);
    const pdfBuffer = await fs.promises.readFile(pdfPath);
    if (!pdfBuffer.length) throw new Error("转换后的 PDF 为空，无法预览");
    if (pdfBuffer.byteLength > PREVIEW_FILE_LIMIT_BYTES) {
      throw new Error("转换后的 PDF 过大，暂不支持直接预览");
    }
    await fs.promises.mkdir(path.dirname(source.cachePath), { recursive: true });
    await fs.promises.writeFile(source.cachePath, pdfBuffer);
    return { buffer: pdfBuffer, ext: source.ext, cachePath: source.cachePath };
  } finally {
    await removeDirQuietly(outputTempDir);
    if (inputTempDir) await removeDirQuietly(inputTempDir);
  }
}

function safeLegacyOfficePreviewStem(value) {
  const parsed = path.parse(String(value || "preview").split(/[?#]/)[0]);
  const base = (parsed.name || parsed.base || "preview")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 80);
  return base || "preview";
}

async function convertOfficeFileToPdf(inputPath, ext, outputDir) {
  const errors = [];
  const soffice = findSofficeExecutable();
  if (soffice) {
    try {
      return await convertWithLibreOffice(inputPath, outputDir, soffice);
    } catch (error) {
      errors.push(`LibreOffice：${errorMessageText(error)}`);
    }
  } else {
    errors.push("未找到 LibreOffice");
  }

  if (process.platform === "win32") {
    try {
      return await convertWithMicrosoftOffice(inputPath, ext, outputDir);
    } catch (error) {
      errors.push(`Microsoft Office：${errorMessageText(error)}`);
    }
  } else {
    errors.push("当前系统不支持 Microsoft Office COM 转换");
  }

  throw new Error(`旧版 ${ext} 文件需要转换成 PDF 后预览，但转换失败：${errors.join("；")}`);
}

function findSofficeExecutable() {
  if (cachedSofficeExecutablePath !== undefined) return cachedSofficeExecutablePath;
  const candidates = [
    process.env.SOFFICE_PATH,
    process.env.LIBREOFFICE_PATH,
    "soffice",
    "soffice.exe",
    "libreoffice",
    "libreoffice.exe",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "LibreOffice", "program", "soffice.exe") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "LibreOffice", "program", "soffice.exe") : "",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const hasPathSeparator = /[\\/]/.test(candidate);
      if (hasPathSeparator && !fs.existsSync(candidate)) continue;
      const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (!result.error && result.status === 0) {
        cachedSofficeExecutablePath = candidate;
        return cachedSofficeExecutablePath;
      }
    } catch {}
  }
  cachedSofficeExecutablePath = null;
  return cachedSofficeExecutablePath;
}

async function convertWithLibreOffice(inputPath, outputDir, soffice) {
  const profileDir = await fs.promises.mkdtemp(path.join(outputDir, "lo-profile-"));
  const args = [
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--nolockcheck",
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--convert-to",
    "pdf",
    "--outdir",
    outputDir,
    inputPath,
  ];
  const result = await runProcessCapture(soffice, args, LEGACY_OFFICE_PREVIEW_CONVERT_TIMEOUT_MS);
  const pdfPath = await newestPdfFileInDir(outputDir);
  if (!pdfPath) {
    throw new Error((result.stderr || result.stdout || "PDF 未生成").trim());
  }
  return pdfPath;
}

async function convertWithMicrosoftOffice(inputPath, ext, outputDir) {
  const outputPath = path.join(outputDir, `${safeLegacyOfficePreviewStem(inputPath)}.pdf`);
  const script = microsoftOfficePdfScript(inputPath, outputPath, ext);
  await runProcessCapture(
    powershellExecutablePath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", script],
    LEGACY_OFFICE_PREVIEW_CONVERT_TIMEOUT_MS,
  );
  const stats = await fs.promises.stat(outputPath);
  if (!stats.isFile() || stats.size <= 0) throw new Error("PDF 未生成");
  return outputPath;
}

function microsoftOfficePdfScript(inputPath, outputPath, ext) {
  return `
$ErrorActionPreference = 'Stop'
$inputPath = ${psQuote(inputPath)}
$outputPath = ${psQuote(outputPath)}
$ext = ${psQuote(ext)}
function Release-ComObject($value) {
  if ($null -ne $value) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($value) } catch {}
  }
}
if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
switch ($ext) {
  '.doc' {
    $app = $null
    $doc = $null
    try {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $doc = $app.Documents.Open($inputPath, $false, $true)
      $doc.ExportAsFixedFormat($outputPath, 17)
    } finally {
      if ($null -ne $doc) { try { $doc.Close($false) } catch {}; Release-ComObject $doc }
      if ($null -ne $app) { try { $app.Quit() } catch {}; Release-ComObject $app }
    }
  }
  '.xls' {
    $app = $null
    $workbook = $null
    try {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $app.AskToUpdateLinks = $false
      $workbook = $app.Workbooks.Open($inputPath, 0, $true)
      $workbook.ExportAsFixedFormat(0, $outputPath)
    } finally {
      if ($null -ne $workbook) { try { $workbook.Close($false) } catch {}; Release-ComObject $workbook }
      if ($null -ne $app) { try { $app.Quit() } catch {}; Release-ComObject $app }
    }
  }
  '.ppt' {
    $app = $null
    $presentation = $null
    try {
      $app = New-Object -ComObject PowerPoint.Application
      $presentation = $app.Presentations.Open($inputPath, $true, $false, $false)
      $presentation.SaveAs($outputPath, 32)
    } finally {
      if ($null -ne $presentation) { try { $presentation.Close() } catch {}; Release-ComObject $presentation }
      if ($null -ne $app) { try { $app.Quit() } catch {}; Release-ComObject $app }
    }
  }
  default { throw "Unsupported legacy Office extension: $ext" }
}
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
if (!(Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw 'PDF output was not created.' }
`;
}

function runProcessCapture(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { windowsHide: true });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`转换超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const result = { stdout, stderr, code };
      if (code === 0) {
        finish(null, result);
        return;
      }
      finish(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

async function newestPdfFileInDir(dirPath) {
  const entries = await fs.promises.readdir(dirPath);
  const pdfs = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".pdf")) continue;
    const filePath = path.join(dirPath, entry);
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.isFile() && stats.size > 0) pdfs.push({ filePath, mtimeMs: stats.mtimeMs });
    } catch {}
  }
  pdfs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pdfs[0]?.filePath || null;
}

function fileNameFromPreviewUrl(url) {
  try {
    const parsed = new URL(url);
    const name = path.basename(decodeURIComponent(parsed.pathname || ""));
    return name || "";
  } catch {
    return path.basename(String(url || "").split(/[?#]/)[0]) || "";
  }
}

function errorMessageText(error) {
  return error?.message || String(error || "未知错误");
}

async function removeDirQuietly(dirPath) {
  if (!dirPath) return;
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch {}
}

async function readFileHead(filePath, byteLength) {
  if (byteLength <= 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteLength);
    const result = await handle.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function isTextLocalPreviewExtension(ext) {
  return [
    ".md",
    ".txt",
    ".csv",
    ".json",
    ".xml",
    ".log",
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".less",
    ".yml",
    ".yaml",
    ".sql",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".sh",
    ".bat",
    ".ps1",
  ].includes(ext);
}

function isSupportedLocalPreviewExtension(ext) {
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".webp",
    ".svg",
    ".pdf",
    ".doc",
    ".docx",
    ".rtf",
    ".wps",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".html",
    ".htm",
    ".md",
    ".txt",
    ".csv",
    ".json",
    ".xml",
    ".log",
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".less",
    ".yml",
    ".yaml",
    ".sql",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".sh",
    ".bat",
    ".ps1",
    ".mp4",
    ".webm",
    ".ogg",
    ".mov",
    ".m4v",
  ].includes(ext);
}

async function localFileInfo(params = {}) {
  const resolution = await resolveLocalPathForAction(params, "file");
  const { path: filePath, stats } = resolution;
  return {
    path: filePath,
    name: path.basename(filePath),
    mime: mimeFromFilePath(filePath),
    size: stats.size,
    recovered: resolution.recovered,
    recoveryStrategy: resolution.strategy
};
}

async function localPathInfo(params = {}) {
  const resolution = await resolveLocalPathForAction(params, "any");
  const { path: filePath, stats } = resolution;
  const isFile = stats.isFile();
  const isDirectory = stats.isDirectory();
  return {
    path: filePath,
    name: path.basename(filePath) || filePath,
    mime: isFile ? mimeFromFilePath(filePath) : "inode/directory",
    size: isFile ? stats.size : 0,
    isFile,
    isDirectory,
    recovered: resolution.recovered,
    recoveryStrategy: resolution.strategy
};
}

async function revealLocalFile(params = {}) {
  const resolution = await resolveLocalPathForAction(params, "any");
  const { path: filePath, stats } = resolution;
  if (stats.isDirectory()) {
    const openError = await shell.openPath(filePath);
    if (openError) {
      throw new Error(openError);
    }
    return { ok: true, path: filePath, recovered: resolution.recovered };
  }
  if (!stats.isFile()) {
    throw new Error("本地路径不是文件");
  }
  shell.showItemInFolder(filePath);
  return { ok: true, path: filePath, recovered: resolution.recovered };
}

async function openLocalFile(params = {}) {
  const resolution = await resolveLocalPathForAction(params, "file");
  const filePath = resolution.path;
  const openError = await shell.openPath(filePath);
  if (openError) {
    throw new Error(openError);
  }
  return { ok: true, path: filePath, recovered: resolution.recovered };
}

async function readLocalFile(params = {}) {
  const resolution = await resolveLocalPathForAction(params, "file");
  const { path: filePath, stats } = resolution;
  if (stats.size > PREVIEW_FILE_LIMIT_BYTES) {
    throw new Error("文件过大，暂不支持自动上传");
  }
  const buffer = await fs.promises.readFile(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    mime: mimeFromFilePath(filePath),
    size: stats.size,
    fileKey: localFileIdentityKey(filePath, stats),
    base64: buffer.toString("base64"),
    recovered: resolution.recovered
};
}

async function resolveLocalPathForAction(params = {}, expectedType = "file") {
  const requestedPath = localPreviewPath(String(params.path || params.url || ""));
  return resolveExistingLocalPath(requestedPath, {
    expectedType,
    cwd: params.cwd || currentSkillsCwd || desktopWorkspace(),
    managedWorkspacesRoot: threadGroupsRootPath()
});
}

function localFileIdentityKey(filePath, stats = null) {
  if (!filePath) return "";
  let localPath = "";
  try {
    localPath = localPreviewPath(filePath);
  } catch {
    localPath = String(filePath || "").trim();
  }
  try {
    const realPath = fs.realpathSync.native(localPath);
    return `path:${normalizeLocalFileIdentityPath(realPath)}`;
  } catch {
    try {
      return `path:${normalizeLocalFileIdentityPath(localPath)}`;
    } catch {
      const statKey = fileStatIdentityKey(stats) || fileStatIdentityKeyForPath(localPath);
      return statKey || String(filePath).trim();
    }
  }
}

function fileStatIdentityKeyForPath(filePath) {
  try {
    return fileStatIdentityKey(fs.statSync(filePath));
  } catch {
    return "";
  }
}

function fileStatIdentityKey(stats) {
  const dev = stats?.dev;
  const ino = stats?.ino;
  if (dev === undefined || ino === undefined || String(ino) === "0") return "";
  return `stat:${String(dev)}:${String(ino)}`;
}

function normalizeLocalFileIdentityPath(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isLocalPreviewPath(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || "")) && !/^file:\/\//i.test(String(value || ""))) return false;
  const normalized = normalizeLocalPreviewPath(value);
  return (
    (/^file:\/\//i.test(normalized) && isAbsoluteFilePreviewUrl(normalized)) ||
    /^[a-z]:[\\/]/i.test(normalized) ||
    /^\\\\/.test(normalized) ||
    normalized.startsWith("/")
  );
}

function localPreviewPath(value) {
  const normalized = stripWindowsSourceLocationSuffix(stripWindowsLocalFileDescriptionSuffix(normalizeLocalPreviewPath(value)));
  if (/^file:\/\//i.test(normalized)) {
    if (!isAbsoluteFilePreviewUrl(normalized)) {
      throw new Error("Local file preview URL must be absolute.");
    }
    return normalizeLocalPreviewPath(fileURLToPath(normalized));
  }
  return path.resolve(normalized.replace(/^\/([a-z]:[\\/])/i, "$1"));
}

function isAbsoluteFilePreviewUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") return false;
    if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") {
      return Boolean(parsed.pathname && parsed.pathname !== "/");
    }
    return Boolean(parsed.pathname && parsed.pathname.startsWith("/"));
  } catch {
    return false;
  }
}

function normalizeLocalPreviewPath(value) {
  let text = String(value || "").trim().replace(/^["'`<]+|["'`>]+$/g, "");
  const slashText = text.replace(/\\/g, "/");
  const fileUrlIndex = slashText.toLowerCase().lastIndexOf("file:///");
  if (fileUrlIndex > 0) {
    text = slashText.slice(fileUrlIndex);
  } else if (!/^file:\/\//i.test(slashText)) {
    const driveMatches = [...slashText.matchAll(/[a-z]:\//gi)];
    const lastDrive = driveMatches.at(-1);
    if (lastDrive?.index != null && lastDrive.index > 0) {
      text = slashText.slice(lastDrive.index).replace(/\//g, path.sep);
    }
  }
  return text.replace(/^\/([a-z]:[\\/])/i, "$1");
}

function mimeFromImagePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}

function mimeFromFilePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"].includes(ext)) return mimeFromImagePath(filePath);
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx" || ext === ".wps") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".rtf") return "application/rtf";
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".ppt") return "application/vnd.ms-powerpoint";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".csv") return "text/csv";
  if (ext === ".json") return "application/json";
  if (ext === ".xml") return "application/xml";
  if ([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".less", ".yml", ".yaml", ".sql", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".sh", ".bat", ".ps1"].includes(ext)) {
    return "text/plain";
  }
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".ogg") return "video/ogg";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".zip" || ext === ".rar" || ext === ".7z") return "application/zip";
  return "application/octet-stream";
}

function clearScheduledWork() {
  if (appWindowRestoreTimer) {
    clearTimeout(appWindowRestoreTimer);
    appWindowRestoreTimer = null;
  }
  if (desktopNotificationTimer) {
    clearTimeout(desktopNotificationTimer);
    desktopNotificationTimer = null;
  }
}

async function withShutdownTimeout(label, promise) {
  let timer = null;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[shutdown] timed out while stopping ${label}`);
          resolve();
        }, SHUTDOWN_STEP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupAndExit(exitCode = 0) {
  if (appCleanupStarted) return;
  appCleanupStarted = true;
  appShuttingDown = true;
  clearScheduledWork();
  closeDesktopNotificationWindow();
  if (appTray) {
    appTray.destroy();
    appTray = null;
  }

  for (const record of binanceMarketRendererSubscriptions.values()) {
    record.sender?.removeListener?.("destroyed", record.cleanup);
    try { await record.dispose?.(); } catch {}
  }
  binanceMarketRendererSubscriptions.clear();
  if (tradingMarketDataHub) {
    try {
      await withShutdownTimeout("trading market data hub", tradingMarketDataHub.close());
    } catch (error) {
      console.warn("[trading-market-data] failed to stop", error?.message || error);
    } finally {
      tradingMarketDataHub = null;
    }
  }
  if (binanceNetworkRouter) {
    binanceNetworkRouter.close();
    binanceNetworkRouter = null;
  }
  if (binanceRoutePreferenceStore) {
    try {
      binanceRoutePreferenceStore.close();
    } catch (error) {
      console.warn("[binance-route] failed to persist route preference", error?.message || error);
    } finally {
      binanceRoutePreferenceStore = null;
    }
  }
  if (binancePrivateProxyTransport) {
    try {
      await withShutdownTimeout("Binance private proxy transport", binancePrivateProxyTransport.close());
    } catch (error) {
      console.warn("[binance-private-proxy] failed to stop", error?.message || error);
    } finally {
      binancePrivateProxyTransport = null;
    }
  }
  if (binanceGatewayNetworkFetch) {
    binanceGatewayNetworkFetch.close?.();
    binanceGatewayNetworkFetch = null;
  }

  app.exit(exitCode);
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  createWindow();
  createAppTray();
  void repairPackagedWindowsShortcuts();
  void refreshWindowIcon();
  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      void refreshWindowIcon();
    }
  });
});

async function refreshWindowIcon() {
  const icon = await createWindowIcon();
  if (!icon) return;
  windowIcon = icon;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(icon);
  }
  if (appTray) updateAppTrayIcon(icon);
  else createAppTray();
}

app.on("window-all-closed", () => {
  if (appShuttingDown || appCleanupStarted) return;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (appCleanupStarted) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  void cleanupAndExit(0);
});

// ===== 兼容层：渲染层仍在调用、主进程已移除实现的通道（安全空实现，不抛错） =====
const STUB_OK = { ok: true, local: true, items: [], data: [], list: [], total: 0 };
const STUB_CHANNELS = [
  "velune:reportConsumptionAppEntry",
  "velune:reportConsumptionEvent",
  "externalModels:current",
  "externalModels:changed",
  "tradingStrategy:list",
  "velune:getDefaults",
  "velune:start"
];
for (const channel of STUB_CHANNELS) {
  if (ipcMain.listenerCount(channel)) continue;
  ipcMain.handle(channel, async () => ({ ...STUB_OK }));
}
