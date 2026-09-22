/**
 * Managed toolchain primitives: pinned uv → managed Python → venv → pinned
 * OpenViking wheel. Decision-free mechanisms shared by the end-user CLI
 * (scripts/cli.mjs) and the repo dev bootstrap (scripts/dev.mjs): every
 * function is parameterized by home, reports through log, and throws instead
 * of exiting. Script-level prompts, config parsing and lifecycle stay in the
 * scripts.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

export const TOOLCHAIN = Object.freeze({
  uvVersion: "0.12.5",
  pythonVersion: "3.12",
  openvikingVersion: "0.4.15",
  zstandardVersion: "0.25.0",
});
export const OPENVIKING_SPEC = `openviking[local-embed]==${TOOLCHAIN.openvikingVersion}`;
export const ZSTANDARD_SPEC = `zstandard==${TOOLCHAIN.zstandardVersion}`;

const UV_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export function isToolchainPlatformSupported(platformName = platform(), archName = arch()) {
  return Boolean(UV_TARGETS[`${platformName}-${archName}`]);
}

export function toolchainPaths(home, { platformName = platform() } = {}) {
  const isWin = platformName === "win32";
  const binDir = join(home, "bin");
  const venvDir = join(home, "venv");
  const venvBin = join(venvDir, isWin ? "Scripts" : "bin");
  return {
    binDir,
    uvBin: join(binDir, isWin ? "uv.exe" : "uv"),
    pythonDir: join(home, "python"),
    uvCache: join(home, "cache", "uv"),
    venvDir,
    venvPython: join(venvBin, isWin ? "python.exe" : "python"),
    serverBin: join(venvBin, isWin ? "openviking-server.exe" : "openviking-server"),
  };
}

export function runProcess(cmd, args, { capture = false, env = process.env } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    windowsHide: true,
    env,
  });
  if (res.error) return { ok: false, code: -1, out: "", err: String(res.error) };
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    out: (res.stdout || "").toString(),
    err: (res.stderr || "").toString(),
  };
}

// uv 的托管 Python 与缓存全部收敛进 home；UV_PYTHON_INSTALL_MIRROR 不由本函数
// 设置，用户在网络受限环境下可自行导出，会随 process.env 透传给 uv。
export function uvEnv(paths) {
  return { ...process.env, UV_PYTHON_INSTALL_DIR: paths.pythonDir, UV_CACHE_DIR: paths.uvCache };
}

// Node 的全局 fetch 默认不读 HTTP(S)_PROXY；环境提供代理时改用 undici 的 EnvHttpProxyAgent
//（同时遵循 NO_PROXY）。注意 setGlobalDispatcher 影响进程内全部后续 fetch；当前两个脚本在下载
// 之外没有其他 fetch 调用（健康探测走 node:http），新增 fetch 调用方时需重新评估此前提。
// undici 是包依赖但 cli.mjs 保持零依赖属性：导入失败时静默退回直连。
let proxyReady = false;
async function enableEnvProxy() {
  if (proxyReady) return;
  proxyReady = true;
  if (!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)) return;
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    /* undici 不可用时直连下载 */
  }
}

async function download(url, dest) {
  await enableEnvProxy();
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载失败 ${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function ensureUv({ home, mirror, log = () => {} }) {
  const paths = toolchainPaths(home);
  const current = runProcess(paths.uvBin, ["--version"], { capture: true });
  if (current.ok && current.out.trim().startsWith(`uv ${TOOLCHAIN.uvVersion}`)) return paths;

  const target = UV_TARGETS[`${platform()}-${arch()}`];
  if (!target) {
    throw new Error(
      `没有适配 ${platform()}-${arch()} 的 uv 预置二进制。请手动安装 uv (https://docs.astral.sh/uv/) 后重试。`,
    );
  }
  const isWin = platform() === "win32";
  const name = `uv-${target}.${isWin ? "zip" : "tar.gz"}`;
  const base = mirror?.replace(/\/$/, "") || `https://github.com/astral-sh/uv/releases/download/${TOOLCHAIN.uvVersion}`;

  log(`安装 uv ${TOOLCHAIN.uvVersion} → ${paths.uvBin}`);
  const tmp = join(home, ".uv-tmp");
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  cleanup();
  mkdirSync(tmp, { recursive: true });
  try {
    try {
      await download(`${base}/${name}`, join(tmp, name));
      await download(`${base}/${name}.sha256`, join(tmp, `${name}.sha256`));
    } catch (e) {
      throw new Error(
        `uv 下载失败：${e?.message || e}。网络受限时可设置 PI_OPENVIKING_UV_MIRROR（指向 release 资产目录）后重试。`,
      );
    }
    const expected = readFileSync(join(tmp, `${name}.sha256`), "utf8").trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(join(tmp, name))).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `uv 下载校验和不匹配（期望 ${expected}，实际 ${actual}）。如使用镜像，请检查 PI_OPENVIKING_UV_MIRROR 指向的版本是否为 ${TOOLCHAIN.uvVersion}。`,
      );
    }
    // macOS/Linux 必有 tar；Windows 10+ 自带的 bsdtar 可直接解 zip。
    if (!runProcess("tar", ["-xf", join(tmp, name), "-C", tmp]).ok) {
      throw new Error("解压 uv 失败（需要系统 tar）。");
    }
    // unix tarball 内含 uv-<target>/ 子目录；Windows zip 是扁平结构。
    const binName = isWin ? "uv.exe" : "uv";
    const extracted = join(tmp, existsSync(join(tmp, `uv-${target}`)) ? `uv-${target}` : "", binName);
    if (!existsSync(extracted)) throw new Error(`解压后未找到 ${binName}。`);
    mkdirSync(paths.binDir, { recursive: true });
    renameSync(extracted, paths.uvBin);
    if (!isWin) chmodSync(paths.uvBin, 0o755);
  } finally {
    cleanup();
  }
  // 自校验：立即暴露 libc/平台不匹配（如 musl 系统上 gnu 二进制无法执行），
  // 避免错误延迟到 uv python install 才以误导性信息出现。
  const check = runProcess(paths.uvBin, ["--version"], { capture: true });
  if (!check.ok || !check.out.trim().startsWith(`uv ${TOOLCHAIN.uvVersion}`)) {
    throw new Error(
      `uv 安装后无法执行（当前平台 libc 可能不兼容，如 Alpine/musl）。请手动安装 uv (https://docs.astral.sh/uv/) 后重试。`,
    );
  }
  return paths;
}

export function ensurePython({ home, log = () => {} }) {
  const paths = toolchainPaths(home);
  const found = runProcess(paths.uvBin, ["python", "find", "--managed-python", TOOLCHAIN.pythonVersion], {
    capture: true,
    env: uvEnv(paths),
  });
  // Windows 上 uv 输出与 homedir() 的盘符大小写/分隔符可能不一致，归一化后再比较。
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  if (found.ok && norm(found.out.trim()).startsWith(norm(paths.pythonDir))) {
    log(`托管 Python ${TOOLCHAIN.pythonVersion} 已就绪（跳过安装）`);
    return paths;
  }
  log(`安装托管 Python ${TOOLCHAIN.pythonVersion} → ${paths.pythonDir}`);
  // --no-bin：阻止 uv 向 ~/.local/bin 写 python3.x 链接，保证全部产物收敛在 home。
  if (!runProcess(paths.uvBin, ["python", "install", "--no-bin", TOOLCHAIN.pythonVersion], { env: uvEnv(paths) }).ok) {
    throw new Error(`托管 Python 安装失败。网络受限时可设置 UV_PYTHON_INSTALL_MIRROR（见 docs/usage.md）后重试。`);
  }
  return paths;
}

function createVenv(paths, log) {
  log(`创建虚拟环境: ${paths.venvDir}`);
  rmSync(paths.venvDir, { recursive: true, force: true }); // 清理可能的半成品目录
  if (
    runProcess(paths.uvBin, ["venv", paths.venvDir, "--managed-python", "--python", TOOLCHAIN.pythonVersion], {
      env: uvEnv(paths),
    }).ok &&
    existsSync(paths.venvPython)
  ) {
    return;
  }
  rmSync(paths.venvDir, { recursive: true, force: true });
  throw new Error("创建 venv 失败（uv managed python），见上方输出。");
}

function installedVersion(venvPython, pkg) {
  const res = runProcess(venvPython, ["-c", `import importlib.metadata as m; print(m.version("${pkg}"))`], {
    capture: true,
  });
  return res.ok ? res.out.trim() : "";
}

export function ensureServerPackages({ home, log = () => {} }) {
  const paths = toolchainPaths(home);
  if (!existsSync(paths.venvPython)) createVenv(paths, log);

  const ov = installedVersion(paths.venvPython, "openviking");
  if (ov === TOOLCHAIN.openvikingVersion) {
    log(`服务端已就绪: openviking ${ov}（跳过安装）`);
  } else {
    log(`安装服务端: ${OPENVIKING_SPEC}（当前 openviking=${ov || "未安装"}）`);
    const install = runProcess(
      paths.uvBin,
      ["pip", "install", "--python", paths.venvPython, "--upgrade", OPENVIKING_SPEC],
      { env: uvEnv(paths) },
    );
    if (!install.ok) throw new Error("服务端依赖安装失败，见上方输出。");
    if (!existsSync(paths.serverBin)) throw new Error(`安装完成但找不到 ${paths.serverBin}`);
  }
  // 安装/复用后都验证服务二进制可执行且身份与 pin 一致。
  const check = runProcess(paths.serverBin, ["--version"], { capture: true });
  if (!check.ok || !check.out.includes(TOOLCHAIN.openvikingVersion)) {
    throw new Error(`服务端二进制无法执行或版本不是 ${TOOLCHAIN.openvikingVersion}（${paths.serverBin}）。`);
  }
  return paths;
}
