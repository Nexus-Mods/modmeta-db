"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
const levelup = require("levelup");
const minimatch = require("minimatch");
const encode = require("encoding-down");
const http = require("http");
const https = require("https");
const leveldown = require("leveldown");
const path = require("path");
const semvish = require("semvish");
const url = require("url");
const Quota_1 = require("./Quota");
const nexusParams_1 = require("./nexusParams");
const util_1 = require("./util");
class HTTPError extends Error {
    constructor(code, message) {
        super(message);
        this.name = this.constructor.name;
        this.mCode = code;
    }
    get code() {
        return this.mCode;
    }
}
function isMD5Hash(input) {
    if (input.length !== 32) {
        return false;
    }
    if (input.search(/[^A-Fa-f0-9]/) !== -1) {
        return false;
    }
    return true;
}
class ModDB {
    constructor(gameId, servers, log, timeoutMS) {
        this.mBlacklist = new Set();
        this.translateFromNexus = (nexusObj, gameId) => {
            const urlFragments = [
                'nxm:/',
                nexusObj.mod.game_domain,
                'mods',
                nexusObj.mod.mod_id,
                'files',
                nexusObj.file_details.file_id,
            ];
            const page = `https://www.nexusmods.com/${nexusObj.mod.game_domain}/mods/${nexusObj.mod.mod_id}/`;
            return {
                key: `hash:${nexusObj.file_details.md5}:${nexusObj.file_details.size}:${gameId}:`,
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
        };
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
        this.mNexusQuota = new Quota_1.default(nexusParams_1.QUOTA_MAX, nexusParams_1.QUOTA_MAX, nexusParams_1.QUOTA_RATE_MS);
    }
    static create(dbName, gameId, servers, log, database, timeoutMS) {
        const res = new ModDB(gameId, servers, log, timeoutMS);
        return res.connect(dbName, database || encode(leveldown(dbName)))
            .then(() => res);
    }
    connect(dbName, database) {
        return new Promise((resolve, reject) => {
            this.mDB = levelup(database, { keyEncoding: 'utf8', valueEncoding: 'utf8' }, (err, db) => {
                if (err) {
                    reject(err);
                }
                else {
                    this.mDB = db;
                    resolve();
                }
            });
        })
            .then(() => {
            this.promisify();
        });
    }
    close() {
        return new Promise((resolve, reject) => {
            this.mDB.close((err) => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }
    setGameId(gameId) {
        this.mGameId = gameId;
    }
    getByKey(key) {
        if (this.mDB.isClosed()) {
            return Promise.resolve([]);
        }
        return this.getAllByKey(key, this.mGameId);
    }
    getByLogicalName(logicalName, versionMatch) {
        if (this.mDB.isClosed()) {
            return Promise.resolve([]);
        }
        return this.getAllByLogicalName(logicalName, versionMatch);
    }
    getByExpression(expression, versionMatch) {
        if (this.mDB.isClosed()) {
            return Promise.resolve([]);
        }
        return this.getAllByExpression(expression, versionMatch);
    }
    insert(mod) {
        const missingKeys = this.missingKeys(mod);
        if (missingKeys.length !== 0) {
            return Promise.reject(new Error('Invalid mod object. Missing keys: ' +
                missingKeys.join(', ')));
        }
        const key = this.makeKey(mod);
        return this.mDB.putAsync(key, mod)
            .then(() => this.mDB.putAsync(this.makeNameLookup(mod), key))
            .then(() => this.mDB.putAsync(this.makeLogicalLookup(mod), key));
    }
    lookup(filePath, fileMD5, fileSize, gameId) {
        let hashResult = fileMD5;
        let hashFileSize = fileSize;
        if ((filePath === undefined) && (fileMD5 === undefined)) {
            return Promise.resolve([]);
        }
        const promise = fileMD5 !== undefined
            ? Promise.resolve()
            : util_1.genHash(filePath).then((res) => {
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
    restGet(urlString, addHeaders = {}) {
        const parsed = url.parse(urlString);
        const lib = parsed.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            const params = {
                method: 'GET',
                protocol: parsed.protocol,
                port: parsed.port,
                hostname: parsed.hostname,
                path: parsed.path,
                headers: Object.assign({ 'Content-Type': 'application/json' }, addHeaders),
                timeout: this.mTimeout || 5000,
                agent: new lib.Agent(),
            };
            lib.request(params, (res) => {
                if (res.statusCode === 200) {
                    res.setEncoding('utf8');
                    let data = '';
                    res
                        .on('data', buf => data += buf)
                        .on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        }
                        catch (err) {
                            reject(new Error('Invalid response: ' + err.message));
                        }
                    });
                }
                else {
                    reject(new HTTPError(res.statusCode, res.statusMessage));
                }
            })
                .on('error', err => {
                reject(err);
            })
                .end();
        });
    }
    queryServerLogical(server, logicalName, versionMatch) {
        if (server.protocol === 'nexus') {
            return Promise.resolve([]);
        }
        const url = `${server.url}/by_name/${logicalName}/versionMatch`;
        return this.restGet(url);
    }
    queryServerHash(server, gameId, hash) {
        if (!isMD5Hash(hash)) {
            return Promise.resolve([]);
        }
        if (server.protocol === 'nexus') {
            return this.queryServerHashNexus(server, gameId, hash);
        }
        else {
            return this.queryServerHashMeta(server, hash);
        }
    }
    queryServerHashNexus(server, gameId, hash) {
        const realGameId = this.translateNexusGameId(gameId || this.mGameId);
        const url = `${server.url}/games/${realGameId}/mods/md5_search/${hash}`;
        return this.mNexusQuota.wait()
            .then(() => this.restGet(url, { APIKEY: server.apiKey }))
            .then(nexusData => nexusData.map(nexusObj => this.translateFromNexus(nexusObj, gameId)))
            .catch(HTTPError, err => {
            if (err.code === 521) {
                return Promise.reject(new Error('API offline'));
            }
            else if (err.code === 429) {
                this.mNexusQuota.reset();
                return Promise.delay(1000)
                    .then(() => this.mNexusQuota.wait())
                    .then(() => this.queryServerHashNexus(server, gameId, hash));
            }
            else if (err.code === 404) {
                return Promise.resolve([]);
            }
            else {
                return err;
            }
        });
    }
    queryServerHashMeta(server, hash) {
        const url = `${server.url}/by_hash/${hash}`;
        return this.restGet(url);
    }
    translateNexusGameId(input) {
        if ((input === 'skyrimse') || (input === 'skyrimvr')) {
            return 'skyrimspecialedition';
        }
        else if (input === 'falloutnv') {
            return 'newvegas';
        }
        else if (input === 'fallout4vr') {
            return 'fallout4';
        }
        else if (input === 'teso') {
            return 'elderscrollsonline';
        }
        else if ((input === 'nwn') || (input === 'nwnee')) {
            return 'neverwinter';
        }
        else {
            return input;
        }
    }
    readRange(type, key, terminate = true) {
        if (this.mDB.isClosed()) {
            return Promise.resolve([]);
        }
        return new Promise((resolve, reject) => {
            const result = [];
            let stream;
            if (terminate) {
                stream = this.mDB.createReadStream({
                    gte: type + ':' + key + ':',
                    lt: type + ':' + key + 'a:',
                });
            }
            else {
                stream = this.mDB.createReadStream({
                    gte: type + ':' + key,
                    lte: type + ':' + key + 'zzzzzzzzzzzzzzzzzzz:',
                });
            }
            stream.on('data', (data) => result.push(data));
            stream.on('error', (err) => reject(err));
            stream.on('end', () => resolve(result));
        });
    }
    cacheResults(results, lifeTime) {
        if (this.mDB.isClosed()) {
            return Promise.resolve();
        }
        return Promise.mapSeries(results, result => {
            return this.insert(result.value);
        })
            .then(() => null);
    }
    getAllByKey(key, gameId) {
        if (this.mBlacklist.has(JSON.stringify({ key, gameId }))) {
            return Promise.resolve([]);
        }
        return this.readRange('hash', key)
            .then((results) => {
            if (results.length > 0) {
                return Promise.resolve(results);
            }
            const hash = key.split(':')[0];
            let remoteResults;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults && (remoteResults.length > 0)) {
                    return Promise.resolve();
                }
                return this.queryServerHash(server, gameId, hash)
                    .then((serverResults) => {
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
    resolveIndex(key) {
        return new Promise((resolve, reject) => this.mDB.get(key, (err, value) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(value);
            }
        }));
    }
    getAllByLogicalName(logicalName, versionMatch) {
        if (this.mBlacklist.has(JSON.stringify({ logicalName, versionMatch }))) {
            return Promise.resolve([]);
        }
        const versionFilter = res => semvish.satisfies(res.key.split(':')[2], versionMatch, false);
        return this.readRange('log', logicalName)
            .then((results) => Promise.map(results.filter(versionFilter), (indexResult) => this.resolveIndex(indexResult.value)))
            .then((results) => {
            if (results.length > 0) {
                return Promise.resolve(results);
            }
            let remoteResults;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults) {
                    return Promise.resolve();
                }
                return this.queryServerLogical(server, logicalName, versionMatch)
                    .then((serverResults) => {
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
    getAllByExpression(expression, versionMatch) {
        if (this.mBlacklist.has(JSON.stringify({ expression, versionMatch }))) {
            return Promise.resolve([]);
        }
        const filter = res => {
            const [type, fileName, version] = res.key.split(':');
            return minimatch(fileName, expression)
                && semvish.satisfies(version, versionMatch, false);
        };
        const staticPart = expression.split(/[?*]/)[0];
        return this.readRange('name', staticPart, false)
            .then((results) => Promise.map(results.filter(filter), (indexResult) => this.resolveIndex(indexResult.value)))
            .then((results) => {
            if (results.length > 0) {
                return Promise.resolve(results);
            }
            let remoteResults;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults) {
                    return Promise.resolve();
                }
                return this.queryServerLogical(server, expression, versionMatch)
                    .then((serverResults) => {
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
    makeKey(mod) {
        return `hash:${mod.fileMD5}:${mod.fileSizeBytes}:${mod.gameId}:`;
    }
    makeNameLookup(mod) {
        return `name:${mod.fileName}:${mod.fileVersion}:`;
    }
    makeLogicalLookup(mod) {
        return `log:${mod.logicalFileName}:${mod.fileVersion}:`;
    }
    missingKeys(mod) {
        const actualKeys = new Set(Object.keys(mod));
        return this.mModKeys.filter(key => !actualKeys.has(key));
    }
    promisify() {
        this.mDB.getAsync = Promise.promisify(this.mDB.get);
        this.mDB.putAsync = Promise.promisify(this.mDB.put);
    }
}
exports.default = ModDB;
