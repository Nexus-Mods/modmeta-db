"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Debouncer {
    constructor(func, debounceMS, reset, triggerImmediately = false) {
        this.mCallbacks = [];
        this.mAddCallbacks = [];
        this.mRunning = false;
        this.mReschedule = 'no';
        this.mArgs = [];
        this.mRetrigger = false;
        this.mResetting = reset !== false;
        this.mFunc = func;
        this.mDebounceMS = debounceMS;
        this.mTriggerImmediately = triggerImmediately;
    }
    schedule(callback, ...args) {
        if ((callback !== undefined) && (callback !== null)) {
            this.mCallbacks.push(callback);
        }
        this.mArgs = args;
        if (this.mTriggerImmediately && (this.mTimer === undefined)) {
            this.run();
        }
        else {
            const doReset = (this.mTimer !== undefined) && this.mResetting;
            if (doReset) {
                this.clear();
            }
            if (this.mTriggerImmediately) {
                this.mRetrigger = true;
                if (doReset) {
                    this.startTimer();
                }
            }
            else if (this.mRunning) {
                if (this.mReschedule !== 'immediately') {
                    this.mReschedule = 'yes';
                }
            }
            else if (this.mTimer === undefined) {
                this.startTimer();
            }
        }
    }
    runNow(callback, ...args) {
        if (this.mTimer !== undefined) {
            this.clear();
        }
        if ((callback !== undefined) && (callback !== null)) {
            this.mCallbacks.push(callback);
        }
        this.mArgs = args;
        if (this.mRunning) {
            this.mReschedule = 'immediately';
        }
        else {
            this.run();
        }
    }
    wait(callback, immediately = false) {
        if ((this.mTimer === undefined) && !this.mRunning) {
            return callback(null);
        }
        this.mAddCallbacks.push(callback);
        if (immediately && !this.mRunning) {
            this.clear();
            this.run();
        }
    }
    clear() {
        clearTimeout(this.mTimer);
        this.mTimer = undefined;
    }
    run() {
        const callbacks = this.mCallbacks;
        this.mCallbacks = [];
        const args = this.mArgs;
        this.mArgs = [];
        this.mTimer = undefined;
        let prom;
        try {
            prom = this.mFunc(...args);
        }
        catch (err) {
            prom = err;
        }
        if ((prom === null || prom === void 0 ? void 0 : prom['then']) !== undefined) {
            this.mRunning = true;
            prom['then'](() => this.invokeCallbacks(callbacks, null))
                .catch((err) => this.invokeCallbacks(callbacks, err))
                .finally(() => {
                this.mRunning = false;
                if (this.mReschedule === 'immediately') {
                    this.mReschedule = 'no';
                    this.run();
                }
                else if (this.mReschedule === 'yes') {
                    this.mReschedule = 'no';
                    this.reschedule();
                }
            });
        }
        else {
            this.invokeCallbacks(callbacks, prom);
        }
        if (this.mTriggerImmediately) {
            this.startTimer();
        }
    }
    reschedule() {
        if ((this.mTimer !== undefined) && this.mResetting) {
            this.clear();
        }
        if (this.mTimer === undefined) {
            this.startTimer();
        }
    }
    invokeCallbacks(localCallbacks, err) {
        localCallbacks.forEach((cb) => cb(err));
        this.mAddCallbacks.forEach((cb) => cb(err));
        this.mAddCallbacks = [];
    }
    startTimer() {
        this.mTimer = setTimeout(() => {
            this.mTimer = undefined;
            if (!this.mTriggerImmediately || this.mRetrigger) {
                this.mRetrigger = false;
                if (this.mRunning) {
                    this.mReschedule = 'immediately';
                }
                else {
                    this.run();
                }
            }
        }, this.mDebounceMS);
    }
}
exports.default = Debouncer;
