// Runs async jobs one at a time, in call order. Each addon routes start() and
// stop() through one of these so two callers (boot, the season-change
// handler, a Restart click) cannot interleave and kill each other's child.
export default class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(job: () => Promise<T>): Promise<T> {
        const result = this.tail.then(job);
        this.tail = result.catch(() => undefined);
        return result;
    }
}
