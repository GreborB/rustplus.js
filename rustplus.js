"use strict";

const path = require('path');
const WebSocket = require('ws');
const protobuf = require("protobufjs");
const { EventEmitter } = require('events');
const Camera = require('./camera'); // Assuming camera.js is also in the fork

class RustPlus extends EventEmitter {

    /**
     * @param server The ip address or hostname of the Rust Server
     * @param port The port of the Rust Server (app.port in server.cfg)
     * @param playerId SteamId of the Player
     * @param playerToken Player Token from Server Pairing
     * @param useFacepunchProxy True to use secure websocket via Facepunch's proxy, or false to directly connect to Rust Server
     *
     * Events emitted by the RustPlus class instance
     * - connecting: When we are connecting to the Rust Server.
     * - connected: When we are connected to the Rust Server.
     * - message: When an AppMessage has been received from the Rust Server.
     * - request: When an AppRequest has been sent to the Rust Server.
     * - disconnected: When we are disconnected from the Rust Server.
     * - error: When something goes wrong.
     */
    constructor(server, port, playerId, playerToken, useFacepunchProxy = false) {

        super();

        this.server = server;
        this.port = port;
        this.playerId = playerId;
        this.playerToken = playerToken;
        this.useFacepunchProxy = useFacepunchProxy; // This can be overridden by the service later

        this.seq = 0;
        this.seqCallbacks = [];
        this.websocket = null; // Initialize websocket to null

    }

    /**
     * Connect to the Rust Server.
     * @param {string[]} [protocols] Optional WebSocket protocols.
     * @param {object} [options] Optional WebSocket constructor options.
     */
    connect(protocols, options) {

        // check if we are already connected or connecting
        if(this.websocket && (this.websocket.readyState === WebSocket.CONNECTING || this.websocket.readyState === WebSocket.OPEN)){
            console.log("INTERNAL: WebSocket connection attempt skipped, already connecting or connected.");
            // Optionally disconnect the existing one if behaviour requires replacing
            // this.disconnect();
            return; // Don't attempt a new connection if one is active/pending
        }

        // If websocket exists but is closed/closing, ensure it's cleaned up before reconnecting
        if (this.websocket) {
             console.log("INTERNAL: Cleaning up previous closed/closing WebSocket instance.");
             this.websocket.terminate();
             this.websocket = null;
        }


        protobuf.load(path.join(__dirname, 'rustplus.proto'), (err, root) => {

            // handle errors loading protobuf schema
            if (err) {
                this.emit('error', err);
                return;
            }

            // load proto types
            this.AppRequest = root.lookupType("rustplus.AppRequest");
            this.AppMessage = root.lookupType("rustplus.AppMessage");

            // fire event as we are connecting
            this.emit('connecting');

            // connect to websocket
            var address = this.useFacepunchProxy ? `wss://companion-rust.facepunch.com/game/${this.server}/${this.port}` : `wss://${this.server}:${this.port}`;
            console.log(`INTERNAL: Attempting WebSocket connection to: ${address}`); // Added for debugging

            try {
                // Pass protocols and options if provided
                this.websocket = new WebSocket(address, protocols, options);
            } catch (wsError) {
                console.error("INTERNAL: Error creating WebSocket instance:", wsError);
                this.emit('error', wsError);
                this.websocket = null; // Ensure websocket is null on constructor error
                return;
            }

            // Check readyState immediately in case 'open' fired before listener attached
            if (this.websocket.readyState === WebSocket.OPEN) {
                console.log("INTERNAL: WebSocket already open on creation.");
                this._handleOpen();
            } else {
                 // Attach listeners only if not already open
                 this.websocket.on('open', () => this._handleOpen());
            }

            // fire event for websocket errors
            this.websocket.on('error', (e) => {
                console.error("INTERNAL: WebSocket 'error' event:", e.message);
                this.emit('error', e);
                // Consider cleanup here? Depends on whether 'close' always follows 'error'
                // this.websocket = null;
            });

            this.websocket.on('message', (data) => {

                // decode received message
                var message = this.AppMessage.decode(data);

                // check if received message is a response and if we have a callback registered for it
                if(message.response && message.response.seq && this.seqCallbacks[message.response.seq]){

                    // get the callback for the response sequence
                    var callback = this.seqCallbacks[message.response.seq];

                    // call the callback with the response message
                    var result = callback(message);

                    // remove the callback
                    delete this.seqCallbacks[message.response.seq];

                    // if callback returns true, don't fire message event
                    if(result){
                        return;
                    }

                }

                // fire message event for received messages that aren't handled by callback
                this.emit('message', this.AppMessage.decode(data));

            });

            // fire event when disconnected
            this.websocket.on('close', (code, reason) => {
                console.log(`INTERNAL: WebSocket 'close' event. Code: ${code}, Reason: ${reason}`);
                // Clear potentially dangling callbacks on disconnect
                this.seqCallbacks = [];
                this.websocket = null; // Clear the instance on close
                this.emit('disconnected');
            });

        });

    }

    /**
     * Internal handler for WebSocket open event.
     * @private
     */
    _handleOpen() {
        console.log('INTERNAL: WebSocket connection opened and handled by _handleOpen.'); // Added for debugging
        // Reset sequence number on new connection
        this.seq = 0;
        this.emit('connected');
    }

    /**
     * Disconnect from the Rust Server.
     */
    disconnect() {
        if(this.websocket){
            console.log(`INTERNAL: Disconnecting WebSocket (readyState: ${this.websocket.readyState}).`);
            // Don't emit 'disconnected' here, let the 'close' event handle it naturally
            this.websocket.terminate(); // Force close
            this.websocket = null; // Clear immediately
            // Clear any pending callbacks that won't get a response
            this.seqCallbacks = [];
        } else {
            console.log("INTERNAL: Disconnect called but no active WebSocket instance.");
        }
    }

    /**
     * Check if RustPlus is connected to the server.
     * @returns {boolean}
     */
    isConnected() {
        return (this.websocket && this.websocket.readyState === WebSocket.OPEN);
    }

    /**
     * Send a Request to the Rust Server with an optional callback when a Response is received.
     * @param data this should contain valid data for the AppRequest packet in the rustplus.proto schema file
     * @param callback
     */
    sendRequest(data, callback) {

        // Check if connected before sending
        if (!this.isConnected()) {
             console.error("INTERNAL: Attempted to send request while not connected.");
             // Find and reject the callback if it exists, otherwise the promise might hang forever
             if (callback) {
                // Simulate an error response for the callback
                callback({ response: { error: { error: "not_connected" } } });
            }
             // Or emit an error?
             // this.emit('error', new Error("Attempted to send request while not connected."));
            return;
        }

        // increment sequence number
        let currentSeq = ++this.seq;

        // save callback if provided
        if(callback){
            this.seqCallbacks[currentSeq] = callback;
        }

        // create protobuf from AppRequest packet
        let request = this.AppRequest.fromObject({
            seq: currentSeq,
            playerId: this.playerId,
            playerToken: this.playerToken,
            ...data, // merge in provided data for AppRequest
        });

        try {
            // send AppRequest packet to rust server
            this.websocket.send(this.AppRequest.encode(request).finish());

            // fire event when request has been sent, this is useful for logging
            this.emit('request', request);
        } catch (sendError) {
             console.error("INTERNAL: Error sending WebSocket message:", sendError);
             this.emit('error', sendError);
             // Clean up callback if send fails
            if (callback && this.seqCallbacks[currentSeq]) {
                 delete this.seqCallbacks[currentSeq];
            }
             // Rethrow or handle? For now, log and emit.
        }

    }

    /**
     * Send a Request to the Rust Server and return a Promise
     * @param data this should contain valid data for the AppRequest packet defined in the rustplus.proto schema file
     * @param timeoutMilliseconds milliseconds before the promise will be rejected. Defaults to 10 seconds.
     */
    sendRequestAsync(data, timeoutMilliseconds = 10000) {
        return new Promise((resolve, reject) => {

            // Check if connected before attempting to send
             if (!this.isConnected()) {
                  console.error("INTERNAL: Attempted sendRequestAsync while not connected.");
                  return reject(new Error("Not connected to Rust server"));
             }

            // Store the sequence number associated with this promise
            let promiseSeq;

            // Setup timeout *before* sending request
            var timeout = setTimeout(() => {
                 // Ensure we clean up the callback if timeout hits first
                if (promiseSeq && this.seqCallbacks[promiseSeq]) {
                     delete this.seqCallbacks[promiseSeq];
                     console.log(`INTERNAL: Request ${promiseSeq} timed out.`);
                }
                reject(new Error('Timeout reached while waiting for response'));
            }, timeoutMilliseconds);

            // send request using the callback mechanism
            this.sendRequest(data, (message) => {
                 // If sendRequest failed immediately, the callback might still be called with an error
                 // Or if not connected, it might have been called synchronously above.

                // Response received, clear the timeout
                clearTimeout(timeout);

                // Check for explicit AppError from the server response
                if(message.response && message.response.error && message.response.error.error){
                    console.warn(`INTERNAL: Request ${message.response.seq} failed with AppError: ${message.response.error.error}`);
                    reject(message.response.error); // Reject with the AppError object
                } else if (message.response) {
                    // Request was successful (no AppError), resolve with message.response
                    resolve(message.response);
                } else {
                     // This case should ideally not happen if sendRequest handles errors,
                     // but as a fallback, reject if message.response is missing.
                     console.error(`INTERNAL: Invalid response structure received for seq ${message.seq || 'unknown'}:`, message);
                     reject(new Error("Invalid response structure received"));
                }

                // Return true to prevent the 'message' event from firing for this response
                return true;
            });

            // Capture the sequence number assigned by sendRequest
            // This assumes sendRequest assigns seq before returning if synchronous,
            // or we rely on the callback logic to have the correct sequence.
            // A safer way might be to have sendRequest return the seq number.
            // For now, we rely on the callback having the correct message.seq.
            // We store the seq *inside* the timeout closure for cleanup.
            promiseSeq = this.seq; // Capture the latest seq number assigned

        });
    }

    // --- Entity Methods ---

    /**
     * Send a Request to the Rust Server to set the Entity Value.
     * @param entityId the entity id to set the value for
     * @param value the value to set on the entity
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    setEntityValue(entityId, value, callback) {
         if (callback) {
             console.warn("INTERNAL: setEntityValue callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 entityId: entityId,
                 setEntityValue: {
                     value: value,
                 },
             }, callback);
             return Promise.resolve(); // Return dummy promise if callback used
         } else {
             return this.sendRequestAsync({
                 entityId: entityId,
                 setEntityValue: {
                     value: value,
                 },
             });
         }
    }

    /**
     * Turn a Smart Switch On
     * @param entityId the entity id of the smart switch to turn on
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    turnSmartSwitchOn(entityId) {
        return this.setEntityValue(entityId, true);
    }

    /**
     * Turn a Smart Switch Off
     * @param entityId the entity id of the smart switch to turn off
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    turnSmartSwitchOff(entityId) {
        return this.setEntityValue(entityId, false);
    }

    /**
     * Get info for an Entity
     * @param entityId the id of the entity to get info of
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object containing entity info.
     */
    getEntityInfo(entityId, callback) {
        if (callback) {
             console.warn("INTERNAL: getEntityInfo callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 entityId: entityId,
                 getEntityInfo: {},
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 entityId: entityId,
                 getEntityInfo: {},
             });
        }
    }

    // --- Team Methods ---

    /**
     * Send a message to Team Chat
     * @param message the message to send to team chat
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    sendTeamMessage(message, callback) {
        if (callback) {
             console.warn("INTERNAL: sendTeamMessage callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 sendTeamMessage: {
                     message: message,
                 },
             }, callback);
             return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 sendTeamMessage: {
                     message: message,
                 },
             });
        }
    }

    /**
     * Get team info
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object containing team info.
     */
    getTeamInfo(callback) {
         if (callback) {
             console.warn("INTERNAL: getTeamInfo callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 getTeamInfo: {},
             }, callback);
             return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 getTeamInfo: {},
             });
        }
    }

    // --- Map/Server Info Methods ---

    /**
     * Get the Map
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object containing map data.
     */
    getMap(callback) {
        if (callback) {
             console.warn("INTERNAL: getMap callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 getMap: {},
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 getMap: {},
             });
        }
    }

    /**
     * Get the ingame time
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object containing time data.
    */
    getTime(callback) {
        if (callback) {
             console.warn("INTERNAL: getTime callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 getTime: {},
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 getTime: {},
             });
        }
    }

    /**
     * Get all map markers
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object containing map markers.
     */
    getMapMarkers(callback) {
        if (callback) {
             console.warn("INTERNAL: getMapMarkers callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 getMapMarkers: {},
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 getMapMarkers: {},
             });
        }
    }

    /**
     * Get the server info
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object containing server info.
     */
    getInfo(callback) {
        if (callback) {
             console.warn("INTERNAL: getInfo callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 getInfo: {},
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 getInfo: {},
             });
        }
    }

    // --- Camera Methods ---

    /**
     * Subscribes to a Camera
     * @param identifier Camera Identifier, such as OILRIG1 (or custom name)
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    subscribeToCamera(identifier, callback) {
         if (callback) {
             console.warn("INTERNAL: subscribeToCamera callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 cameraSubscribe: {
                     cameraId: identifier,
                 },
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 cameraSubscribe: {
                     cameraId: identifier,
                 },
             });
        }
    }

    /**
     * Unsubscribes from a Camera
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    unsubscribeFromCamera(callback) {
        if (callback) {
             console.warn("INTERNAL: unsubscribeFromCamera callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 cameraUnsubscribe: {},
             }, callback)
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 cameraUnsubscribe: {},
             });
        }
    }

    /**
     * Sends camera input to the server (mouse movement)
     * @param buttons The buttons that are currently pressed
     * @param x The x delta of the mouse movement
     * @param y The y delta of the mouse movement
     * @param callback Deprecated: Use async version.
     * @returns {Promise<object>} Promise resolving with the AppResponse object.
     */
    sendCameraInput(buttons, x, y, callback) {
        if (callback) {
             console.warn("INTERNAL: sendCameraInput callback is deprecated. Use returned promise instead.");
             this.sendRequest({
                 cameraInput: {
                     buttons: buttons,
                     mouseDelta: {
                         x: x,
                         y: y,
                     }
                 },
             }, callback);
              return Promise.resolve();
        } else {
            return this.sendRequestAsync({
                 cameraInput: {
                     buttons: buttons,
                     mouseDelta: {
                         x: x,
                         y: y,
                     }
                 },
             });
        }
    }

    /**
     * Get a camera instance for controlling CCTV Cameras, PTZ Cameras and Auto Turrets.
     * Note: Ensure the Camera class is correctly defined and exported in './camera.js'.
     * @param identifier Camera Identifier, such as DOME1, OILRIG1L1, (or a custom camera id)
     * @returns {Camera}
     */
    getCamera(identifier) {
        // Assuming Camera class handles its own connection state via the provided RustPlus instance
        return new Camera(this, identifier);
    }

    // --- Deprecated Strobe Method ---
    /**
     * Quickly turn on and off a Smart Switch as if it were a Strobe Light.
     * You will get rate limited by the Rust Server after a short period.
     * It was interesting to watch in game though 😝
     * @deprecated Use manual timing with async methods if needed. Relies on setTimeout.
     */
    strobe(entityId, timeoutMilliseconds = 100, value = true) {
        console.warn("INTERNAL: strobe method is deprecated and may lead to rate limiting.");
        this.setEntityValue(entityId, value)
            .then(() => {
                 setTimeout(() => {
                     this.strobe(entityId, timeoutMilliseconds, !value);
                 }, timeoutMilliseconds);
            })
            .catch(err => {
                console.error(`Error during strobe for entity ${entityId}:`, err);
                // Stop strobing on error
            });
    }

}

module.exports = RustPlus;
