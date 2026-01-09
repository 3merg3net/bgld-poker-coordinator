// src/tournaments/TournamentDirector.ts

type TournamentType = "sng" | "scheduled";

type TournamentConfig = {
  tournamentId: string;
  tournamentName: string;

  buyIn: number;
  startingStack: number;
  seatsPerTable: number;

  isPrivate: boolean;
  createdAt: number;

  hostPlayerId: string;

  minPlayers: number;
  maxTables: number; // V1 cap
  maxPlayers?: number; // optional cap override (otherwise capacity())

  // ✅ scheduling
  type: TournamentType;
  startAt?: number; // ms timestamp for scheduled
  lateRegUntil?: number; // optional ms timestamp for late reg
};

type TournamentStatus =
  | "waiting" // registering, not yet ready
  | "ready" // minPlayers met (mostly for SNG)
  | "running"
  | "finished"
  | "cancelled";

type TournamentState = TournamentConfig & {
  status: TournamentStatus;

  // ✅ registration state
  registered: Set<string>;
  registeredOrder: string[];
  waitlistedOrder: string[];

  // tableRoomId -> playerIds
  tables: Map<string, string[]>;

  // ✅ scheduling runtime
  startedAt?: number;
  cancelledAt?: number;
  cancelReason?: string;

  // If scheduled & min not met at startAt:
  // we can delay a few times before cancelling
  delayCount: number;
  delayedUntil?: number;

  // ✅ optional: mark when it first became ready (minPlayers met)
  readyAt?: number;
};

function randId(prefix: string) {
  const s = Math.random().toString(36).slice(2, 8).toLowerCase();
  return `${prefix}-${s}`;
}

function clampInt(n: any, min: number, max: number, fallback: number) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function toMs(n: any): number | undefined {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

export class TournamentDirector {
  private tournaments = new Map<string, TournamentState>();

  // ✅ scheduled behavior knobs (simple + “real”)
  private readonly SCHEDULED_DELAY_MS = 10 * 60_000; // 10 minutes
  private readonly MAX_DELAYS = 3; // after 3 delays -> cancel

  createTournament(args: {
    hostPlayerId: string;
    tournamentName?: string;

    buyIn: number;
    startingStack: number;

    seatsPerTable?: number;
    isPrivate?: boolean;

    minPlayers?: number;
    maxTables?: number;

    // ✅ new
    type?: TournamentType; // default sng
    startAt?: number; // ms timestamp for scheduled
    lateRegUntil?: number; // ms timestamp
    maxPlayers?: number; // optional hard cap (<= capacity)
  }): { tournamentId: string } {
    const tournamentId = randId("tourn");
    const tournamentName = String(args.tournamentName || "Tournament").slice(0, 48);

    const seatsPerTable = clampInt(args.seatsPerTable, 2, 9, 9);
    const isPrivate = Boolean(args.isPrivate);

    const minPlayers = clampInt(args.minPlayers, 2, 45, 6);
    const maxTables = clampInt(args.maxTables, 1, 5, 5);

    const type: TournamentType = (args.type === "scheduled" ? "scheduled" : "sng");

    // startAt only meaningful for scheduled
    const startAt = type === "scheduled" ? toMs(args.startAt) : undefined;
    const lateRegUntil = type === "scheduled" ? toMs(args.lateRegUntil) : undefined;

    const state: TournamentState = {
      tournamentId,
      tournamentName,

      buyIn: Math.max(0, Math.floor(args.buyIn)),
      startingStack: Math.max(0, Math.floor(args.startingStack)),
      seatsPerTable,

      isPrivate,
      createdAt: Date.now(),

      hostPlayerId: String(args.hostPlayerId || "").trim(),
      minPlayers,
      maxTables,

      maxPlayers: args.maxPlayers ? Math.max(2, Math.floor(args.maxPlayers)) : undefined,

      type,
      startAt,
      lateRegUntil,

      status: "waiting",

      registered: new Set<string>(),
      registeredOrder: [],
      waitlistedOrder: [],
      tables: new Map(),

      delayCount: 0,
    };

    this.tournaments.set(tournamentId, state);
    return { tournamentId };
  }

  /** total seats available before overflow is waitlisted */
  private capacity(t: TournamentState) {
    const capByTables = Math.max(1, t.maxTables * t.seatsPerTable);
    const maxPlayers = t.maxPlayers ? Math.max(2, Math.floor(t.maxPlayers)) : capByTables;
    return Math.min(capByTables, maxPlayers);
  }

  /** ✅ helper for server.ts routing */
  getRegisteredPlayers(tournamentId: string): string[] {
    const t = this.tournaments.get(tournamentId);
    if (!t) return [];
    return [...t.registeredOrder];
  }

  /** ✅ host/admin cancel */
  cancelTournament(tournamentId: string, requesterId: string, reason = "Cancelled") {
    const t = this.tournaments.get(tournamentId);
    if (!t) return { ok: false, error: "Tournament not found" as const };

    // only host can cancel (admin can be handled in server.ts)
    if (t.hostPlayerId !== requesterId) {
      return { ok: false, error: "Only host can cancel" as const };
    }

    if (t.status === "running") {
      return { ok: false, error: "Cannot cancel a running tournament (v1)" as const };
    }
    if (t.status === "cancelled") return { ok: true as const };

    t.status = "cancelled";
    t.cancelledAt = Date.now();
    t.cancelReason = reason;

    return { ok: true as const };
  }

  /** ✅ cleanup finished/cancelled older than X ms (optional) */
  pruneOld(ms = 60 * 60_000) {
    const now = Date.now();
    for (const [id, t] of this.tournaments.entries()) {
      if (t.status === "finished" || t.status === "cancelled") {
        const ts = t.cancelledAt ?? t.startedAt ?? t.createdAt;
        if (now - ts > ms) this.tournaments.delete(id);
      }
    }
  }

  listTournaments() {
    return Array.from(this.tournaments.values())
      .filter((t) => t.status !== "finished") // keep cancelled visible if you want (optional)
      .map((t) => {
        const cap = this.capacity(t);
        const now = Date.now();
        const startAt = t.startAt ?? null;
        const delayedUntil = t.delayedUntil ?? null;

        const effectiveStart =
          delayedUntil && delayedUntil > now ? delayedUntil : startAt;

        const startsInMs =
          effectiveStart && effectiveStart > now ? effectiveStart - now : 0;

        return {
          tournamentId: t.tournamentId,
          tournamentName: t.tournamentName,
          buyIn: t.buyIn,
          startingStack: t.startingStack,
          seatsPerTable: t.seatsPerTable,
          isPrivate: t.isPrivate,

          type: t.type,
          status: t.status,

          minPlayers: t.minPlayers,
          maxTables: t.maxTables,
          cap,

          registeredCount: t.registered.size,
          waitlistedCount: t.waitlistedOrder.length,

          hostPlayerId: t.hostPlayerId,
          createdAt: t.createdAt,

          // ✅ schedule display fields
          startAt,
          delayedUntil,
          startsInMs,

          // nice UI hints
          ready: t.registered.size >= t.minPlayers,
          full: t.registered.size >= cap,
          delayCount: t.delayCount,
          cancelReason: t.cancelReason ?? null,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** registration */
  registerPlayer(tournamentId: string, playerId: string) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return { ok: false, error: "Tournament not found" as const };
    if (t.status === "running") return { ok: false, error: "Tournament already started" as const };
    if (t.status === "cancelled") return { ok: false, error: "Tournament cancelled" as const };

    const pid = String(playerId || "").trim();
    if (!pid) return { ok: false, error: "Missing playerId" as const };

    const cap = this.capacity(t);

    // already registered
    if (t.registered.has(pid)) {
      return {
        ok: true as const,
        registeredCount: t.registered.size,
        waitlistedCount: t.waitlistedOrder.length,
        cap,
        isRegistered: true,
        isWaitlisted: false,
      };
    }

    // already waitlisted
    if (t.waitlistedOrder.includes(pid)) {
      return {
        ok: true as const,
        registeredCount: t.registered.size,
        waitlistedCount: t.waitlistedOrder.length,
        cap,
        isRegistered: false,
        isWaitlisted: true,
      };
    }

    // if full → waitlist
    if (t.registered.size >= cap) {
      t.waitlistedOrder.push(pid);
      return {
        ok: true as const,
        registeredCount: t.registered.size,
        waitlistedCount: t.waitlistedOrder.length,
        cap,
        isRegistered: false,
        isWaitlisted: true,
      };
    }

    // normal registration
    t.registered.add(pid);
    t.registeredOrder.push(pid);

    // ready transition
    // ✅ mark ready time, but keep status WAITING until host starts
if (t.readyAt == null && t.registered.size >= t.minPlayers) {
  t.readyAt = Date.now();
}


    return {
      ok: true as const,
      registeredCount: t.registered.size,
      waitlistedCount: t.waitlistedOrder.length,
      cap,
      isRegistered: true,
      isWaitlisted: false,
    };
  }

  /**
   * ✅ manual start (host)
   * - For SNG: starts when ready
   * - For scheduled: you can still allow host to start early once minPlayers met (optional)
   */
  startTournament(tournamentId: string, requesterId: string) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return { ok: false, error: "Tournament not found" as const };
    if (t.hostPlayerId !== requesterId) return { ok: false, error: "Only host can start" as const };
    if (t.status === "running") return { ok: false, error: "Tournament already started" as const };
    if (t.status === "cancelled") return { ok: false, error: "Tournament cancelled" as const };

    return this.startInternal(t, "host");
  }

  /** ✅ tick scheduled tournaments (call from server.ts on an interval) */
  tick(now = Date.now()) {
    const started: Array<{ tournamentId: string; assignments: Array<{ tableRoomId: string; players: string[] }> }> = [];
    const cancelled: Array<{ tournamentId: string; reason: string }> = [];

    for (const t of this.tournaments.values()) {
      if (t.status === "running" || t.status === "finished" || t.status === "cancelled") continue;

      const cap = this.capacity(t);

      // SNG: if you ever want auto-start when FULL (optional)
      // (leave OFF in v1 unless you really want it)
      // if (t.type === "sng" && t.registered.size >= cap && t.registered.size >= t.minPlayers) { ... }

      if (t.type === "scheduled") {
        const effectiveStart =
          (t.delayedUntil && t.delayedUntil > now) ? t.delayedUntil : t.startAt;

        if (!effectiveStart) continue; // scheduled but no start time set

        // Not time yet
        if (now < effectiveStart) continue;

        // Time hit:
        if (t.registered.size >= t.minPlayers) {
          const res = this.startInternal(t, "scheduled");
          if (res.ok && res.assignments) {
  started.push({ tournamentId: t.tournamentId, assignments: res.assignments });
}

          continue;
        }

        // Not enough players -> delay or cancel
        if (t.delayCount < this.MAX_DELAYS) {
          t.delayCount += 1;
          t.delayedUntil = now + this.SCHEDULED_DELAY_MS;
          // keep status waiting/ready (ready is false anyway)
          t.status = "waiting";
          continue;
        }

        // cancel after max delays
        t.status = "cancelled";
        t.cancelledAt = now;
        t.cancelReason = `Not enough players (min ${t.minPlayers})`;
        cancelled.push({ tournamentId: t.tournamentId, reason: t.cancelReason });
      }
    }

    return { started, cancelled };
  }

  /** snapshot/config for UI */
  getTournamentConfig(tournamentId: string) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;

    const cap = this.capacity(t);

    return {
      tournamentId: t.tournamentId,
      tournamentName: t.tournamentName,
      buyIn: t.buyIn,
      startingStack: t.startingStack,
      seatsPerTable: t.seatsPerTable,
      isPrivate: t.isPrivate,

      type: t.type,
      status: t.status,

      minPlayers: t.minPlayers,
      maxTables: t.maxTables,
      cap,

      maxPlayers: t.maxPlayers ?? null,

      // schedule
      startAt: t.startAt ?? null,
      delayedUntil: t.delayedUntil ?? null,
      delayCount: t.delayCount,
      lateRegUntil: t.lateRegUntil ?? null,

      hostPlayerId: t.hostPlayerId,

      registeredCount: t.registered.size,
      waitlistedCount: t.waitlistedOrder.length,

      registeredPlayers: [...t.registeredOrder],
      waitlistedPlayers: [...t.waitlistedOrder],

      readyAt: t.readyAt ?? null,
      cancelReason: t.cancelReason ?? null,
    };
  }

  private makeTableRoomId(tournamentId: string, tableIndex: number) {
    return `${tournamentId}-t${tableIndex}`;
  }

  private startInternal(t: TournamentState, why: "host" | "scheduled") {
    // use ordered list to keep deterministic field order
    const players = [...t.registeredOrder];

    if (players.length < t.minPlayers) {
      return { ok: false, error: `Need ${t.minPlayers} players to start` as const };
    }

    // build tables
    t.tables.clear();

    const maxSeatsTotal = this.capacity(t);
    const entrants = players.slice(0, maxSeatsTotal);

    let tableIndex = 1;
    let rid = this.makeTableRoomId(t.tournamentId, tableIndex);
    t.tables.set(rid, []);

    for (const pid of entrants) {
      let cur = t.tables.get(rid)!;
      if (cur.length >= t.seatsPerTable) {
        tableIndex++;
        if (tableIndex > t.maxTables) break;
        rid = this.makeTableRoomId(t.tournamentId, tableIndex);
        t.tables.set(rid, []);
        cur = t.tables.get(rid)!;
      }
      cur.push(pid);
    }

    t.status = "running";
    t.startedAt = Date.now();

    const assignments: Array<{ tableRoomId: string; players: string[] }> = [];
    for (const [roomId, pids] of t.tables.entries()) {
      assignments.push({ tableRoomId: roomId, players: [...pids] });
    }

    return { ok: true as const, assignments, why };
  }
}
