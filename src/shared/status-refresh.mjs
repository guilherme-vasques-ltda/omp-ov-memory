/**
 * Run an async status refresh at most once concurrently and publish only while active.
 * The caller owns the status data; this helper owns timer and in-flight lifecycle only.
 */
export function createStatusRefresh({
  refresh,
  publish,
  onError,
  intervalMs,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let timer = null;
  let inFlight = null;
  let generation = 0;

  const run = () => {
    if (inFlight) return inFlight;

    const currentGeneration = generation;
    const current = Promise.resolve()
      .then(refresh)
      .then((value) => {
        if (currentGeneration === generation) publish(value);
        return value;
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  const start = () => {
    if (timer) return;
    timer = setIntervalFn(() => {
      void run().catch(onError);
    }, intervalMs);
    timer.unref?.();
  };

  const stop = async () => {
    generation++;
    if (timer) clearIntervalFn(timer);
    timer = null;
    const pending = inFlight;
    if (!pending) return;
    try {
      await pending;
    } catch (error) {
      onError(error);
    }
  };

  return { run, start, stop };
}
