import Nexus from '@nexusmods/nexus-api';
import Bluebird = require('bluebird');
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
export declare type ModInfoStatus = 'unpublished' | 'published' | 'hidden' | 'revoked';
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
    archived?: boolean;
    status?: ModInfoStatus;
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
export interface IQuery {
    hash?: string;
    expression?: string;
    name?: string;
    versionMatch?: string;
    size?: number;
}
export interface IServer {
    nexus?: Nexus;
    url: string;
    loopbackCB?: (query: IQuery) => Bluebird<ILookupResult[]>;
    cacheDurationSec: number;
    priority?: number;
}
