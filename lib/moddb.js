"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
const levelup = require("levelup");
const minimatch = require("minimatch");
const encode = require("encoding-down");
const http = require("http");
const https = require("https");
const leveldown = require("leveldown");
const nexus_api_1 = require("nexus-api");
const path = require("path");
const semver = require("semver");
const url = require("url");
const params = require("./parameters");
const util_1 = require("./util");
function svclean(input) {
    let res = semver.valid(semver.coerce(input));
    if (res !== null) {
        res = semver.clean(res);
    }
    return res || '0.0.0-' + input;
}
exports.svclean = svclean;
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
        this.mRemainingExpires = params.REFETCH_PER_HOUR;
        this.mExpireHour = (new Date()).getHours();
        this.translateFromNexus = (hash, size, nexusObj, gameId) => {
            const realSize = size || (nexusObj.file_details.size * 1024);
            const urlFragments = [
                'nxm:/',
                nexusObj.mod.domain_name,
                'mods',
                nexusObj.mod.mod_id,
                'files',
                nexusObj.file_details.file_id,
            ];
            const page = `https://www.nexusmods.com/${nexusObj.mod.domain_name}/mods/${nexusObj.mod.mod_id}/`;
            return {
                key: `hash:${hash}:${realSize}:${gameId}:`,
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
    addServer(server) {
        this.mServers.push(server);
    }
    setGameId(gameId) {
        this.mGameId = gameId.toLowerCase();
    }
    getByReference(ref) {
        if (ref.fileMD5 !== undefined) {
            if ((ref.fileSize !== undefined) && (ref.gameId !== undefined)) {
                return this.getByKey(this.createKey(ref.fileMD5, ref.fileSize, ref.gameId), ref.gameId);
            }
            else {
                return this.getByKey(ref.fileMD5, ref.gameId);
            }
        }
        else if (ref.logicalFileName !== undefined) {
            return this.getByLogicalName(ref.logicalFileName, ref.versionMatch);
        }
        else if (ref.fileExpression !== undefined) {
            return this.getByExpression(ref.fileExpression, ref.versionMatch);
        }
        else {
            return Promise.resolve([]);
        }
    }
    getByKey(key, gameId) {
        if (this.mDB.isClosed()) {
            return Promise.resolve([]);
        }
        return this.getAllByKey(key, gameId || this.mGameId);
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
    insert(mods) {
        try {
            const groups = mods.reduce((prev, mod) => {
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
            return Promise.map(Object.keys(groups), key => this.putSafe(key, JSON.stringify(groups[key]))
                .then(() => Promise.map(groups[key], mod => this.putSafe(this.makeNameLookup(mod), key)))
                .then(() => Promise.map(groups[key], mod => this.putSafe(this.makeLogicalLookup(mod), key))))
                .then(() => null);
        }
        catch (err) {
            return Promise.reject(err);
        }
    }
    lookup(filePath, fileMD5, fileSize, gameId) {
        if (gameId !== undefined) {
            gameId = gameId.toLowerCase();
        }
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
            let lookupKey = this.createKey(hashResult, hashFileSize, gameId);
            return this.getAllByKey(lookupKey, gameId)
                .tap(result => {
                if (result.length === 0) {
                    this.insert([{
                            fileMD5: hashResult,
                            fileName: filePath !== undefined ? path.basename(filePath) : undefined,
                            fileSizeBytes: hashFileSize,
                            fileVersion: '',
                            gameId,
                            sourceURI: '',
                            expires: params.EXPIRE_INVALID_SEC,
                        }]);
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
        if (server.nexus !== undefined) {
            return Promise.resolve([]);
        }
        const url = `${server.url}/by_name/${logicalName}/${versionMatch}`;
        return this.restGet(url);
    }
    queryServerHash(server, gameId, hash, size) {
        if (!isMD5Hash(hash)) {
            return Promise.resolve([]);
        }
        if (server.nexus !== undefined) {
            return this.queryServerHashNexus(server, gameId, hash, size);
        }
        else {
            return this.queryServerHashMeta(server, hash);
        }
    }
    queryServerHashNexus(server, gameId, hash, size) {
        return Promise.resolve(server.nexus.getFileByMD5(hash, this.translateNexusGameId(gameId)))
            .then(nexusData => nexusData
            .map(nexusObj => this.translateFromNexus(hash, size, nexusObj, gameId)))
            .catch(nexus_api_1.NexusError, err => {
            if (err.statusCode === 521) {
                return Promise.reject(new Error('API offline'));
            }
            else if (err.statusCode === 404) {
                return Promise.resolve([]);
            }
            else {
                return Promise.reject(err);
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
            stream.on('data', (data) => {
                try {
                    if (type === 'hash') {
                        const value = JSON.parse(data.value);
                        if (Array.isArray(value)) {
                            result.push(...value.map(val => ({
                                key: data.key,
                                value: val,
                            })));
                        }
                        else {
                            result.push({
                                key: data.key,
                                value,
                            });
                        }
                    }
                    else {
                        result.push(data);
                    }
                }
                catch (err) {
                    this.mLog('warn', 'Invalid data stored for', data.key);
                }
            });
            stream.on('error', (err) => reject(err));
            stream.on('end', () => resolve(result));
        });
    }
    cacheResults(results, lifeTime) {
        if (this.mDB.isClosed()) {
            return Promise.resolve();
        }
        const date = Math.floor(Date.now() / 1000);
        return this.insert(results.map(result => (Object.assign({}, result.value, { expires: date + lifeTime }))));
    }
    expireResults(input) {
        if (input.length === 0) {
            return false;
        }
        const date = new Date();
        if (date.getHours() !== this.mExpireHour) {
            this.mRemainingExpires = params.REFETCH_PER_HOUR;
        }
        if (this.mRemainingExpires === 0) {
            return false;
        }
        if (input.find(res => (res.value.expires !== undefined)
            && (res.value.expires * 1000 > date.getTime())) !== undefined) {
            return false;
        }
        --this.mRemainingExpires;
        return true;
    }
    getAllByKey(key, gameId) {
        if (this.mBlacklist.has(JSON.stringify({ key, gameId }))) {
            return Promise.resolve([]);
        }
        return this.readRange('hash', key)
            .then((results) => {
            results = results.filter(result => (gameId === undefined) || result.key.split(':')[3] === gameId);
            if (this.expireResults(results)) {
                results = [];
            }
            if (results.length > 0) {
                return Promise.resolve(results);
            }
            const keySplit = key.split(':');
            const hash = keySplit[0];
            const size = parseInt(keySplit[1], 10);
            let remoteResults;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults && (remoteResults.length > 0)) {
                    return Promise.resolve();
                }
                return this.queryServerHash(server, gameId, hash, size)
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
        return this.getSafe(key)
            .then(data => data === undefined ? undefined : ({
            key: key,
            value: JSON.parse(data),
        }))
            .catch(err => {
            this.mLog('warn', 'failed to look up key from index', {
                key,
                error: err.message,
            });
            return Promise.resolve(undefined);
        });
    }
    getAllByLogicalName(logicalName, versionMatch) {
        if (this.mBlacklist.has(JSON.stringify({ logicalName, versionMatch }))) {
            return Promise.resolve([]);
        }
        const versionFilter = res => semver.satisfies(svclean(res.key.split(':')[2]), versionMatch, false);
        return this.readRange('log', logicalName)
            .then((results) => Promise.map(results.filter(versionFilter), (indexResult) => this.resolveIndex(indexResult.value))
            .filter(res => res !== undefined))
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
                && semver.satisfies(svclean(version), versionMatch, false);
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
    createKey(hash, size, gameId) {
        let lookupKey = `${hash}`;
        if (size !== undefined) {
            lookupKey += ':' + size;
            if (gameId !== undefined) {
                lookupKey += ':' + gameId;
            }
        }
        return lookupKey;
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
    putSafe(key, data) {
        if (this.mDB.isClosed()) {
            return Promise.resolve();
        }
        return this.mDB.putAsync(key, data);
    }
    getSafe(key) {
        if (this.mDB.isClosed()) {
            return Promise.resolve(undefined);
        }
        return this.mDB.getAsync(key);
    }
}
exports.default = ModDB;
