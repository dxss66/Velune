import { app } from "electron/main";
import fs from "node:fs";
import path from "node:path";

const APP_PREFERENCES_FILE_NAME = "app-preferences.json";
const DEFAULT_APP_PREFERENCES = Object.freeze({
  theme: "light",
  language: "zh-CN"
});

/**
 * Local app preferences (theme, language) and the UI copy table.
 * Values live in app-preferences.json under Electron's userData directory.
 */
export function createAppPreferences() {
  let cache = null;

  function appPreferencesPath() {
    return path.join(app.getPath("userData"), APP_PREFERENCES_FILE_NAME);
  }

  function readJsonFileSafe(filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function normalizeAppTheme(value) {
    return value === "light" ? "light" : "dark";
  }

  function normalizeAppLanguage(value) {
    return value === "en" || value === "zh-TW" ? value : "zh-CN";
  }

  function normalizeAppPreferences(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      ...DEFAULT_APP_PREFERENCES,
      theme: source.theme === undefined ? DEFAULT_APP_PREFERENCES.theme : normalizeAppTheme(source.theme),
      language: normalizeAppLanguage(source.language)
  };
  }

  function appPreferences() {
    if (cache) return cache;
    cache = normalizeAppPreferences(readJsonFileSafe(appPreferencesPath()));
    return cache;
  }

  function appLanguage() {
    return normalizeAppLanguage(appPreferences().language);
  }

  const MAIN_UI_COPY = Object.freeze({
    en: Object.freeze({
      settings: "Settings",
      close: "Close",
      taskCompleteTitle: "Task complete",
      taskCompleteBody: "The task completed successfully. You can view the result in the app.",
      planStatusUpdated: "Plan status updated",
      executionPlan: "Execution plan",
      currentStatus: "Current status",
      alertTriggered: "Alert triggered",
      tradingCondition: "Trading condition",
      triggeredAt: "Triggered at",
      saveImage: "Save image",
      imageSaved: "Image saved",
      saveFailed: "Save failed",
      actionFailed: "Action failed",
      diagnosticsFilter: "JSON diagnostics",
      selectGroupFolder: "Select project folder",
      filesAndFolders: "Files and folders",
      selectImportContent: "Select content to import",
      fileFolderImportDetail: "You can select multiple files; folders are imported in full.",
      selectFiles: "Select files",
      selectFolder: "Select folder",
      cancel: "Cancel",
      selectFile: "Select file",
      selectFileOrFolder: "Select file or folder",
      exportUsageData: "Export usage data",
      excelWorkbook: "Excel workbook",
      usageDataFilePrefix: "Velune-usage-data",
      points: "Points",
      emptyUsageExport: "Usage export failed: the server returned an empty file",
      selectChromeUploadFile: "Select a file for Chrome to upload",
      copy: "Copy"
  }),
    "zh-CN": Object.freeze({
      settings: "设置",
      close: "关闭",
      taskCompleteTitle: "任务已完成",
      taskCompleteBody: "任务已成功完成。您可以在应用中查看结果。",
      planStatusUpdated: "计划状态已更新",
      executionPlan: "执行计划",
      currentStatus: "当前状态",
      alertTriggered: "预警已触发",
      tradingCondition: "交易条件",
      triggeredAt: "触发时间",
      saveImage: "保存图片",
      imageSaved: "已保存图片",
      saveFailed: "保存失败",
      actionFailed: "操作失败",
      diagnosticsFilter: "JSON 诊断报告",
      selectGroupFolder: "选择分组文件夹",
      filesAndFolders: "文件和文件夹",
      selectImportContent: "请选择要导入的内容",
      fileFolderImportDetail: "文件支持多选；文件夹将作为整个目录导入。",
      selectFiles: "选择文件",
      selectFolder: "选择文件夹",
      cancel: "取消",
      selectFile: "选择文件",
      selectFileOrFolder: "选择文件或文件夹",
      exportUsageData: "导出使用数据",
      excelWorkbook: "Excel 工作簿",
      usageDataFilePrefix: "Velune使用数据",
      points: "积分",
      emptyUsageExport: "消费明细导出失败：后端返回了空文件",
      selectChromeUploadFile: "选择要交给 Chrome 上传的文件",
      copy: "复制"
  }),
    "zh-TW": Object.freeze({
      settings: "設定",
      close: "關閉",
      taskCompleteTitle: "任務已完成",
      taskCompleteBody: "任務已成功完成。您可以在應用程式中查看結果。",
      planStatusUpdated: "計畫狀態已更新",
      executionPlan: "執行計畫",
      currentStatus: "目前狀態",
      alertTriggered: "預警已觸發",
      tradingCondition: "交易條件",
      triggeredAt: "觸發時間",
      saveImage: "儲存圖片",
      imageSaved: "已儲存圖片",
      saveFailed: "儲存失敗",
      actionFailed: "操作失敗",
      diagnosticsFilter: "JSON 診斷報告",
      selectGroupFolder: "選擇分組資料夾",
      filesAndFolders: "檔案和資料夾",
      selectImportContent: "請選擇要匯入的內容",
      fileFolderImportDetail: "檔案支援多選；資料夾將作為整個目錄匯入。",
      selectFiles: "選擇檔案",
      selectFolder: "選擇資料夾",
      cancel: "取消",
      selectFile: "選擇檔案",
      selectFileOrFolder: "選擇檔案或資料夾",
      exportUsageData: "匯出使用資料",
      excelWorkbook: "Excel 活頁簿",
      usageDataFilePrefix: "Velune使用資料",
      points: "點數",
      emptyUsageExport: "使用明細匯出失敗：伺服器傳回空白檔案",
      selectChromeUploadFile: "選擇要交給 Chrome 上傳的檔案",
      copy: "複製"
  })
  });

  function mainUiText(key, language = appLanguage()) {
    const normalized = normalizeAppLanguage(language);
    return MAIN_UI_COPY[normalized]?.[key] || MAIN_UI_COPY.en[key] || key;
  }

  function appLanguageLocale(language = appLanguage()) {
    const normalized = normalizeAppLanguage(language);
    return normalized === "en" ? "en-US" : normalized;
  }

  async function writeAppPreferences(nextPreferences) {
    const normalized = normalizeAppPreferences(nextPreferences);
    const destination = appPreferencesPath();
    const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.promises.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await fs.promises.rename(tempPath, destination);
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw error;
    }
    cache = normalized;
    return normalized;
  }

  async function setAppTheme(theme) {
    const preferences = await writeAppPreferences({
      ...appPreferences(),
      theme: normalizeAppTheme(theme)
  });
    return preferences;
  }

  async function setAppLanguage(language) {
    return writeAppPreferences({
      ...appPreferences(),
      language: normalizeAppLanguage(language)
  });
  }

  return {
    appPreferences,
    appLanguage,
    mainUiText,
    appLanguageLocale,
    normalizeAppLanguage,
    setAppTheme,
    setAppLanguage,
  };
}
