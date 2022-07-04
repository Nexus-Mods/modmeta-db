declare class Debouncer {
    private mDebounceMS;
    private mFunc;
    private mTimer;
    private mCallbacks;
    private mAddCallbacks;
    private mRunning;
    private mReschedule;
    private mArgs;
    private mResetting;
    private mTriggerImmediately;
    private mRetrigger;
    constructor(func: (...args: any[]) => Error | PromiseLike<void>, debounceMS: number, reset?: boolean, triggerImmediately?: boolean);
    schedule(callback?: (err: Error) => void, ...args: any[]): void;
    runNow(callback?: (err: Error) => void, ...args: any[]): void;
    wait(callback: (err: Error) => void, immediately?: boolean): void;
    clear(): void;
    private run;
    private reschedule;
    private invokeCallbacks;
    private startTimer;
}
export default Debouncer;
