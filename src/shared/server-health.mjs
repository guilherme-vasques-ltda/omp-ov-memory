import { get } from "node:http";

const MAX_HEALTH_BODY_BYTES = 64 * 1024;

export function probeServerHealth(endpoint, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const req = get(`${endpoint}/health`, (res) => {
      let body = "";
      let tooLarge = false;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (tooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body) > MAX_HEALTH_BODY_BYTES) {
          tooLarge = true;
          body = "";
        }
      });
      res.on("end", () => {
        let data = null;
        if (!tooLarge) {
          try {
            data = JSON.parse(body);
          } catch {
            /* A malformed health response is not healthy. */
          }
        }
        const statusCode = res.statusCode ?? 0;
        finish({ ok: statusCode >= 200 && statusCode < 300 && data?.healthy === true, statusCode, data });
      });
      res.on("aborted", () => finish({ ok: false, statusCode: res.statusCode ?? 0, data: null }));
      res.on("error", () => finish({ ok: false, statusCode: res.statusCode ?? 0, data: null }));
    });
    deadline = setTimeout(() => {
      req.destroy();
      finish({ ok: false, statusCode: 0, data: null });
    }, timeoutMs);
    req.on("error", () => finish({ ok: false, statusCode: 0, data: null }));
  });
}
