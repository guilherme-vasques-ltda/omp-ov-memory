// 内容进入任务模型上下文的权重策略。
//
// Archive 的压力轴和 ActiveContext 的容量判定必须使用同一策略量：前者决定"哪一段事件
// 构成一个 Archive"，后者决定"这段上下文是否还装得下"。两处若各自折算，同一段内容会
// 得到不同的上下文大小，预算与 eligibility 就无法互相校准。
//
// 折算按 UTF-8 字节数除以 4，而不是字符数除以 4：后者对 CJK 会低估约三倍，使同一预算
// 在不同语种下表达完全不同的上下文量。这个常数是策略量，最终值由端到端校准确定；同一
// 内容恒得同一权重，因此不依赖 provider 是否报告计量。

import { canonicalJsonBytes } from "./canonical-json.mjs";

export function contextTokenWeight(value) {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : canonicalJsonBytes(value ?? null).length;
  return Math.ceil(bytes / 4);
}

/** 一个事件的上下文权重：度量它实际进入上下文的内容，不是一次请求的累计 usage。 */
export function eventTokenWeight(event) {
  const part = event?.payload?.part;
  return contextTokenWeight(part ? part.value : event?.payload?.entry ?? null);
}
