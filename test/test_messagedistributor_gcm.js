var assert = require("assert");
var system = require("system");
var response = require("ringo/jsgi/response");
var {Semaphore} = require("ringo/concurrent");
var {WebServer} = require("./webserver");
var {Application} = require("stick");
var {MessageDistributor} = require("../lib/messagedistributor");
var {Message} = require("../lib/gcm/message");

var WEBSERVER_PORT = 7333;
var server = null;
var md = null;
var app = null;

var createResponse = function(results) {
    var success = results.reduce(function(prev, result) {
        return (result.error === undefined) ? prev += 1 : prev;
    }, 0);
    var failure = results.reduce(function(prev, result) {
        return (result.error !== undefined) ? prev += 1 : prev;
    }, 0);
    var canonicalIds = results.reduce(function(prev, result) {
        return (result.registration_id !== undefined) ? prev += 1 : prev;
    }, 0);
    return {
        "multicast_id": Math.floor(Math.random() * 1000),
        "success": success,
        "failure": failure,
        "canonical_ids": canonicalIds,
        "results": results
    };
};

var createSuccess = function(regId) {
    var result = {
        "message_id": "1:" + Math.floor(Math.random() * 1000)
    };
    if (regId !== undefined) {
        result.registration_id = regId;
    }
    return result;
};

var createError = function(error) {
    if (typeof(error) !== "string") {
        throw new Error("Missing response error");
    }
    return {
        "error": error
    }
};

exports.setUp = function() {
    app = new Application();
    app.configure("params", "route");

    server = new WebServer(app, WEBSERVER_PORT);
    server.start();
    md = new MessageDistributor("test", {
        testmode: true,
        gcm: {
            server: server.getUrl(),
            apiKey: "theKey"
        },
        apns: {
            testmode: true,
            certificate: {
                path: "insertCertHere",
                password: "insertPwdForCertHere"
            }
        }
    });
};

exports.tearDown = function() {
    server && server.stop();
    server = null;
    md && md.stop();
    md = null;
    app = null;
};

exports.testSendMessageNormal = function() {
    var requestData = null;
    var auth = null;
    var semaphore = new Semaphore();

    app.post("/", function(req) {
        requestData = req.postParams;
        auth = req.headers.authorization;
        return response.json(createResponse([createSuccess()]));
    });

    var signal = function() {
        semaphore.signal();
    };
    md.on("messageSent", signal);
    md.start();
    var msg = new Message({message: "daMessage"});
    msg.on("success", signal);
    try {
        md.sendMessage(msg);
        assert.fail("sendMessage with Message without recipients should throw Error");
    } catch(e) {}
    msg.addRecipients(["42"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(1000, 2), "Send message");
    assert.deepEqual(requestData, {
        registration_ids: ["42"],
        data: {message: "daMessage"},
        dry_run: true // because testmode is set to true
    });
    assert.equal(auth, "key=theKey");
};

var testError = function(err) {
    var requestData = null;
    var semaphore = new Semaphore(0);
    app.post("/", function(req) {
        requestData = req.postParams;
        var res = response.json({});
        res.status = err;
        return res;
    });
    md.on("messageSent", function() {
        assert.fail();
    });
    var signal = function() {
        semaphore.signal();
    };
    md.on("error" + err, signal);
    md.start();
    var msg = new Message("daMessage");
    msg.on("failed", signal);
    msg.addRecipients(["42"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(1000, 2), "Handle http " + err);
    assert.equal(md.services.gcm.queue.total(), 0);
};

exports.testSendMessageBad = function() {
    testError(400);
};

exports.testSendMessageUnauthorized = function() {
    testError(401);
    // On authorization errors messagedistributor will be shut down
    java.lang.Thread.sleep(1000);
    assert.equal(md.getSchedulerId("gcm"), null);
};

exports.testSendMessageErrorConnect = function() {
    server.stop();
    server = null;
    var semaphore = new Semaphore();
    md.on("messageSent", function() {
        assert.fail();
    });
    md.on("errorConnect", function() {
        semaphore.signal();
    });
    md.on("error500", function() {
        semaphore.signal();
        // FIXME: current behavior of httpclient
        // returns a status 500 response for timeouts
    });
    md.start();
    var msg = new Message("daMessage");
    msg.addRecipients(["42"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(10000), "Handle connection failed");
    assert.equal(md.services.gcm.queue.total(), 1);
};


exports.testSendMessageRegistrationIdChange = function() {
    var requestData = null;
    var semaphore = new Semaphore();
    app.post("/", function(req) {
        requestData = req.postParams;
        return response.json(createResponse([createSuccess(), createSuccess("21"), createSuccess()]));
    });
    
    var ids = {
            "42": false,
            "43": false,
            "44": false
    };
    var signal = function() {
        semaphore.signal();
    };
    var plattformOk = true;
    md.on("idChange", function(oid, nid, plattform) {
        ids[oid] = nid;
        if (plattform != "gcm") {
            plattformOk = false;
        }
        signal();
    });
    md.start();
    var msg = new Message("daMessage");
    msg.on("idChange", signal);
    msg.on("success", signal);
    msg.addRecipients(["42", "43", "44"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(1000, 3), "Send message");
    assert.isTrue(plattformOk);
    assert.deepEqual(ids, {
        "42": false,
        "43": "21",
        "44": false
    });
};

exports.testSendMessageRegistrationIdUnregistered = function() {
    var requestData = null;
    var semaphore = new Semaphore();
    app.post("/", function(req) {
        requestData = req.postParams;
        return response.json(createResponse([createSuccess(), createError("NotRegistered"), createSuccess()]));
    });
    
    var ids = {
            "42": false,
            "43": false,
            "44": false
    };
    var plattformOk = true;
    var signal = function() {
        semaphore.signal();
    };
    md.on("idUnregistered", function(oid, plattform) {
        ids[oid] = true;
        if (plattform != "gcm") {
            plattformOk = false;
        }
        signal();
    });
    md.start();
    var msg = new Message("daMessage");
    msg.on("success", signal);
    msg.on("idUnregistered", signal);
    msg.addRecipients(["42", "43", "44"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(1000,3), "Send message");
    assert.isTrue(plattformOk);
    assert.deepEqual(ids, {
        "42": false,
        "43": true,
        "44": false
    });
};

exports.testSendMessageRegistrationIdProbUnrecoverableError = function() {
    var requestData = null;
    var semaphore = new Semaphore();
    app.post("/", function(req) {
        requestData = req.postParams;
        return response.json(createResponse([createSuccess(), createError("Blah"), createSuccess()]));
    });
    var plattformOk = true;
    var signal = function() {
        semaphore.signal();
    };
    var ids = {
            "42": false,
            "43": false,
            "44": false
    };
    var error;
    md.on("idUnhandledError", function(oid, err, plattform) {
        ids[oid] = true;
        error = err;
        if (plattform != "gcm") {
            plattformOk = false;
        }
        semaphore.signal();
    });
    md.start();
    var msg = new Message("daMessage");
    msg.on("success", signal);
    msg.on("idUnhandledError", signal);
    msg.addRecipients(["42", "43", "44"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(1000, 3), "Send message");
    assert.deepEqual(ids, {
        "42": false,
        "43": true,
        "44": false
    });
    assert.equal(error, "Blah");
};

exports.testSendMessageOneRecipientResend = function() {
    var requestData = null;
    var semaphore = new Semaphore();
    app.post("/", function(req) {
        requestData = req.postParams;
        if (requestData.registration_ids.length == 3) {
            return response.json(createResponse([createSuccess(), createError("Unavailable"), createSuccess()]));
        } else if (requestData.registration_ids.length == 1) {
            return response.json(createResponse([createSuccess()]));
        } else {
            return response.json({}).error();
        }
    });
    
    var resent;
    md.on("messageRescheduled", function(arr) {
        resent = arr;
        semaphore.signal();
    });
    md.on("messageSent", function() {
        semaphore.signal();
    });
    md.start();
    var msg = new Message("daMessage");
    msg.addRecipients(["42", "43", "44"]);
    md.sendMessage(msg);
    assert.isTrue(semaphore.tryWait(1000, 2), "Send message");
    assert.equal(md.services.gcm.queue.total(), 1);
    assert.isTrue(semaphore.tryWait(11500), "Wait for resent message");
    assert.deepEqual(requestData.registration_ids, ["43"]);
    assert.equal(md.services.gcm.queue.total(), 0);
};