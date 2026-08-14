var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : /* @__PURE__ */ Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/host/index.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readProfileManifest as readProfileManifest2 } from "@deepseek-ai/dsh-app-boot";

// src/host/github.ts
var API_BASE = "https://api.github.com";
var RAW_BASE = "https://raw.githubusercontent.com";
var USER_AGENT = "dsh-plugin-marketplace";
var MAX_PATCH_CHARS = 65536;
var GitHubError = class extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "GitHubError";
  }
  code;
  details;
};
var REPO_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;
function parseRepo(spec) {
  const match = REPO_PATTERN.exec(spec.trim());
  if (match === null) {
    throw new GitHubError("bad-repo", "Malformed repository spec \u2014 expected owner/repo.");
  }
  return { owner: match[1], repo: match[2] };
}
function isSafePatchPath(value) {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}
var GitHubClient = class {
  token = process.env.GITHUB_TOKEN ?? void 0;
  cache = /* @__PURE__ */ new Map();
  /** One conditional GET against the API; 304 serves the cached body. */
  async api(path, cacheKey) {
    const url = API_BASE + path;
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28"
    };
    if (this.token !== void 0) headers.authorization = "Bearer " + this.token;
    const cached = cacheKey === void 0 ? void 0 : this.cache.get(cacheKey);
    if (cached?.etag !== void 0 && cached.etag !== null) headers["if-none-match"] = cached.etag;
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (cause) {
      throw new GitHubError("network", "GitHub request failed: " + url, { cause: String(cause) });
    }
    if (response.status === 304 && cached !== void 0) {
      return { status: 304, body: cached.body, headers: response.headers };
    }
    if (response.status === 403 || response.status === 429) throw this.rateLimitError(response.headers);
    if (response.status === 401) {
      throw new GitHubError("bad-token", "GitHub rejected the token (401). Fix or unset GITHUB_TOKEN for anonymous access.");
    }
    if (response.status === 404) {
      throw new GitHubError("not-found", "GitHub resource not found: " + url, { url });
    }
    if (!response.ok) {
      throw new GitHubError("network", "GitHub request failed (" + String(response.status) + "): " + url, { status: response.status });
    }
    const body = await response.json();
    if (cacheKey !== void 0) {
      this.cache.set(cacheKey, { etag: response.headers.get("etag"), body, fetchedAt: Date.now() });
    }
    return { status: response.status, body, headers: response.headers };
  }
  rateLimitError(headers) {
    const reset = Number(headers.get("x-ratelimit-reset") ?? "0");
    const seconds = reset > 0 ? Math.max(0, reset - Math.floor(Date.now() / 1e3)) : 3600;
    return new GitHubError(
      "rate-limited",
      "GitHub rate limit exceeded \u2014 resets in about " + Math.ceil(seconds / 60) + " minutes. Set GITHUB_TOKEN for a higher quota.",
      { remaining: Number(headers.get("x-ratelimit-remaining") ?? "0"), reset }
    );
  }
  rate(headers, source) {
    return {
      limit: Number(headers.get("x-ratelimit-limit") ?? "0"),
      remaining: Number(headers.get("x-ratelimit-remaining") ?? "0"),
      reset: Number(headers.get("x-ratelimit-reset") ?? "0"),
      source
    };
  }
  /**
   * Resolve the concrete commit for a repo: an explicit tag, branch, or SHA;
   * otherwise the latest release tag, then the default branch.
   */
  async resolveRef(owner, repo, ref) {
    if (ref !== "") {
      try {
        const { body: body2, headers: headers2 } = await this.api("/repos/" + owner + "/" + repo + "/commits/" + encodeURIComponent(ref));
        const sha = body2.sha;
        if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
          throw new GitHubError("ref-not-found", "Ref '" + ref + "' did not resolve to a commit on " + owner + "/" + repo + ".", { ref });
        }
        return { ref: sha, rate: this.rate(headers2, "core") };
      } catch (error) {
        if (error instanceof GitHubError && error.code === "not-found") {
          throw new GitHubError("ref-not-found", "Ref '" + ref + "' not found on " + owner + "/" + repo + ".", { ref });
        }
        throw error;
      }
    }
    try {
      const { body: body2, headers: headers2 } = await this.api("/repos/" + owner + "/" + repo + "/releases/latest");
      const tag = body2.tag_name;
      if (typeof tag === "string" && tag !== "") return { ref: tag, rate: this.rate(headers2, "core") };
    } catch (error) {
      if (!(error instanceof GitHubError) || error.code !== "not-found") throw error;
    }
    const { body, headers } = await this.api("/repos/" + owner + "/" + repo);
    const branch = body.default_branch;
    const fallback = typeof branch === "string" && branch !== "" ? branch : "main";
    return { ref: fallback, rate: this.rate(headers, "core") };
  }
  /** Read the plugin manifest and bundle patch at one ref, for review before install. */
  async details(repoSpec, ref) {
    const { owner, repo } = parseRepo(repoSpec);
    const resolved = await this.resolveRef(owner, repo, ref);
    const rawBase = RAW_BASE + "/" + owner + "/" + repo + "/" + resolved.ref;
    let manifest = null;
    let patch = null;
    const headers = { accept: "application/vnd.github+json", "user-agent": USER_AGENT };
    try {
      const response = await fetch(rawBase + "/package.json", { headers });
      if (response.ok) {
        const pkg = await response.json();
        const dsh = pkg.dsh;
        const bundle = dsh?.bundle;
        const client = dsh?.client;
        const declaredPatch = bundle?.patch;
        manifest = {
          name: typeof pkg.name === "string" ? pkg.name : "",
          version: typeof pkg.version === "string" ? pkg.version : "unknown",
          description: typeof pkg.description === "string" ? pkg.description : "",
          license: typeof pkg.license === "string" ? pkg.license : null,
          bundlePatch: typeof declaredPatch === "string" && isSafePatchPath(declaredPatch) ? declaredPatch : null,
          hasClient: client !== void 0 && typeof client === "object"
        };
        if (manifest.name === "") {
          throw new GitHubError("bad-manifest", owner + "/" + repo + " package.json has no name field.");
        }
        if (manifest.bundlePatch !== null) {
          const patchResponse = await fetch(rawBase + "/" + manifest.bundlePatch, { headers });
          patch = patchResponse.ok ? (await patchResponse.text()).slice(0, MAX_PATCH_CHARS) : null;
        }
      } else if (response.status === 404) {
        manifest = null;
      }
    } catch (error) {
      if (error instanceof GitHubError) throw error;
    }
    return {
      repo: owner + "/" + repo,
      ref,
      resolvedRef: resolved.ref,
      manifest,
      patch,
      readmeUrl: "https://github.com/" + owner + "/" + repo + "#readme",
      rate: resolved.rate
    };
  }
};

// src/host/installer.ts
import { spawn } from "node:child_process";
var MAX_LOG_CHARS = 65536;
var MAX_JOBS = 8;
var JobTable = class {
  jobs = /* @__PURE__ */ new Map();
  seq = 0;
  create(kind, packageName) {
    this.seq += 1;
    const record = {
      jobId: "mkt-" + String(this.seq) + "-" + Date.now().toString(36),
      kind,
      packageName,
      phase: "spawning",
      log: "",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      outcome: null,
      failure: null
    };
    this.jobs.set(record.jobId, record);
    while (this.jobs.size > MAX_JOBS) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === void 0) break;
      this.jobs.delete(oldest);
    }
    return record;
  }
  get(jobId) {
    return this.jobs.get(jobId);
  }
  activeFor(packageName) {
    for (const job of this.jobs.values()) {
      if (job.packageName === packageName && job.finishedAt === null) return true;
    }
    return false;
  }
  hasActive() {
    for (const job of this.jobs.values()) {
      if (job.finishedAt === null) return true;
    }
    return false;
  }
  append(job, chunk) {
    job.log = (job.log + chunk).slice(-MAX_LOG_CHARS);
  }
  phase(job, value) {
    job.phase = value;
  }
  exit(job, code) {
    job.exitCode = code;
  }
  settle(job, outcome) {
    job.phase = "done";
    job.outcome = outcome;
    job.finishedAt = Date.now();
  }
  fail(job, failure) {
    job.phase = "failed";
    job.failure = failure;
    job.finishedAt = Date.now();
  }
  snapshot(job) {
    return {
      jobId: job.jobId,
      kind: job.kind,
      packageName: job.packageName,
      phase: job.phase,
      log: job.log,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      outcome: job.outcome === null ? null : { ...job.outcome },
      failure: job.failure === null ? null : { ...job.failure }
    };
  }
};
function runPnpmJob(job, args, dir, table) {
  return new Promise((resolve) => {
    table.append(job, "$ pnpm " + args.join(" ") + "\n");
    const child = spawn("pnpm", args, {
      cwd: dir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout?.on("data", (chunk) => {
      table.append(job, chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      table.append(job, chunk.toString());
    });
    child.on("error", (error) => {
      table.append(job, "spawn failed: " + error.message + "\n");
      resolve(null);
    });
    child.on("close", (code) => {
      table.exit(job, code);
      resolve(code);
    });
  });
}

// src/host/restart.ts
import { spawn as spawn2 } from "node:child_process";
var ENV_PARENT = "DSH_MARKETPLACE_RESTART_PARENT";
var ENV_EXECUTABLE = "DSH_MARKETPLACE_RESTART_EXECUTABLE";
var ENV_ARGS = "DSH_MARKETPLACE_RESTART_ARGS";
var ENV_CWD = "DSH_MARKETPLACE_RESTART_CWD";
var HELPER_SOURCE = String.raw`
const { spawn } = require('node:child_process')
const keys = [
  'DSH_MARKETPLACE_RESTART_PARENT',
  'DSH_MARKETPLACE_RESTART_EXECUTABLE',
  'DSH_MARKETPLACE_RESTART_ARGS',
  'DSH_MARKETPLACE_RESTART_CWD',
]
const decode = (name) => Buffer.from(process.env[name] || '', 'base64').toString('utf8')
const parentPid = Number(process.env.DSH_MARKETPLACE_RESTART_PARENT)
const executable = decode('DSH_MARKETPLACE_RESTART_EXECUTABLE')
const cwd = decode('DSH_MARKETPLACE_RESTART_CWD')
let args
try {
  args = JSON.parse(decode('DSH_MARKETPLACE_RESTART_ARGS'))
} catch {
  process.exit(2)
}
if (!Number.isInteger(parentPid) || parentPid <= 0 || executable === '' || cwd === '' || !Array.isArray(args)) {
  process.exit(2)
}
const env = { ...process.env }
for (const key of keys) delete env[key]
const deadline = Date.now() + 30000

function parentAlive() {
  try {
    process.kill(parentPid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function relaunch() {
  const child = spawn(executable, args, {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('error', () => { process.exit(4) })
  child.once('spawn', () => {
    child.unref()
    process.exit(0)
  })
}

function waitForParent() {
  if (!parentAlive()) {
    setTimeout(relaunch, 350)
    return
  }
  if (Date.now() >= deadline) {
    process.exit(3)
  }
  setTimeout(waitForParent, 100)
}

waitForParent()
`;
function currentRestartTarget() {
  return {
    parentPid: process.pid,
    executable: process.execPath,
    args: [...process.execArgv, ...process.argv.slice(1)],
    cwd: process.cwd(),
    env: process.env
  };
}
function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}
async function launchRestartHelper(target) {
  const helper = spawn2(process.execPath, ["-e", HELPER_SOURCE], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...target.env,
      [ENV_PARENT]: String(target.parentPid),
      [ENV_EXECUTABLE]: encode(target.executable),
      [ENV_ARGS]: encode(JSON.stringify(target.args)),
      [ENV_CWD]: encode(target.cwd)
    }
  });
  await new Promise((resolve, reject) => {
    helper.once("spawn", resolve);
    helper.once("error", reject);
  });
  helper.unref();
}
async function scheduleProcessRestart(shutdownDelayMs = 750) {
  await launchRestartHelper(currentRestartTarget());
  const timer = setTimeout(() => {
    if (process.platform === "win32") {
      const handled = process.emit("SIGTERM");
      if (!handled) process.exit(0);
      return;
    }
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(0);
    }
  }, shutdownDelayMs);
  timer.unref();
}

// src/host/registry.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
var PAGE_SIZE = 30;
var categorySchema = z.union([
  z.literal("ui"),
  z.literal("agents"),
  z.literal("developer-tools"),
  z.literal("models"),
  z.literal("data"),
  z.literal("integrations"),
  z.literal("media"),
  z.literal("security"),
  z.literal("observability"),
  z.literal("other")
]);
var discoverySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  windowDays: z.literal(7),
  plugins: z.array(z.object({
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    categories: z.array(categorySchema).min(1).max(3),
    starGrowth7d: z.number().int().nonnegative()
  }).strict())
}).strict();
var installSchema = z.object({
  mode: z.union([z.literal("automatic"), z.literal("guided")]),
  source: z.union([z.literal("github"), z.literal("npm"), z.literal("tarball"), z.literal("manual")]),
  spec: z.string(),
  profiles: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)),
  requiresBuildApproval: z.boolean(),
  requiresRestart: z.boolean(),
  manualSteps: z.boolean(),
  instructionsUrl: z.url()
}).strict();
var registryPluginBaseSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  description: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  language: z.string().nullable(),
  license: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  defaultBranch: z.string().min(1),
  verifiedCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  htmlUrl: z.url(),
  topics: z.array(z.string()),
  packageName: z.string().min(1),
  version: z.string().min(1),
  bundlePatch: z.string().min(1),
  hasClient: z.boolean(),
  verifiedAt: z.iso.datetime()
});
var registryV1Schema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  plugins: z.array(registryPluginBaseSchema.strict())
}).strict();
var registryV2Schema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  plugins: z.array(registryPluginBaseSchema.extend({ install: installSchema }).strict())
}).strict();
var RegistryConfigSchema = z.object({
  registryUrl: z.url().optional(),
  registryCacheMinutes: z.number().int().min(1).max(1440).default(15),
  registryRequestTimeoutMs: z.number().int().min(1e3).max(6e4).default(1e4)
}).default({
  registryCacheMinutes: 15,
  registryRequestTimeoutMs: 1e4
});
var RegistryError = class extends Error {
  code = "registry-unavailable";
  details;
  constructor(message, details = {}) {
    super(message);
    this.name = "RegistryError";
    this.details = details;
  }
};
var RegistryClient = class {
  cache;
  source;
  bundledSource;
  cacheMs;
  timeoutMs;
  constructor(source, bundledSource, cacheMs, timeoutMs) {
    this.source = source;
    this.bundledSource = bundledSource;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
  }
  /** Search only centrally verified entries. */
  async search(query, page, sort, category) {
    const registry = await this.load();
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const filtered = registry.plugins.filter((plugin) => {
      if (category !== "all" && !plugin.categories.includes(category)) return false;
      if (terms.length === 0) return true;
      const text = [
        plugin.fullName,
        plugin.packageName,
        plugin.description ?? "",
        plugin.language ?? "",
        ...plugin.topics,
        ...plugin.categories
      ].join("\n").toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
    filtered.sort((left, right) => {
      const primary = sort === "updated" ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt) : sort === "trending" ? right.starGrowth7d - left.starGrowth7d : right.stars - left.stars;
      if (primary !== 0) return primary;
      const secondary = sort === "trending" ? right.stars - left.stars : 0;
      return secondary !== 0 ? secondary : left.fullName.localeCompare(right.fullName);
    });
    const offset = (page - 1) * PAGE_SIZE;
    return {
      totalCount: filtered.length,
      items: filtered.slice(offset, offset + PAGE_SIZE),
      rate: { limit: 0, remaining: 0, reset: 0, source: "search" }
    };
  }
  /** Find one currently verified repository, case-insensitively. */
  async find(repo) {
    const normalized = repo.trim().toLocaleLowerCase();
    return (await this.load()).plugins.find((plugin) => plugin.fullName.toLocaleLowerCase() === normalized);
  }
  /** Find the Registry owner of one installed npm package name. */
  async findByPackage(packageName) {
    return (await this.load()).plugins.find((plugin) => plugin.packageName === packageName);
  }
  async load() {
    if (this.cache !== void 0 && Date.now() < this.cache.expiresAt) return this.cache.registry;
    try {
      return await this.loadSource(this.source);
    } catch (error) {
      if (this.cache !== void 0) {
        this.cache.expiresAt = Date.now() + Math.min(this.cacheMs, 6e4);
        return this.cache.registry;
      }
      if (this.source !== this.bundledSource) {
        try {
          return await this.loadSource(this.bundledSource);
        } catch (fallbackError) {
          throw unavailable(this.source, error, fallbackError);
        }
      }
      throw unavailable(this.source, error);
    }
  }
  async loadSource(source) {
    const url = new URL(source);
    let raw;
    let etag = null;
    if (url.protocol === "file:") {
      raw = JSON.parse(await readFile(url, "utf8"));
    } else if (url.protocol === "https:" || url.protocol === "http:") {
      const headers = { accept: "application/json" };
      if (this.cache?.source === source && this.cache.etag !== null) headers["if-none-match"] = this.cache.etag;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status === 304 && this.cache?.source === source) {
        this.cache.expiresAt = Date.now() + this.cacheMs;
        return this.cache.registry;
      }
      if (!response.ok) throw new Error(`Registry returned HTTP ${String(response.status)}`);
      raw = await response.json();
      etag = response.headers.get("etag");
    } else {
      throw new Error(`Unsupported Registry URL protocol ${JSON.stringify(url.protocol)}`);
    }
    const registry = applyDiscovery(normalizeRegistry(raw), await this.loadDiscovery(source));
    const names = /* @__PURE__ */ new Set();
    for (const plugin of registry.plugins) {
      const key = plugin.fullName.toLocaleLowerCase();
      if (names.has(key)) throw new Error(`Registry repeats repository ${JSON.stringify(plugin.fullName)}`);
      names.add(key);
      if (plugin.install.mode === "automatic") {
        const github = "github:" + plugin.fullName + "#" + plugin.verifiedCommit;
        const npm = plugin.packageName + "@" + plugin.version;
        const exact = plugin.install.source === "github" && plugin.install.spec.toLocaleLowerCase() === github.toLocaleLowerCase() || plugin.install.source === "npm" && plugin.install.spec === npm;
        if (!exact) {
          throw new Error(`Registry automatic install is not pinned to an exact verified source for ${JSON.stringify(plugin.fullName)}`);
        }
      }
    }
    this.cache = { registry, etag, expiresAt: Date.now() + this.cacheMs, source };
    return registry;
  }
  /** Discovery metadata is optional so custom and legacy registries still load. */
  async loadDiscovery(source) {
    try {
      const url = discoverySource(source);
      let raw;
      if (url.protocol === "file:") {
        raw = JSON.parse(await readFile(url, "utf8"));
      } else if (url.protocol === "https:" || url.protocol === "http:") {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) return void 0;
        raw = await response.json();
      } else {
        return void 0;
      }
      return discoverySchema.parse(raw);
    } catch {
      return void 0;
    }
  }
};
function normalizeRegistry(raw) {
  const version = typeof raw === "object" && raw !== null && "schemaVersion" in raw ? raw.schemaVersion : void 0;
  if (version === 2) {
    const current = registryV2Schema.parse(raw);
    return {
      ...current,
      plugins: current.plugins.map((plugin) => withDefaultDiscovery(plugin))
    };
  }
  const legacy = registryV1Schema.parse(raw);
  return {
    schemaVersion: 2,
    generatedAt: legacy.generatedAt,
    plugins: legacy.plugins.map((plugin) => withDefaultDiscovery({
      ...plugin,
      install: legacyInstall(plugin)
    }))
  };
}
function withDefaultDiscovery(plugin) {
  return { ...plugin, categories: ["other"], starGrowth7d: 0 };
}
function applyDiscovery(registry, discovery) {
  if (discovery === void 0) return registry;
  const rows = new Map(discovery.plugins.map((row) => [row.fullName.toLocaleLowerCase(), row]));
  return {
    ...registry,
    plugins: registry.plugins.map((plugin) => {
      const row = rows.get(plugin.fullName.toLocaleLowerCase());
      if (row === void 0) return plugin;
      return { ...plugin, categories: [...new Set(row.categories)], starGrowth7d: row.starGrowth7d };
    })
  };
}
function discoverySource(source) {
  const url = new URL(source);
  const slash = url.pathname.lastIndexOf("/");
  url.pathname = url.pathname.slice(0, slash + 1) + "discovery.json";
  return url;
}
function legacyInstall(plugin) {
  const profiles = plugin.hasClient ? ["web"] : [];
  return {
    mode: profiles.length > 0 ? "automatic" : "guided",
    source: "github",
    spec: "github:" + plugin.fullName + "#" + plugin.verifiedCommit,
    profiles,
    requiresBuildApproval: false,
    requiresRestart: true,
    manualSteps: profiles.length === 0,
    instructionsUrl: plugin.htmlUrl + "#readme"
  };
}
function unavailable(source, error, fallbackError) {
  return new RegistryError("The verified plugin Registry could not be loaded.", {
    source,
    cause: error instanceof Error ? error.message : String(error),
    ...fallbackError === void 0 ? {} : {
      fallbackCause: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
    }
  });
}

// src/host/profile.ts
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROFILE_BUNDLES,
  PROFILE_TEMPLATES,
  initProfile,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest
} from "@deepseek-ai/dsh-app-boot";

// src/host/bundle-state.ts
function reconcileBundleNames(beforeDependencies, dependencies, currentBundles, declaresBundle) {
  const before = new Set(beforeDependencies);
  const after = new Set(dependencies);
  const bundles = [...currentBundles];
  for (const packageName of after) {
    if (declaresBundle(packageName) && !bundles.includes(packageName) && !before.has(packageName)) {
      bundles.push(packageName);
    }
  }
  for (const packageName of [...bundles]) {
    const wasDependency = before.has(packageName) || after.has(packageName);
    const stillBundle = after.has(packageName) && declaresBundle(packageName);
    if (wasDependency && !stillBundle) bundles.splice(bundles.indexOf(packageName), 1);
  }
  return bundles;
}
function toggleBundleName(currentBundles, packageName, enabled) {
  const bundles = [...currentBundles];
  const index = bundles.indexOf(packageName);
  if (enabled && index < 0) bundles.push(packageName);
  if (!enabled && index >= 0) bundles.splice(index, 1);
  return bundles;
}

// src/host/profile.ts
var NAME = "dsh";
function profileLocation(ctx) {
  const baseUrl = ctx.baseUrl;
  if (baseUrl !== void 0) {
    let raw;
    if (typeof baseUrl === "string") {
      raw = /^[a-z][a-z0-9+.-]*:/.test(baseUrl) ? fileURLToPath(new URL(baseUrl)) : baseUrl;
    } else {
      raw = fileURLToPath(baseUrl);
    }
    const dir = /\.(yml|yaml|json)$/.test(basename(raw)) ? dirname(raw) : raw;
    const name = basename(dir);
    if (name !== "" && name !== "." && name !== "..") return { dir, name };
  }
  const fallback = "web";
  return { dir: resolveProfileDir(fallback), name: fallback };
}
function ensureProfile(dir, name) {
  if (!existsSync(join(dir, "package.json"))) {
    initProfile(dir, PROFILE_TEMPLATES[name] ?? DEFAULT_PROFILE_BUNDLES);
  }
}
function packageManifestPath(packageName, dir) {
  try {
    const require2 = createRequire(join(dir, "package.json"));
    return require2.resolve(packageName + "/package.json");
  } catch {
    return null;
  }
}
function exportsPatch(packageName, dir) {
  const path = packageManifestPath(packageName, dir);
  if (path === null) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const dsh = manifest.dsh;
    const bundle = dsh?.bundle;
    return typeof bundle?.patch === "string";
  } catch {
    return false;
  }
}
function installedVersion(packageName, dir) {
  const path = packageManifestPath(packageName, dir);
  if (path === null) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
function reconcileBundles(before, dir) {
  const after = readProfileManifest(NAME, dir);
  const beforeDeps = Object.keys(before.dependencies ?? {});
  const dependencies = Object.keys(after.dependencies ?? {});
  const current = after.dsh?.profile?.bundles ?? [];
  const plugins = reconcileBundleNames(beforeDeps, dependencies, current, (packageName) => exportsPatch(packageName, dir));
  if (!sameNames(current, plugins)) {
    after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } };
    writeProfileManifest(dir, after);
  }
  return after;
}
function setBundleEnabled(packageName, enabled, dir) {
  const manifest = readProfileManifest(NAME, dir);
  if (manifest.dependencies?.[packageName] === void 0 || !exportsPatch(packageName, dir)) return false;
  const current = manifest.dsh?.profile?.bundles ?? [];
  const bundles = toggleBundleName(current, packageName, enabled);
  if (!sameNames(current, bundles)) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
    writeProfileManifest(dir, manifest);
  }
  return true;
}
function sameNames(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function installedEntries(manifest, dir) {
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
  const entries = [];
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    const version = installedVersion(packageName, dir);
    if (version === null) continue;
    const declared = manifest.dependencies?.[packageName];
    const isBundle = exportsPatch(packageName, dir);
    entries.push({
      packageName,
      version,
      isBundle,
      enabled: isBundle && bundles.has(packageName),
      currentSpec: typeof declared === "string" ? declared : "",
      registryRepo: null,
      availableVersion: null,
      verifiedCommit: null,
      updateAvailable: false,
      canUpdate: false,
      install: null
    });
  }
  return entries.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

// src/host/index.ts
var NAME2 = "dsh";
var BUNDLED_REGISTRY_URL = new URL("../registry/plugins.json", import.meta.url).href;
var DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/YELEBAI/dsh-plugin-marketplace/main/registry/plugins.json";
function ok(value) {
  return { ok: true, value };
}
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}
function toFailure(error) {
  if (error instanceof GitHubError) {
    return fail(error.code, error.message, error.details);
  }
  if (error instanceof RegistryError) {
    return fail(error.code, error.message, error.details);
  }
  const message = error instanceof Error ? error.message : String(error);
  return fail("internal", message, {});
}
var _restart_dec, _installed_dec, _jobStatus_dec, _setEnabled_dec, _uninstall_dec, _update_dec, _installPlugin_dec, _details_dec, _search_dec, _a, _init;
var MarketplaceService = class extends (_a = TypertRemoteService, _search_dec = [Remote("search")], _details_dec = [Remote("details")], _installPlugin_dec = [Remote("installPlugin")], _update_dec = [Remote("update")], _uninstall_dec = [Remote("uninstall")], _setEnabled_dec = [Remote("setEnabled")], _jobStatus_dec = [Remote("jobStatus")], _installed_dec = [Remote("installed")], _restart_dec = [Remote("restart")], _a) {
  constructor(ctx, config) {
    super(ctx, "marketplace");
    __runInitializers(_init, 5, this);
    __publicField(this, "github", new GitHubClient());
    __publicField(this, "registry");
    __publicField(this, "jobs", new JobTable());
    __publicField(this, "pendingInstallResolution", 0);
    __publicField(this, "restartPending", false);
    const source = config.registryUrl ?? process.env.DSH_PLUGIN_REGISTRY_URL?.trim() ?? DEFAULT_REGISTRY_URL;
    new URL(source);
    this.registry = new RegistryClient(
      source,
      BUNDLED_REGISTRY_URL,
      config.registryCacheMinutes * 6e4,
      config.registryRequestTimeoutMs
    );
  }
  async search(request) {
    try {
      const page = Number.isInteger(request.page) && request.page >= 1 ? request.page : 1;
      const sort = request.sort === "updated" || request.sort === "trending" ? request.sort : "stars";
      const category = request.category === "all" ? "all" : request.category;
      return ok(await this.registry.search(request.query, page, sort, category));
    } catch (error) {
      return toFailure(error);
    }
  }
  async details(request) {
    try {
      return ok(await this.github.details(request.repo, request.ref ?? ""));
    } catch (error) {
      return toFailure(error);
    }
  }
  async installPlugin(request) {
    return this.startJob("install", request.repo, request.ref ?? "", (packageName) => {
      if (this.jobs.activeFor(packageName)) {
        return fail("job-running", "Another job is already running for " + packageName + ".");
      }
      return void 0;
    });
  }
  async update(request) {
    return this.startJob("update", request.repo, request.ref ?? "", (packageName) => {
      if (this.jobs.activeFor(packageName)) {
        return fail("job-running", "Another job is already running for " + packageName + ".");
      }
      return void 0;
    });
  }
  async uninstall(request) {
    try {
      if (this.restartPending) {
        return fail("restart-pending", "DSH is already preparing to restart.");
      }
      const packageName = request.packageName.trim();
      if (packageName === "" || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(packageName)) {
        return fail("bad-package", "Malformed package name: " + request.packageName);
      }
      const profile = profileLocation(this.ctx);
      ensureProfile(profile.dir, profile.name);
      if (this.jobs.activeFor(packageName)) {
        return fail("job-running", "Another job is already running for " + packageName + ".");
      }
      const before = readProfileManifest2(NAME2, profile.dir);
      const job = this.jobs.create("uninstall", packageName);
      void this.drive(job, profile, ["remove", packageName], before);
      return ok({ jobId: job.jobId });
    } catch (error) {
      return toFailure(error);
    }
  }
  async setEnabled(request) {
    try {
      if (this.restartPending) {
        return fail("restart-pending", "DSH is already preparing to restart.");
      }
      const packageName = request.packageName.trim();
      if (packageName === "" || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(packageName)) {
        return fail("bad-package", "Malformed package name: " + request.packageName);
      }
      if (this.jobs.activeFor(packageName)) {
        return fail("job-running", "Another job is already running for " + packageName + ".");
      }
      const profile = profileLocation(this.ctx);
      ensureProfile(profile.dir, profile.name);
      if (!setBundleEnabled(packageName, request.enabled, profile.dir)) {
        return fail("not-a-dsh-plugin", packageName + " is not an installed DSH bundle in profile " + profile.name + ".");
      }
      return ok({ packageName, enabled: request.enabled, requiresRestart: true });
    } catch (error) {
      return toFailure(error);
    }
  }
  async jobStatus(request) {
    const job = this.jobs.get(request.jobId);
    if (job === void 0) {
      return fail("job-missing", "Unknown job: " + request.jobId);
    }
    return ok(this.jobs.snapshot(job));
  }
  async installed() {
    try {
      const profile = profileLocation(this.ctx);
      const entries = installedEntries(readProfileManifest2(NAME2, profile.dir), profile.dir);
      await Promise.all(entries.map(async (entry) => {
        const registered = await this.registry.findByPackage(entry.packageName);
        if (registered === void 0) return;
        entry.registryRepo = registered.fullName;
        entry.availableVersion = registered.version;
        entry.verifiedCommit = registered.verifiedCommit;
        entry.install = registered.install;
        const versionOrder = compareSemver(registered.version, entry.version);
        entry.updateAvailable = versionOrder > 0 || versionOrder === 0 && registered.install.source === "github" && isGitHubSpec(entry.currentSpec) && !entry.currentSpec.toLocaleLowerCase().includes(registered.verifiedCommit.toLocaleLowerCase());
        entry.canUpdate = registered.install.mode === "automatic" && (registered.install.source === "github" || registered.install.source === "npm") && registered.install.profiles.includes(profile.name) && registered.install.spec !== "";
      }));
      return ok({ profile: profile.name, entries });
    } catch (error) {
      return toFailure(error);
    }
  }
  async restart() {
    try {
      if (this.restartPending) {
        return fail("restart-pending", "DSH is already preparing to restart.");
      }
      if (this.pendingInstallResolution > 0 || this.jobs.hasActive()) {
        return fail("job-running", "Wait for all plugin install, update, or uninstall jobs to finish before restarting DSH.");
      }
      const profile = profileLocation(this.ctx);
      this.restartPending = true;
      try {
        await scheduleProcessRestart();
      } catch (error) {
        this.restartPending = false;
        throw error;
      }
      return ok({ accepted: true, profile: profile.name });
    } catch (error) {
      return toFailure(error);
    }
  }
  /** Shared install/update pipeline: resolve → gate → spawn detached job. */
  async startJob(kind, repo, ref, gate) {
    if (this.restartPending) {
      return fail("restart-pending", "DSH is already preparing to restart.");
    }
    this.pendingInstallResolution += 1;
    try {
      const registered = await this.registry.find(repo);
      if (registered === void 0) {
        return fail("not-in-registry", repo + " is not present in the verified DSH plugin Registry.");
      }
      if (ref !== "" && ref.toLocaleLowerCase() !== registered.verifiedCommit.toLocaleLowerCase()) {
        return fail("unverified-ref", "The requested ref is not the commit approved by the DSH plugin Registry.", {
          requestedRef: ref,
          verifiedCommit: registered.verifiedCommit
        });
      }
      const details = await this.github.details(registered.fullName, registered.verifiedCommit);
      const manifest = details.manifest;
      if (manifest === null || manifest.bundlePatch === null || details.patch === null) {
        return fail(
          "not-a-dsh-plugin",
          details.repo + " no longer provides the Registry-verified DSH bundle files."
        );
      }
      if (manifest.name !== registered.packageName || manifest.bundlePatch !== registered.bundlePatch) {
        return fail("registry-mismatch", details.repo + " no longer matches its verified Registry identity.");
      }
      const packageName = manifest.name;
      const gated = gate(packageName);
      if (gated !== void 0) return gated;
      const profile = profileLocation(this.ctx);
      ensureProfile(profile.dir, profile.name);
      if (registered.install.mode !== "automatic" || !registered.install.profiles.includes(profile.name) || registered.install.spec === "") {
        return fail("guided-install", "This plugin needs its author's guided installation steps.", {
          profile: profile.name,
          supportedProfiles: registered.install.profiles,
          instructionsUrl: registered.install.instructionsUrl
        });
      }
      const before = readProfileManifest2(NAME2, profile.dir);
      if (kind === "install" && before.dependencies?.[packageName] !== void 0) {
        return fail("already-installed", packageName + " is already installed \u2014 use Update instead.");
      }
      if (kind === "update" && before.dependencies?.[packageName] === void 0) {
        return fail("not-installed", packageName + " is not installed in profile " + profile.name + ".");
      }
      const job = this.jobs.create(kind, packageName);
      const spec = executableSpec(registered);
      void this.drive(job, profile, ["add", spec], before, registered.install.requiresRestart);
      return ok({ jobId: job.jobId });
    } catch (error) {
      return toFailure(error);
    } finally {
      this.pendingInstallResolution -= 1;
    }
  }
  /** Detached job body: pnpm → reconcile → settle; failures land in the job. */
  async drive(job, profile, args, before, requiresRestart = true) {
    try {
      this.jobs.phase(job, "running");
      const code = await runPnpmJob(job, args, profile.dir, this.jobs);
      if (code !== 0) {
        const hint = code === null ? "pnpm could not be spawned \u2014 is pnpm on PATH?" : "pnpm exited with code " + String(code) + ". See the job log for details.";
        this.jobs.fail(job, { code: "pnpm-failed", message: hint });
        return;
      }
      this.jobs.phase(job, "reconciling");
      const after = reconcileBundles(before, profile.dir);
      void after;
      const version = installedVersion(job.packageName, profile.dir) ?? "unknown";
      this.jobs.settle(job, { packageName: job.packageName, version, requiresRestart });
    } catch (error) {
      this.jobs.fail(job, {
        code: "install-failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "search", _search_dec, MarketplaceService);
__decorateElement(_init, 1, "details", _details_dec, MarketplaceService);
__decorateElement(_init, 1, "installPlugin", _installPlugin_dec, MarketplaceService);
__decorateElement(_init, 1, "update", _update_dec, MarketplaceService);
__decorateElement(_init, 1, "uninstall", _uninstall_dec, MarketplaceService);
__decorateElement(_init, 1, "setEnabled", _setEnabled_dec, MarketplaceService);
__decorateElement(_init, 1, "jobStatus", _jobStatus_dec, MarketplaceService);
__decorateElement(_init, 1, "installed", _installed_dec, MarketplaceService);
__decorateElement(_init, 1, "restart", _restart_dec, MarketplaceService);
__decoratorMetadata(_init, MarketplaceService);
__publicField(MarketplaceService, "inject", []);
__publicField(MarketplaceService, "Config", RegistryConfigSchema);
function executableSpec(plugin) {
  if (plugin.install.source === "github") {
    const expected = "github:" + plugin.fullName + "#" + plugin.verifiedCommit;
    if (plugin.install.spec.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
      throw new RegistryError("Registry GitHub install spec does not match the verified repository commit.", {
        repository: plugin.fullName
      });
    }
    return expected;
  }
  if (plugin.install.source === "npm") {
    const expected = plugin.packageName + "@" + plugin.version;
    if (plugin.install.spec !== expected) {
      throw new RegistryError("Registry npm install spec does not match the verified package version.", {
        repository: plugin.fullName
      });
    }
    return expected;
  }
  throw new RegistryError("Only Registry entries pinned to an exact GitHub commit or verified npm release can be installed automatically.");
}
function isGitHubSpec(value) {
  return /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.test(value);
}
function compareSemver(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (match === null) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? []
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return left === right ? 0 : -1;
  for (let index = 0; index < 3; index += 1) {
    const av = a.core[index];
    const bv = b.core[index];
    if (av !== bv) return av > bv ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const maximum = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < maximum; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === void 0 || bv === void 0) return av === void 0 ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av.localeCompare(bv) > 0 ? 1 : -1;
  }
  return 0;
}
var index_default = MarketplaceService;
export {
  MarketplaceService,
  index_default as default
};
