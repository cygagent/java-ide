#!/usr/bin/env node
/**
 * JDT LS 前置验证脚本（对应 docs/java-ide-mvp-plan.md 第 9 章第 1 条）
 *
 * 目的：不经 UI，直接用命令行把 JDT LS 拉起来，通过 LSP(JSON-RPC over stdio)
 *       跑通 initialize -> initialized -> didOpen -> completion 全链路，
 *       确认补全能出结果，并采集三项关键数据：
 *         (1) 启动到 ready 的时长
 *         (2) 补全响应耗时
 *         (3) JDT LS 进程实际内存占用
 *
 * 用法：
 *   node scripts/verify-jdtls/lsp-verify.mjs            # 正常跑
 *   node scripts/verify-jdtls/lsp-verify.mjs --verbose  # 额外打印 JDT LS stderr
 *   JDTLS_XMX=2g node scripts/verify-jdtls/lsp-verify.mjs   # 换堆上限
 *
 * 退出码：0 = 全链路通过；1 = 失败（含具体失败阶段）
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- 路径与配置

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const JAVA = path.join(ROOT, 'runtime/jdk21/Contents/Home/bin/java');
const JAVA_HOME = path.join(ROOT, 'runtime/jdk21/Contents/Home');
const JDTLS = path.join(ROOT, 'runtime/jdtls');
const LAUNCHER = path.join(
  JDTLS,
  'plugins/org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar'
);
const CONFIG = path.join(JDTLS, 'config_mac');
const FIXTURE = path.join(__dirname, 'fixture');
const FIXTURE_FILE = path.join(FIXTURE, 'Hello.java');
const WORKSPACE = path.join(os.tmpdir(), 'java-ide-jdtls-verify-ws');

const XMX = process.env.JDTLS_XMX || '1g';
const VERBOSE = process.argv.includes('--verbose');
const REQ_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 120_000; // 首次补全可用前的等待上限

// ---------------------------------------------------------------- 环境自检

function preflight() {
  const required = [
    ['JDK 21 java 可执行文件', JAVA],
    ['JDT LS 目录', JDTLS],
    ['Equinox launcher', LAUNCHER],
    ['JDT LS config_mac', CONFIG],
    ['验证用 Java 源文件', FIXTURE_FILE],
  ];
  const missing = required.filter(([, p]) => !fs.existsSync(p));
  if (missing.length > 0) {
    for (const [name, p] of missing) console.error(`[x] 缺失 ${name}: ${p}`);
    process.exit(1);
  }
  fs.mkdirSync(WORKSPACE, { recursive: true });
}

// ---------------------------------------------------------------- 进程与日志

const t0 = Date.now();
const mark = () => Date.now() - t0;
const log = (...a) => console.log(`[+${String(mark()).padStart(6)}ms]`, ...a);

let child = null;
let stderrTail = [];
let memSamples = [];
let memTimer = null;

function rssMB(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return out ? Math.round(parseInt(out, 10) / 1024) : null;
  } catch {
    return null;
  }
}

function startMemSampling(pid) {
  memTimer = setInterval(() => {
    const mb = rssMB(pid);
    if (mb !== null) memSamples.push({ t: mark(), mb });
  }, 500);
}

function stopMemSampling() {
  if (memTimer) clearInterval(memTimer);
  memTimer = null;
}

function cleanup() {
  stopMemSampling();
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ---------------------------------------------------------------- LSP 传输层

const SETTINGS = {
  java: {
    import: { maven: { enabled: false }, gradle: { enabled: false } },
    completion: { maxResults: 50 },
    signatureHelp: { enabled: true },
    referencesCodeLens: { enabled: false },
    implementationsCodeLens: { enabled: false },
  },
};

const pending = new Map();
let nextId = 1;
let buf = Buffer.alloc(0);
const progressEvents = [];
const diagnostics = [];
const diagResolvers = [];

function waitForDiagnostics(timeoutMs) {
  if (diagnostics.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    diagResolvers.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function send(obj) {
  const json = JSON.stringify(obj);
  const len = Buffer.byteLength(json, 'utf8');
  child.stdin.write(`Content-Length: ${len}\r\n\r\n${json}`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, REQ_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, method });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function handleMessage(msg) {
  // 服务端对我方请求的响应
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method} -> ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
    return;
  }

  // 服务端发给我方的请求
  if (msg.id !== undefined && msg.method !== undefined) {
    switch (msg.method) {
      case 'workspace/configuration': {
        const items = msg.params?.items ?? [];
        respond(msg.id, items.map(() => SETTINGS));
        break;
      }
      case 'client/registerCapability':
      case 'window/workDoneProgress/create':
        respond(msg.id, null);
        break;
      case 'window/showMessageRequest':
        respond(msg.id, null);
        break;
      case 'workspace/applyEdit':
        respond(msg.id, { applied: true });
        break;
      default:
        respond(msg.id, null);
    }
    return;
  }

  // 服务端通知
  if (msg.method === 'language/status') {
    const { type, message } = msg.params ?? {};
    progressEvents.push({ t: mark(), type, message });
    if (VERBOSE) log(`language/status: ${type} - ${message}`);
    return;
  }

  if (msg.method === 'textDocument/publishDiagnostics') {
    const items = msg.params?.diagnostics ?? [];
    diagnostics.push(...items);
    if (VERBOSE) log(`publishDiagnostics: ${items.length} 条`);
    const waiters = diagResolvers.splice(0);
    waiters.forEach((r) => r());
  }
}

function pump() {
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buf.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    if (buf.length < headerEnd + 4 + len) return;
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
    buf = buf.slice(headerEnd + 4 + len);
    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      log(`[warn] 报文解析失败: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- 启动 JDT LS

function launch() {
  const args = [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dosgi.checkConfiguration=true',
    `-Dosgi.sharedConfiguration.area=${CONFIG}`,
    '-Dosgi.sharedConfiguration.area.readOnly=true',
    '-Dosgi.configuration.cascaded=true',
    `-Xmx${XMX}`,
    '-XX:+UseG1GC',
    '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '-jar', LAUNCHER,
    '-data', WORKSPACE,
  ];

  log(`启动 JDT LS（-Xmx${XMX}，JAVA_HOME=${JAVA_HOME}）`);
  log(`workspace = ${WORKSPACE}`);

  child = spawn(JAVA, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JAVA_HOME },
  });

  startMemSampling(child.pid);

  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });

  child.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    stderrTail.push(s);
    if (stderrTail.length > 40) stderrTail.shift();
    if (VERBOSE) process.stderr.write(`[jdtls] ${s}`);
  });

  child.on('exit', (code, signal) => {
    if (memTimer) {
      stopMemSampling();
      if (code !== 0 && code !== null) log(`[warn] JDT LS 意外退出 code=${code} signal=${signal}`);
    }
  });

  return new Promise((resolve, reject) => {
    child.once('error', (e) => reject(new Error(`无法拉起 JDT LS 进程: ${e.message}`)));
    child.once('spawn', resolve);
  });
}

// ---------------------------------------------------------------- 组装请求

function fileUri(p) {
  return pathToFileURL(p).toString();
}

function buildInitializeParams() {
  const root = fileUri(FIXTURE);
  return {
    processId: process.pid,
    clientInfo: { name: 'java-ide-verify', version: '0.0.1' },
    rootPath: FIXTURE,
    rootUri: root,
    workspaceFolders: [{ uri: root, name: 'fixture' }],
    capabilities: {
      workspace: {
        configuration: true,
        workspaceFolders: true,
        applyEdit: true,
      },
      textDocument: {
        synchronization: { dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: true },
        completion: {
          dynamicRegistration: false,
          completionItem: {
            snippetSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            insertReplaceSupport: false,
          },
        },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        documentFormatting: { dynamicRegistration: false },
      },
    },
    initializationOptions: {
      settings: SETTINGS,
      extendedClientCapabilities: {
        classFileContentsSupport: false,
        progressReportProvider: false,
      },
    },
    trace: 'off',
  };
}

function completionPosition() {
  const lines = fs.readFileSync(FIXTURE_FILE, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf('text.length()');
    if (idx >= 0) return { line: i, character: idx + 'text.'.length };
  }
  throw new Error('在 fixture 中找不到补全触发点 text.length()');
}

function normalizeItems(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.completionItems)) return result.completionItems;
  return [];
}

// ---------------------------------------------------------------- 主流程

async function waitForReady(uri) {
  const pos = completionPosition();
  log(`补全触发点: ${path.basename(FIXTURE_FILE)} L${pos.line + 1}:${pos.character + 1}`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let attempt = 0;
  let lastErr = null;

  while (Date.now() < deadline) {
    attempt++;
    const started = Date.now();
    try {
      const result = await request('textDocument/completion', {
        textDocument: { uri },
        position: pos,
        context: { triggerKind: 1 },
      });
      const elapsed = Date.now() - started;
      const items = normalizeItems(result);

      if (items.length > 0) {
        return { items, latencyMs: elapsed, attempt, readyAtMs: mark(), pos };
      }
      lastErr = new Error('补全返回空结果');
      if (attempt === 1) log('首次补全为空，等待项目导入/编译完成后重试…');
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `等待补全可用超时（${READY_TIMEOUT_MS}ms，共尝试 ${attempt} 次）：${lastErr?.message ?? '未知'}`
  );
}

function report(res, diags, memBeforeShutdown) {
  const peak = memSamples.reduce((a, b) => (b.mb > a.mb ? b : a), { mb: 0, t: 0 });
  const firstMem = memSamples[0];
  const line = '─'.repeat(64);

  const statusAt = (type) => progressEvents.find((e) => e.type === type)?.t;
  const serviceReady = statusAt('ServiceReady');

  console.log(`\n${line}\nJDT LS 前置验证结果\n${line}`);
  console.log(`JDK                  : 21 (Temurin, runtime/jdk21/Contents/Home)`);
  console.log(`JDT LS launcher      : ${path.basename(LAUNCHER)}`);
  console.log(`堆上限               : -Xmx${XMX}`);
  console.log(line);
  console.log(`[时序]`);
  console.log(`  进程 spawn -> initialize 响应 : ${res.tInitAboutMs} ms`);
  console.log(`  initialize -> didOpen 完成    : ${res.tDidOpenMs} ms`);
  if (serviceReady !== undefined) {
    console.log(`  spawn -> language/status=ServiceReady : ${serviceReady} ms`);
  }
  console.log(`  spawn -> 首次拿到非空补全     : ${res.readyAtMs} ms（第 ${res.attempt} 次尝试）`);
  console.log(`[补全]`);
  console.log(`  请求耗时 (最后一次)  : ${res.latencyMs} ms`);
  console.log(`  返回条目数           : ${res.items.length}`);
  const sample = res.items.slice(0, 12).map((i) => i.label).join(', ');
  console.log(`  样例                 : ${sample}`);
  console.log(`[诊断]`);
  console.log(`  publishDiagnostics 条数 : ${diags.length}`);
  if (diags.length > 0) {
    const d = diags[0];
    console.log(`  首个诊断 : ${d.range?.start?.line + 1} 行 severity=${d.severity} ${d.message?.split('\n')[0]}`);
  }
  console.log(`[内存] JDT LS 进程 RSS`);
  console.log(`  首次采样 (${firstMem?.t}ms)   : ${firstMem?.mb} MB`);
  console.log(`  补全就绪时 (${res.readyAtMs}ms) : ${res.mbAtReady} MB`);
  console.log(`  峰值 (${peak.t}ms)          : ${peak.mb} MB`);
  console.log(`  shutdown 前 (${memBeforeShutdown.t}ms) : ${memBeforeShutdown.mb} MB`);
  console.log(line);

  const ok = res.items.length > 0;
  console.log(ok ? '结论：PASS —— JDT LS 独立跑通，补全链路可用' : '结论：FAIL —— 补全未返回结果');
  return ok;
}

async function main() {
  preflight();
  await launch();

  // 1) initialize
  const tSendInit = Date.now();
  const initResult = await request('initialize', buildInitializeParams());
  const tInitAboutMs = Date.now() - tSendInit;
  log(`initialize 响应完成，serverInfo=${initResult?.serverInfo?.name} ${initResult?.serverInfo?.version ?? ''}`);
  log(`capabilities.completionProvider = ${JSON.stringify(initResult?.capabilities?.completionProvider ?? null)}`);

  // 2) initialized + 配置下发
  notify('initialized', {});
  notify('workspace/didChangeConfiguration', { settings: SETTINGS });

  // 3) didOpen
  const uri = fileUri(FIXTURE_FILE);
  const text = fs.readFileSync(FIXTURE_FILE, 'utf8');
  notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'java', version: 1, text },
  });
  const tDidOpenMs = mark();
  log('textDocument/didOpen 已发送');

  // 4) 等首次诊断到达（超时即跳过，不阻塞主流程）
  await waitForDiagnostics(15_000);
  log(`textDocument/publishDiagnostics 收到 ${diagnostics.length} 条`);

  // 5) 等补全可用
  const res = await waitForReady(uri);
  res.tInitAboutMs = tInitAboutMs;
  res.tDidOpenMs = tDidOpenMs;
  res.mbAtReady = rssMB(child.pid);

  const memBeforeShutdown = { t: mark(), mb: rssMB(child.pid) };

  // 6) 收尾
  try {
    await request('shutdown', null);
    notify('exit', null);
  } catch (e) {
    log(`[warn] shutdown 异常: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  stopMemSampling();

  const ok = report(res, diagnostics, memBeforeShutdown);

  if (!ok && stderrTail.length > 0) {
    console.log('\n---- JDT LS stderr（尾部 20 行）----');
    console.log(stderrTail.join('').split('\n').slice(-20).join('\n'));
  }

  cleanup();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n[x] 验证失败: ${e.message}`);
  if (stderrTail.length > 0) {
    console.error('\n---- JDT LS stderr（尾部 30 行）----');
    console.error(stderrTail.join('').split('\n').slice(-30).join('\n'));
  }
  cleanup();
  process.exit(1);
});
