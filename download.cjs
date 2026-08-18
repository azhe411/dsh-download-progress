// download.cjs - 带实时进度的下载工具 (v3)
// 用法: node download.cjs <url> <输出路径> [--mirror=<前缀>]
// 进度状态写入 ~/.dsh/downloads/tasks/<任务名>.json (每任务独立, 完成后保留=历史)
// v3: 多任务支持 - 每个下载任务一个状态文件, 完成/错误后留在 tasks/ 目录作为历史
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const url = process.argv[2];
const outPath = process.argv[3];
// 任务状态目录: ~/.dsh/downloads/tasks/<文件名去扩展名>.json
const STATUS_DIR = path.join(os.homedir(), '.dsh', 'downloads', 'tasks');
const fileName = path.basename(outPath);
const taskId = fileName.replace(/\.[^.]+$/, '') + '-' + Date.now().toString(36);
const statusFile = path.join(STATUS_DIR, taskId + '.json');
let mirrorPrefix = '';
for (const a of process.argv.slice(4)) {
  if (a.startsWith('--mirror=')) mirrorPrefix = a.slice(9);
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function writeStatus(obj) {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    if (!obj.startedAt) obj.startedAt = Date.now();
    if (!obj.outPath) obj.outPath = outPath;
    if (!obj.taskId) obj.taskId = taskId;
    fs.writeFileSync(statusFile, JSON.stringify(obj));
  } catch (e) {}
}

// 取消检测: ~/.dsh/downloads/cancel.txt 每行一个 taskId, 出现则中断
const CANCEL_FILE = path.join(os.homedir(), '.dsh', 'downloads', 'cancel.txt');
function shouldCancel() {
  try {
    if (!fs.existsSync(CANCEL_FILE)) return false
    const lines = fs.readFileSync(CANCEL_FILE, 'utf-8').split('\n').map(l => l.trim())
    return lines.includes(taskId)
  } catch (e) { return false }
}
function markCancelled() {
  writeStatus({ name: fileName, status: 'cancelled', error: '已取消', endedAt: Date.now() })
  process.stdout.write('\n[download] 已取消: ' + outPath + '\n')
  process.exit(0)
}

// 探测最终 URL (HEAD, 跟随重定向), 返回 { finalUrl, total }
function probe(u, depth) {
  return new Promise((resolve, reject) => {
    const mod = u.startsWith('https') ? https : http;
    const req = mod.request(u, { method: 'HEAD', headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        resolve(probe(next, depth + 1));
      } else {
        res.resume();
        resolve({
          finalUrl: u,
          total: parseInt(res.headers['content-length'] || '0', 10) || 0,
        });
      }
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('probe timeout')); });
    req.end();
  });
}

// 正式下载 (GET, 支持断点续传: 已存在文件则从已有大小续传)
function download(finalUrl, total, ws, outPath, cb) {
  const mod = finalUrl.startsWith('https') ? https : http;
  const startTime = Date.now();
  // 断点续传: 计算已下载字节
  let downloaded = 0;
  try { downloaded = fs.statSync(outPath).size; } catch (e) {}
  let lastTick = Date.now();
  let lastBytes = downloaded;
  const speedWindow = [];
  const headers = { 'User-Agent': UA };
  if (downloaded > 0) headers['Range'] = 'bytes=' + downloaded + '-';

  const req = mod.get(finalUrl, { headers }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      download(new URL(res.headers.location, finalUrl).href, total, ws, outPath, cb);
      return;
    }
    // 206 = 续传成功; 200 = 服务器不支持续传重新下载
    if (res.statusCode === 200 && downloaded > 0) {
      // 服务器忽略 Range, 从头写
      downloaded = 0;
      try { ws.truncate(0); } catch (e) {}
    }
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (!ws.write(chunk)) {
        res.pause()
        // 缓冲区排空后恢复下载 (在 res 作用域内注册)
        ws.once('drain', () => res.resume())
      }
      const now = Date.now();
      // 取消检测 (每 500ms)
      if (now - lastTick >= 500) {
        if (shouldCancel()) {
          res.destroy()
          try { ws.close() } catch (e) {}
          markCancelled()
          return
        }
        const dt = (now - lastTick) / 1000;
        const inst = (downloaded - lastBytes) / dt;
        speedWindow.push(inst);
        if (speedWindow.length > 6) speedWindow.shift();
        const avg = speedWindow.reduce((a, b) => a + b, 0) / speedWindow.length;
        lastTick = now;
        lastBytes = downloaded;
        const elapsedSec = (now - startTime) / 1000;
        const pct = total ? Math.min(100, Math.round(downloaded / total * 1000) / 10) : -1;
        const speedMBps = avg / 1048576;
        const etaSec = avg > 0 && total ? Math.round((total - downloaded) / avg) : -1;
        writeStatus({
          name: fileName, finalUrl, total, downloaded, percent: pct,
          speedMBps: Math.round(speedMBps * 100) / 100,
          elapsedSec: Math.round(elapsedSec), etaSec,
          status: 'downloading',
        });
        process.stdout.write(`\r[download] ${pct >= 0 ? pct + '%' : '?'} ${(downloaded / 1048576).toFixed(1)}MB/${total ? (total / 1048576).toFixed(1) + 'MB' : '?'} ${speedMBps.toFixed(1)}MB/s${etaSec >= 0 ? ' ETA ' + Math.floor(etaSec / 60) + 'm' + (etaSec % 60) + 's' : ''}   `);
      }
    });
    res.on('end', () => {
      const elapsedSec = (Date.now() - startTime) / 1000;
      writeStatus({ name: fileName, finalUrl, total, downloaded, percent: 100, speedMBps: Math.round((downloaded / 1048576 / elapsedSec) * 100) / 100, elapsedSec: Math.round(elapsedSec), etaSec: 0, status: 'done', endedAt: Date.now() });
      process.stdout.write('\n[download] 完成: ' + outPath + '\n');
      cb(null);
    });
    res.on('error', (e) => { writeStatus({ name: fileName, status: 'error', error: String(e.message), endedAt: Date.now() }); cb(e); });
  });
  req.on('error', (e) => { writeStatus({ name: fileName, status: 'error', error: String(e.message), endedAt: Date.now() }); cb(e); });
}

(async () => {
  const fullUrl = mirrorPrefix ? mirrorPrefix + url : url;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ws = fs.createWriteStream(outPath);
  try {
    writeStatus({ name: fileName, url: fullUrl, status: 'probing' });
    const { finalUrl, total } = await probe(fullUrl, 0);
    writeStatus({ name: fileName, url: fullUrl, finalUrl, total, downloaded: 0, percent: 0, speedMBps: 0, elapsedSec: 0, etaSec: 0, status: 'starting' });
    console.error('[download] 目标:', finalUrl, '大小:', (total / 1048576).toFixed(1) + 'MB');
    download(finalUrl, total, ws, outPath, (err) => { if (err) process.exit(1); });
  } catch (e) {
    writeStatus({ name: fileName, url: fullUrl, status: 'error', error: String(e.message) });
    console.error('[download] 失败:', e.message);
    process.exit(1);
  }
})();
