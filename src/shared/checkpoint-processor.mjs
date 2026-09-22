import { acceptBatchResult, ContentWriteError, ensureDirectoryChain } from "./content-objects.mjs";
import { embeddedImages, renderCheckpointInput, validateCheckpointOverview } from "./checkpoint.mjs";
import { observation as processObservation } from "./observe.mjs";
import { SessionMirror } from "../session-mirror.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled"]);
function mediaExtension(mimeType) {
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "png";
  }
}

function taskError(task) {
  const cancelled = task?.status === "cancelled";
  return {
    errorClass: "protocol",
    errorCode: cancelled ? "task_cancelled" : "task_failed",
    message: cancelled ? "checkpoint VLM task was cancelled" : "checkpoint VLM task failed",
  };
}

export class OpenVikingCheckpointProcessor {
  constructor(client, { observation = processObservation } = {}) {
    this.client = client;
    this.observe = observation;
    this.createdDirectories = new Set();
    this.mirrors = new Map();
  }

  // loadEvents 只在会话尚无输入时调用：处理中轮询只读任务状态，不得每轮重放 Archive 展开。
  // checkpoint_process 随之只覆盖真正处理事件的执行；纯状态轮询由 checkpoint_request 与
  // client_http 记录承担可见性。
  async advance({ taskId, manifest, loadEvents, previousCheckpoint }) {
    let op = null;
    let outcome = "processing";
    try {
      let mirror = this.mirrors.get(taskId);
      if (!mirror) {
        mirror = new SessionMirror(this.client, this.client.cfg?.stateDir ?? join(homedir(), ".openviking", "omp-ov-memory"), taskId);
        this.mirrors.set(taskId, mirror);
      }
      const session = await this.client.getSession(taskId);
      const sessionMissing = !session.ok && (session.status === 404 || session.error?.code === "NOT_FOUND");
      if (!sessionMissing && (!session.ok || !session.result)) {
        return { status: "pending", error: { errorClass: "transport", errorCode: "session_read", message: "checkpoint session is unavailable" } };
      }

      const messageCount = Math.max(0, Number(session.result?.message_count) || 0);
      const commitCount = Math.max(0, Number(session.result?.commit_count) || 0);
      // Phase 1 can move input into a pending native archive before commit_count
      // advances. The cumulative count prevents reloading it on every poll.
      const totalMessageCount = Math.max(messageCount, Number(session.result?.total_message_count) || 0);
      let providerTaskId = null;

      if (totalMessageCount === 0 && commitCount === 0) {
        // Adaptation for v0.4.20: messages does not provision a missing session.
        if (sessionMissing && !await this.client.createSession(taskId)) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "session_create", message: "checkpoint session creation is pending" } };
        }
        const events = await loadEvents();
        if (!events) return { status: "pending" };
        op = this.observe.begin("checkpoint_process", events.length, embeddedImages(events).length);
        const media = await this.prepareMedia(taskId, events);
        if (!media) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "media_prepare", message: "checkpoint media preparation is pending" } };
        }
        const input = renderCheckpointInput(manifest, events, previousCheckpoint, media);
        const added = await mirror.sync([{type: "message", id: "checkpoint-input", parentId: null,
          timestamp: "1970-01-01T00:00:00.000Z", message: {role: "user", content: input}}]);
        if (!added) return { status: "pending", error: { errorClass: "transport", errorCode: "message_add", message: "checkpoint input submission is pending" } };
      }

      if (commitCount === 0) {
        // A timed-out append can have reached the server before this process
        // restarted. Reconcile its durable intent from source IDs before commit;
        // sync([]) cannot submit a replacement checkpoint input.
        if (!await mirror.sync([])) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "message_reconcile", message: "checkpoint input outcome is pending reconciliation" } };
        }
        const committed = await mirror.commit();
        if (!committed) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "session_commit", message: "checkpoint VLM submission is pending" } };
        }
        // A guarded commit's task is discovered from the server after acceptance.
        providerTaskId = null;
      }

      if (!providerTaskId) {
        const listed = await this.client.listTasks(taskId);
        if (!listed.ok || !Array.isArray(listed.result)) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "task_list", message: "checkpoint task status is unavailable" } };
        }
        const tasks = [...listed.result].sort((a, b) => Number(b?.created_at || 0) - Number(a?.created_at || 0));
        providerTaskId = typeof tasks[0]?.task_id === "string" ? tasks[0].task_id : null;
      }
      if (!providerTaskId) {
        return { status: "pending", error: { errorClass: "protocol", errorCode: "task_missing", message: "checkpoint commit returned no task" } };
      }

      const taskResponse = await this.client.getTask(providerTaskId);
      if (!taskResponse.ok || !taskResponse.result) {
        return { status: "pending", error: { errorClass: "transport", errorCode: "task_read", message: "checkpoint task status is unavailable" } };
      }
      const task = taskResponse.result;
      if (!TERMINAL_TASK_STATES.has(task.status)) {
        const taskCreatedAtMs = Number(task.created_at) * 1000;
        return {
          status: "processing",
          // 服务器侧 task 创建时刻是悬挂判定的起点：媒体准备发生在 task 创建前，不计入生成超时。
          taskCreatedAtMs: Number.isFinite(taskCreatedAtMs) ? taskCreatedAtMs : null,
        };
      }
      if (task.status !== "completed") {
        outcome = "failed";
        return { status: "failed", error: taskError(task) };
      }

      const context = await this.client.getSessionContext(taskId);
      const overview = context.ok && typeof context.result?.latest_archive_overview === "string"
        ? context.result.latest_archive_overview.trim()
        : "";
      if (!overview) {
        outcome = "failed";
        return {
          status: "failed",
          error: { errorClass: "protocol", errorCode: "empty_output", message: "checkpoint VLM completed without a working-memory overview" },
        };
      }
      let normalizedOverview;
      try {
        normalizedOverview = validateCheckpointOverview(overview);
      } catch {
        outcome = "failed";
        return {
          status: "failed",
          error: { errorClass: "protocol", errorCode: "invalid_output", message: "checkpoint VLM completed without a valid unified continuation" },
        };
      }
      outcome = "completed";
      return { status: "completed", overview: normalizedOverview };
    } finally {
      if (op !== null) this.observe.end("checkpoint_process", op, outcome);
    }
  }

  async prepareMedia(taskId, events) {
    const images = embeddedImages(events);
    if (images.length === 0) return [];
    const userRoot = this.client.userRoot;
    const taskRoot = `${userRoot}/resources/.pi-openviking/checkpoint-inputs/v1/${taskId}`;
    await ensureDirectoryChain(this.client, `${userRoot}/resources`, taskRoot, this.createdDirectories);
    const media = [];
    for (const [index, image] of images.entries()) {
      const uri = `${taskRoot}/image-${String(index).padStart(4, "0")}.${mediaExtension(image.mimeType)}`;
      // Use the compatibility adapter; raw legacy preconditions are rejected by v0.4.20.
      const response = await this.client.batchWrite({
        root_uri: taskRoot,
        operations: [{uri, content_base64: image.bytes.toString("base64"), precondition: {kind: "create_if_absent"}}],
        wait: false,
      });
      // 响应判定收敛到协议层：形状、root_uri 与 URI 全覆盖由 acceptBatchResult 保证，
      // 失败以 ContentWriteError 体系分类。create_if_absent 下 updated 意味着服务端改写了
      // 字节，VLM 输入不再可信，按协议失败处理而不是静默接受。
      const accepted = acceptBatchResult(response, taskRoot, [uri]);
      if (accepted.updated.has(uri)) {
        throw new ContentWriteError("OpenViking modified a checkpoint media object", { uri });
      }
      const abstract = await this.client.abstract(uri);
      if (typeof abstract !== "string" || !abstract.trim()) return null;
      media.push({
        eventId: image.eventId,
        mimeType: image.mimeType,
        byteLength: image.bytes.length,
        contentHash: image.contentHash,
        abstract: abstract.trim(),
      });
    }
    return media;
  }

  async cleanup(taskId) {
    if (!/^cptask_[0-9a-f]{64}$/.test(taskId)) throw new TypeError("checkpoint cleanup requires a task id");
    const userRoot = String(this.client.userRoot || "").replace(/\/+$/, "");
    if (!/^viking:\/\/user\/[A-Za-z0-9._-]+(?:\/omp-ov-memory\/sessions\/[a-f0-9]{24,64})?$/.test(userRoot)) throw new TypeError("checkpoint cleanup requires a bound user root");
    const taskRoot = `${userRoot}/resources/.pi-openviking/checkpoint-inputs/v1/${taskId}`;
    // 被放弃的非终态 provider task（如上游连接中断后悬挂的 session_commit）先取消再删除，
    // 避免在服务器上留下永不终态的占用；取消是 best-effort，删除与回读才是清理的判定。
    try {
      const listed = await this.client.listTasks(taskId);
      if (listed.ok && Array.isArray(listed.result)) {
        for (const task of listed.result) {
          if (typeof task?.task_id === "string" && !TERMINAL_TASK_STATES.has(task.status)) {
            await this.client.cancelTask?.(task.task_id);
          }
        }
      }
    } catch { /* 取消失败不阻断删除 */ }
    await this.client.deleteSession(taskId);
    await this.client.delete(taskRoot, true);
    const [session, media] = await Promise.all([
      this.client.getSession(taskId),
      this.client.statUri(taskRoot),
    ]);
    const sessionGone = !session.ok && (session.status === 404 || session.error?.code === "NOT_FOUND");
    const mediaGone = media?.ok === true && media.exists === false;
    return sessionGone && mediaGone;
  }
}
