"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function serveREST(db, portIn) {
    const express = require('express');
    const bodyParser = require('body-parser');
    const app = express();
    const router = express.Router();
    const port = portIn || 51666;
    router.route('/by_key/:file_hash')
        .get((req, res) => {
        db.getByKey(req.params.file_hash)
            .then((mods) => res.json(mods))
            .catch((err) => res.send(err));
    });
    router.route('/by_name/:name/:version')
        .get((req, res) => {
        db.getByLogicalName(req.params.name, req.params.version)
            .then((mods) => res.json(mods))
            .catch(err => res.send(err));
    });
    router.route('/by_expression/:expression/:version')
        .get((req, res) => {
        db.getByExpression(req.params.expression, req.params.version)
            .then((mods) => res.json(mods))
            .catch(err => res.send(err));
    });
    router.route('/describe')
        .post((req, res) => {
        db.insert(req.body)
            .then(() => { res.json({ result: 'OK' }); })
            .catch((err) => res.send(err));
    });
    router.route('/list')
        .get((req, res) => {
        db.list()
            .then((output) => { res.json(output); })
            .catch((err) => res.send(err));
    });
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(bodyParser.json());
    app.use('/api', router);
    app.listen(port, () => { console.log(`Serving database on ${port}!`); });
}
exports.serveREST = serveREST;
