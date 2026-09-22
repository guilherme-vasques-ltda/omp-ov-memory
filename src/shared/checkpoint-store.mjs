import {
  CHECKPOINT_MAX_ATTEMPTS,
  buildCheckpointEvent,
  buildCheckpointFailureEvent,
  buildCheckpointRequestEvent,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointId,
  checkpointRequestEventId,
  parseCheckpointEvent,
  parseCheckpointFailureEvent,
  parseCheckpointRequestEvent,
} from "./checkpoint.mjs";
import { ContentConflictError, withBusyRetry } from "./content-objects.mjs";
import { OpenVikingCheckpointProcessor } from "./checkpoint-processor.mjs";
import { observation as processObservation } from "./observe.mjs";

const initialState = () => ({
  mode: "caught_up",
  consumed: 0,
  pending: 0,
  backlogTokens: 0,
  lastCheckpointId: null,
  currentArchiveId: null,
  lastFailure: null,
});

const errorMessage = (error) => `${error?.name || "Error"}: ${error?.message || String(error)}`;

export class CheckpointManager {
  constructor(client, {
    adapter,
    archiveManager,
    processor = null,
    observation = processObservation,
    notify = () => {},
    onStateChange = () => {},
    pollIntervalMs = 2000,
    // 上游连接中断会让 provider task 永远停在非终态（OpenViking 0.4.15 不终态化 WM 创建失败）；
    // 超过该时限未到终态的 task 按 task_timeout 记入 failure 事实并进入既有重试链。
    taskTimeoutMs = 600_000,
    now = () => new Date().toISOString(),
  }) {
    this.adapter = adapter;
    this.archiveManager = archiveManager;
    this.processor = processor ?? new OpenVikingCheckpointProcessor(client, { observation });
    this.observe = observation;
    this.notify = notify;
    this.onStateChange = onStateChange;
    this.pollIntervalMs = pollIntervalMs;
    this.taskTimeoutMs = taskTimeoutMs;
    this.now = now;
    this.sessionId = null;
    this.archives = [];
    this.archiveChains = [];
    this.scopeVersion = 0;
    this.refreshTail = Promise.resolve();
    this.publicationVersion = 0;
    this.cleanedTaskIds = new Set();
    this.pendingCleanupTaskIds = new Set();
    // 事实不可变且身份由规范字节决定：已验证的事件内容在进程内缓存，轮询只重新探测缺失；
    // 键含 sessionId，同身份事件跨会话存放于不同位置，不可混用。
    this.factCache = new Map();
    this.state = initialState();
    this.current = null;
    this.timer = null;
    this.dirty = false;
    this.stopped = false;
    this.busyRetryController = new AbortController();
    this.observe.emit("checkpoint_state", "snapshot", this.state, null);
  }

  get status() {
    return { ...this.state };
  }

  schedule(sessionId, archives, archiveChains = [archives]) {
    if (this.stopped) return Promise.resolve();
    const byId = new Map();
    for (const descriptor of archives ?? []) {
      if (descriptor?.manifest?.archiveId) byId.set(descriptor.manifest.archiveId, descriptor);
    }
    const nextArchives = [...byId.values()];
    const nextChains = (archiveChains ?? []).map((chain) => {
      const unique = new Map();
      for (const descriptor of chain ?? []) {
        if (descriptor?.manifest?.archiveId) unique.set(descriptor.manifest.archiveId, descriptor);
      }
      return [...unique.values()];
    });
    const scopeChanged = sessionId !== this.sessionId || nextArchives.length < this.archives.length ||
      this.archives.some((descriptor, index) => {
        const next = nextArchives[index]?.manifest;
        return descriptor.manifest.archiveId !== next?.archiveId ||
          descriptor.manifest.contentHash !== next?.contentHash;
      });
    if (scopeChanged) this.scopeVersion++;
    this.sessionId = sessionId;
    this.archives = nextArchives;
    this.archiveChains = nextChains;
    this.dirty = true;
    return this.kick();
  }

  refresh() {
    const scanLatest = async () => {
      while (!this.stopped && this.sessionId) {
        const sessionId = this.sessionId;
        const archives = this.archives;
        const scopeVersion = this.scopeVersion;
        const publicationVersion = this.publicationVersion;
        const scan = await this.scanFacts(sessionId, archives);
        if (this.stopped) return;
        if (sessionId !== this.sessionId || archives !== this.archives || scopeVersion !== this.scopeVersion ||
            publicationVersion !== this.publicationVersion) continue;
        this.publishState(scan);
        return;
      }
    };
    this.refreshTail = this.refreshTail
      .then(scanLatest, scanLatest)
      .catch((error) => this.recordOperationalFailure(error, "reconcile", "pending_retry"));
    return this.refreshTail;
  }

  observeFinalState() {
    this.observe.emit("checkpoint_state", "snapshot", this.state, null);
  }

  async stop() {
    this.stopped = true;
    this.busyRetryController.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { await Promise.all([this.current, this.refreshTail]); } catch { /* status already records the failure */ }
  }


  kick() {
    if (this.current) return this.current;
    this.dirty = false;
    this.current = this.reconcile()
      .catch((error) => this.recordOperationalFailure(error, "reconcile", "pending_retry"))
      .finally(() => {
        this.current = null;
        if (!this.stopped && this.dirty) queueMicrotask(() => this.kick());
      });
    return this.current;
  }

  schedulePoll() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async reconcile() {
    const scope = {
      version: this.scopeVersion,
      sessionId: this.sessionId,
      archives: this.archives,
      archiveChains: this.archiveChains,
    };
    // scopeVersion only gates side effects that have not started. An append-only fact write already in
    // flight may win after a branch change; its Archive-bound identity remains valid, while the next scan
    // derives user-visible state solely from the new Archive scope.
    const currentScope = () => scope.version === this.scopeVersion;
    if (this.stopped || !currentScope() || !scope.sessionId) return;

    // Append-only request facts may arrive after a previous run; each reconciliation discovers them once,
    // outside the per-Archive loop, while pendingCleanupTaskIds retains only positive obligations.
    if (!await this.cleanupObsoleteRequests(
      scope.sessionId, scope.archives, scope.archiveChains, currentScope,
    )) return;
    while (!this.stopped && currentScope()) {
      const scan = await this.scanFacts(scope.sessionId, scope.archives);
      if (!currentScope()) return;
      this.publishState(scan);
      if (!await this.cleanupTerminalAttempts(scan.terminalTaskIds)) return;
      if (!currentScope() || !scan.current || scan.exhausted) return;

      const { manifest } = scan.current.descriptor;
      // Archive 展开是消费前最重的一次读取；任务事实（request/failure/session/task 状态）未要求
      // 事件正文时不得展开——处理中轮询每轮全量展开会把 stat/download 放大到会话级热点。
      const readExpanded = async () => {
        const source = await this.archiveManager.expand(scope.sessionId, manifest.archiveId);
        if (!currentScope()) return null;
        if (source.manifest.contentHash !== manifest.contentHash) {
          throw new Error("checkpoint source Archive changed after scheduling");
        }
        return source;
      };
      let expanded = null;
      const loadExpanded = async () => {
        if (!expanded) expanded = await readExpanded();
        return expanded;
      };

      let requestEvent = scan.current.requestEvent;
      let requestBranch = "resume";
      if (!requestEvent) {
        const stored = await loadExpanded();
        if (!stored) return;
        requestEvent = buildCheckpointRequestEvent({
          manifest: stored.manifest,
          previousCheckpointId: scan.previousCheckpoint?.checkpointId ?? null,
          attempt: scan.current.attempt,
          submittedAt: this.now(),
        });
        requestEvent = await this.writeFact(scope.sessionId, requestEvent);
        if (!currentScope()) return;
        requestBranch = "submit";
      }
      this.observe.emit("checkpoint_request", requestBranch, scan.current.attempt, scan.pending.length);

      const request = this.validateRequestEvent(
        requestEvent,
        scan.current.descriptor,
        scan.previousCheckpoint?.checkpointId ?? null,
        scan.current.attempt,
      );
      this.cleanedTaskIds.delete(request.taskId);
      let result = await this.processor.advance({
        taskId: request.taskId,
        manifest,
        loadEvents: async () => (await loadExpanded())?.events ?? null,
        previousCheckpoint: scan.previousCheckpoint,
      });
      if (!currentScope()) {
        this.observe.emit("checkpoint_request", "obsolete", request.attempt, scan.pending.length);
        this.pendingCleanupTaskIds.add(request.taskId);
        await this.cleanupAttempt(request.taskId);
        return;
      }
      // task 年龄以服务器侧创建时刻为准（不含媒体准备）；超时未到终态即转入既有的 failure 事实与重试链。
      if (result.status === "processing" && Number.isFinite(result.taskCreatedAtMs) &&
        Date.parse(this.now()) - result.taskCreatedAtMs > this.taskTimeoutMs) {
        result = {
          status: "failed",
          error: { errorClass: "protocol", errorCode: "task_timeout", message: "checkpoint VLM task timed out" },
        };
      }
      if (result.status === "processing" || result.status === "pending") {
        if (result.error) this.recordOperationalFailure(result.error, result.error.errorCode, "pending_retry");
        this.schedulePoll();
        return;
      }

      if (result.status === "failed") {
        const failureEvent = buildCheckpointFailureEvent({
          requestEvent,
          failedAt: this.now(),
          error: result.error,
        });
        const storedFailure = await this.writeFact(scope.sessionId, failureEvent);
        if (!currentScope()) {
          this.pendingCleanupTaskIds.add(request.taskId);
          await this.cleanupAttempt(request.taskId);
          return;
        }
        const failure = this.validateFailureEvent(storedFailure, requestEvent);
        const retrying = request.attempt < CHECKPOINT_MAX_ATTEMPTS;
        this.observe.emit(
          "checkpoint_failure",
          failure.error,
          failure.error.errorCode,
          retrying ? "retry" : "abort_operation",
          retrying ? "retry_attempt" : "retry_exhausted",
          scan.pending.length,
          scan.backlogTokens,
        );
        const action = retrying ? "将重试" : "重试已耗尽";
        this.notify(`OpenViking checkpoint 失败，${action}（Archive ${manifest.archiveId.slice(0, 12)}…）`, "warning");
        this.pendingCleanupTaskIds.add(request.taskId);
        if (!await this.cleanupAttempt(request.taskId)) return;
        continue;
      }

      // 完成路径重新展开 Archive，不能复用提交输入前的证明：checkpoint 只能引用 task 完成时仍自证的来源。
      const storedSource = await readExpanded();
      if (!storedSource || !currentScope()) {
        this.pendingCleanupTaskIds.add(request.taskId);
        await this.cleanupAttempt(request.taskId);
        return;
      }
      const checkpointEvent = buildCheckpointEvent({
        manifest: storedSource.manifest,
        requestEvent,
        overview: result.overview,
        completedAt: this.now(),
      });
      const storedCheckpoint = await this.writeFact(scope.sessionId, checkpointEvent);
      if (!currentScope()) {
        this.pendingCleanupTaskIds.add(request.taskId);
        await this.cleanupAttempt(request.taskId);
        return;
      }
      const acceptedCheckpoint = this.validateCheckpointEvent(
        storedCheckpoint, scan.current.descriptor, requestEvent,
      );
      this.observe.emit("checkpoint_request", "complete", request.attempt, Math.max(0, scan.pending.length - 1));
      const remaining = scan.pending.slice(1);
      this.publishState({
        ...scan,
        consumed: [...scan.consumed, { descriptor: scan.current.descriptor, checkpoint: acceptedCheckpoint }],
        pending: remaining,
        previousCheckpoint: acceptedCheckpoint,
        backlogTokens: remaining.reduce(
          (sum, descriptor) => sum + Math.max(0, Number(descriptor.tokenCount) || 0), 0,
        ),
        current: remaining[0] ? { descriptor: remaining[0], attempt: 1, requestEvent: null } : null,
        exhausted: false,
        lastFailure: null,
      });
      this.pendingCleanupTaskIds.add(request.taskId);
      if (!await this.cleanupAttempt(request.taskId)) return;
    }
  }

  async writeFact(sessionId, event) {
    try {
      const result = await withBusyRetry(
        () => this.adapter.writeEvents(sessionId, [event]),
        {
          signal: this.busyRetryController.signal,
          onRetry: (error) => this.observe.emit(
            "checkpoint_failure", error, "reconcile", "retry", "pending_retry",
            this.state.pending, this.state.backlogTokens,
          ),
        },
      );
      if (result.acceptedEventIds.length !== 1 || result.acceptedEventIds[0] !== event.eventId) {
        throw new Error("OpenViking did not accept the checkpoint fact");
      }
    } catch (error) {
      if (!(error instanceof ContentConflictError)) throw error;
      const raced = await this.readFact(sessionId, event.eventId);
      if (!raced) throw error;
      return raced.event;
    }
    // 回读本身就是接受证明：事实缺失时 readEvent 抛出，字节与 eventId 不符时
    // verifyRecordedEventBytes 抛出，因此这里不需要再复述同一判据。
    const stored = await this.adapter.readEvent(sessionId, event.eventId);
    this.factCache.set(`${sessionId}:${event.eventId}`, stored);
    return stored.event;
  }

  /** 读取并验证一条事实；已验证内容按身份缓存，缺失不缓存（轮询要发现后到的追加）。 */
  async readFact(sessionId, eventId) {
    const key = `${sessionId}:${eventId}`;
    if (this.factCache.has(key)) return this.factCache.get(key);
    const stored = await this.adapter.readEventIfExists(sessionId, eventId);
    if (stored) this.factCache.set(key, stored);
    return stored;
  }

  async cleanupAttempt(taskId) {
    if (this.cleanedTaskIds.has(taskId)) return true;
    try {
      const cleaned = await this.processor.cleanup(taskId);
      if (cleaned) {
        this.cleanedTaskIds.add(taskId);
        this.pendingCleanupTaskIds.delete(taskId);
        return true;
      }
      this.recordOperationalFailure(new Error("checkpoint temporary state remains"), "cleanup", "retain_fact");
    } catch (error) {
      this.recordOperationalFailure(error, "cleanup", "retain_fact");
    }
    return false;
  }

  async cleanupTerminalAttempts(taskIds) {
    let complete = true;
    for (const taskId of new Set([...this.pendingCleanupTaskIds, ...taskIds])) {
      if (!await this.cleanupAttempt(taskId)) complete = false;
    }
    return complete;
  }

  async cleanupObsoleteRequests(sessionId, currentArchives, archiveChains, currentScope) {
    const currentIds = new Set(currentArchives.map((descriptor) => descriptor.manifest.archiveId));
    const taskIds = new Set();
    for (const chain of archiveChains) {
      const previousCheckpointIds = [null];
      for (const descriptor of chain) {
        if (!currentScope()) return true;
        if (!currentIds.has(descriptor.manifest.archiveId)) {
          for (const previousCheckpointId of previousCheckpointIds) {
            for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
              const stored = await this.readFact(
                sessionId, checkpointRequestEventId(descriptor.manifest, previousCheckpointId, attempt),
              );
              if (!currentScope()) return true;
              if (!stored) continue;
              const request = this.validateRequestEvent(
                stored.event, descriptor, previousCheckpointId, attempt,
              );
              taskIds.add(request.taskId);
            }
          }
        }
        previousCheckpointIds.push(checkpointId(descriptor.manifest));
      }
    }

    if (!currentScope()) return true;
    for (const taskId of taskIds) this.pendingCleanupTaskIds.add(taskId);

    let complete = true;
    for (const taskId of taskIds) {
      if (!currentScope()) return true;
      if (!await this.cleanupAttempt(taskId)) complete = false;
    }
    return complete;
  }

  validateRequestEvent(event, descriptor, previousCheckpointId, attempt) {
    const request = parseCheckpointRequestEvent(event);
    const manifest = descriptor.manifest;
    if (event.parentId !== manifest.lastEventId || request.archiveId !== manifest.archiveId ||
        request.archiveHash !== manifest.contentHash || request.previousCheckpointId !== previousCheckpointId ||
        request.attempt !== attempt) {
      throw new Error("checkpoint request does not match the current Archive chain");
    }
    return request;
  }

  validateFailureEvent(event, requestEvent) {
    const failure = parseCheckpointFailureEvent(event);
    const request = parseCheckpointRequestEvent(requestEvent);
    if (event.parentId !== requestEvent.eventId || failure.taskId !== request.taskId ||
        failure.archiveId !== request.archiveId || failure.archiveHash !== request.archiveHash ||
        failure.attempt !== request.attempt) {
      throw new Error("checkpoint failure does not match its request");
    }
    return failure;
  }

  validateCheckpointEvent(event, descriptor, requestEvent) {
    const checkpoint = parseCheckpointEvent(event, descriptor.manifest);
    if (event.parentId !== requestEvent.eventId) {
      throw new Error("checkpoint does not match its request");
    }
    return checkpoint;
  }

  async validateStoredCheckpoint(sessionId, descriptor, previousCheckpoint, checkpointEvent) {
    const previousId = previousCheckpoint?.checkpointId ?? null;
    const terminalTaskIds = [];
    let gap = false;
    let matchedRequest = null;
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      const [requestStored, failureStored] = await Promise.all([
        this.readFact(
          sessionId,
          checkpointRequestEventId(descriptor.manifest, previousId, attempt),
        ),
        this.readFact(
          sessionId,
          checkpointFailureEventId(descriptor.manifest, previousId, attempt),
        ),
      ]);
      if (!requestStored) {
        if (failureStored) throw new Error("checkpoint failure exists without its request");
        gap = true;
        continue;
      }
      if (gap || matchedRequest) throw new Error("checkpoint request chain is not contiguous");
      const request = this.validateRequestEvent(requestStored.event, descriptor, previousId, attempt);
      if (failureStored) {
        this.validateFailureEvent(failureStored.event, requestStored.event);
        terminalTaskIds.push(request.taskId);
        continue;
      }
      if (checkpointEvent.parentId !== requestStored.event.eventId) {
        throw new Error("checkpoint has no matching request chain");
      }
      matchedRequest = requestStored.event;
      terminalTaskIds.push(request.taskId);
    }
    if (!matchedRequest) throw new Error("checkpoint has no matching request chain");
    return {
      checkpoint: this.validateCheckpointEvent(checkpointEvent, descriptor, matchedRequest),
      terminalTaskIds,
    };
  }
  async scanFacts(sessionId, archives) {
    const consumed = [];
    const pending = [];
    const terminalTaskIds = [];
    let previousCheckpoint = null;
    let sawPending = false;
    for (const descriptor of archives) {
      const stored = await this.readFact(sessionId, checkpointEventId(descriptor.manifest));
      if (stored) {
        if (sawPending) throw new Error("checkpoint chain contains a consumed Archive after an unconsumed gap");
        const validated = await this.validateStoredCheckpoint(sessionId, descriptor, previousCheckpoint, stored.event);
        terminalTaskIds.push(...validated.terminalTaskIds);
        previousCheckpoint = validated.checkpoint;
        consumed.push({ descriptor, checkpoint: validated.checkpoint });
      } else {
        sawPending = true;
        pending.push(descriptor);
      }
    }

    const backlogTokens = pending.reduce((sum, descriptor) => sum + Math.max(0, Number(descriptor.tokenCount) || 0), 0);
    if (pending.length === 0) {
      return { consumed, pending, previousCheckpoint, backlogTokens, current: null, exhausted: false, lastFailure: null, terminalTaskIds };
    }

    const descriptor = pending[0];
    const previousId = previousCheckpoint?.checkpointId ?? null;
    let current = null;
    let lastFailure = null;
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      const [requestStored, failureStored] = await Promise.all([
        this.readFact(
          sessionId,
          checkpointRequestEventId(descriptor.manifest, previousId, attempt),
        ),
        this.readFact(
          sessionId,
          checkpointFailureEventId(descriptor.manifest, previousId, attempt),
        ),
      ]);
      if (!requestStored) {
        if (failureStored) throw new Error("checkpoint failure exists without its request");
        current = { descriptor, attempt, requestEvent: null };
        break;
      }
      const request = this.validateRequestEvent(requestStored.event, descriptor, previousId, attempt);
      if (!failureStored) {
        current = { descriptor, attempt, requestEvent: requestStored.event };
        break;
      }
      const failure = this.validateFailureEvent(failureStored.event, requestStored.event);
      terminalTaskIds.push(request.taskId);
      lastFailure = failure.error.message;
    }
    return {
      consumed,
      pending,
      previousCheckpoint,
      backlogTokens,
      current,
      exhausted: current === null,
      lastFailure,
      terminalTaskIds,
    };
  }

  publishState(scan) {
    this.publicationVersion++;
    const previous = this.state;
    const mode = scan.pending.length === 0 ? "caught_up"
      : scan.exhausted ? "failed"
        : scan.pending.length >= 2 ? "lagging" : "processing";
    const next = {
      mode,
      consumed: scan.consumed.length,
      pending: scan.pending.length,
      backlogTokens: scan.backlogTokens,
      lastCheckpointId: scan.previousCheckpoint?.checkpointId ?? null,
      currentArchiveId: scan.current?.descriptor?.manifest?.archiveId ?? scan.pending[0]?.manifest?.archiveId ?? null,
      lastFailure: scan.lastFailure,
    };
    this.state = next;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.observe.emit("checkpoint_state", "change", previous, next);
      this.onStateChange(next);
      if (previous.mode !== "lagging" && next.mode === "lagging") {
        this.notify(`OpenViking checkpoint 消费落后：${next.pending} 个 Archive，约 ${next.backlogTokens} tokens`, "warning");
      } else if (previous.mode === "lagging" && (next.mode === "processing" || next.mode === "caught_up")) {
        this.notify("OpenViking checkpoint 消费已恢复", "info");
      }
    }
  }

  recordOperationalFailure(error, errorCode, branch) {
    const previous = this.state;
    this.state = { ...this.state, lastFailure: errorMessage(error) };
    this.observe.emit(
      "checkpoint_failure",
      error,
      String(errorCode || "reconcile").replace(/[^a-z0-9_]/g, "_").slice(0, 64),
      branch === "retain_fact" ? "ignore" : "retry",
      branch,
      this.state.pending,
      this.state.backlogTokens,
    );
    if (previous.lastFailure !== this.state.lastFailure) {
      this.observe.emit("checkpoint_state", "change", previous, this.state);
    }
    this.schedulePoll();
  }
}
