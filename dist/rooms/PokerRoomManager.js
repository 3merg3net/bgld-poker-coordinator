"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PokerRoomManager = void 0;
const HoldemGame_1 = require("../game/HoldemGame");
class PokerRoomManager {
    constructor(roomId) {
        this.clients = new Map();
        this.seats = [];
        this.game = new HoldemGame_1.HoldemGame();
        // Track if a hand is currently running
        this.handInProgress = false;
        // Track lifetime fake rake (just for logging / dev)
        this.totalFakeRake = 0;
        this.roomId = roomId;
        // 9-max layout – front-end dynamically places seated players in a ring
        for (let i = 0; i < 9; i++) {
            this.seats.push({
                seatIndex: i,
                playerId: null,
                name: undefined,
                chips: 0,
            });
        }
    }
    addClient(playerId, socket, name) {
        this.clients.set(playerId, {
            socket,
            playerId,
            name,
        });
        // Clear out any seats that belong to players who are no longer connected
        this.cleanupGhostSeats();
        this.broadcast({
            kind: "poker",
            roomId: this.roomId,
            playerId,
            type: "room-joined",
            onlineCount: this.clients.size,
        });
        // Send seats + current state
        this.sendTo(playerId, {
            kind: "poker",
            roomId: this.roomId,
            playerId,
            type: "seats-update",
            seats: this.seats,
        });
        const lastTable = this.game.getLastState();
        if (lastTable) {
            this.sendTo(playerId, {
                kind: "poker",
                roomId: this.roomId,
                playerId,
                type: "table-state",
                handId: lastTable.handId,
                board: lastTable.board,
                players: lastTable.players,
            });
        }
        const betting = this.game.getBettingState();
        if (betting) {
            this.sendTo(playerId, {
                kind: "poker",
                roomId: this.roomId,
                playerId,
                type: "betting-state",
                handId: betting.handId,
                street: betting.street,
                pot: betting.pot,
                buttonSeatIndex: betting.buttonSeatIndex,
                currentSeatIndex: betting.currentSeatIndex,
                bigBlind: betting.bigBlind,
                smallBlind: betting.smallBlind,
                maxCommitted: betting.maxCommitted,
                players: betting.players,
            });
        }
    }
    removeClient(playerId) {
        if (!this.clients.has(playerId))
            return;
        this.clients.delete(playerId);
        // Stand them up if seated
        let changed = false;
        this.seats = this.seats.map((s) => {
            if (s.playerId === playerId) {
                changed = true;
                return { ...s, playerId: null, name: undefined, chips: 0 };
            }
            return s;
        });
        if (changed) {
            this.broadcast({
                kind: "poker",
                roomId: this.roomId,
                playerId,
                type: "seats-update",
                seats: this.seats,
            });
        }
        this.broadcast({
            kind: "poker",
            roomId: this.roomId,
            playerId,
            type: "room-left",
        });
        // If no clients remain, hard reset table so no ghost seats/hands remain
        if (this.clients.size === 0) {
            this.resetTableState();
        }
    }
    handleMessage(msg) {
        var _a;
        switch (msg.type) {
            case "ping":
                this.broadcast({
                    kind: "poker",
                    roomId: this.roomId,
                    playerId: msg.playerId,
                    type: "pong",
                    payload: (_a = msg.payload) !== null && _a !== void 0 ? _a : "pong",
                });
                break;
            case "chat":
                this.broadcast({
                    kind: "poker",
                    roomId: this.roomId,
                    playerId: msg.playerId,
                    type: "chat-broadcast",
                    text: msg.text,
                });
                break;
            case "sit":
                this.handleSit(msg.playerId, msg.buyIn, msg.seatIndex, msg.name);
                break;
            case "stand":
                this.handleStand(msg.playerId);
                break;
            case "start-hand":
                this.handleStartHand(msg.playerId);
                break;
            case "action":
                this.handleAction(msg.playerId, msg.action, msg.amount);
                break;
            case "timeout-fold":
  void this.handleTimeoutFold(playerId);
  return;    
            // client asks server to reveal *their* hole cards to everyone
            case "show-cards":
                this.handleShowCards(msg.playerId);
                break;
            default:
                // join/leave handled at connection level
                break;
        }
    }
    // ───────────────── SITTING / STANDING ─────────────────
    handleSit(playerId, buyIn, seatIndex, name) {
        // ✅ GG-style: allow sitting mid-hand.
        // New players won't appear in the current betting state,
        // so they simply wait and are dealt in on the *next* hand.
        // If already seated, ignore
        const already = this.seats.find((s) => s.playerId === playerId);
        if (already)
            return;
        // Pick seat: specific or first open
        let targetSeat;
        if (typeof seatIndex === "number") {
            targetSeat = this.seats.find((s) => s.seatIndex === seatIndex && !s.playerId);
        }
        else {
            targetSeat = this.seats.find((s) => !s.playerId);
        }
        if (!targetSeat) {
            this.sendTo(playerId, {
                kind: "poker",
                roomId: this.roomId,
                playerId,
                type: "error",
                message: "No seat available",
            });
            return;
        }
        // SANITIZE BUY-IN (fake chips)
        const stack = Math.max(1, Math.floor(buyIn !== null && buyIn !== void 0 ? buyIn : 0));
        // Assign seat
        this.seats = this.seats.map((s) => {
            var _a;
            return s.seatIndex === targetSeat.seatIndex
                ? {
                    ...s,
                    playerId,
                    name: name || ((_a = this.clients.get(playerId)) === null || _a === void 0 ? void 0 : _a.name),
                    chips: stack,
                }
                : s;
        });
        this.broadcast({
            kind: "poker",
            roomId: this.roomId,
            playerId,
            type: "seats-update",
            seats: this.seats,
        });
        // Optional: system chat "X sits and will be dealt next hand."
    }
    handleStand(playerId) {
        let changed = false;
        this.seats = this.seats.map((s) => {
            if (s.playerId === playerId) {
                changed = true;
                return { ...s, playerId: null, name: undefined, chips: 0 };
            }
            return s;
        });
        if (changed) {
            this.broadcast({
                kind: "poker",
                roomId: this.roomId,
                playerId,
                type: "seats-update",
                seats: this.seats,
            });
        }
    }
    // ───────────────── HAND LIFECYCLE ─────────────────
    handleStartHand(requesterId) {
        // Re-sync handInProgress with actual betting state
        const currentBetting = this.game.getBettingState();
        if (!currentBetting || currentBetting.street === "done") {
            this.handInProgress = false;
        }
        // Prevent spamming new hands while one is really running
        if (this.handInProgress) {
            this.sendTo(requesterId, {
                kind: "poker",
                roomId: this.roomId,
                playerId: requesterId,
                type: "error",
                message: "A hand is already in progress.",
            });
            return;
        }
        // Clear any ghost seats before we look at active players
        this.cleanupGhostSeats();
        // Require at least 2 active players with chips
        const activeSeats = this.seats.filter((s) => { var _a; return s.playerId && ((_a = s.chips) !== null && _a !== void 0 ? _a : 0) > 0; });
        if (activeSeats.length < 2) {
            this.sendTo(requesterId, {
                kind: "poker",
                roomId: this.roomId,
                playerId: requesterId,
                type: "error",
                message: "At least 2 seated players with chips are required to start a hand.",
            });
            return;
        }
        const table = this.game.startHand(this.seats);
        if (!table) {
            this.sendTo(requesterId, {
                kind: "poker",
                roomId: this.roomId,
                playerId: requesterId,
                type: "error",
                message: "No seated players to start a hand",
            });
            return;
        }
        // Mark a hand as running
        this.handInProgress = true;
        // Broadcast table + betting
        this.broadcast({
            kind: "poker",
            roomId: this.roomId,
            playerId: "server",
            type: "table-state",
            handId: table.handId,
            board: table.board,
            players: table.players,
        });
        const betting = this.game.getBettingState();
        if (betting) {
            this.broadcast({
                kind: "poker",
                roomId: this.roomId,
                playerId: "server",
                type: "betting-state",
                handId: betting.handId,
                street: betting.street,
                pot: betting.pot,
                buttonSeatIndex: betting.buttonSeatIndex,
                currentSeatIndex: betting.currentSeatIndex,
                bigBlind: betting.bigBlind,
                smallBlind: betting.smallBlind,
                maxCommitted: betting.maxCommitted,
                players: betting.players,
            });
        }
    }
    handleAction(playerId, action, amount) {
        const betting = this.game.applyAction(playerId, action, amount);
        if (!betting)
            return;
        // Always broadcast updated betting state
        this.broadcast({
            kind: "poker",
            roomId: this.roomId,
            playerId: "server",
            type: "betting-state",
            handId: betting.handId,
            street: betting.street,
            pot: betting.pot,
            buttonSeatIndex: betting.buttonSeatIndex,
            currentSeatIndex: betting.currentSeatIndex,
            bigBlind: betting.bigBlind,
            smallBlind: betting.smallBlind,
            maxCommitted: betting.maxCommitted,
            players: betting.players,
        });
        // Also broadcast updated table state (board might have changed)
        const table = this.game.getLastState();
        if (table) {
            this.broadcast({
                kind: "poker",
                roomId: this.roomId,
                playerId: "server",
                type: "table-state",
                handId: table.handId,
                board: table.board,
                players: table.players,
            });
        }
        // If hand ended, compute and broadcast showdown + track fake rake
        if (betting.street === "done") {
            // Fake rake: 5% of final pot
            const fakeRake = Math.floor((betting.pot * 5) / 100);
            this.totalFakeRake += fakeRake;
            console.log(`[PokerRoom:${this.roomId}] Hand #${betting.handId} complete. Pot=${betting.pot}, ` +
                `Fake rake (5%)=${fakeRake}, Total fake rake=${this.totalFakeRake}`);
            const showdown = this.game.computeShowdown();
            if (showdown) {
                // ⬇️ No enrichment here – just pass through.
                // Front-end will only see what computeShowdown() returns.
                this.broadcast({
                    kind: "poker",
                    roomId: this.roomId,
                    playerId: "server",
                    type: "showdown",
                    handId: showdown.handId,
                    board: showdown.board,
                    players: showdown.players,
                });
            }
            // Hand is over; allow new players to sit and new hand to start
            this.handInProgress = false;
        }
    }
    /**
     * Player requests to show *their* hole cards to the table.
     * We only allow this after river (street === "done").
     */
    handleShowCards(playerId) {
        const betting = this.game.getBettingState();
        if (!betting || betting.street !== "done") {
            // Don’t reveal mid-hand
            return;
        }
        // Optional helper on HoldemGame:
        // getHoleCardsForPlayer(playerId: string): string[] | null
        const anyGame = this.game;
        if (typeof anyGame.getHoleCardsForPlayer !== "function") {
            return;
        }
        const hole = anyGame.getHoleCardsForPlayer(playerId);
        if (!hole || hole.length !== 2)
            return;
        this.broadcast({
            kind: "poker",
            roomId: this.roomId,
            playerId,
            type: "player-show-cards",
            cards: hole, // e.g. ["Ah", "Kd"]
        });
    }
    // ───────────────── GHOST / RESET HELPERS ─────────────────
    /** Remove seats that reference players who no longer have a live WebSocket */
    cleanupGhostSeats() {
        const activeIds = new Set(this.clients.keys());
        let changed = false;
        this.seats = this.seats.map((s) => {
            if (s.playerId && !activeIds.has(s.playerId)) {
                changed = true;
                return { ...s, playerId: null, name: undefined, chips: 0 };
            }
            return s;
        });
        if (changed) {
            this.broadcast({
                kind: "poker",
                roomId: this.roomId,
                playerId: "server",
                type: "seats-update",
                seats: this.seats,
            });
        }
    }
    /** When the last client leaves, fully reset seats + game state. */
    resetTableState() {
        const freshSeats = [];
        for (let i = 0; i < 9; i++) {
            freshSeats.push({
                seatIndex: i,
                playerId: null,
                name: undefined,
                chips: 0,
            });
        }
        this.seats = freshSeats;
        this.game = new HoldemGame_1.HoldemGame();
        this.handInProgress = false;
        this.totalFakeRake = 0;
        console.log(`[PokerRoom:${this.roomId}] All clients gone. Resetting table state.`);
    }
    // ───────────────── LOW-LEVEL SEND HELPERS ─────────────────
    broadcast(message) {
        const raw = JSON.stringify(message);
        for (const { socket } of this.clients.values()) {
            if (socket.readyState === socket.OPEN) {
                socket.send(raw);
            }
        }
    }
    sendTo(playerId, message) {
        const entry = this.clients.get(playerId);
        if (!entry)
            return;
        if (entry.socket.readyState !== entry.socket.OPEN)
            return;
        entry.socket.send(JSON.stringify(message));
    }
}
exports.PokerRoomManager = PokerRoomManager;
