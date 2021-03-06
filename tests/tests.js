/* global equal, notEqual, ok, module, test */

define([
    'jquery',
    'strophe.js',
    'websocket'
    ], function($, wrapper, websocket) {
    const Strophe = wrapper.Strophe;
    const XMPP_DOMAIN = 'anonymous.server.com';
    const WEBSOCKET_URL = 'ws://localhost:8888';
    const JID = `8a5dce26-73ee-4505-bd0e-cb44bc3923dc@${XMPP_DOMAIN}/Q0TEoAmA`;

    const OPEN_STREAM = [
        `<open xml:lang='en' version='1.0' from='${XMPP_DOMAIN}' xmlns='urn:ietf:params:xml:ns:xmpp-framing' id='0cda18a2-6ec2-46e9-bf43-abad458caacb'/>`,
        "<stream:features xmlns:stream='http://etherx.jabber.org/streams' xmlns='jabber:client'><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>ANONYMOUS</mechanism></mechanisms></stream:features>"
    ];
    const OPEN_STREAM2 = [
        `<open xml:lang='en' version='1.0' from='${XMPP_DOMAIN}' xmlns='urn:ietf:params:xml:ns:xmpp-framing' id='860ef67e-6af1-4e6f-ad2d-22e124a1c0ca'/>`,
        "<stream:features xmlns:stream='http://etherx.jabber.org/streams' xmlns='jabber:client'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><required/></bind><session xmlns='urn:ietf:params:xml:ns:xmpp-session'><optional/></session><ver xmlns='urn:xmpp:features:rosterver'/><sm xmlns='urn:xmpp:sm:2'><optional/></sm><sm xmlns='urn:xmpp:sm:3'><optional/></sm><c hash='sha-1' node='http://prosody.im' ver='A5axPJ3bu8TW84XiqwpG16Sype8=' xmlns='http://jabber.org/protocol/caps'/></stream:features>"
    ];

    function createResumedStream({ resumeToken }) {
        return [
            OPEN_STREAM,
            "<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>",
            OPEN_STREAM2,
            `<resumed xmlns='urn:xmpp:sm:3' h='0' previd='${resumeToken}'/>`,
            'result',
            'result'
        ];
    }

    function createFailedWithTooManyAck() {
        return [
                OPEN_STREAM,
                "<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>",
                OPEN_STREAM2,
                "<stream:error xmlns:stream='http://etherx.jabber.org/streams' xmlns='jabber:client'>" +
                    "<undefined-condition xmlns='urn:ietf:params:xml:ns:xmpp-streams'/>" +
                    "<handled-count-too-high xmlns='urn:xmpp:sm:3' h='0' send-count='0'/>" +
                    "<text xml:lang='en' xmlns='urn:ietf:params:xml:ns:xmpp-streams'>" +
                        "You acknowledged X stanzas, but I only sent you 0 so far." +
                    "</text>" +
                "</stream:error>"
        ];
    }

    function createResponseStream({
        failToEnableResume,
        resumeToken
    }) {
        return [
            OPEN_STREAM,
            "<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>",
            OPEN_STREAM2,
            `<iq type='result' xmlns='jabber:client' id='_bind_auth_2'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>${JID}</jid></bind></iq>`,
            `<iq xmlns='jabber:client' type='result' to='${JID}' id='_session_auth_2'/>`,
            failToEnableResume
                ? "<failed xmlns='urn:xmpp:sm:3'><unexpected-request xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></failed>"
                : `<enabled xmlns='urn:xmpp:sm:3' id='${resumeToken}' resume='true'/>`
        ];
    }

    class MockServer {
        constructor({ assert, wsUrl, responseStreams }) {
            const Server = websocket.Server;

            this.mockServer = new Server(wsUrl);
            let socketCounter = 0;

            this.mockServer.on('connection', socket => {
                const socketIdx = socketCounter;

                socketCounter += 1;

                socket.respIdx = 0;
                let processedStanzas = 0;
                socket.on('message', msg => {
                    console.info('Server received:', msg);
                    let responseStream = responseStreams[socketIdx];

                    if (!responseStream) {
                        socket.close(1000, 'unexpected connection');

                        return;
                    }

                    let response;
                    if (msg.startsWith('<r xmlns="urn:xmpp:sm:3"')) {
                        response = `<a xmlns="urn:xmpp:sm:3" h="${processedStanzas}" />`;
                    } else {
                        response = responseStream[socket.respIdx];
                        socket.respIdx += 1;
                    }

                    console.info('Server response:', response);

                    if (Array.isArray(response)) {
                        for(const r of response) {
                            socket.send(r);
                        }
                    } else if (response) {
                        if (response === 'result') {
                            processedStanzas += 1;
                            const id = msg.match(' id="(.*):sendIQ" ')[1];
                            response = `<iq type='result' from='${XMPP_DOMAIN}' to='${JID}' xmlns='jabber:client' id='${id}:sendIQ'/>`
                        } else if (response === 'ignore') {

                            return;
                        } else if (response === 'close') {
                            socket.close();

                            return;
                        }
                        socket.send(response);
                    } else {
                        assert.ok(false, "Unexpected msg received: " + msg);
                        socket.close();
                    }
                })
            });
        }

        cleanup() {
            for(const client of this.mockServer.clients()) {
                client.close(1000, 'test cleanup');
            }
            this.mockServer.stop();
        }
    }

    function createTestPromise(mockServerOptions, executor) {
        const mockServer = new MockServer({
            wsUrl: WEBSOCKET_URL,
            ...mockServerOptions
        });

        return new Promise((resolve, reject) => {
            setTimeout(() => {
                mockServer.cleanup();
                reject('The test got stuck?');
            }, 5000);

            executor(resolve, reject);
        }).then(
            () => mockServer.cleanup(),
            error => {
                mockServer.cleanup();

                throw error;
            });
    }

    const getStatusString = function(status) {
        switch (status) {
            case Strophe.Status.ERROR:
                return 'ERROR';
            case Strophe.Status.CONNECTING:
                return 'CONNECTING';
            case Strophe.Status.CONNFAIL:
                return 'CONNFAIL';
            case Strophe.Status.AUTHENTICATING:
                return 'AUTHENTICATING';
            case Strophe.Status.AUTHFAIL:
                return 'AUTHFAIL';
            case Strophe.Status.CONNECTED:
                return 'CONNECTED';
            case Strophe.Status.DISCONNECTED:
                return 'DISCONNECTED';
            case Strophe.Status.DISCONNECTING:
                return 'DISCONNECTING';
            case Strophe.Status.ATTACHED:
                return 'ATTACHED';
            default:
                return 'unknown';
        }
    };

    class TestStropheConnection  {
        constructor() {
            this.c = new Strophe.Connection(WEBSOCKET_URL);
            this.c.connect(
                XMPP_DOMAIN,
                null,
                this._connect_cb.bind(this));
        }

        _connect_cb(status, error, elem) {
            this.status = status;
            console.info('Strophe conn status', getStatusString(status), error, elem);
            const statusObserver = this._statusObserver;

            if (statusObserver && statusObserver.status === status) {
                this._statusObserver = undefined;
                statusObserver.resolve({ status, error, elem});
            }
        }

        enableStreamResume() {
            this.c.streamManagement.enable(/* resume */ true);

            return this.awaitResumeEnabled();
        }

        awaitStatus(status, timeout = 2000) {
            return new Promise((resolve, reject) => {
                this._statusObserver = {
                    status,
                    resolve
                };
                setTimeout(() => reject('Wait for ' + getStatusString(status) + ' timeout'), timeout);
            });
        }

        awaitResumeEnabled(timeout = 2000) {
            return new Promise((resolve, reject) => {
                // Strophe calls it's resume method after streamManagement plugin enables stream resumption - override
                // the function to catch the exact moment.
                const originalResume = this.c.resume;
                this.c.resume = () => {
                    this.c.resume = originalResume;
                    originalResume.call(this.c);

                    resolve();
                };
                setTimeout(() => reject('Wait for resumed timeout'), timeout);
            });
        }

        sendPingIQ(timeout = 2000) {
            return new Promise((resolve, reject) => {
                this.c.sendIQ(wrapper.$iq({
                        to: XMPP_DOMAIN,
                        type: 'get' })
                        .c('ping', { xmlns: 'urn:xmpp:ping' }),
                    resolve,
                    error => {
                        reject('Send ping error: ' + error && error.message);
                    },
                    timeout);
            });
        }
    }

    var run = function () {
        QUnit.module("stream management");

        QUnit.test("enable stream resume", assert => {
            const resumeToken = '1257';
            const mockServerOptions = {
                assert,
                wsUrl: WEBSOCKET_URL,
                responseStreams: [
                    createResponseStream({ resumeToken })
                ]
            };

            return createTestPromise(mockServerOptions, resolve => {
                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        assert.equal(resumeToken, stropheConn.c.streamManagement.getResumeToken(), 'Check resume token');
                        resolve();
                    });
            });
        });

        QUnit.test("failed to enable stream resume", assert => {
            const mockServerOptions = {
                assert,
                wsUrl: WEBSOCKET_URL,
                responseStreams: [
                    createResponseStream({ failToEnableResume: true })
                ]
            };

            return createTestPromise(mockServerOptions, resolve => {
                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => {
                        stropheConn.c.streamManagement.enable(/* resume */ true);
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.ERROR))
                    .then(({ elem }) => {
                        assert.equal('failed', elem.nodeName, 'failed element nodeName');
                        assert.equal('urn:xmpp:sm:3', elem.namespaceURI, 'failed element xmlns');
                        resolve();
                    });
            });
        });

        QUnit.test("resume no unacked stanzas", assert => {
            const resumeToken = '1257';
            const mockServerOptions = {
                assert,
                wsUrl: WEBSOCKET_URL,
                responseStreams: [
                    createResponseStream({ resumeToken }),
                    createResumedStream({ resumeToken })
                ]
            };

            return createTestPromise(mockServerOptions, (resolve, reject) => {
                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        // Close the websocket which should now transition Strophe to DISCONNECTED
                        stropheConn.c._proto.socket.close();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.DISCONNECTED))
                    .then(() => {
                        assert.equal(resumeToken, stropheConn.c.streamManagement.getResumeToken(), 'Check resume token');
                        stropheConn.c.streamManagement.resume();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.CONNECTED))
                    .then(resolve, reject);
            });
        });

        QUnit.test('closed on the 1st resume attempt', assert => {
            const resumeToken = '1234';
            const disruptedStream = createResumedStream({ resumeToken });

            disruptedStream[2]  = 'close';

            const mockServerOptions = {
                assert,
                responseStreams:[
                    createResponseStream({ resumeToken }),
                    disruptedStream,
                    createResumedStream({ resumeToken })
                ]
            };

            return createTestPromise(mockServerOptions, (resolve, reject) => {
                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        stropheConn.c._proto.socket.close();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.DISCONNECTED))
                    .then(() => {
                        assert.equal(resumeToken, stropheConn.c.streamManagement.getResumeToken(), 'Check resume token');
                        stropheConn.c.streamManagement.resume();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.DISCONNECTED))
                    .then(() => {
                        assert.equal(resumeToken, stropheConn.c.streamManagement.getResumeToken(), 'Check token not lost');
                        stropheConn.c.streamManagement.resume();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.CONNECTED))
                    .then(resolve, reject);
            });
        });

        QUnit.test("resume with unacked stanzas", assert => {
            const resumeToken = '1257';
            const mockServerOptions = {
                assert,
                wsUrl: WEBSOCKET_URL,
                responseStreams: [
                    createResponseStream({ resumeToken }),
                    createResumedStream({ resumeToken })
                ]
            };

            return createTestPromise(mockServerOptions, (resolve, reject) => {
                let ping1Promise, ping2Promise;

                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        // Override Websocket's send method to not send the IQs as if the network link was broken.
                        stropheConn.c._proto.socket.send = () => { };

                        ping1Promise = stropheConn.sendPingIQ();
                        ping2Promise = stropheConn.sendPingIQ();

                        // Close the websocket and make Strophe the connection's been dropped
                        stropheConn.c._proto.socket.close();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.DISCONNECTED))
                    .then(() => {
                        assert.equal(resumeToken, stropheConn.c.streamManagement.getResumeToken(), 'Check resume token');
                        stropheConn.c.streamManagement.resume();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.CONNECTED))
                    .then(()  => {
                        assert.notEqual(undefined, ping1Promise);
                        assert.notEqual(undefined, ping2Promise);

                        return ping1Promise
                            .then(() => ping2Promise)
                            .then(resolve, reject);
                    });
            });
        });

        QUnit.test("resume failed with too many acknowledged stanzas", assert => {
            const resumeToken = '1257';
            const mockServerOptions = {
                assert,
                wsUrl: WEBSOCKET_URL,
                responseStreams: [
                    createResponseStream({ resumeToken }),
                    createFailedWithTooManyAck()
                ]
            };

            return createTestPromise(mockServerOptions, resolve => {
                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        // Modify the client processed counter to make server return an error on resume
                        stropheConn.c.streamManagement._clientProcessedStanzasCounter += 2;
                        // Close the websocket and make Strophe the connection's been dropped
                        stropheConn.c._proto.socket.close();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.DISCONNECTED))
                    .then(() => {
                        assert.equal(resumeToken, stropheConn.c.streamManagement.getResumeToken(), 'Check resume token');
                        stropheConn.c.streamManagement.resume();
                    })
                    .then(() => stropheConn.awaitStatus(Strophe.Status.ERROR))
                    .then(({ error }) => {
                        assert.equal('undefined-condition', error, 'check undefined-condition');
                        resolve();
                    });
            });
        });
        QUnit.test('stanza acknowledgment', (assert) => {
            const resumeToken = '1257';
            const responseStream = createResponseStream({ resumeToken });

            const STANZA_COUNT = Strophe._connectionPlugins.streamManagement.requestResponseInterval;

            for  (let i = 0; i < STANZA_COUNT; i++) {
                responseStream.push('result');
            }

            const mockServerOptions = {
                assert,
                responseStreams: [ responseStream ]
            };

            return createTestPromise(mockServerOptions, (resolve, reject) => {
                let pingPromises = [];

                const stropheConn = new TestStropheConnection();
                const waitForStanzasAck = new Promise((resolve, reject) => {
                    let counter = 0;
                    stropheConn.c.streamManagement.addAcknowledgedStanzaListener(() => {
                        counter += 1;
                        if (counter === STANZA_COUNT) {
                            resolve();
                        }
                    });
                    setTimeout(() => reject('AcknowledgedStanzaListener timeout'), 5000);
                });

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        for (let i = 0; i < STANZA_COUNT; i++) {
                            pingPromises.push(stropheConn.sendPingIQ());
                        }
                    })
                    .then(()  => {
                        assert.equal(STANZA_COUNT, pingPromises.length);

                        return Promise.all(pingPromises);
                    })
                    .then(()  => waitForStanzasAck)
                    .then(() => {
                        assert.equal(STANZA_COUNT, stropheConn.c.streamManagement._serverProcesssedStanzasCounter);
                    })
                    .then(resolve, reject);
            });
        });
        QUnit.test("disconnect", function(assert) {
            const resumeToken = '1234';
            const responseStream = createResponseStream({ resumeToken });

            responseStream.push('ignore'); // Ignore <presence type="unavailable" xmlns="jabber:client"/>
            responseStream.push('ignore'); // Ignore <close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>

            const mockServerOptions = {
                assert,
                responseStreams:[ responseStream ]
            };

            return createTestPromise(mockServerOptions, (resolve, reject) => {
                const stropheConn = new TestStropheConnection();

                stropheConn.awaitStatus(Strophe.Status.CONNECTED)
                    .then(() => stropheConn.enableStreamResume())
                    .then(() => {
                        assert.equal(stropheConn.c.streamManagement.getResumeToken(), resumeToken, 'resume token');
                        stropheConn.c.disconnect();
                        assert.equal(stropheConn.status, Strophe.Status.DISCONNECTED, 'disconnected status');
                        assert.equal(stropheConn.c.streamManagement.getResumeToken(), undefined,  'resume token cleared');
                    })
                    .then(resolve, reject);
            });
        });
   };
    return {run: run};
});
