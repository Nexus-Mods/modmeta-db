import * as Promise from 'bluebird';
import levelup = require('levelup');
import * as minimatch from 'minimatch';

import * as encode from 'encoding-down';
import * as http from 'http';
import * as https from 'https';
import * as leveldown from 'leveldown';
import { NexusError, IMD5Result } from '@nexusmods/nexus-api';
import * as path from 'path';
import * as semver from 'semver';
import * as url from 'url';

import * as params from './parameters';
import {IHashResult, IIndexResult, ILookupResult, IModInfo, IServer, IReference} from './types';
import {genHash} from './util';

interface ILevelUpAsync extends levelup.LevelUp {
  getAsync?: (key: string) => Promise<any>;
  putAsync?: (key: string, data: any) => Promise<void>;
}

interface ILookupResultRaw {
  key: string;
  value: IModInfo[];
}

function fromRawReducer(prev: ILookupResult[], input: ILookupResultRaw): ILookupResult[] {
  input.value.forEach(val => {
    prev.push({ key: input.key, value: val });
  })
  return prev;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFunc = (level: LogLevel, message: string, extra?: any) => void;

// interface compatible with http and https module
interface IHTTP {
  request: (options: https.RequestOptions | string | URL,
            callback?: (res: http.IncomingMessage) => void) => http.ClientRequest;
  Agent: typeof http.Agent;
}

export function svclean(input: string): string {
  let res = semver.valid(semver.coerce(input));
  if (res !== null) {
    res = semver.clean(res);
  }
  return res || '0.0.0-' + input;
}

class HTTPError extends Error {
  private mCode: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.mCode = code;
  }

  public get code() {
    return this.mCode;
  }
}

/**
 * test if the specified string is a valid (md5) hash
 */
function isMD5Hash(input: string): boolean {
  if (input.length !== 32) {
    return false;
  }
  if (input.search(/[^A-Fa-f0-9]/) !== -1) {
    return false;
  }
  return true;
}

/**
 * The primary database interface.
 * This allows queries about meta information regarding a file and
 * will relay them to a remote server if not found locally
 */
class ModDB {
  private mDB: ILevelUpAsync;
  private mServers: IServer[];
  private mModKeys: string[];
  private mTimeout: number;
  private mGameId: string;
  private mBlacklist: Set<string> = new Set();
  private mLog: LogFunc;
  private mRemainingExpires: number = params.REFETCH_PER_HOUR;
  private mExpireHour: number = (new Date()).getHours();

  public static create(dbName: string,
              gameId: string,
              servers: IServer[],
              log?: LogFunc,
              database?: any,
              timeoutMS?: number): Promise<ModDB> {
    const res = new ModDB(gameId, servers, log, timeoutMS);
    return res.connect(dbName, database || encode((leveldown as any)(dbName)))
      .then(() => res);
  }

  /**
   * constructor
   *
   * @param {string} dbName name for the new databaes
   * @param {string} gameId default game id for lookups to the nexus api
   * @param {IServer} servers list of servers we synchronize with
   * @param {LogFunc} log function called for logging messages
   * @param {any} database the database backend to use. if not set, tries to use leveldb
   * @param {number} timeoutMS timeout in milliseconds for outgoing network requests.
   *                           defaults to 5 seconds
   */
  constructor(gameId: string,
              servers: IServer[],
              log?: LogFunc,
              timeoutMS?: number) {
    this.mModKeys = [
      'fileName',
      'fileVersion',
      'fileMD5',
      'fileSizeBytes',
      'sourceURI',
      'gameId',
    ];

    this.mGameId = gameId;
    this.mServers = servers;
    this.mTimeout = timeoutMS;
    this.mLog = log || (() => undefined);
  }

  public connect(dbName: string, database: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.mDB = (levelup as any)(database, {keyEncoding: 'utf8', valueEncoding: 'utf8'}, (err, db) => {
        if (err) {
          reject(err);
        } else {
          this.mDB = db;
          resolve();
        }
      });
    })
    .then(() => {
      this.promisify();
    });
  }

  /**
   * close meta database
   */
  public close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.mDB.close((err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  public addServer(server: IServer) {
    this.mServers.push(server);
  }

  /**
   * update the gameId which is used as the default for lookups to the nexus
   * api if the game id of the file being looked up isn't provided
   *
   * @param {string} gameId
   *
   * @memberOf ModDB
   */
  public setGameId(gameId: string) {
    this.mGameId = gameId.toLowerCase();
  }

  /**
   * retrieve a mod using a reference as part it was returned from other lookup calls
   * @param ref the reference to look up
   */
  public getByReference(ref: IReference): Promise<ILookupResult[]> {
    if (ref.fileMD5 !== undefined) {
      if ((ref.fileSize !== undefined) && (ref.gameId !== undefined)) {
        return this.getByKey(this.createKey(ref.fileMD5, ref.fileSize, ref.gameId), ref.gameId);
      } else {
        return this.getByKey(ref.fileMD5, ref.gameId);
      }
    } else if (ref.logicalFileName !== undefined) {
      return this.getByLogicalName(ref.logicalFileName, ref.versionMatch);
    } else if (ref.fileExpression !== undefined) {
      return this.getByExpression(ref.fileExpression, ref.versionMatch);
    } else {
      // empty mod reference, no way we could find anything
      return Promise.resolve([]);
    }
  }

  /**
   * retrieve a mod if the hash (or a full key) is already known
   *
   * @param {string} key the hash or full key (<hash>:<size>:<gameid>) to look up
   * @param {string} gameId the game id to look up. This will only have an effect if the first parameter
   *                        contains only the hash, in which case the result will be filtered to contain
   *                        only the game id.
   * @returns {Promise<ILookupResult[]>}
   *
   * @memberOf ModDB
   */
  public getByKey(key: string, gameId?: string): Promise<ILookupResult[]> {
    if (this.mDB.isClosed()) {
      // database already closed
      return Promise.resolve([]);
    }

    return this.getAllByKey(key, gameId || this.mGameId);
  }

  /**
   * retrieve mods by their logical name and version
   * does not work on nexus servers
   */
  public getByLogicalName(logicalName: string, versionMatch: string): Promise<ILookupResult[]> {
    if (this.mDB.isClosed()) {
      // database already closed
      return Promise.resolve([]);
    }

    return this.getAllByLogicalName(logicalName, versionMatch);
  }

  /**
   * retrieve mods by a file expression match and version
   * does not work on nexus servers
   */
  public getByExpression(expression: string, versionMatch: string): Promise<ILookupResult[]> {
    if (this.mDB.isClosed()) {
      // database already closed
      return Promise.resolve([]);
    }

    return this.getAllByExpression(expression, versionMatch);
  }

  /**
   * insert a mod into the database, potentially overwriting
   * existing data
   *
   * @param {IModInfo} mod
   * @returns {Promise<void>}
   *
   * @memberOf ModDB
   */
  public insert(mods: IModInfo[]): Promise<void> {
    try {
      const groups: { [key: string]: IModInfo[] } = mods.reduce((prev, mod) => {
        const missingKeys = this.missingKeys(mod);
        if (missingKeys.length !== 0) {
          throw new Error('Invalid mod object. Missing keys: ' +
            missingKeys.join(', '));
        }
        const key = this.makeKey(mod);
        if (prev[key] === undefined) {
          prev[key] = [];
        }
        prev[key].push(mod);
        return prev;
      }, {});
      return Promise.map(Object.keys(groups), key =>
        this.putSafe(key, JSON.stringify(groups[key]))
          .then(() => Promise.map(groups[key], mod =>
            this.putSafe(this.makeNameLookup(mod), key)))
          .then(() => Promise.map(groups[key], mod =>
            this.putSafe(this.makeLogicalLookup(mod), key))))
        .then(() => null);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  public list(): Promise<any> {
    return new Promise((resolve, reject) => {
      let result = {};
      this.mDB.createReadStream()
        .on('data', (data: { key: string, value: string }) => {
          try {
            result[data.key] = data.value;
          } catch (err) {
            this.mLog('warn', 'Invalid data stored for', data.key);
          }
        })
        .on('error', (err) => reject(err))
        .on('end', () => resolve(result));

    })
  }

  /**
   * look up the meta information for the mod identified by the
   * parameters.
   * Please note that this may return multiple results, i.e. if
   * the same file has been uploaded for multiple games and gameId
   * is left undefined
   *
   * @param {string} filePath
   * @param {string} fileMD5
   * @param {number} fileSize
   * @param {string} [gameId]
   * @returns {Promise<ILookupResult[]>}
   *
   * @memberOf ModDB
   */
  public lookup(filePath?: string, fileMD5?: string, fileSize?: number,
                gameId?: string): Promise<ILookupResult[]> {
    if (gameId !== undefined) {
      gameId = gameId.toLowerCase();
    }
    let hashResult: string = fileMD5;
    let hashFileSize: number = fileSize;

    if ((filePath === undefined) && (fileMD5 === undefined)) {
      return Promise.resolve([]);
    }

    const promise = fileMD5 !== undefined
      ? Promise.resolve()
      : genHash(filePath).then((res: IHashResult) => {
        hashResult = res.md5sum;
        hashFileSize = res.numBytes;
        return Promise.resolve();
      });

    return promise.then(() => {
      let lookupKey = this.createKey(hashResult, hashFileSize, gameId);
      return this.getAllByKey(lookupKey, gameId)
        .tap(result => {
          // if the result is empty, put whatever we know in the cache,
          // just to avoid re-querying the server
          if (result.length === 0) {
            this.insert([{
              fileMD5: hashResult,
              fileName: filePath !== undefined ? path.basename(filePath) : undefined,
              fileSizeBytes: hashFileSize,
              fileVersion: '',
              gameId,
              sourceURI: '',
              expires: Date.now() + params.EXPIRE_INVALID_SEC,
            }]);
          }
        });
    });
  }

  private restGet(urlString: string, addHeaders: any = {}): Promise<any> {
    const parsed = url.parse(urlString);
    const lib: IHTTP = parsed.protocol === 'https:' ? https : http;
    return new Promise<any>((resolve, reject) => {
      const params: http.RequestOptions = {
        method: 'GET',
        protocol: parsed.protocol,
        port: parsed.port,
        hostname: parsed.hostname,
        path: parsed.path,
        headers: {
          'Content-Type': 'application/json',
          ...addHeaders
        },
        timeout: this.mTimeout || 5000,
        agent: new lib.Agent(),
      };
      lib.request(params, (res: http.IncomingMessage) => {
        if (res.statusCode === 200) {
          res.setEncoding('utf8');
          let data = '';
          res
            .on('data', buf => data += buf)
            .on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (err) {
                reject(new Error('Invalid response: ' + err.message));
              }
            });

        } else {
          reject(new HTTPError(res.statusCode, res.statusMessage));
        }
      })
      .on('error', err => {
        reject(err);
      })
      .end();
    });
  }

  private queryServerLogical(server: IServer, logicalName: string,
                             versionMatch: string): Promise<ILookupResult[]> {
    if (server.nexus !== undefined) {
      // not supported
      return Promise.resolve([]);
    }

    const url = `${server.url}/by_name/${logicalName}/${versionMatch}`;
    return this.restGet(url);
  }

  private queryServerHash(server: IServer, gameId: string, hash: string, size: number): Promise<ILookupResult[]> {
    if (!isMD5Hash(hash)) {
      // avoid querying a server with an invalid hash
      return Promise.resolve([]);
    }
    if (server.nexus !== undefined) {
      return this.queryServerHashNexus(server, gameId, hash, size);
    } else {
      return this.queryServerHashMeta(server, hash);
    }
  }

  private queryServerHashNexus(server: IServer, gameId: string,
                               hash: string, size: number): Promise<ILookupResult[]> {
    return Promise.resolve(server.nexus.getFileByMD5(hash, this.translateNexusGameId(gameId)))
      .then(nexusData => nexusData
        .map(nexusObj => this.translateFromNexus(hash, size, nexusObj, gameId)))
      .catch(NexusError, err => {
        if (err.statusCode === 521) {
          return Promise.reject(new Error('API offline'));
        } else if (err.statusCode === 404) {
          return Promise.resolve([]);
        } else {
          // TODO not sure what data contains at this point. If the api is working
          // correct it _should_ be a json object containing an error message
          return Promise.reject(err);
        }
      });
  }

  private queryServerHashMeta(server: IServer, hash: string): Promise<ILookupResult[]> {
    const url = `${server.url}/by_key/${hash}`;
    return this.restGet(url);
  }

  private translateNexusGameId(input: string): string {
    if ((input === 'skyrimse') || (input === 'skyrimvr')) {
      return 'skyrimspecialedition';
    } else if (input === 'falloutnv') {
      return 'newvegas';
    } else if (input === 'fallout4vr') {
      return 'fallout4';
    } else if (input === 'teso') {
      return 'elderscrollsonline';
    } else if ((input === 'nwn') || (input === 'nwnee')) {
      return 'neverwinter';
    } else {
      return input;
    }
  }

  /**
   * the nexus site currently uses a different api
   *
   * @private
   *
   * @memberOf ModDB
   */
  private translateFromNexus = (hash: string, size: number, nexusObj: IMD5Result, gameId: string): ILookupResult => {
    const realSize = size || (nexusObj.file_details.size * 1024);
    const urlFragments = [
      'nxm:/',
      nexusObj.mod.domain_name,
      'mods',
      nexusObj.mod.mod_id,
      'files',
      nexusObj.file_details.file_id,
    ];

    const page =
      `https://www.nexusmods.com/${nexusObj.mod.domain_name}/mods/${nexusObj.mod.mod_id}/`;
    return {
      key:
        `hash:${hash}:${realSize}:${gameId}:`,
      value: {
        fileMD5: hash,
        fileName: nexusObj.file_details.file_name,
        fileSizeBytes: realSize,
        logicalFileName: nexusObj.file_details.name,
        fileVersion: svclean(nexusObj.file_details.version),
        gameId,
        domainName: nexusObj.mod.domain_name,
        sourceURI: urlFragments.join('/'),
        source: 'nexus',
        details: {
          category: nexusObj.mod.category_id.toString(),
          description: nexusObj.mod.description,
          author: nexusObj.mod.author,
          homepage: page,
          modId: nexusObj.mod.mod_id.toString(),
          fileId: nexusObj.file_details.file_id.toString(),
        },
      },
    };
  }

  private readRange<T>(type: 'hash' | 'log' | 'name', key: string,
                       terminate: boolean = true): Promise<T[]> {
    if (this.mDB.isClosed()) {
      return Promise.resolve([]);
    }

    return new Promise<T[]>((resolve, reject) => {
      const result: T[] = [];

      let stream;

      if (terminate) {
        stream = this.mDB.createReadStream({
          gte: type + ':' + key + ':',
          lt: type + ':' + key + 'a:',
        });
      } else {
        stream = this.mDB.createReadStream({
          gte: type + ':' + key,
          lte: type + ':' + key + 'zzzzzzzzzzzzzzzzzzz:',
        });
      }

      stream.on('data', (data: {key: string, value: string}) => {
        try {
          if (type === 'hash') {
            const value = JSON.parse(data.value);
            if (Array.isArray(value)) {
              result.push(...value.map(val => ({
                key: data.key,
                value: val,
              } as any)));
            } else {
              result.push({
                key: data.key,
                value,
              } as any);
            }
          } else {
            result.push(data as any);
          }
        } catch (err) {
          this.mLog('warn', 'Invalid data stored for', data.key);
        }
      });
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(result));
    });
  }

  private cacheResults(results: ILookupResult[], lifeTime: number): Promise<void> {
    if (this.mDB.isClosed()) {
      return Promise.resolve();
    }

    const date = Math.floor(Date.now() / 1000);

    // cache all results in our database
    return this.insert(results.map(result => ({
      ...result.value,
      expires: date + lifeTime,
    })));
  }

  private expireResults(input: ILookupResult[]): boolean {
    if (input.length === 0) {
      return false;
    }

    const date = new Date();
    if (date.getHours() !== this.mExpireHour) {
      this.mRemainingExpires = params.REFETCH_PER_HOUR;
    }

    // don't expire if we've done too much of that in the last hour
    if (this.mRemainingExpires === 0) {
      return false;
    }

    // don't expire if we have valid results
    if (input.find(res => (res.value.expires !== undefined)
                       && (res.value.expires * 1000 > date.getTime())) !== undefined) {
      return false;
    }

    --this.mRemainingExpires;
    return true;
  }

  private getAllByKey(key: string, gameId?: string): Promise<ILookupResult[]> {
    if (this.mBlacklist.has(JSON.stringify({ key, gameId }))) {
      // avoid querying the same keys again and again
      return Promise.resolve([]);
    }

    return this.readRange<ILookupResult>('hash', key)
        .then((results: ILookupResult[]) => {
          // it's possible that the caller knows the game id but not the size.
          // In this case the key can't include the gameid as a marker either
          // so we have to filter here
          results = results.filter(result =>
            (gameId === undefined) || result.key.split(':')[3] === gameId);

          if (this.expireResults(results)) {
            results = [];
          }

          if (results.length > 0) {
            return Promise.resolve(results);
          }

          const keySplit = key.split(':');
          const hash = keySplit[0];
          const size = parseInt(keySplit[1], 10);
          let remoteResults: ILookupResult[];

          return Promise.mapSeries(this.mServers, (server: IServer) => {
            if (remoteResults && (remoteResults.length > 0)) {
              // only use the results from the first server that had anything
              return Promise.resolve();
            }
            return this.queryServerHash(server, gameId, hash, size)
                .then((serverResults: ILookupResult[]) => {
                  remoteResults = serverResults;
                  return this.cacheResults(remoteResults, server.cacheDurationSec);
                })
                .catch(err => {
                  this.mLog('warn', 'failed to query by key', {
                    server: server.url, key, gameId, error: err.message.toString(),
                  });
                  this.mBlacklist.add(JSON.stringify({ key, gameId }));
                });
          })
          .then(() => Promise.resolve(remoteResults || []));
        });
  }

  private resolveIndex(key: string): Promise<ILookupResultRaw> {
    return this.getSafe(key)
      .then(data => {
        if (data === undefined) {
          return undefined;
        }

        const value = JSON.parse(data);

        if (Array.isArray(value)) {
          return { key, value };
        } else {
          return { key, value: [value] };
        }
      })
      .catch(err => {
        // this is bad actually, it indicates we have an invalid index entry
        // which means database corruption
        this.mLog('warn', 'failed to look up key from index', {
          key,
          error: err.message,
        });
        return Promise.resolve(undefined);
      });
  }

  private getAllByLogicalName(logicalName: string, versionMatch: string): Promise<ILookupResult[]> {
    if (this.mBlacklist.has(JSON.stringify({ logicalName, versionMatch }))) {
      return Promise.resolve([]);
    }
    const versionFilter = res =>
        semver.satisfies(svclean(res.key.split(':')[2]), versionMatch, false);
    return this.readRange<IIndexResult>('log', logicalName)
      .then((results: IIndexResult[]) =>
        Promise.map(results.filter(versionFilter), (indexResult: IIndexResult) =>
          this.resolveIndex(indexResult.value))
          .filter(res => res !== undefined))
      .then((results: ILookupResultRaw[]) => {
        if (results.length > 0) {
          return Promise.resolve(results.reduce(fromRawReducer, []));
        }

        let remoteResults: ILookupResult[];

        return Promise.mapSeries(this.mServers, (server: IServer) => {
          if (remoteResults) {
            return Promise.resolve();
          }
          return this.queryServerLogical(server, logicalName, versionMatch)
            .then((serverResults: ILookupResult[]) => {
              remoteResults = serverResults;
              return this.cacheResults(remoteResults, server.cacheDurationSec);
            })
            .catch(err => {
              this.mLog('warn', 'failed to query by logical name', {
                server: server.url, logicalName, versionMatch,
                error: err.message.toString(),
              });
              this.mBlacklist.add(JSON.stringify({ logicalName, versionMatch }));
            });
        }).then(() => Promise.resolve(remoteResults || []));
      });
  }

  private getAllByExpression(expression: string, versionMatch: string): Promise<ILookupResult[]> {
    if (this.mBlacklist.has(JSON.stringify({ expression, versionMatch }))) {
      return Promise.resolve([]);
    }
    const filter = res => {
      const [type, fileName, version] = res.key.split(':');
      return minimatch(fileName, expression)
        && semver.satisfies(svclean(version), versionMatch, false);
    };

    const staticPart = expression.split(/[?*]/)[0];

    return this.readRange<IIndexResult>('name', staticPart, false)
        .then((results: IIndexResult[]) =>
                  Promise.map(results.filter(filter),
                              (indexResult: IIndexResult) =>
                                  this.resolveIndex(indexResult.value)))
        .then((results: ILookupResultRaw[]) => {
          if (results.length > 0) {
            return Promise.resolve(results.reduce(fromRawReducer, []));
          }

          let remoteResults: ILookupResult[];

          return Promise.mapSeries(this.mServers, (server: IServer) => {
            if (remoteResults) {
              return Promise.resolve();
            }
            return this.queryServerLogical(server, expression, versionMatch)
                .then((serverResults: ILookupResult[]) => {
                  remoteResults = serverResults;
                  return this.cacheResults(remoteResults, server.cacheDurationSec);
                })
                .catch(err => {
                  this.mLog('warn', 'failed to query by expression', {
                    server: server.url, expression, versionMatch,
                    error: err.message.toString(),
                  });
                  this.mBlacklist.add(JSON.stringify({ expression, versionMatch }));
                });
          }).then(() => Promise.resolve(remoteResults || []));
        });
  }

  private createKey(hash: string, size: number, gameId: string) {
    let lookupKey = `${hash}`;
    if (size !== undefined) {
      lookupKey += ':' + size;
      if (gameId !== undefined) {
        lookupKey += ':' + gameId;
      }
    }
    return lookupKey;
  }

  private makeKey(mod: IModInfo) {
    return `hash:${mod.fileMD5}:${mod.fileSizeBytes}:${mod.gameId}:`;
  }

  private makeNameLookup(mod: IModInfo) {
    return `name:${mod.fileName}:${mod.fileVersion}:`;
  }

  private makeLogicalLookup(mod: IModInfo) {
    return `log:${mod.logicalFileName}:${mod.fileVersion}:`;
  }

  private missingKeys(mod: any) {
    const actualKeys = new Set(Object.keys(mod));
    return this.mModKeys.filter(key => !actualKeys.has(key));
  }

  private promisify() {
    this.mDB.getAsync = Promise.promisify(this.mDB.get);
    this.mDB.putAsync = Promise.promisify(this.mDB.put) as any;
  }

  private putSafe(key: string, data: any): Promise<void> {
    if (this.mDB.isClosed()) {
      return Promise.resolve();
    }
    return this.mDB.putAsync(key, data);
  }

  private getSafe(key): Promise<any> {
    if (this.mDB.isClosed()) {
      return Promise.resolve(undefined);
    }
    return this.mDB.getAsync(key);
  }
}

export default ModDB;
