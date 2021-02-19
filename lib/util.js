"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.genHash = void 0;
const Promise = require("bluebird");
const fs = require("fs");
function genHash(filePath, onProgress) {
    return Promise.resolve(fs.promises.stat(filePath))
        .then(stats => new Promise((resolve, reject) => {
        try {
            const { createHash } = require('crypto');
            const hash = createHash('md5');
            let size = 0;
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => {
                hash.update(data);
                size += data.length;
                onProgress === null || onProgress === void 0 ? void 0 : onProgress(size, stats.size);
            });
            stream.on('end', () => resolve({
                md5sum: hash.digest('hex'),
                numBytes: size,
            }));
            stream.on('error', (err) => {
                reject(err);
            });
        }
        catch (err) {
            reject(err);
        }
    }));
}
exports.genHash = genHash;
