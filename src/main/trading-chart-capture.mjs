import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeTradingChartCaptureRect(window, value) {
  const { x, y, width, height } = value || {};
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  // Renderer bounds use CSS pixels; capturePage expects device-independent pixels.
  // The display scale factor is handled by Electron, only page zoom belongs here.
  const zoom = window.webContents.getZoomFactor();
  const [contentWidth, contentHeight] = window.getContentSize();
  const left = Math.max(0, Math.floor(x * zoom));
  const top = Math.max(0, Math.floor(y * zoom));
  const right = Math.min(contentWidth, Math.ceil((x + width) * zoom));
  const bottom = Math.min(contentHeight, Math.ceil((y + height) * zoom));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function captureTradingChart(window, params, { app, clipboard }) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return { ok: false, message: '交易图表窗口不可用' };
  }
  const rect = normalizeTradingChartCaptureRect(window, params?.rect);
  if (!rect) return { ok: false, message: '交易图表截图区域无效' };
  const image = await window.webContents.capturePage(rect);
  if (!image || image.isEmpty()) return { ok: false, message: '交易图表截图为空' };
  const buffer = image.toPNG();
  const desktop = params?.destination === 'desktop';
  const directory = desktop ? app.getPath('desktop') : path.join(app.getPath('temp'), 'velune-trading-captures');
  await fs.mkdir(directory, { recursive: true });
  const name = `velune-kline-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, buffer, { flag: 'wx' });
  const result = {
    ok: true, path: filePath, name, mime: 'image/png', size: buffer.length,
    width: image.getSize().width, height: image.getSize().height,
  };
  if (desktop) {
    try {
      clipboard.writeImage(image);
      return { ...result, copied: true };
    } catch {
      return { ...result, copied: false, message: '截图已经保存在桌面，但复制到剪贴板失败，请重试' };
    }
  }
  return result;
}
