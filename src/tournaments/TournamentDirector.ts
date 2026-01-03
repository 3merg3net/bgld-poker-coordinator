// src/tournaments/TournamentDirector.ts

type TournamentConfig = {
  tournamentId: string;
  tournamentName: string;
  buyIn: number;
  startingStack: number;
  seatsPerTable: number;
  isPrivate: boolean;
  createdAt: number;
};

type TournamentState = TournamentConfig & {
  // tableRoomId -> playerIds
  tables: Map<string, string[]>;
};

function randId(prefix: string) {
  const s = Math.random().toString(36).slice(2, 8).toLowerCase();
  return `${prefix}-${s}`;
}

export class TournamentDirector {
  private tournaments = new Map<string, TournamentState>();

  createTournament(args: {
    tournamentName?: string;
    buyIn: number;
    startingStack: number;
    seatsPerTable?: number;
    isPrivate?: boolean;
  }): { tournamentId: string; firstTableRoomId: string } {
    const tournamentId = randId("tourn");
    const tournamentName = (args.tournamentName || "Tournament").slice(0, 48);

    const seatsPerTable = Math.max(2, Math.min(9, Math.floor(args.seatsPerTable ?? 9)));
    const isPrivate = Boolean(args.isPrivate);

    const state: TournamentState = {
      tournamentId,
      tournamentName,
      buyIn: Math.max(0, Math.floor(args.buyIn)),
      startingStack: Math.max(0, Math.floor(args.startingStack)),
      seatsPerTable,
      isPrivate,
      createdAt: Date.now(),
      tables: new Map(),
    };

    const firstTableRoomId = this.makeTableRoomId(tournamentId, 1);
    state.tables.set(firstTableRoomId, []);
    this.tournaments.set(tournamentId, state);

    return { tournamentId, firstTableRoomId };
  }

  joinTournament(tournamentId: string, playerId: string): { ok: boolean; tableRoomId?: string; error?: string } {
    const t = this.tournaments.get(tournamentId);
    if (!t) return { ok: false, error: "Tournament not found" };

    // already seated somewhere?
    for (const [rid, players] of t.tables.entries()) {
      if (players.includes(playerId)) return { ok: true, tableRoomId: rid };
    }

    // find a table with space
    for (const [rid, players] of t.tables.entries()) {
      if (players.length < t.seatsPerTable) {
        players.push(playerId);
        return { ok: true, tableRoomId: rid };
      }
    }

    // create new table
    const nextIndex = t.tables.size + 1;
    const newRid = this.makeTableRoomId(tournamentId, nextIndex);
    t.tables.set(newRid, [playerId]);
    return { ok: true, tableRoomId: newRid };
  }

  getTournamentConfig(tournamentId: string) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;
    return {
      tournamentId: t.tournamentId,
      tournamentName: t.tournamentName,
      buyIn: t.buyIn,
      startingStack: t.startingStack,
      seatsPerTable: t.seatsPerTable,
      isPrivate: t.isPrivate,
    };
  }

  private makeTableRoomId(tournamentId: string, tableIndex: number) {
    // roomId namespace prevents collision with cash rooms
    return `${tournamentId}-t${tableIndex}`; // e.g. tourn-ab12cd-t1
  }
}
