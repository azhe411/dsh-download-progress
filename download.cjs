// download.cjs - 带实时进度的下载工具 (v2)
// 用法: node download.cjs <url> <输出路径> [--mirror=<前缀>]
// 进度状态写入 ~/.dsh/downloads/active.json (供 download-progress 插件每秒轮询显示)
// v2 修复: 探测 URL 与下载分离, 避免重定向丢数据; 支持断点续传
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const url = process.argv[2];
const outPath = process.argv[3];
// 标准状态文件: ~/.dsh/downloads/active.json (进度条插件读这个)
const STATUS_DIR = path.join(os.homedir(), '.dsh', 'downloads');
const statusFile = path.join(STATUS_DIR, 'active.json');
let mirrorPrefix = '';
for (const a of process.argv.slice(4)) {
  if (a.startsWith('--mirror=')) mirrorPrefix = a.slice(9);
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
// 文件名 (从输出路径取, 进度条显示用)
const fileName = path.basename(outPath);

function writeStatus(obj) {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(obj));
  } catch (e) {}
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
      if (now - lastTick >= 500) {
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
      writeStatus({ name: fileName, finalUrl, total, downloaded, percent: 100, speedMBps: Math.round((downloaded / 1048576 / elapsedSec) * 100) / 100, elapsedSec: Math.round(elapsedSec), etaSec: 0, status: 'done' });
      process.stdout.write('\n[download] 完成: ' + outPath + '\n');
      cb(null);
    });
    res.on('error', (e) => { writeStatus({ name: fileName, status: 'error', error: String(e.message) }); cb(e); });
  });
  req.on('error', (e) => { writeStatus({ name: fileName, status: 'error', error: String(e.message) }); cb(e); });
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
