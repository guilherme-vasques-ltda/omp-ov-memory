/** Bound the entire operation; callers must fence state updates after a timeout. */
export async function within<T>(operation: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.catch(() => fallback),
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, milliseconds)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
