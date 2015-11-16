/*
 udraw
 
 (c) 2015 Tim Sullivan
 udraw may be freely distributed under the MIT license.
 For all details and documentation: github.com/timatooth/udraw
 */

/* eslint no-console: 0*/
/* eslint-env node */
/* global __dirname */
'use strict';
var express = require('express');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var rateLimit = require('express-rate-limit');
var redis = require('redis');
var adapter = require('socket.io-redis');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var Canvas = require('canvas'), Image = Canvas.Image;
/** Boundary limit for fetching tiles */
var tileRadius = 300;
var patchPass = 'meh patch pass yo';

var redisPort = 6379;
var host = 'localhost';
var tileRedis = redis.createClient(redisPort, host, {return_buffers: true});

io.adapter(adapter(redis.createClient({host: host, port: redisPort})));

/**!! Big TODO Ditch express.js for rest Http api. Considering Go or nhhttp2 w/asio lib */

app.set('trust proxy', 'loopback');
app.set('x-powered-by', false);
app.set('etag', 'strong');

var putLimiter = rateLimit({
    /* config */
    delayAfter: 0,
    max: 150
});

var staticDir = '/dist';
if (process.argv.length > 2) {
    console.warn("Serving dev files!");
    staticDir = '/public';
}

//Express Middleware
app.use('/static', express.static(__dirname + staticDir));
app.use(morgan('combined'));
app.use(bodyParser.raw({type: 'image/png', limit: '250kb'}));
app.use(bodyParser.json({type: 'application/json', limit: '250kb'}));

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

app.get('/:x/:y', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

app.get('/ogimage/:x/:y', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

app.put('/canvases/:name/:zoom/:x/:y', putLimiter, function (req, res) {
    var p = req.params;
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

    var key = "tile:" + req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;

    tileRedis.hget(key, "protection", function (err, data) {
        if (Number(data) === 0) {
            saveTile(key, req, res);
        } else {
            tileRedis.hget(key, "lastuser", function (err, user) {
                console.log(String(user));
                if (String(user) === req.ip) {
                    saveTile(key, req, res);
                } else {
                    res.sendStatus(403);
                }
            });
        }
    });
});

var saveTile = function (key, req, res) {
    tileRedis.hset(key, "data", req.body);
    tileRedis.hset(key, "lastuser", req.ip);
    tileRedis.hset(key, "lastupdate", Date.now() / 1000);
    tileRedis.hset(key, "protection", 0);

    res.sendStatus(201);
    tileRedis.incr('putcount');
    tileRedis.hincrby("user:" + req.ip, "putcount", 1);
};

app.get('/canvases/:name/:zoom/:x/:y', function (req, res) {
    var p = req.params;
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

    var key = req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;
    tileRedis.hget("tile:" + key, "data", function (err, reply) {
        if (err !== null) {
            console.log(err);
            res.sendStatus(500);
        } else if (reply === null) {
            res.sendStatus(204); //make them create the tile
        } else {
            tileRedis.incr('getcount');
            tileRedis.hincrby("user:" + req.ip, "getcount", 1);
            res.set('Content-Type', 'image/png');
            res.send(reply);
        }
    });
});

/**
 * As the cool name suggests, this 'PATCHes' a tile patch onto a tile.
 * If the tile does not exist yet it should be created as a transparent
 * 256x256 image and then the patch applied and saved.
 * 
 * @param {Request} req incoming request with PNG body
 * @param {Response} res response sent back is 201 on success
 * 
 * Rest parms:
 * ox - local offset in the tile to be patched 
 * oy - local y offset in the tile to be patched
 */
app.patch('/canvases/:name/:zoom/:x/:y/:ox:oy', function (req, res) {
    //request range checking
    var p = req.params;
    if (p.name !== "main") {
        return res.sendStatus(404);
    } else if (Number(p.zoom) !== 1) {
        return res.sendStatus(404);
    } else if (Number(p.x) < -(tileRadius / 2) ||
            Number(p.x) > tileRadius / 2 ||
            Number(p.y) < -(tileRadius / 2) ||
            Number(p.y) > tileRadius / 2) {
        return res.sendStatus(416); //requested outside range
    } else if (Number(p.ox) < 0 ||
            Number(p.ox) > 256 ||
            Number(p.oy) < 0 ||
            Number(p.oy) > 256) {
        return res.sendStatus(416); //patch offset is out of acceptable range
    }

    var key = req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;

    tileRedis.hget("tile:" + key, "data", function (err, reply) {
        var buffer;
        if (err !== null) {
            console.log(err);
            res.sendStatus(500);
            return;
        } else if (reply === null) {
            //no tile here yet create transparent blank one
            var canvas = new Canvas(256, 256);
            var ctx = canvas.getContext('2d');
            //load patch image
            var sourceImage = new Image;
            sourceImage.src = req.body;
            //draw new changes atop
            ctx.drawImage(sourceImage, Number(p.ox), Number(p.oy));
            console.log("got size drawing into fresh: " + sourceImage.width + " x " + sourceImage.height);
            buffer = canvas.toBuffer();
        } else {
            //apply image patch on top of existing one
            console.log('applying patch on top of existing image');
            var canvas = new Canvas(256, 256);
            var destinationImage = new Image;
            var ctx = canvas.getContext('2d');
            destinationImage.src = reply; // loads buffer from redis
            ctx.drawImage(destinationImage, 0, 0);

            //load patch image
            var sourceImage = new Image;
            sourceImage.src = req.body;
            //draw new changes atop
            ctx.drawImage(sourceImage, Number(p.ox), Number(p.oy));
            console.log("got size: " + sourceImage.width + " x " + sourceImage.height);
            //save to redis
            buffer = canvas.toBuffer();
        }
        tileRedis.hset(key, "data", buffer);
        tileRedis.hset(key, "lastuser", req.ip);
        tileRedis.hset(key, "lastupdate", Date.now() / 1000);
        tileRedis.hset(key, "protection", 0);

        res.sendStatus(201);
        tileRedis.incr('patchcount');
        tileRedis.hincrby("user:" + req.ip, "patchcount", 1);
    });
});

//not used
app.patch('/canvases/:name/:zoom/:x/:y/meta', function (req, res) {
    if (('creds' in req.body) && req.body.creds === patchPass) {
        var key = "tile:" + req.params.name + ':' + req.params.zoom + ':' + req.params.x + ':' + req.params.y;
        tileRedis.hset(key, "protection", 1, function (err) {
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

/******************** - Socket.IO code - ********************************/

/** Store the socket id with tool states and pan offsets */
var clientStates = {};
tileRedis.set("currentconnections", 0); //reset on boot

io.on('connection', function (socket) {
    var ip = socket.request.connection.remoteAddress;
    tileRedis.incr("totalconnections");
    tileRedis.incr("currentconnections");
    tileRedis.hset("user:" + ip, "lastconnect", Date.now() / 1000 | 0);
    tileRedis.hincrby("user:" + ip, "connectcount", 1);

    socket.emit('states', clientStates);

    socket.on('disconnect', function () {
        if (clientStates.hasOwnProperty(socket.id)) {
            delete clientStates[socket.id];
        }
        tileRedis.decr("currentconnections");
    });

    function inRadius(diamater, x, y, client) {
        var r = diamater / 2;
        if (x > -r + client.offsetX && x < r + client.offsetX && y > -r + client.offsetY && r + client.offsetY) {
            return true;
        }
        return false;
    }

    socket.on('move', function (msg) {
        msg.id = socket.id;
        Object.keys(clientStates).forEach(function (key) {
            if (socket.id === key) { //not send move to initator of the move
                return;
            }
            //when someone is 3000px or more from the client don't relay the move
            if (inRadius(6000, msg.x, msg.y, clientStates[key]) === true) {
                io.to(key).emit('move', msg);
            }
        });
    });

    socket.on('pan', function (msg) {
        msg.id = socket.id;
        socket.broadcast.emit('pan', msg);
        if (clientStates.hasOwnProperty(socket.id)) {
            clientStates[socket.id].offsetX = msg.offsetX;
            clientStates[socket.id].offsetY = msg.offsetY;
        }
    });

    socket.on('ping', function () {
        socket.emit('pong');
    });

    socket.on('status', function (msg) {
        if (msg.size > 60 || msg.size < 1 || msg.opacity > 1 || msg.opacity < 0) {
            tileRedis.sadd("malicious", ip);
            return;
        }
        clientStates[socket.id] = msg;
        msg.id = socket.id;
        socket.broadcast.emit('status', msg);
    });
});

var port = process.env.PORT || 3000;

if (process.argv.length > 2) {
    //listen on all ports in dev
    http.listen(port, function () {
        console.log('http listening on *:' + port);
    });
} else {
    //only listen on localhost
    http.listen(port, 'localhost', function () {
        console.log('http listening on localhost:' + port);
    });
}
