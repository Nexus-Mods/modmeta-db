import Nexus from '@nexusmods/nexus-api';
export interface IReference {
    fileMD5?: string;
    fileSize?: number;
    gameId?: string;
    versionMatch?: string;
    logicalFileName?: string;
    fileExpression?: string;
}
export declare type RuleType = 'before' | 'after' | 'requires' | 'conflicts' | 'recommends' | 'provides';
export interface IRule {
    type: RuleType;
    reference: IReference;
    comment?: string;
}
export interface IModInfo {
    fileName: string;
    fileSizeBytes: number;
    gameId: string;
    domainName?: string;
    logicalFileName?: string;
    fileVersion: string;
    fileMD5: string;
    sourceURI: any;
    source?: string;
    rules?: IRule[];
    expires?: number;
    details?: {
        homepage?: string;
        category?: string;
        description?: string;
        author?: string;
        modId?: string;
        fileId?: string;
    };
}
export interface ILookupResult {
    key: string;
    value: IModInfo;
}
export interface IIndexResult {
    key: string;
    value: string;
}
export interface IHashResult {
    md5sum: string;
    numBytes: number;
}
export interface IServer {
    nexus?: Nexus;
    url: string;
    cacheDurationSec: number;
}
