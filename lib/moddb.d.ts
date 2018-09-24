import * as Promise from 'bluebird';
import { ILookupResult, IModInfo } from './types';
export interface IServer {
    protocol: 'nexus' | 'metadb';
    url: string;
    apiKey?: string;
    cacheDurationSec: number;
}
export declare type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare type LogFunc = (level: LogLevel, message: string, extra?: any) => void;
declare class ModDB {
    private mDB;
    private mServers;
    private mModKeys;
    private mTimeout;
    private mGameId;
    private mBlacklist;
    private mLog;
    private mNexusQuota;
    static create(dbName: string, gameId: string, servers: IServer[], log?: LogFunc, database?: any, timeoutMS?: number): Promise<ModDB>;
    constructor(gameId: string, servers: IServer[], log?: LogFunc, timeoutMS?: number);
    connect(dbName: string, database: any): Promise<void>;
    close(): Promise<void>;
    setGameId(gameId: string): void;
    getByKey(key: string): Promise<ILookupResult[]>;
    getByLogicalName(logicalName: string, versionMatch: string): Promise<ILookupResult[]>;
    getByExpression(expression: string, versionMatch: string): Promise<ILookupResult[]>;
    insert(mod: IModInfo): Promise<void>;
    lookup(filePath?: string, fileMD5?: string, fileSize?: number, gameId?: string): Promise<ILookupResult[]>;
    private restGet;
    private queryServerLogical;
    private queryServerHash;
    private queryServerHashNexus;
    private queryServerHashMeta;
    private translateNexusGameId;
    private translateFromNexus;
    private readRange;
    private cacheResults;
    private getAllByKey;
    private resolveIndex;
    private getAllByLogicalName;
    private getAllByExpression;
    private makeKey;
    private makeNameLookup;
    private makeLogicalLookup;
    private missingKeys;
    private promisify;
}
export default ModDB;