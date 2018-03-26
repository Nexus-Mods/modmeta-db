/// <reference types="bluebird" />
import * as Promise from 'bluebird';
declare class Quota {
    private mCount;
    private mMaximum;
    private mMSPerIncrement;
    private mLastCheck;
    constructor(init: number, max: number, msPerIncrement: number);
    wait(): Promise<void>;
    setMax(newMax: number): void;
}
export default Quota;
