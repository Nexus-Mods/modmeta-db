"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.svclean = void 0;
const Promise = require("bluebird");
const levelup = require("levelup");
const minimatch = require("minimatch");
const encode = require("encoding-down");
const http = require("http");
const https = require("https");
const leveldown_1 = require("leveldown");
const path = require("path");
const semver = require("semver");
const url = require("url");
const Debouncer_1 = require("./Debouncer");
const params = require("./parameters");
const util_1 = require("./util");
function fromRawReducer(prev, input) {
    input.value.forEach(val => {
        prev.push({ key: input.key, value: val });
    });
    return prev;
}
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
const FILE_HASH_QUERY = {
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
};
class ModDB {
    constructor(gameId, servers, log, timeoutMS) {
        this.mBlacklist = new Set();
        this.mRemainingExpires = params.REFETCH_PER_HOUR;
        this.mExpireHour = (new Date()).getHours();
        this.mMD5Requests = [];
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
        this.convertModStatus = (input) => {
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
        };
        this.translateFromGraphQL = (hash, size, nexusObj, gameId) => {
            const realSize = size || parseInt(nexusObj.fileSize, 10);
            const urlFragments = [
                'nxm:/',
                nexusObj.modFile.game.domainName,
                'mods',
                nexusObj.modFile.modId.toString(),
                'files',
                nexusObj.modFile.fileId.toString(),
            ];
            const page = `https://www.nexusmods.com/${nexusObj.modFile.game.domainName}/mods/${nexusObj.modFile.modId}/`;
            return {
                key: `hash:${hash}:${realSize}:${gameId}:`,
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
        };
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
        this.mNexusMD5Debouncer = new Debouncer_1.default(() => {
            const requests = this.mMD5Requests;
            this.mMD5Requests = [];
            const server = servers.find(iter => iter.nexus !== undefined);
            if (server === undefined) {
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
                    var _a, _b;
                    const matches = results.data
                        .filter(iter => (iter.md5 === req.checksum) && !!iter.modFile);
                    if (matches.length > 0) {
                        req.resolve(matches.map(hash => {
                            const fileSize = req.fileSize || parseInt(hash.fileSize, 10);
                            const resolvedGameId = this.gameIdFromNexusDomain(hash.modFile.game.domainName, gameId);
                            return this.translateFromGraphQL(hash.md5, fileSize, hash, resolvedGameId);
                        }));
                    }
                    else {
                        const error = ((_a = results.errors) !== null && _a !== void 0 ? _a : []).find(iter => { var _a; return ((_a = iter.extensions) === null || _a === void 0 ? void 0 : _a.parameter) === req.checksum; });
                        if (error !== undefined) {
                            const err = new Error(error.message);
                            err['code'] = (_b = error.extensions) === null || _b === void 0 ? void 0 : _b.code;
                            req.reject(err);
                        }
                        else {
                            req.resolve([]);
                        }
                    }
                });
            })
                .catch(err => {
                let forwardErr = err;
                if (err.statusCode === 521) {
                    forwardErr = new Error('API offline');
                }
                requests.forEach(req => req.reject(forwardErr));
            });
        }, params.BATCHED_REQUEST_TIME);
        this.mLog = log || (() => undefined);
    }
    static create(dbName, gameId, servers, log, database, timeoutMS) {
        const res = new ModDB(gameId, servers, log, timeoutMS);
        return res.connect(dbName, database || encode(leveldown_1.default(dbName)))
            .then(() => res);
    }
    connect(dbName, database, attemptRepair = true) {
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
        })
            .catch(err => {
            if (attemptRepair) {
                return this.repairDB(dbName)
                    .then(() => this.connect(dbName, database, false));
            }
            else {
                return Promise.reject(err);
            }
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
    hashFileName(fileName) {
        if (fileName === undefined) {
            return undefined;
        }
        const { createHash } = require('crypto');
        const hash = createHash('md5');
        hash.update(fileName);
        return hash.digest('hex');
    }
    insert(mods) {
        try {
            const cleanup = [];
            const groups = mods.reduce((prev, mod) => {
                const missingKeys = this.missingKeys(mod);
                if (missingKeys.length !== 0) {
                    throw new Error('Invalid mod object. Missing keys: ' +
                        missingKeys.join(', '));
                }
                const nameHash = this.hashFileName(mod.fileName);
                if (mod.fileMD5 === undefined) {
                    mod.fileMD5 = nameHash;
                }
                else if (nameHash !== undefined) {
                    cleanup.push(this.getAllByKey(this.createKey(nameHash))
                        .then(results => {
                        const existing = results.find(res => (res.value.fileMD5 === nameHash) && (res.value.fileName === mod.fileName));
                        if (existing !== undefined) {
                            return this.putSafe(existing.key, JSON.stringify(Object.assign(Object.assign({}, existing.value), { fileMD5: mod.fileMD5 })));
                        }
                    }));
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
            return Promise.all(cleanup)
                .then(() => Promise.map(Object.keys(groups), key => this.putSafe(key, JSON.stringify(groups[key]))
                .then(() => Promise.map(groups[key], mod => this.putSafe(this.makeNameLookup(mod), key)))
                .then(() => Promise.map(groups[key], mod => {
                return (mod.logicalFileName !== undefined)
                    ? this.putSafe(this.makeLogicalLookup(mod), key)
                    : Promise.resolve();
            }))))
                .then(() => null);
        }
        catch (err) {
            return Promise.reject(err);
        }
    }
    list() {
        return new Promise((resolve, reject) => {
            let result = {};
            this.mDB.createReadStream()
                .on('data', (data) => {
                try {
                    result[data.key] = data.value;
                }
                catch (err) {
                    this.mLog('warn', 'Invalid data stored for', data.key);
                }
            })
                .on('error', (err) => reject(err))
                .on('end', () => resolve(result));
        });
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
                            expires: Date.now() + params.EXPIRE_INVALID_SEC,
                        }]);
                }
            });
        });
    }
    repairDB(dbPath) {
        return new Promise((resolve, reject) => {
            leveldown_1.default.repair(dbPath, (err) => {
                if (err !== null) {
                    reject(err);
                }
                else {
                    resolve();
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
        else if (server.loopbackCB !== undefined) {
            return server.loopbackCB({ name: logicalName, versionMatch });
        }
        const url = `${server.url.endsWith('/') ? server.url : server.url + "/"}by_name/${logicalName}/${versionMatch}`;
        return this.restGet(url);
    }
    queryServerExpression(server, expression, versionMatch) {
        if (server.nexus !== undefined) {
            return Promise.resolve([]);
        }
        else if (server.loopbackCB !== undefined) {
            return server.loopbackCB({ expression, versionMatch });
        }
        const url = `${server.url.endsWith('/') ? server.url : server.url + "/"}/by_expression/${expression}/${versionMatch}`;
        return this.restGet(url);
    }
    queryServerHash(server, gameId, hash, size) {
        if (!isMD5Hash(hash)) {
            return Promise.resolve([]);
        }
        if (server.nexus !== undefined) {
            return this.queryServerHashNexus(server, gameId, hash, size);
        }
        else if (server.loopbackCB !== undefined) {
            return server.loopbackCB({ hash, size });
        }
        else {
            return this.queryServerHashMeta(server, hash);
        }
    }
    queryServerHashNexus(server, gameId, hash, size) {
        return new Promise((resolve, reject) => {
            this.mMD5Requests.push({ checksum: hash, fileSize: size, resolve, reject });
            this.mNexusMD5Debouncer.schedule();
        });
    }
    queryServerHashMeta(server, hash) {
        const url = `${server.url.endsWith('/') ? server.url : server.url + "/"}/by_key/${hash}`;
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
    gameIdFromNexusDomain(input, reqGameId) {
        if (input === 'skyrimspecialedition') {
            return reqGameId === 'skyrimvr' ? 'skyrimvr' : 'skyrimse';
        }
        else if (input === 'newvegas') {
            return 'falloutnv';
        }
        else if (input === 'fallout4') {
            return reqGameId === 'fallout4vr' ? 'fallout4vr' : 'fallout4';
        }
        else if (input === 'elderscrollsonline') {
            return 'teso';
        }
        else if (input === 'neverwinter') {
            return reqGameId === 'nwnee' ? 'nwnee' : 'nwn';
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
        return this.insert(results.map(result => (Object.assign(Object.assign({}, result.value), { expires: date + lifeTime }))));
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
            let preExpire = [...results];
            if (this.expireResults(results)) {
                results = [];
            }
            if (results.length > 0) {
                return Promise.resolve(results);
            }
            const keySplit = key.split(':');
            const hash = keySplit[0];
            const size = keySplit.length > 1 ? parseInt(keySplit[1], 10) : 0;
            let remoteResults;
            let allInvalid = true;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults && (remoteResults.length > 0)) {
                    return Promise.resolve();
                }
                return this.queryServerHash(server, gameId, hash, size)
                    .then((serverResults) => {
                    allInvalid = false;
                    remoteResults = serverResults;
                    return this.cacheResults(remoteResults, server.cacheDurationSec);
                })
                    .catch(err => {
                    this.mLog('warn', 'failed to query by key', {
                        server: server.url, key, gameId, error: err.message.toString(),
                    });
                });
            })
                .then(() => {
                if (allInvalid) {
                    this.mBlacklist.add(JSON.stringify({ key, gameId }));
                }
                if ((remoteResults !== undefined) && (remoteResults.length > 0)) {
                    return remoteResults;
                }
                else {
                    return preExpire;
                }
            });
        });
    }
    resolveIndex(key) {
        return this.getSafe(key)
            .then(data => {
            if (data === undefined) {
                return undefined;
            }
            const value = JSON.parse(data);
            if (Array.isArray(value)) {
                return { key, value };
            }
            else {
                return { key, value: [value] };
            }
        })
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
                return Promise.resolve(results.reduce(fromRawReducer, []));
            }
            let remoteResults;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults && (remoteResults.length > 0)) {
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
                return Promise.resolve(results.reduce(fromRawReducer, []));
            }
            let remoteResults;
            return Promise.mapSeries(this.mServers, (server) => {
                if (remoteResults && (remoteResults.length > 0)) {
                    return Promise.resolve();
                }
                return this.queryServerExpression(server, expression, versionMatch)
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
