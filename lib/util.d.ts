import { IHashResult } from './types';
import * as Promise from 'bluebird';
export declare function genHash(filePath: string, onProgress?: (read: number, total: number) => void): Promise<IHashResult>;
