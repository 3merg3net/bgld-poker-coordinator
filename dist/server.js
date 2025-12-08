"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const ws_1 = __importStar(require("ws"));
const PokerRoomManager_1 = require("./rooms/PokerRoomManager");
const BlackjackRoomManager_1 = require("./rooms/BlackjackRoomManager");
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const rooms = new Map();
function roomKey(kind, roomId) {
    return `${kind}:${roomId}`;
}
function getRoom(kind, roomId) {
    const key = roomKey(kind, roomId);
    let room = rooms.get(key);
    if (!room) {
        room =
            kind === "blackjack"
                ? new BlackjackRoomManager_1.BlackjackRoomManager(roomId)
                : new PokerRoomManager_1.PokerRoomManager(roomId);
        rooms.set(key, room);
    }
    return room;
}
const wss = new ws_1.WebSocketServer({ port: PORT });
console.log(`[Coordinator] Listening on port ${PORT}`);
wss.on("connection", (socket) => {
    console.log("[Coordinator] New WebSocket client connected");
    let currentKind = null;
    let currentRoomId = null;
    let currentPlayerId = null;
    let heartbeatTimer = null;
    const startHeartbeat = () => {
        if (heartbeatTimer)
            return;
        heartbeatTimer = setInterval(() => {
            if (socket.readyState === ws_1.default.OPEN &&
                currentKind &&
                currentRoomId &&
                currentPlayerId) {
                const hb = {
                    kind: currentKind,
                    roomId: currentRoomId,
                    playerId: currentPlayerId,
                    type: "heartbeat",
                    ts: Date.now(),
                };
                socket.send(JSON.stringify(hb));
            }
        }, 15000);
    };
    socket.on("message", (data) => {
        var _a;
        let msg;
        try {
            msg = JSON.parse(String(data));
        }
        catch (err) {
            console.warn("[Coordinator] Failed to parse message", err);
            return;
        }
        if (!msg || typeof msg !== "object")
            return;
        // First message must be join-room
        if (msg.type === "join-room") {
            if (!msg.roomId || !msg.playerId) {
                console.warn("[Coordinator] join-room missing fields");
                return;
            }
            const kind = msg.kind === "blackjack" ? "blackjack" : "poker";
            currentKind = kind;
            currentRoomId = msg.roomId;
            currentPlayerId = msg.playerId;
            const room = getRoom(kind, currentRoomId);
            room.addClient(currentPlayerId, socket, (_a = msg.name) !== null && _a !== void 0 ? _a : undefined);
            startHeartbeat();
            return;
        }
        if (!currentKind || !currentRoomId || !currentPlayerId) {
            console.warn("[Coordinator] Ignoring non-join message before join-room");
            return;
        }
        if (msg.type === "leave-room") {
            const key = roomKey(currentKind, currentRoomId);
            const room = rooms.get(key);
            room && room.removeClient(currentPlayerId);
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            socket.close();
            return;
        }
        const room = getRoom(currentKind, currentRoomId);
        room.handleMessage(msg);
    });
    socket.on("close", () => {
        console.log("[Coordinator] Client disconnected");
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (currentKind && currentRoomId && currentPlayerId) {
            const key = roomKey(currentKind, currentRoomId);
            const room = rooms.get(key);
            room && room.removeClient(currentPlayerId);
        }
    });
    socket.on("error", (err) => {
        console.error("[Coordinator] Socket error:", err);
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    });
});
