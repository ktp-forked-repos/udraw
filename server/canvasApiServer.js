'use strict';
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const redis = require('redis');

const http = require('http')
const path = require('path');

const StatsD = require('node-dogstatsd').StatsD;
const dogstatsd = new StatsD();
const Raven = require('raven');

const S3Adapter = require('./s3adapter');

// Must configure Raven before doing anything else with it
Raven.config(process.env.SENTRY_DSN).install();

/** Boundary limit for fetching tiles */
const tileRadius = 300;
const patchPass = 'meh patch pass yo';
//location of static web files
const staticDir = path.join(__dirname, '../public')

const canvasApiServer = () => {

    let tileRedis = redis.createClient(
        process.env.REDIS_PORT || 6379,
        process.env.REDIS_HOST || 'localhost',
        { return_buffers: true }
    );

    let adapter = S3Adapter(process.env.UDRAW_S3_BUCKET);

    let app = express();
    // The request handler must be the first middleware on the app
    app.use(Raven.requestHandler());
    app.use(Raven.errorHandler());

    let httpServer = http.Server(app);

    app.set('trust proxy', 'loopback');
    app.set('x-powered-by', false);

    const putLimiter = rateLimit({
        /* config */
        delayAfter: 0,
        max: 150
    });


    //Express Middleware
    app.use('/', express.static(staticDir));
    app.use(morgan('combined'));
    app.use(bodyParser.raw({type: 'image/png', limit: '250kb'}));
    app.use(bodyParser.json({type: 'application/json', limit: '250kb'}));
    app.use(cors());

    //datadog metrics
    const dd_options = {
      'response_code':true,
      'tags': ['app:udraw']
    }

    const connect_datadog = require('connect-datadog')(dd_options);

    app.use(connect_datadog);

    app.get('/',(req, res) => {
        res.sendFile(path.join(staticDir, 'index.html'));
    });

    app.get('/:x/:y', (req, res) => {
        res.sendFile(path.join(staticDir, 'index.html'));
    });

    app.get('/ogimage/:x/:y', (req, res) => {
        res.sendFile(path.join(staticDir, 'images/og-image.png'));
    });

    app.put('/canvases/:name/:zoom/:x/:y', putLimiter, (req, res) => {
        let p = req.params;
        if (p.name !== "main") {
            return res.sendStatus(404);
        } else if (Number(p.zoom) !== 1) {
            return res.sendStatus(404);
        } else if
        (Number(p.x) < -(tileRadius / 2) ||
        Number(p.x) > tileRadius / 2 ||
        Number(p.y) < -(tileRadius / 2) ||
        Number(p.y) > tileRadius / 2)
        {
            return res.sendStatus(416); //requested outside range
        }

        const key = "tile:" + req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;
        cacheTile(key, req, res);
        adapter.saveTileAt(req.params.name, req.params.zoom, req.params.x, req.params.y, req.body, (result) => {
            if(!result) {
                console.log("Saving " + key +" to S3 FAILED")
            }
        });

    });

    const cacheTile = (key, req, res) => {
        tileRedis.hset(key, "data", req.body);
        tileRedis.hset(key, "lastuser", req.ip);
        tileRedis.hset(key, "lastupdate", Date.now() / 1000);
        tileRedis.hset(key, "protection", 0);

        res.sendStatus(201);
        tileRedis.incr('putcount');
        tileRedis.hincrby("user:" + req.ip, "putcount", 1);
        dogstatsd.increment('tile.saves');
    };

    app.get('/canvases/:name/:zoom/:x/:y', (req, res) => {
        let p = req.params;
        if (p.name !== "main") {
            return res.sendStatus(404);
        } else if (Number(p.zoom) !== 1) {
            return res.sendStatus(404);
        } else if (Number(p.x) < -(tileRadius / 2) ||
        Number(p.x) > tileRadius / 2 ||
        Number(p.y) < -(tileRadius / 2) ||
        Number(p.y) > tileRadius / 2) {
            return res.sendStatus(416); //requested outside range
        }

        const key = req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;
        tileRedis.hget("tile:" + key, "data", (err, reply) => {
            if (err !== null) {
                console.log(err);
                res.sendStatus(500);
            } else if (reply === null) { // no tile in cache
                let cacheKey = "tile:" + key;
                //check persistent storage
                adapter.getTileAt(req.params.name, req.params.zoom, req.params.x, req.params.y, (data) => {
                    // if we have data, an existing tile was found, send the payload & cache it in redis
                    if(data !== null){
                        //cache it
                        tileRedis.hset(cacheKey, "data", data);
                        tileRedis.hset(cacheKey, "lastuser", req.ip);
                        tileRedis.hset(cacheKey, "lastupdate", Date.now() / 1000);
                        tileRedis.hset(cacheKey, "protection", 0);
                        res.set('Content-Type', 'image/png');
                        res.send(data);
                        dogstatsd.increment('cache.miss');
                    } else {
                        // cache not found result
                        tileRedis.hset(cacheKey, "data", "miss"); //special case of no tile
                        tileRedis.hset(cacheKey, "lastuser", req.ip);
                        tileRedis.hset(cacheKey, "lastupdate", Date.now() / 1000);
                        tileRedis.hset(cacheKey, "protection", 0);
                        res.sendStatus(204); //make them create the tile (client side)
                        dogstatsd.increment('cache.emptymiss');
                    }
                });
            } else if (reply.equals(Buffer("miss")))  {
                dogstatsd.increment('cache.emptyhit');
                res.sendStatus(204); //make them create the tile (client side)
            } else {
                dogstatsd.increment('cache.hit');
                tileRedis.incr('getcount');
                tileRedis.hincrby("user:" + req.ip, "getcount", 1);
                dogstatsd.increment('tile.gets');
                res.set('Content-Type', 'image/png');
                res.send(reply);
            }
        });
    });

    app.patch('/canvases/:name/:zoom/:x/:y', (req, res) => {
        if (('creds' in req.body) && req.body.creds === patchPass) {
            const key = "tile:" + req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;
            tileRedis.hset(key, "protection", 1, (err) => {
                if (err === null) {
                    res.sendStatus(200);
                } else {
                    res.sendStatus(500);
                }
            });
        } else {
            res.sendStatus(401);
        }
    });

    return httpServer;
}

module.exports = canvasApiServer;
