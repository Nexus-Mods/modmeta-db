import * as Promise from 'bluebird';
import levelup = require('levelup');
import * as minimatch from 'minimatch';

import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as semvish from 'semvish';
import * as url from 'url';

import Quota from './Quota';
import { QUOTA_MAX, QUOTA_RATE_MS } from './nexusParams';
import {IHashResult, IIndexResult, ILookupResult, IModInfo} from './types';
import {genHash} from './util';

interface ILevelUpAsync extends LevelUp {
  getAsync?: (key: string) => Promise<any>;
  putAsync?: (key: string, data: any) => Promise<void>;
}

export interface IServer {
  protocol: 'nexus' | 'metadb';
  url: string;
  apiKey?: string;
  cacheDurationSec: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFunc = (level: LogLevel, message: string, extra?: any) => void;

// interface compatible with http and https module
interface IHTTP {
  request: (options: https.RequestOptions | string | URL,
            callback?: (res: http.IncomingMessage) => void) => http.ClientRequest;
  Agent: typeof http.Agent;
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
  private mNexusQuota: Quota;

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
  constructor(dbName: string,
              gameId: string,
              servers: IServer[],
              log?: LogFunc,
              database?: any,
              timeoutMS?: number) {
    this.mDB = levelup(dbName, {valueEncoding: 'json', db: database});
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
    this.mNexusQuota = new Quota(QUOTA_MAX, QUOTA_MAX, QUOTA_RATE_MS);

    this.promisify();
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

  /**
   * update the gameId which is used as the default for lookups to the nexus
   * api if the game id of the file being looked up isn't available
   *
   * @param {string} gameId
   *
   * @memberOf ModDB
   */
  public setGameId(gameId: string) {
    this.mGameId = gameId;
  }

  /**
   * retrieve a mod if the hash (or a full key) is already known
   *
   * @param {string} hash
   * @returns {Promise<ILookupResult[]>}
   *
   * @memberOf ModDB
   */
  public getByKey(key: string): Promise<ILookupResult[]> {
    if (this.mDB.isClosed()) {
      // database already closed
      return Promise.resolve([]);
    }

    return this.getAllByKey(key, this.mGameId);
  }

  /**
   * retrieve mods by their logical name and version
   */
  public getByLogicalName(logicalName: string, versionMatch: string): Promise<ILookupResult[]> {
    if (this.mDB.isClosed()) {
      // database already closed
      return Promise.resolve([]);
    }

    return this.getAllByLogicalName(logicalName, versionMatch);
  }

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
  public insert(mod: IModInfo): Promise<void> {
    const missingKeys = this.missingKeys(mod);
    if (missingKeys.length !== 0) {
      return Promise.reject(new Error('Invalid mod object. Missing keys: ' +
                                      missingKeys.join(', ')));
    }

    const key = this.makeKey(mod);

    return this.mDB.putAsync(key, mod)
      .then(() => this.mDB.putAsync(this.makeNameLookup(mod), key))
      .then(() => this.mDB.putAsync(this.makeLogicalLookup(mod), key))
    ;
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
      let lookupKey = `${hashResult}`;
      if (hashFileSize !== undefined) {
        lookupKey += ':' + hashFileSize;
        if (gameId !== undefined) {
          lookupKey += ':' + gameId;
        }
      }
      return this.getAllByKey(lookupKey, gameId)
        .tap(result => {
          // if the result is empty, put whatever we know in the cache,
          // just to avoid re-querying the server
          if (result.length === 0) {
            this.insert({
              fileMD5: hashResult,
              fileName: filePath !== undefined ? path.basename(filePath) : undefined,
              fileSizeBytes: hashFileSize,
              fileVersion: '',
              gameId,
              sourceURI: '',
            });
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
    if (server.protocol === 'nexus') {
      // not supported
      return Promise.resolve([]);
    }

    const url = `${server.url}/by_name/${logicalName}/versionMatch`;
    return this.restGet(url);
  }

  private queryServerHash(server: IServer, gameId: string, hash: string): Promise<ILookupResult[]> {
    if (server.protocol === 'nexus') {
      return this.queryServerHashNexus(server, gameId, hash);
    } else {
      return this.queryServerHashMeta(server, hash);
    }
  }

  private queryServerHashNexus(server: IServer, gameId: string,
                               hash: string): Promise<ILookupResult[]> {
    // no result in our database, look at the backends
    const realGameId = this.translateNexusGameId(gameId || this.mGameId);

    const url = `${server.url}/games/${realGameId}/mods/md5_search/${hash}`;

    return this.mNexusQuota.wait()
      .then(() => this.restGet(url, { APIKEY: server.apiKey }))
      .then(nexusData => nexusData.map(nexusObj => this.translateFromNexus(nexusObj, gameId)))
      .catch(HTTPError, err => {
        if (err.code === 521) {
          return Promise.reject(new Error('API offline'));
        } else if (err.code === 429) {
          this.mNexusQuota.reset();
          return Promise.delay(1000)
            .then(() => this.mNexusQuota.wait())
            .then(() => this.queryServerHashNexus(server, gameId, hash));
        } else {
          // TODO not sure what data contains at this point. If the api is working
          // correct it _should_ be a json object containing an error message
          return err;
        }
      });
  }

  private queryServerHashMeta(server: IServer, hash: string): Promise<ILookupResult[]> {
    const url = `${server.url}/by_hash/${hash}`;
    return this.restGet(url);
  }

  private translateNexusGameId(input: string): string {
    if (input === 'skyrimse') {
      return 'skyrimspecialedition';
    } else if (input === 'skyrimvr') {
      return 'skyrimspecialedition';
    } else if (input === 'falloutnv') {
      return 'newvegas';
    } else if (input === 'fallout4vr') {
      return 'fallout4';
    } else if (input === 'teso') {
      return 'elderscrollsonline';
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
  private translateFromNexus = (nexusObj: any, gameId: string):
      ILookupResult => {
        const urlFragments = [
          'nxm:/',
          nexusObj.mod.game_domain,
          'mods',
          nexusObj.mod.mod_id,
          'files',
          nexusObj.file_details.file_id,
        ];

        const page =
            `https://www.nexusmods.com/${nexusObj.mod.game_domain}/mods/${nexusObj.mod.mod_id}/`;
        return {
          key:
              `hash:${nexusObj.file_details.md5}:${nexusObj.file_details.size}:${gameId}:`,
          value: {
            fileMD5: nexusObj.file_details.md5,
            fileName: nexusObj.file_details.file_name,
            fileSizeBytes: nexusObj.file_details.file_size,
            logicalFileName: nexusObj.file_details.name,
            fileVersion: semvish.clean(nexusObj.file_details.version, true),
            gameId,
            sourceURI: urlFragments.join('/'),
            details: {
              category: nexusObj.mod.category_id,
              description: nexusObj.mod.description,
              author: nexusObj.mod.author,
              homepage: page,
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

      stream.on('data', (data: T) => result.push(data));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(result));
    });
  }

  private cacheResults(results: ILookupResult[], lifeTime: number): Promise<void> {
    if (this.mDB.isClosed()) {
      return Promise.resolve();
    }

    // cache all results in our database
    return Promise.mapSeries(results, result => {
      // TODO: cached results currently don't expire
      /*
      const temp = { ...result.value };
      temp.expires = new Date().getTime() / 1000 + lifeTime;
      */
      return this.insert(result.value);
    })
    .then(() => null);
  }

  private getAllByKey(key: string, gameId: string): Promise<ILookupResult[]> {
    if (this.mBlacklist.has(JSON.stringify({ key, gameId }))) {
      // avoid querying the same keys again and again
      return Promise.resolve([]);
    }

    return this.readRange<ILookupResult>('hash', key)
        .then((results: ILookupResult[]) => {
          if (results.length > 0) {
            return Promise.resolve(results);
          }

          const hash = key.split(':')[0];
          let remoteResults: ILookupResult[];

          return Promise.mapSeries(this.mServers, (server: IServer) => {
            if (remoteResults && (remoteResults.length > 0)) {
              // only use the results from the first server that had anything
              return Promise.resolve();
            }
            return this.queryServerHash(server, gameId, hash)
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

  private resolveIndex(key: string): Promise<ILookupResult> {
    return new Promise<ILookupResult>(
        (resolve, reject) => this.mDB.get(key, (err, value) => {
          if (err) {
            reject(err);
          } else {
            resolve(value);
          }
        }));
  }

  private getAllByLogicalName(logicalName: string, versionMatch: string): Promise<ILookupResult[]> {
    if (this.mBlacklist.has(JSON.stringify({ logicalName, versionMatch }))) {
      return Promise.resolve([]);
    }
    const versionFilter = res =>
        semvish.satisfies(res.key.split(':')[2], versionMatch, false);
    return this.readRange<IIndexResult>('log', logicalName)
        .then((results: IIndexResult[]) =>
                  Promise.map(results.filter(versionFilter),
                              (indexResult: IIndexResult) =>
                                  this.resolveIndex(indexResult.value)))
        .then((results: ILookupResult[]) => {
          if (results.length > 0) {
            return Promise.resolve(results);
          }

          let remoteResults: ILookupResult[];

          return Promise.mapSeries(this.mServers, (server: IServer) => {
            if (remoteResults) {
              return Promise.resolve();
            }
            return this.queryServerLogical(server, logicalName,
                                            versionMatch)
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
        && semvish.satisfies(version, versionMatch, false);
    };

    const staticPart = expression.split(/[?*]/)[0];

    return this.readRange<IIndexResult>('name', staticPart, false)
        .then((results: IIndexResult[]) =>
                  Promise.map(results.filter(filter),
                              (indexResult: IIndexResult) =>
                                  this.resolveIndex(indexResult.value)))
        .then((results: ILookupResult[]) => {
          if (results.length > 0) {
            return Promise.resolve(results);
          }

          let remoteResults: ILookupResult[];

          return Promise.mapSeries(this.mServers, (server: IServer) => {
            if (remoteResults) {
              return Promise.resolve();
            }
            return this.queryServerLogical(server, expression,
                                            versionMatch)
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
}

export default ModDB;
