"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
class Quota {
    constructor(init, max, msPerIncrement) {
        this.mLastCheck = Date.now();
        this.mCount = init;
        this.mMaximum = max;
        this.mMSPerIncrement = msPerIncrement;
    }
    wait() {
        return new Promise((resolve, reject) => {
            const now = Date.now();
            const recovered = Math.floor((now - this.mLastCheck) / this.mMSPerIncrement);
            this.mCount = Math.min(this.mCount + recovered, this.mMaximum);
            this.mLastCheck = now;
            --this.mCount;
            if (this.mCount >= 0) {
                return resolve();
            }
            else {
                setTimeout(resolve, this.mCount * this.mMSPerIncrement * -1);
            }
        });
    }
    setMax(newMax) {
        this.mMaximum = newMax;
    }
}
exports.default = Quota;
