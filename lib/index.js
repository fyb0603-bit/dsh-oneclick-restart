// dsh-oneclick-restart host half.
//
// 设置页「一键重启」的宿主实现：暴露三个同源路由，负责
//   1) 实时上报有没有正在运行的对话（取自 ctx.agents 注册表，权威源）；
//   2) 下发 CSRF 能力，写操作必须带 token；
//   3) 在校验通过后，用 Windows 计划任务拉起外部重启器（restart-app.ps1），
//      由它 kill 掉本进程的根（桌面主进程 / host）再重新启动。
//
// 设计取舍：
//  - 路由前缀固定 /oneclick-restart，与 ark-quota / quick-screenshot 等既有插件
//    完全不重叠；status 里带 plugin 标识，客户端据此判断路由是否被别的插件抢占
//    （webServer 的重名 exact 路由是静默覆盖，没有内建冲突报错）。
//  - 重启动作绝不能在本进程内做：一旦杀掉自己就没人收尾，所以走计划任务，
//    脱离宿主进程树（与本机既有的 restart-harness 同一套实测路径）。
//  - 二次确认在服务端也要验：confirm 必须是 RESTART；有运行中对话时还必须
//    acknowledgeRunning 为真，且客户端看到的 running 集合与此刻完全一致
//    （否则视为陈旧视图，回 409 stale，让前端刷新后重新确认）。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-oneclick-restart";
export const inject = ["webServer", "agents"];
export const PLUGIN = "dsh-oneclick-restart";
export const VERSION = "0.1.0";
export const ROUTE_STATUS = "/oneclick-restart/status";
export const ROUTE_TOKEN = "/oneclick-restart/token";
export const ROUTE_RESTART = "/oneclick-restart/restart";
export const TASK_NAME = "DSHOneClickRestart";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = join(LIB_DIR, "restart-app.ps1");
const SHELL_SRC = join(LIB_DIR, "restart-app.vbs");

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/** 只接受本机 Host：这条路由能重启整个应用。 */
export function isLoopbackHost(req) {
  const host = req && req.headers ? req.headers.host : "";
  if (typeof host !== "string" || host.trim().length === 0) return true;
  let hostname;
  try {
    hostname = new URL("http://" + host).hostname.toLowerCase();
  } catch {
    return false;
  }
  hostname = hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "localhost." ||
    hostname === "127.0.0.1" || hostname === "::1";
}

function hasValidToken(req, expected) {
  const supplied = req && req.headers ? req.headers["x-oneclick-restart-token"] : "";
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolvePromise(text ? JSON.parse(text) : {});
      } catch {
        resolvePromise({ _parseError: true });
      }
    });
  });
}

/** 计划任务的 /tr 命令行里不能出现空格（否则要多层引号），状态目录必须无空格。 */
function pickStateDir() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const preferred = home ? join(home, ".dsh", "oneclick-restart") : "";
  if (preferred && !/\s/.test(preferred)) return { dir: preferred, fallback: false };
  const tmp = process.env.TEMP || process.env.TMP || "";
  const alt = tmp ? join(tmp, "dsh-oneclick-restart") : "";
  if (alt && !/\s/.test(alt)) return { dir: alt, fallback: true };
  return { dir: preferred || alt || ".", fallback: true };
}

export function apply(ctx) {
  const token = randomBytes(24).toString("base64url");
  const bootId = randomBytes(8).toString("hex");
  const startedAt = Date.now();
  const picked = pickStateDir();
  const dir = picked.dir;
  const logPath = join(dir, "restart.log");
  const scriptPath = join(dir, "restart-app.ps1");
  const shellPath = join(dir, "restart-app.vbs");
  const configPath = join(dir, "target.json");
  const launcherPath = join(dir, "launch.cmd");

  let accepted = null;
  let launch = null;
  let lastError = null;

  const exe = process.execPath || "";
  const exeName = basename(exe).toLowerCase();
  const isHarnessExe = exeName === "deepseek harness.exe";
  // ELECTRON_RUN_AS_NODE 说明本进程是 Electron 派生的 node 子进程（host）：
  // 要重启的是它的父进程（桌面主进程）。否则本进程就是主进程自己。
  const isHostChild = isHarnessExe && !!process.env.ELECTRON_RUN_AS_NODE && process.ppid !== process.pid;
  const target = isHarnessExe
    ? {
        mode: "desktop",
        pid: isHostChild ? process.ppid : process.pid,
        exe,
        workdir: dirname(exe),
        expectName: "DeepSeek Harness",
        args: [],
      }
    : {
        mode: "host",
        pid: process.pid,
        exe,
        workdir: process.cwd(),
        expectName: null,
        args: process.argv.slice(1),
      };

  try {
    mkdirSync(dir, { recursive: true });
    const script = readFileSync(SCRIPT_SRC, "utf8");
    writeFileSync(scriptPath, script, "utf8");
    // 隐藏启动壳与 ps1 放同一目录：vbs 自寻址同目录的 restart-app.ps1 / target.json，
    // 于是计划任务的 /tr 只需一条没有引号的短命令。
    writeFileSync(shellPath, readFileSync(SHELL_SRC, "utf8"), "utf8");
  } catch (error) {
    lastError = "copy restart-app.ps1/.vbs failed: " + String((error && error.message) || error);
  }

  const tailLog = () => {
    try {
      if (!existsSync(logPath)) return [];
      const text = readFileSync(logPath, "utf8");
      return text.slice(-2400).split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-10);
    } catch {
      return [];
    }
  };

  const logLine = (msg) => {
    try {
      const line = "[" + new Date().toISOString() + "] " + msg;
      const prev = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      writeFileSync(logPath, prev + line + "\r\n", "utf8");
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  const runningAgents = () => {
    try {
      const registry = ctx.agents;
      if (!registry || typeof registry.list !== "function") return [];
      const list = registry.list() || [];
      const out = [];
      for (const agent of list) {
        if (!agent || agent.status !== "running") continue;
        const id = agent.id !== undefined ? String(agent.id) : agent.sessionId !== undefined ? String(agent.sessionId) : "";
        if (id) out.push(id);
      }
      out.sort();
      return out;
    } catch {
      return [];
    }
  };

  const statusPayload = () => {
    const running = runningAgents();
    return {
      ok: true,
      plugin: PLUGIN,
      version: VERSION,
      bootId,
      startedAt,
      now: Date.now(),
      pid: process.pid,
      electronHost: isHostChild,
      target: {
        mode: target.mode,
        pid: target.pid,
        exe: target.exe,
        workdir: target.workdir,
        expectName: target.expectName,
        args: target.args,
      },
      running,
      runningCount: running.length,
      accepted,
      launch,
      stateDir: dir,
      stateDirFallback: picked.fallback,
      logTail: tailLog(),
      error: lastError,
    };
  };

  const launchRestart = () => {
    const config = {
      mode: target.mode,
      pid: target.pid,
      exe: target.exe,
      workdir: target.workdir,
      expectName: target.expectName,
      args: target.args,
      log: logPath,
      task: TASK_NAME,
      delayMs: 1500,
    };
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      // 经 wscript 隐藏壳拉起 powershell：schtasks 直接跑 powershell 会留下一个真实的
      // 控制台窗口，该窗口与新起的 DSH 共用 console，用户关窗就会把 DSH 一起带走。
      // 路径来自 pickStateDir()（已保证无空格），因此 /tr 里不需要任何引号。
      const inner = "wscript.exe //B " + shellPath;
      const cmdText = [
        "@echo off",
        "schtasks /create /tn \"" + TASK_NAME + "\" /tr \"" + inner + "\" /sc once /st 23:59 /f >nul 2>&1",
        "schtasks /run /tn \"" + TASK_NAME + "\" >nul 2>&1",
        "",
      ].join("\r\n");
      writeFileSync(launcherPath, cmdText, "utf8");
      const result = spawnSync("cmd.exe", ["/d", "/c", launcherPath], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 25000,
      });
      const ok = result.status === 0;
      if (!ok) {
        lastError = "schtasks failed: " + String((result.stderr || result.stdout || result.status || "").slice(0, 300));
      }
      return { ok, status: result.status, detail: String(result.stdout || "").trim().slice(0, 300) };
    } catch (error) {
      lastError = "launch failed: " + String((error && error.message) || error);
      return { ok: false, status: null, detail: lastError };
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_STATUS,
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, code: "method", message: "GET only" });
        return;
      }
      if (!isLoopbackHost(req)) {
        sendJson(res, 403, { ok: false, code: "invalid-host", message: "拒绝非本机 Host 请求" });
        return;
      }
      sendJson(res, 200, statusPayload());
    },
  }), "oneclick-restart: status route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_TOKEN,
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, code: "method", message: "GET only" });
        return;
      }
      if (!isLoopbackHost(req)) {
        sendJson(res, 403, { ok: false, code: "invalid-host", message: "拒绝非本机 Host 请求" });
        return;
      }
      sendJson(res, 200, { ok: true, plugin: PLUGIN, token, bootId });
    },
  }), "oneclick-restart: token route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_RESTART,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
      if (!isLoopbackHost(req)) {
        sendJson(res, 403, { ok: false, code: "invalid-host", message: "拒绝非本机 Host 请求" });
        return;
      }
      if (!hasValidToken(req, token)) {
        logLine("deny csrf host=" + String((req.headers && req.headers.host) || ""));
        sendJson(res, 403, { ok: false, code: "csrf", message: "缺少或无效的 token" });
        return;
      }
      const body = await readBody(req);
      if (body && body._parseError) {
        sendJson(res, 400, { ok: false, code: "body", message: "body 不是合法 JSON" });
        return;
      }
      if (accepted) {
        sendJson(res, 202, { ok: true, replay: true, accepted, bootId });
        return;
      }
      if (!body || body.confirm !== "RESTART") {
        logLine("deny confirm body=" + JSON.stringify(body || {}).slice(0, 240));
        sendJson(res, 400, {
          ok: false,
          code: "confirm",
          message: "需要二次确认：body.confirm 必须为 RESTART",
        });
        return;
      }
      const running = runningAgents();
      if (running.length > 0) {
        if (body.acknowledgeRunning !== true) {
          logLine("deny running-sessions running=" + running.join(","));
          sendJson(res, 400, {
            ok: false,
            code: "running-sessions",
            message: "当前有 " + running.length + " 个对话在运行，必须显式确认中断",
            running,
          });
          return;
        }
        const expected = Array.isArray(body.expectRunningIds)
          ? body.expectRunningIds.map((v) => String(v)).sort()
          : [];
        // 只做单向校验：服务端此刻的 running 必须全部被客户端确认过。
        // 严格相等会因回合起落抖动把合法点击判成 stale（用户体感就是点了没反应）。
        const seen = new Set(expected);
        const uncovered = running.filter((id) => !seen.has(id));
        const same = uncovered.length === 0;
        if (!same) {
          logLine("deny stale running=" + running.join(",") + " expected=" + expected.join(","));
          sendJson(res, 409, {
            ok: false,
            code: "stale",
            message: "运行中的对话已经变化，请刷新后重新确认",
            running,
          });
          return;
        }
      }
      const started = launchRestart();
      accepted = {
        id: randomBytes(6).toString("hex"),
        at: Date.now(),
        bootId,
        target: { mode: target.mode, pid: target.pid, exe: target.exe },
        interrupted: running,
        task: TASK_NAME,
        scheduled: started.ok,
        detail: started.detail,
      };
      launch = started;
      logLine("accept id=" + accepted.id + " scheduled=" + started.ok +
        " interrupted=" + running.join(",") + " detail=" + String(started.detail || "").slice(0, 200));
      sendJson(res, 202, { ok: true, accepted, bootId });
    },
  }), "oneclick-restart: restart route");
}
