import * as Promise from 'bluebird';
import { ILookupResult, IModInfo, IServer, IReference } from './types';
export declare type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare type LogFunc = (level: LogLevel, message: string, extra?: any) => void;
export declare function svclean(input: string): string;
declare class ModDB {
    private mDB;
    private mServers;
    private mModKeys;
    private mTimeout;
    private mGameId;
    private mBlacklist;
    private mLog;
    private mRemainingExpires;
    private mExpireHour;
    private mNexusMD5Debouncer;
    private mMD5Requests;
    static create(dbName: string, gameId: string, servers: IServer[], log?: LogFunc, database?: any, timeoutMS?: number): Promise<ModDB>;
    constructor(gameId: string, servers: IServer[], log?: LogFunc, timeoutMS?: number);
    connect(dbName: string, database: any, attemptRepair?: boolean): Promise<void>;
    close(): Promise<void>;
    addServer(server: IServer): void;
    setGameId(gameId: string): void;
    getByReference(ref: IReference): Promise<ILookupResult[]>;
    getByKey(key: string, gameId?: string): Promise<ILookupResult[]>;
    getByLogicalName(logicalName: string, versionMatch: string): Promise<ILookupResult[]>;
    getByExpression(expression: string, versionMatch: string): Promise<ILookupResult[]>;
    private hashFileName;
    insert(mods: IModInfo[]): Promise<void>;
    list(): Promise<any>;
    lookup(filePath?: string, fileMD5?: string, fileSize?: number, gameId?: string): Promise<ILookupResult[]>;
    private repairDB;
    private restGet;
    private queryServerLogical;
    private queryServerExpression;
    private queryServerHash;
    private queryServerHashNexus;
    private queryServerHashMeta;
    private translateNexusGameId;
    private gameIdFromNexusDomain;
    private translateFromNexus;
    private convertModStatus;
    private translateFromGraphQL;
    private readRange;
    private cacheResults;
    private expireResults;
    private getAllByKey;
    private resolveIndex;
    private getAllByLogicalName;
    private getAllByExpression;
    private createKey;
    private makeKey;
    private makeNameLookup;
    private makeLogicalLookup;
    private missingKeys;
    private promisify;
    private putSafe;
    private getSafe;
}
export default ModDB;
