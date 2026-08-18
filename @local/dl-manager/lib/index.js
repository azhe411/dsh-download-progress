// dl-manager - 常驻下载管理器（host 半）：读 tasks 状态 + 打开文件位置
// 固化版 @local/dl-manager v3（2026-08-18 崩溃修复）：
//   v1 错误地用了动态插件专属的 harness.handle 全局 → ReferenceError 崩溃
//   v2 改用 ctx.webServer.register 注册 HTTP 端点，但漏写 inject 声明 → cordis
//      反射层对未注入服务取属性抛 "cannot get property "webServer" without inject" → 插件树加载失败崩溃
//   v3 声明 inject: ['webServer']（唯一依赖的服务）；fs/subprocess 改为 node 内置
//      模块（readdirSync / execFile），不再依赖 ctx.fs 与 ctx.subprocess
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import { execFile } from 'child_process';

const HOME = homedir();
const BASE = join(HOME, '.dsh');
const TASKS_DIR = join(BASE, 'downloads', 'tasks');
const TASKS_PATH = '/api/dl-manager/tasks';
const OPEN_PATH = '/api/dl-manager/open';

// cordis 注入声明：本插件只依赖 webServer 服务（由 dsh-host-webserver 提供）。
// 未注入的服务在 ctx 上取属性会直接抛错，必须显式声明。
export const inject = ['webServer'];

function readTasks() {
  try {
    const entries = readdirSync(TASKS_DIR);
    const tasks = [];
    for (const name of entries) {
      if (!name || !name.endsWith('.json')) continue;
      try {
        const text = readFileSync(join(TASKS_DIR, name), 'utf8');
        const obj = JSON.parse(text);
        if (obj && obj.name) { obj.taskId = name.replace(/\.json$/, ''); tasks.push(obj); }
      } catch (e2) { /* skip */ }
    }
    const rank = (t) => (t.status === 'downloading' || t.status === 'starting' || t.status === 'probing') ? 0 : 1;
    tasks.sort((a, b) => rank(a) - rank(b) || ((b.startedAt || 0) - (a.startedAt || 0)));
    return tasks.slice(0, 20);
  } catch (e) { return []; }
}

function sendJson(res, code, obj) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  } catch (e) { /* socket closed */ }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TASKS_PATH,
    handler: async (req, res) => {
      const tasks = readTasks();
      sendJson(res, 200, { ok: true, tasks });
    },
  }), 'dl-manager: tasks route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: async (req, res) => {
      try {
        const u = new URL(req.url, 'http://local');
        const taskId = u.searchParams.get('taskId') || '';
        const obj = JSON.parse(readFileSync(join(TASKS_DIR, taskId + '.json'), 'utf8'));
        const p = obj.outPath || '';
        if (!p) return sendJson(res, 404, { ok: false, error: '任务缺少输出路径' });
        execFile(join('C:', 'Windows', 'explorer.exe'), ['/select,', p], { cwd: BASE, windowsHide: true }, () => {});
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 404, { ok: false, error: String(e) });
      }
    },
  }), 'dl-manager: open route');
}
