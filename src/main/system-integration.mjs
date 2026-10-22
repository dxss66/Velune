import { app, shell } from "electron/main";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windows shell integration: start-menu / desktop shortcuts, taskbar pinning
 * and launch-at-login. Extracted from main.mjs; everything here works on OS
 * paths and shortcuts only, never on renderer state.
 */
export function createSystemIntegration({ appId, displayName, shellIconPath }) {
  function shortcutBaseName() {
    return String(displayName || app.getName() || "velune_desktop")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .trim() || "velune_desktop";
  }

  function legacyShortcutBaseName() {
    return String.fromCodePoint(0x597d, 0x54af);
  }

  function roamingAppDataPath() {
    return process.env.APPDATA || app.getPath("appData");
  }

  function systemDriveRootPath() {
    const drive = String(process.env.SystemDrive || "").trim();
    if (/^[A-Za-z]:$/.test(drive)) return `${drive}\\`;
    const root = path.parse(process.env.SystemRoot || "C:\\Windows").root;
    return root || "C:\\";
  }

  function commonAppDataPath() {
    return process.env.ProgramData || path.join(systemDriveRootPath(), "ProgramData");
  }

  function publicUserPath() {
    return process.env.PUBLIC || path.join(systemDriveRootPath(), "Users", "Public");
  }

  function powershellExecutablePath() {
    if (process.env.SystemRoot) {
      return path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    }
    return "powershell.exe";
  }

  function systemIntegrationShortcutPath(key, baseName = shortcutBaseName()) {
    const fileName = `${baseName}.lnk`;
    if (key === "taskbar") {
      return path.join(roamingAppDataPath(), "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", fileName);
    }
    if (key === "startMenu") {
      return path.join(roamingAppDataPath(), "Microsoft", "Windows", "Start Menu", "Programs", fileName);
    }
    if (key === "desktop") {
      return path.join(app.getPath("desktop"), fileName);
    }
    return null;
  }

  function packagedWindowsShortcutPaths(baseName = shortcutBaseName()) {
    const fileName = `${baseName}.lnk`;
    return uniqueSystemIntegrationPaths([
      systemIntegrationShortcutPath("startMenu", baseName),
      systemIntegrationShortcutPath("desktop", baseName),
      path.join(commonAppDataPath(), "Microsoft", "Windows", "Start Menu", "Programs", fileName),
      path.join(publicUserPath(), "Desktop", fileName),
    ]);
  }

  function systemIntegrationSourceShortcutPath() {
    return path.join(app.getPath("userData"), "shortcuts", `${shortcutBaseName()}.lnk`);
  }

  function appExecutablePath() {
    try {
      return app.getPath("exe") || process.execPath;
    } catch {
      return process.execPath;
    }
  }

  function appLaunchArgs() {
    return app.isPackaged ? [] : [app.getAppPath()];
  }

  function shortcutDetails() {
    const target = appExecutablePath();
    return {
      target,
      cwd: path.dirname(target),
      args: appLaunchArgs().join(" "),
      description: displayName,
      icon: shellIconPath || target,
      iconIndex: 0,
      appUserModelId: appId
  };
  }

  async function writeAppShortcut(shortcutPath) {
    await fs.promises.mkdir(path.dirname(shortcutPath), { recursive: true });
    const operation = (await shortcutExists(shortcutPath)) ? "replace" : "create";
    const ok = shell.writeShortcutLink(shortcutPath, operation, shortcutDetails());
    if (!ok) {
      throw new Error("创建快捷方式失败");
    }
    return shortcutPath;
  }

  async function repairAppShortcut(shortcutPath) {
    if (!shortcutPath || !(await shortcutExists(shortcutPath))) return null;
    let needsRepair = true;
    try {
      needsRepair = shortcutNeedsRepair(shell.readShortcutLink(shortcutPath));
    } catch {
      needsRepair = true;
    }
    if (!needsRepair) return shortcutPath;
    return writeAppShortcut(shortcutPath);
  }

  async function migrateLegacyPackagedWindowsShortcuts() {
    const currentPaths = packagedWindowsShortcutPaths();
    const legacyPaths = packagedWindowsShortcutPaths(legacyShortcutBaseName());
    const migrations = legacyPaths.map(async (legacyPath, index) => {
      if (!legacyPath || !(await shortcutExists(legacyPath))) return null;
      try {
        if (!shortcutDetailsMatchApp(shell.readShortcutLink(legacyPath))) return null;
      } catch {
        return null;
      }
      const currentPath = currentPaths[index];
      if (!currentPath) return null;
      await writeAppShortcut(currentPath);
      await fs.promises.rm(legacyPath, { force: true });
      await Promise.all([
        notifyWindowsShortcutChanged(legacyPath),
        notifyWindowsShortcutChanged(currentPath),
      ]);
      return currentPath;
    });
    return Promise.allSettled(migrations);
  }

  async function repairPackagedWindowsShortcuts() {
    if (process.platform !== "win32" || !app.isPackaged) return;
    const migrationResults = await migrateLegacyPackagedWindowsShortcuts();
    const repairs = [];
    repairs.push(...packagedWindowsShortcutPaths().map((shortcutPath) => repairAppShortcut(shortcutPath)));
    const taskbarShortcuts = await matchingTaskbarShortcutPaths();
    repairs.push(...taskbarShortcuts.map((shortcutPath) => repairAppShortcut(shortcutPath)));
    const results = [...migrationResults, ...(await Promise.allSettled(repairs))];
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[system-integration] failed to repair Windows shortcut", result.reason?.message || result.reason);
      }
    }
  }

  function uniqueSystemIntegrationPaths(paths) {
    const seen = new Set();
    const result = [];
    for (const candidate of paths) {
      if (!candidate) continue;
      const key = normalizeShortcutPath(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
    return result;
  }

  async function shortcutExists(shortcutPath) {
    if (!shortcutPath) return false;
    try {
      const stat = await fs.promises.stat(shortcutPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  function taskbarPinMarkerPath() {
    return path.join(app.getPath("userData"), "shortcuts", "taskbar-pin.json");
  }

  function normalizeShortcutPath(value) {
    return expandWindowsEnvironmentVariables(String(value || "")).replace(/\//g, "\\").toLowerCase();
  }

  function normalizeShortcutArgs(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function expandWindowsEnvironmentVariables(value) {
    if (process.platform !== "win32") return value;
    return value.replace(/%([^%]+)%/g, (match, name) => {
      const direct = process.env[name];
      if (direct !== undefined) return direct;
      const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
      return key ? process.env[key] : match;
    });
  }

  function shortcutDetailsLaunchesApp(details) {
    if (!details) return false;
    const expectedTarget = normalizeShortcutPath(appExecutablePath());
    const target = normalizeShortcutPath(details.target);
    if (!expectedTarget || !target || expectedTarget !== target) return false;
    const expectedArgs = normalizeShortcutArgs(appLaunchArgs().join(" "));
    if (!expectedArgs) return true;
    return normalizeShortcutArgs(details.args) === expectedArgs;
  }

  function shortcutDetailsMatchApp(details) {
    if (!details) return false;
    if (shortcutDetailsLaunchesApp(details)) return true;
    const appId = String(details.appUserModelId || "");
    return appId === appId;
  }

  function shortcutNeedsRepair(details) {
    if (!shortcutDetailsLaunchesApp(details)) return true;
    const appId = String(details.appUserModelId || "");
    if (appId !== appId) return true;
    const expectedIcon = normalizeShortcutPath(shellIconPath || appExecutablePath());
    const currentIcon = normalizeShortcutPath(details.icon || details.iconPath || "");
    return Boolean(expectedIcon && currentIcon && currentIcon !== expectedIcon);
  }

  async function matchingTaskbarShortcutPaths() {
    const taskbarPath = systemIntegrationShortcutPath("taskbar");
    if (!taskbarPath) return [];
    const taskbarDir = path.dirname(taskbarPath);
    let entries = [];
    try {
      entries = await fs.promises.readdir(taskbarDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".lnk") continue;
      const shortcutPath = path.join(taskbarDir, entry.name);
      try {
        if (shortcutDetailsMatchApp(shell.readShortcutLink(shortcutPath))) {
          matches.push(shortcutPath);
        }
      } catch {
        // Ignore third-party or malformed taskbar shortcuts.
      }
    }
    return matches;
  }

  async function removeMatchingTaskbarShortcuts() {
    const shortcuts = uniqueSystemIntegrationPaths([systemIntegrationShortcutPath("taskbar"), ...(await matchingTaskbarShortcutPaths())]);
    await Promise.all(shortcuts.map((shortcutPath) => fs.promises.rm(shortcutPath, { force: true })));
    await Promise.all(shortcuts.map((shortcutPath) => notifyWindowsShortcutChanged(shortcutPath)));
  }

  async function writeTaskbarPinMarker() {
    const markerPath = taskbarPinMarkerPath();
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.promises.writeFile(markerPath, JSON.stringify({ pinnedAt: new Date().toISOString() }), "utf8");
  }

  async function removeTaskbarPinMarker() {
    await fs.promises.rm(taskbarPinMarkerPath(), { force: true });
  }

  function shellShortcutChangeNotifyScript(shortcutPath) {
    return `
  $ErrorActionPreference = 'SilentlyContinue'
  $shortcutPath = ${psQuote(shortcutPath)}
  Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public static class VeluneShellNotify {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, string dwItem2);
  }
  "@
  [VeluneShellNotify]::SHChangeNotify(0x00002000, 0x0005, $shortcutPath, $null)
  [VeluneShellNotify]::SHChangeNotify(0x00001000, 0x0005, (Split-Path -LiteralPath $shortcutPath), $null)
  [VeluneShellNotify]::SHChangeNotify(0x08000000, 0x0000, $null, $null)
  $ie4uinit = Join-Path $env:SystemRoot 'System32\\ie4uinit.exe'
  if (Test-Path -LiteralPath $ie4uinit) {
    Start-Process -FilePath $ie4uinit -ArgumentList '-show' -WindowStyle Hidden | Out-Null
  }
  `;
  }

  async function notifyWindowsShortcutChanged(shortcutPath) {
    if (process.platform !== "win32" || !shortcutPath) return;
    try {
      await runPowerShell(shellShortcutChangeNotifyScript(shortcutPath), 3_000);
    } catch (error) {
      console.warn("[system-integration] failed to notify Windows shortcut change", error?.message || error);
    }
  }

  async function hasMatchingTaskbarShortcut() {
    return (await matchingTaskbarShortcutPaths()).length > 0;
  }

  async function writeTaskbarShortcutFallback() {
    const taskbarPath = systemIntegrationShortcutPath("taskbar");
    if (!taskbarPath) return false;
    await writeAppShortcut(taskbarPath);
    await notifyWindowsShortcutChanged(taskbarPath);
    return hasMatchingTaskbarShortcut();
  }

  async function taskbarPinCandidatePaths(options = {}) {
    if (process.platform !== "win32") return [];
    const paths = [];
    const startMenuPath = systemIntegrationShortcutPath("startMenu");
    if (startMenuPath) {
      if (options.ensureStartMenuShortcut) paths.push(await writeAppShortcut(startMenuPath));
      else if (await shortcutExists(startMenuPath)) paths.push(startMenuPath);
    }
    paths.push(await writeAppShortcut(systemIntegrationSourceShortcutPath()));
    const exePath = appExecutablePath();
    if (exePath && fs.existsSync(exePath)) paths.push(exePath);
    return uniqueSystemIntegrationPaths(paths);
  }

  function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function psArray(values) {
    return `@(${values.map((value) => psQuote(value)).join(", ")})`;
  }

  function runPowerShell(script, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const child = spawn(
        powershellExecutablePath(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true },
      );
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("系统设置执行超时"));
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code === 0) {
          finish(null, { stdout, stderr });
          return;
        }
        finish(new Error((stderr || stdout || `PowerShell exited with code ${code}`).trim()));
      });
    });
  }

  function systemIntegrationError(message, cause) {
    const error = new Error(message);
    if (cause) error.cause = cause;
    return error;
  }

  function shellVerbPatterns(action) {
    const patterns = {
      taskbarPin: ["taskbarpin", "pin to taskbar", "固定到任务栏", "固定到任务列", "固定到工作列"],
      taskbarUnpin: [
        "taskbarunpin",
        "unpin from taskbar",
        "从任务栏取消固定",
        "取消固定到任务栏",
        "从任务列取消固定",
        "取消固定到任务列",
        "从工作列取消固定",
        "取消固定到工作列",
      ]
  };
    return patterns[action] || [];
  }

  function shellVerbName(action) {
    const names = {
      taskbarPin: "taskbarpin",
      taskbarUnpin: "taskbarunpin"
  };
    return names[action] || "";
  }

  function shellVerbInvokeScript(itemPath, action) {
    return `
  $ErrorActionPreference = 'Stop'
  $itemPath = ${psQuote(itemPath)}
  $verbName = ${psQuote(shellVerbName(action))}
  $patterns = ${psArray(shellVerbPatterns(action))}
  $shell = New-Object -ComObject Shell.Application
  $folderPath = Split-Path -LiteralPath $itemPath
  $itemName = Split-Path -Leaf $itemPath
  $folder = $shell.Namespace($folderPath)
  if ($null -eq $folder) { throw "Shell folder not found: $folderPath" }
  $item = $folder.ParseName($itemName)
  if ($null -eq $item) { throw "Shell item not found: $itemName" }
  foreach ($verb in @($item.Verbs())) {
    $name = (($verb.Name -replace '&','') -replace '\\s+',' ').Trim()
    $flatName = ($name -replace '[^\\p{L}\\p{N}]','').ToLowerInvariant()
    foreach ($pattern in $patterns) {
      $flatPattern = ($pattern -replace '[^\\p{L}\\p{N}]','').ToLowerInvariant()
      if ($name -like "*$pattern*" -or ($flatPattern -and $flatName -like "*$flatPattern*")) {
        $verb.DoIt()
        Start-Sleep -Milliseconds 800
        exit 0
      }
    }
  }
  $item.InvokeVerb($verbName)
  Start-Sleep -Milliseconds 800
  `;
  }

  function shellPinStateScript(itemPath) {
    return `
  $ErrorActionPreference = 'Stop'
  $itemPath = ${psQuote(itemPath)}
  $pinPatterns = ${psArray(shellVerbPatterns("taskbarPin"))}
  $unpinPatterns = ${psArray(shellVerbPatterns("taskbarUnpin"))}
  $shell = New-Object -ComObject Shell.Application
  $folderPath = Split-Path -LiteralPath $itemPath
  $itemName = Split-Path -Leaf $itemPath
  $folder = $shell.Namespace($folderPath)
  if ($null -eq $folder) { throw "Shell folder not found: $folderPath" }
  $item = $folder.ParseName($itemName)
  if ($null -eq $item) { throw "Shell item not found: $itemName" }
  $state = "unknown"
  foreach ($verb in @($item.Verbs())) {
    $name = (($verb.Name -replace '&','') -replace '\\s+',' ').Trim()
    $flatName = ($name -replace '[^\\p{L}\\p{N}]','').ToLowerInvariant()
    foreach ($pattern in $unpinPatterns) {
      $flatPattern = ($pattern -replace '[^\\p{L}\\p{N}]','').ToLowerInvariant()
      if ($name -like "*$pattern*" -or $flatName -like "*$flatPattern*") {
        $state = "pinned"
        break
      }
    }
    if ($state -eq "pinned") { break }
    foreach ($pattern in $pinPatterns) {
      $flatPattern = ($pattern -replace '[^\\p{L}\\p{N}]','').ToLowerInvariant()
      if ($name -like "*$pattern*" -or $flatName -like "*$flatPattern*") {
        $state = "unpinned"
        break
      }
    }
  }
  Write-Output $state
  `;
  }

  async function readTaskbarPinState(shortcutPath) {
    try {
      const result = await runPowerShell(shellPinStateScript(shortcutPath), 8_000);
      const state = String(result.stdout || "").trim().split(/\r?\n/).pop();
      if (state === "pinned" || state === "unpinned") return state;
    } catch {
      return "unknown";
    }
    return "unknown";
  }

  async function taskbarIntegrationEnabled() {
    if (process.platform !== "win32") return false;
    if (await hasMatchingTaskbarShortcut()) {
      await writeTaskbarPinMarker();
      return true;
    }
    const candidates = await taskbarPinCandidatePaths();
    const states = await Promise.all(candidates.map((candidate) => readTaskbarPinState(candidate)));
    if (states.includes("pinned")) {
      await writeTaskbarPinMarker();
      return true;
    }
    if (states.includes("unpinned")) {
      await removeTaskbarPinMarker();
      return false;
    }
    if (await shortcutExists(taskbarPinMarkerPath())) {
      await removeTaskbarPinMarker();
    }
    return false;
  }

  async function waitForTaskbarIntegrationState(candidatePaths, enabled) {
    for (let index = 0; index < 8; index += 1) {
      const hasTaskbarShortcut = await hasMatchingTaskbarShortcut();
      if (enabled && hasTaskbarShortcut) return true;
      const states = await Promise.all(candidatePaths.map((candidate) => readTaskbarPinState(candidate)));
      if (enabled && states.includes("pinned")) return true;
      if (!enabled && !hasTaskbarShortcut && !states.includes("pinned")) return true;
      if (!enabled && states.includes("unpinned") && !states.includes("pinned")) return true;
      if (states.length && states.every((state) => state === "unknown")) break;
      await delay(350);
    }
    return false;
  }

  async function invokeTaskbarVerb(candidatePath, enabled) {
    const action = enabled ? "taskbarPin" : "taskbarUnpin";
    await runPowerShell(shellVerbInvokeScript(candidatePath, action), 10_000);
  }

  async function setTaskbarIntegration(enabled) {
    if (process.platform !== "win32") {
      throw new Error("当前系统不支持任务栏固定");
    }
    const candidates = await taskbarPinCandidatePaths({ ensureStartMenuShortcut: enabled });
    let lastError = null;
    try {
      for (const candidatePath of candidates) {
        try {
          await invokeTaskbarVerb(candidatePath, enabled);
          const changed = await waitForTaskbarIntegrationState(candidates, enabled);
          if (changed) {
            if (enabled) await writeTaskbarPinMarker();
            else await removeTaskbarPinMarker();
            return;
          }
        } catch (error) {
          lastError = error;
        }
      }
    } finally {
      if (!enabled) {
        await removeMatchingTaskbarShortcuts();
        await removeTaskbarPinMarker();
      }
    }
    if (!enabled) return;
    if (await writeTaskbarShortcutFallback()) {
      await writeTaskbarPinMarker();
      return;
    }
    throw systemIntegrationError(
      enabled
        ? "Windows 未完成固定到任务栏，请在任务栏右键菜单里手动固定"
        : "Windows 未完成从任务栏取消固定，请在任务栏右键菜单里手动取消",
      lastError,
    );
  }

  function startupIntegrationEnabled() {
    try {
      const settings = app.getLoginItemSettings({
        path: appExecutablePath(),
        args: appLaunchArgs()
  });
      return Boolean(settings.openAtLogin);
    } catch {
      return false;
    }
  }

  async function systemIntegrationState() {
    const startMenuPath = systemIntegrationShortcutPath("startMenu");
    return {
      taskbar: await taskbarIntegrationEnabled(),
      startMenu: process.platform === "win32" ? await shortcutExists(startMenuPath) : false,
      startup: startupIntegrationEnabled(),
      available: {
        taskbar: process.platform === "win32",
        startMenu: process.platform === "win32",
        startup: true
  }
  };
  }

  async function setShortcutIntegration(key, enabled) {
    if (process.platform !== "win32") {
      throw new Error("当前系统不支持此快捷方式设置");
    }
    if (key === "taskbar") {
      await setTaskbarIntegration(enabled);
      return;
    }
    const shortcutPath = systemIntegrationShortcutPath(key);
    if (!shortcutPath) {
      throw new Error("未知快捷方式类型");
    }
    if (!enabled) {
      await fs.promises.rm(shortcutPath, { force: true });
      return;
    }
    await writeAppShortcut(shortcutPath);
  }

  function setStartupIntegration(enabled) {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: appExecutablePath(),
      args: appLaunchArgs()
  });
  }

  async function setSystemIntegration(params = {}) {
    const key = String(params.key || "");
    const enabled = Boolean(params.enabled);
    if (key === "taskbar" || key === "startMenu") {
      await setShortcutIntegration(key, enabled);
    } else if (key === "startup") {
      setStartupIntegration(enabled);
    } else {
      throw new Error("未知系统设置项");
    }
    return systemIntegrationState();
  }

  return {
    systemIntegrationState,
    setSystemIntegration,
    repairPackagedWindowsShortcuts,
    psQuote,
    powershellExecutablePath,
  };
}
