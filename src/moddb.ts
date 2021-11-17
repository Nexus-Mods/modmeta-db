import * as Promise from 'bluebird';
import levelup = require('levelup');
import * as minimatch from 'minimatch';

import * as encode from 'encoding-down';
import * as http from 'http';
import * as https from 'https';
import leveldown from 'leveldown';
import { IMD5Result, IFileHash, IFileHashQuery, ModStatus } from '@nexusmods/nexus-api';
import * as path from 'path';
import * as semver from 'semver';
import * as url from 'url';

import Debouncer from './Debouncer';
import * as params from './parameters';
import {IHashResult, IIndexResult, ILookupResult, IModInfo, IServer, IReference, ModInfoStatus} from './types';
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

interface IMD5Request {
  checksum: string;
  fileSize: number;
  resolve: (info: ILookupResult[]) => void;
  reject: (err: Error) => void;
}

const FILE_HASH_QUERY: IFileHashQuery = {
  md5: true,
  fileName: true,
  fileSize: true,
  modFileId: true,
  modFile: {
    date: true,
    description: true,
    fileId: true,
    version: true,
    categoryId: true,
    game: {
      domainName: true,
    },
    mod: {
      author: true,
      category: true,
      description: true,
      status: true,
      modCategory: {
        id: true,
      },
      uploader: {
        name: true,
      },
    },
    modId: true,
    owner: {
      name: true,
    },
    name: true,
  },
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
  private mNexusMD5Debouncer: Debouncer;
  private mMD5Requests: IMD5Request[] = [];

  public static create(dbName: string,
              gameId: string,
              servers: IServer[],
              log?: LogFunc,
              database?: any,
              timeoutMS?: number): Promise<ModDB> {
    const res = new ModDB(gameId, servers, log, timeoutMS);
    return res.connect(dbName, database || encode(leveldown(dbName)))
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
      'fileSizeBytes',
      'sourceURI',
      'gameId',
    ];

    this.mGameId = gameId;
    this.mServers = servers;
    this.mTimeout = timeoutMS;
    this.mNexusMD5Debouncer = new Debouncer(() => {
      const requests = this.mMD5Requests;
      this.mMD5Requests = [];
      const server = servers.find(iter => iter.nexus !== undefined);
      if (server === undefined) {
        // this should never happen, we wouldn't be here in the first place
        const err = new Error('No nexus server configured');
        requests.forEach(iter => iter.reject(err));
        return;
      }

      if (requests.length === 0) {
        return Promise.resolve();
      }

      return server.nexus.fileHashes(FILE_HASH_QUERY, requests.map(iter => iter.checksum))
        .then(results => {
          requests.forEach(req => {
            // we currently just ignore all results with no modFile associated, these are probably
            // files that have been deteled
            const matches = results.data
              .filter(iter => (iter.md5 === req.checksum) && !!iter.modFile);

            if (matches.length > 0) {
              req.resolve(matches.map(hash => {
                const fileSize = req.fileSize || parseInt(hash.fileSize, 10);
                const resolvedGameId =
                  this.gameIdFromNexusDomain(hash.modFile.game.domainName, gameId);
                return this.translateFromGraphQL(hash.md5, fileSize, hash, resolvedGameId);
              }));
            } else {
              const error = (results.errors ?? []).find(iter =>
                iter.extensions?.parameter === req.checksum);
              if (error !== undefined) {
                const err = new Error(error.message);
                err['code'] = error.extensions?.code;
                req.reject(err);
              } else {
                // nothing found
                req.resolve([]);
              }
            }
          });
        })
        .catch(err => {
          let forwardErr: Error = err;
          if (err.statusCode === 521) {
            forwardErr = new Error('API offline');
          }
          requests.forEach(req => req.reject(forwardErr));
        });
    }, params.BATCHED_REQUEST_TIME);
    this.mLog = log || (() => undefined);
  }

  public connect(dbName: string, database: any, attemptRepair: boolean = true): Promise<void> {
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
    })
    .catch(err => {
      if (attemptRepair) {
        return this.repairDB(dbName)
          .then(() => this.connect(dbName, database, false));
      } else {
        return Promise.reject(err);
      }
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

        // we allow entries to be created without md5 hash, they can still be looked
        // up via logicalFileName or fileExpression. But we need something for the md5
        // hash because the other tables are referencing the md5 lookup table
        if (mod.fileMD5 === undefined) {
          const { createHash } = require('crypto');
          const hash = createHash('md5');
          let size = 0;
          hash.update(mod.fileName);
          mod.fileMD5 = hash.digest('hex');
        }

        const key = this.makeKey(mod);
        if (prev[key] === undefined) {
          prev[key] = [];
        }

        if (mod.expires === undefined) {
          mod.expires = Date.now() + params.EXPIRE_INVALID_SEC;
        }

        prev[key].push(mod);
        return prev;
      }, {});
      return Promise.map(Object.keys(groups), key =>
        this.putSafe(key, JSON.stringify(groups[key]))
          .then(() => Promise.map(groups[key], mod =>
            this.putSafe(this.makeNameLookup(mod), key)))
          .then(() => Promise.map(groups[key], mod => {
            return (mod.logicalFileName !== undefined)
              ? this.putSafe(this.makeLogicalLookup(mod), key)
              : Promise.resolve();
          })))
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

  private repairDB(dbPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      leveldown.repair(dbPath, (err: Error) => {
        if (err !== null) {
          reject(err);
        } else {
          resolve();
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

    const url = `${server.url.endsWith('/') ? server.url : server.url + "/"}by_name/${logicalName}/${versionMatch}`;
    return this.restGet(url);
  }

  private queryServerExpression(server: IServer, expression: string,
                                versionMatch: string): Promise<ILookupResult[]> {
    if (server.nexus !== undefined) {
      // not supported
      return Promise.resolve([]);
    }

    const url = `${server.url.endsWith('/') ? server.url : server.url + "/"}/by_expression/${expression}/${versionMatch}`;
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
    return new Promise((resolve, reject) => {
      this.mMD5Requests.push({ checksum: hash, fileSize: size, resolve, reject });
      this.mNexusMD5Debouncer.schedule();
    });
  }

  private queryServerHashMeta(server: IServer, hash: string): Promise<ILookupResult[]> {
    const url = `${server.url.endsWith('/') ? server.url : server.url + "/"}/by_key/${hash}`;
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

  private gameIdFromNexusDomain(input: string, reqGameId: string): string {
    if (input === 'skyrimspecialedition') {
      return reqGameId === 'skyrimvr' ? 'skyrimvr' : 'skyrimse';
    } else if (input === 'newvegas') {
      return 'falloutnv';
    } else if (input === 'fallout4') {
      return reqGameId === 'fallout4vr' ? 'fallout4vr' : 'fallout4';
    } else if (input === 'elderscrollsonline') {
      return 'teso';
    } else if (input === 'neverwinter') {
      return reqGameId === 'nwnee' ? 'nwnee' : 'nwn';
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

  private convertModStatus = (input: string): ModInfoStatus => {
    switch (input) {
      case 'under_moderation':
      case 'removed':
      case 'wastebinned':
        return 'revoked';
      case 'not_published':
        return 'unpublished';
      case 'hidden':
        return 'hidden';
      case 'publish_with_game':
      case 'published':
        return 'published';
      default:
        return undefined;
    }
  }

  private translateFromGraphQL = (hash: string, size: number, nexusObj: Partial<IFileHash>, gameId: string): ILookupResult => {
    const realSize = size || parseInt(nexusObj.fileSize, 10);
    const urlFragments = [
      'nxm:/',
      nexusObj.modFile.game.domainName,
      'mods',
      nexusObj.modFile.modId.toString(),
      'files',
      nexusObj.modFile.fileId.toString(),
    ];

    const page =
      `https://www.nexusmods.com/${nexusObj.modFile.game.domainName}/mods/${nexusObj.modFile.modId}/`;
    return {
      key:
        `hash:${hash}:${realSize}:${gameId}:`,
      value: {
        fileMD5: hash,
        fileName: nexusObj.fileName,
        fileSizeBytes: realSize,
        logicalFileName: nexusObj.modFile.name,
        fileVersion: svclean(nexusObj.modFile.version),
        gameId,
        domainName: nexusObj.modFile.game.domainName,
        sourceURI: urlFragments.join('/'),
        source: 'nexus',
        archived: nexusObj.modFile.categoryId === 7,
        status: this.convertModStatus(nexusObj.modFile.mod.status),
        details: {
          category: nexusObj.modFile.mod.modCategory.id,
          description: nexusObj.modFile.description,
          author: nexusObj.modFile.owner.name,
          homepage: page,
          modId: nexusObj.modFile.modId.toString(),
          fileId: nexusObj.modFileId.toString(),
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

          let preExpire = [...results];
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
          .then(() => {
            if ((remoteResults !== undefined) && (remoteResults.length > 0)) {
              return remoteResults;
            } else {
              // if the servers didn't return anything, use even expired results
              // over returning nothing
              return preExpire;
            }
          });
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
          if (remoteResults && (remoteResults.length > 0)) {
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
            if (remoteResults && (remoteResults.length > 0)) {
              return Promise.resolve();
            }
            return this.queryServerExpression(server, expression, versionMatch)
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
