"use strict";

const path = require('path');
const WebSocket = require('ws');
const protobuf = require("protobufjs");
const { EventEmitter } = require('events');
const Camera = require('./camera');

class RustPlus extends EventEmitter {

    /**
     * @param server The ip address or hostname of the Rust Server
     * @param port The port of the Rust Server (app.port in server.cfg)
     * @param playerId SteamId of the Player
     * @param playerToken Player Token from Server Pairing
     * @param useFacepunchProxy True to use secure websocket via Facepunch's proxy, or false to directly connect to Rust Server
     * @param wsOptions Optional options object to pass to the underlying WebSocket constructor (e.g., for TLS settings)
     *
     * Events emitted by the RustPlus class instance
     * - connecting: When we are connecting to the Rust Server.
     * - connected: When we are connected to the Rust Server (after successful initial getInfo).
     * - message: When an AppMessage has been received from the Rust Server.
     * - request: When an AppRequest has been sent to the Rust Server.
     * - disconnected: When we are disconnected from the Rust Server.
     * - error: When something goes wrong.
     */
    constructor(server, port, playerId, playerToken, useFacepunchProxy = false, wsOptions = {}) { // Added wsOptions parameter

        super();

        this.server = server;
        this.port = port;
        this.playerId = playerId;
        this.playerToken = playerToken;
        this.useFacepunchProxy = useFacepunchProxy;
        this.wsOptions = wsOptions; // Store the options

        this.seq = 0;
        this.seqCallbacks = [];

    }

    /**
     * This sets everything up and then connects to the Rust Server via WebSocket.
     */
    connect() {

        // load protobuf then connect
        protobuf.load(path.resolve(__dirname, "rustplus.proto")).then((root) => {

            // make sure existing connection is disconnected before connecting again.
            if(this.websocket){
                this.disconnect();
            }

            // load proto types
            this.AppRequest = root.lookupType("rustplus.AppRequest");
            this.AppMessage = root.lookupType("rustplus.AppMessage");

            // fire event as we are connecting
            this.emit('connecting');

            // connect to websocket
            var address = this.useFacepunchProxy ? `wss://companion-rust.facepunch.com/game/${this.server}/${this.port}` : `wss://${this.server}:${this.port}`;
            this.websocket = new WebSocket(address, this.wsOptions); // Pass the wsOptions here

            // WebSocket 'open' event handler - MODIFIED LOGIC
            this.websocket.on('open', () => {
                // Try sending an initial request immediately after open
                // Use console.log for temporary debugging within the library file itself
                console.log(`[RustPlus Fork - ${new Date().toISOString()}] WebSocket opened. Sending initial getInfo request...`);
                this.getInfo((message) => {
                    // This callback will be invoked when the getInfo response arrives
                    console.log(`[RustPlus Fork - ${new Date().toISOString()}] Received response to initial getInfo:`, JSON.stringify(message));

                    // Check if the response indicates success before emitting 'connected'
                    if (message && message.response && !message.response.error) {
                        console.log(`[RustPlus Fork - ${new Date().toISOString()}] Initial getInfo successful. Emitting 'connected'.`);
                        this.emit('connected'); // Emit connected ONLY after successful initial request
                    } else {
                        const errorMsg = message?.response?.error?.error || 'Unknown error during initial getInfo';
                        console.error(`[RustPlus Fork - ${new Date().toISOString()}] Initial getInfo failed or returned error. Disconnecting. Error:`, errorMsg);
                        this.emit('error', new Error(`Initial getInfo failed: ${errorMsg}`));
                        this.disconnect(); // Disconnect on failure
                    }
                    return true; // Mark this specific callback as handled (prevents 'message' event for this)
                });

                // We no longer emit 'connected' immediately here.
                // It will be emitted inside the getInfo callback upon success.
            });

            // fire event for websocket errors
            this.websocket.on('error', (e) => {
                console.error(`[RustPlus Fork - ${new Date().toISOString()}] WebSocket error event:`, e.message); // Log error clearly
                this.emit('error', e);
                // Consider disconnecting or cleaning up state here if appropriate
                // this.disconnect(); // Maybe disconnect on any WS error?
            });

            // Handle incoming messages (excluding the handled getInfo response)
            this.websocket.on('message', (data) => {
                try {
                    // decode received message
                    var message = this.AppMessage.decode(data);

                    // check if received message is a response and if we have a callback registered for it
                    if (message.response && message.response.seq && this.seqCallbacks[message.response.seq]) {

                        // get the callback for the response sequence
                        var callback = this.seqCallbacks[message.response.seq];

                        // remove the callback *before* calling it to prevent potential re-entrancy issues
                        delete this.seqCallbacks[message.response.seq];

                        // call the callback with the response message
                        var result = callback(message);


                        // if callback returns true, don't fire global 'message' event
                        if (result) {
                            return;
                        }

                    }

                    // fire message event for received messages that aren't handled by callback
                    // or aren't responses (i.e., broadcasts)
                    this.emit('message', message);

                } catch (decodeError) {
                     console.error(`[RustPlus Fork - ${new Date().toISOString()}] Error decoding protobuf message:`, decodeError);
                     this.emit('error', new Error(`Protobuf decode error: ${decodeError.message}`));
                }

            });

            // fire event when disconnected
            this.websocket.on('close', (code, reason) => {
                console.log(`[RustPlus Fork - ${new Date().toISOString()}] WebSocket closed. Code: ${code}, Reason: ${reason}`); // Log close details
                this.emit('disconnected');
                 // Clean up callbacks map on close
                 this.seqCallbacks = [];
            });

        }).catch(protoLoadError => {
             // Handle errors loading the protobuf file
            console.error(`[RustPlus Fork - ${new Date().toISOString()}] Fatal Error: Failed to load rustplus.proto:`, protoLoadError);
            // Emit an error that the main application can catch
            this.emit('error', new Error(`Failed to load protobuf definition: ${protoLoadError.message}`));
        });

    }

    /**
     * Disconnect from the Rust Server.
     */
    disconnect() {
        if(this.websocket){
            console.log(`[RustPlus Fork - ${new Date().toISOString()}] Disconnect called. Terminating WebSocket.`); // Log disconnect call
            this.websocket.terminate(); // Force close the connection
            this.websocket = null; // Nullify the reference
             // Clean up callbacks map on explicit disconnect
             this.seqCallbacks = [];
        }
    }

    /**
     * Check if RustPlus is connected to the server.
     * @returns {boolean}
     */
    isConnected() {
        // Ensure websocket exists before checking readyState
        return this.websocket && (this.websocket.readyState === WebSocket.OPEN);
    }


    /**
     * Send a Request to the Rust Server with an optional callback when a Response is received.
     * @param data this should contain valid data for the AppRequest packet in the rustplus.proto schema file
     * @param callback Optional callback for the response
     */
    sendRequest(data, callback) {
        // Ensure websocket is ready before sending
        if (!this.isConnected()) {
            const errorMsg = "Attempted to send request while not connected.";
            console.error(`[RustPlus Fork - ${new Date().toISOString()}] ${errorMsg}`);
            // If a callback was provided, call it immediately with an error?
             if (callback) {
                 // Simulate an error response structure if possible, or just pass an Error
                 try {
                     callback({ response: { error: { error: 'disconnected' } } });
                 } catch (cbError) {
                     console.error(`[RustPlus Fork - ${new Date().toISOString()}] Error invoking callback during disconnected sendRequest:`, cbError);
                 }
             }
            // Emit a general error as well
            this.emit('error', new Error(errorMsg));
            return; // Stop processing
        }

        // increment sequence number
        let currentSeq = ++this.seq;

        // save callback if provided
        if(callback){
            this.seqCallbacks[currentSeq] = callback;
        }

        // create protobuf from AppRequest packet
        let requestPayload;
        try {
            requestPayload = this.AppRequest.fromObject({
                seq: currentSeq,
                playerId: this.playerId,
                playerToken: this.playerToken,
                ...data, // merge in provided data for AppRequest
            });
        } catch (objectError) {
            console.error(`[RustPlus Fork - ${new Date().toISOString()}] Error creating protobuf object:`, objectError, "Data:", data);
            this.emit('error', new Error(`Protobuf object creation error: ${objectError.message}`));
            if (callback) delete this.seqCallbacks[currentSeq]; // Clean up callback
            return;
        }


        // send AppRequest packet to rust server
        try {
            const buffer = this.AppRequest.encode(requestPayload).finish();
            this.websocket.send(buffer);
             // fire event when request has been sent, this is useful for logging
             // console.log(`[RustPlus Fork - ${new Date().toISOString()}] Sent request seq ${currentSeq}:`, JSON.stringify(requestPayload)); // Optional: Log sent request
            this.emit('request', requestPayload);
        } catch (sendError) {
            console.error(`[RustPlus Fork - ${new Date().toISOString()}] Error sending WebSocket message seq ${currentSeq}:`, sendError);
            // Handle the error, perhaps emit an error event
            this.emit('error', new Error(`Failed to send request: ${sendError.message}`));
             // If this request had a callback, maybe call it with an error?
             // Or remove the callback if appropriate
             if (this.seqCallbacks[currentSeq]) {
                 delete this.seqCallbacks[currentSeq];
                 // Consider calling callback with an error object or similar
             }
        }
    }

    /**
     * Send a Request to the Rust Server and return a Promise
     * @param data this should contain valid data for the AppRequest packet defined in the rustplus.proto schema file
     * @param timeoutMilliseconds milliseconds before the promise will be rejected. Defaults to 10 seconds.
     */
    sendRequestAsync(data, timeoutMilliseconds = 10000) {
        return new Promise((resolve, reject) => {
             // Check connection status before attempting to send
             if (!this.isConnected()) {
                reject(new Error('Not connected to Rust server.'));
                return;
             }

             // Need to capture the sequence number *before* setting the timeout or sending
             const currentSeq = ++this.seq;
             let timeout = null; // Declare timeout variable

             // Setup the callback first
             this.seqCallbacks[currentSeq] = (message) => {
                 clearTimeout(timeout); // Clear timeout on response
                 // Callback removed by sendRequest logic after this runs or on timeout cleanup
                 if (message.response.error) {
                     reject(message.response.error);
                 } else {
                     resolve(message.response);
                 }
                 return true; // Mark as handled
             };

             // Setup the timeout
             timeout = setTimeout(() => {
                 // Ensure the callback for this sequence is cleaned up on timeout
                 if (this.seqCallbacks[currentSeq]) {
                     delete this.seqCallbacks[currentSeq];
                 }
                reject(new Error(`Timeout reached while waiting for response to seq ${currentSeq}`));
            }, timeoutMilliseconds);

            // Now actually send the request (using the manually incremented seq)
            // Create protobuf from AppRequest packet (adjust internal seq handling)
            let requestPayload;
            try {
                 requestPayload = this.AppRequest.fromObject({
                    seq: currentSeq, // Use the captured sequence
                    playerId: this.playerId,
                    playerToken: this.playerToken,
                    ...data,
                });
            } catch (objectError) {
                console.error(`[RustPlus Fork - ${new Date().toISOString()}] Error creating protobuf object for async req:`, objectError, "Data:", data);
                 clearTimeout(timeout); // Clean up timer
                if (this.seqCallbacks[currentSeq]) delete this.seqCallbacks[currentSeq]; // Clean up callback
                reject(new Error(`Protobuf object creation error: ${objectError.message}`));
                return;
            }

             // Send AppRequest packet
             try {
                 const buffer = this.AppRequest.encode(requestPayload).finish();
                 this.websocket.send(buffer);
                  // console.log(`[RustPlus Fork - ${new Date().toISOString()}] Sent async request seq ${currentSeq}:`, JSON.stringify(requestPayload)); // Optional log
                 this.emit('request', requestPayload);
             } catch (sendError) {
                 console.error(`[RustPlus Fork - ${new Date().toISOString()}] Error sending async WebSocket message seq ${currentSeq}:`, sendError);
                 clearTimeout(timeout); // Clean up timer
                if (this.seqCallbacks[currentSeq]) delete this.seqCallbacks[currentSeq]; // Clean up callback
                 this.emit('error', new Error(`Failed to send async request: ${sendError.message}`));
                 reject(sendError); // Reject the promise
             }
        });
    }


    /**
     * Send a Request to the Rust Server to set the Entity Value.
     * @param entityId the entity id to set the value for
     * @param value the value to set on the entity
     * @param callback
     */
    setEntityValue(entityId, value, callback) {
        this.sendRequest({
            entityId: entityId,
            setEntityValue: {
                value: value,
            },
        }, callback);
    }

    /**
     * Turn a Smart Switch On
     * @param entityId the entity id of the smart switch to turn on
     * @param callback
     */
    turnSmartSwitchOn(entityId, callback) {
        this.setEntityValue(entityId, true, callback);
    }

    /**
     * Turn a Smart Switch Off
     * @param entityId the entity id of the smart switch to turn off
     * @param callback
     */
    turnSmartSwitchOff(entityId, callback) {
        this.setEntityValue(entityId, false, callback);
    }

    /**
     * Quickly turn on and off a Smart Switch as if it were a Strobe Light.
     * You will get rate limited by the Rust Server after a short period.
     * It was interesting to watch in game though 😝
     */
    strobe(entityId, timeoutMilliseconds = 100, value = true) {
        this.setEntityValue(entityId, value);
        setTimeout(() => {
            // Check if connected before strobing again
            if (this.isConnected()) {
                 this.strobe(entityId, timeoutMilliseconds, !value);
            }
        }, timeoutMilliseconds);
    }

    /**
     * Send a message to Team Chat
     * @param message the message to send to team chat
     * @param callback
     */
    sendTeamMessage(message, callback) {
        this.sendRequest({
            sendTeamMessage: {
                message: message,
            },
        }, callback);
    }

    /**
     * Get info for an Entity
     * @param entityId the id of the entity to get info of
     * @param callback
     */
    getEntityInfo(entityId, callback) {
        this.sendRequest({
            entityId: entityId,
            getEntityInfo: {

            },
        }, callback);
    }

    /**
     * Get the Map
     */
    getMap(callback) {
        this.sendRequest({
            getMap: {

            },
        }, callback);
    }

    /**
     * Get the ingame time
    */
    getTime(callback) {
        this.sendRequest({
            getTime: {

            },
        }, callback);
    }

    /**
     * Get all map markers
     */
    getMapMarkers(callback) {
        this.sendRequest({
            getMapMarkers: {

            },
        }, callback);
    }

    /**
     * Get the server info
     */
    getInfo(callback) {
        this.sendRequest({
            getInfo: {

            },
        }, callback);
    }

    /**
     * Get team info
     */
    getTeamInfo(callback) {
        this.sendRequest({
            getTeamInfo: {

            },
        }, callback);
    }

    /**
     * Subscribes to a Camera
     * @param identifier Camera Identifier, such as OILRIG1 (or custom name)
     * @param callback
     */
    subscribeToCamera(identifier, callback) {
        this.sendRequest({
            cameraSubscribe: {
                cameraId: identifier,
            },
        }, callback);
    }

    /**
     * Unsubscribes from a Camera
     * @param callback
     */
    unsubscribeFromCamera(callback) {
        this.sendRequest({
            cameraUnsubscribe: {

            }
        }, callback)
    }

    /**
     * Sends camera input to the server (mouse movement)
     * @param buttons The buttons that are currently pressed
     * @param x The x delta of the mouse movement
     * @param y The y delta of the mouse movement
     * @param callback
     */
    sendCameraInput(buttons, x, y, callback) {
        this.sendRequest({
            cameraInput: {
                buttons: buttons,
                mouseDelta: {
                    x: x,
                    y: y,
                }
            },
        }, callback);
    }

    /**
     * Get a camera instance for controlling CCTV Cameras, PTZ Cameras and  Auto Turrets
     * @param identifier Camera Identifier, such as DOME1, OILRIG1L1, (or a custom camera id)
     * @returns {Camera}
     */
    getCamera(identifier) {
        return new Camera(this, identifier);
    }

}

module.exports = RustPlus;