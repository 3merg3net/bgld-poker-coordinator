// src/rooms/TournamentHub.ts
type SeatSnap = { playerId: string; name?: string; chips: number }
type TableSnap = { tableRoomId: string; seats: SeatSnap[]; updatedAt: number }

type Winner = { playerId: string; name: string; chips?: number }

export class TournamentHub {
  // tournamentId -> tableRoomId -> snapshot
  private tables: Map<string, Map<string, TableSnap>> = new Map()
  // tournamentId -> winner (once decided)
  private winners: Map<string, Winner> = new Map()

  // callback you wire to your server to broadcast into rooms
  constructor(
    private broadcastToTournamentTables: (tournamentId: string, msg: any) => void
  ) {}

  upsertTableSnapshot(tournamentId: string, tableRoomId: string, seats: SeatSnap[]) {
    if (!tournamentId) return
    if (this.winners.has(tournamentId)) return // already complete

    let t = this.tables.get(tournamentId)
    if (!t) {
      t = new Map()
      this.tables.set(tournamentId, t)
    }

    t.set(tableRoomId, { tableRoomId, seats, updatedAt: Date.now() })

    // compute alive players across all tables
    const alive = new Map<string, { playerId: string; name: string; chips: number }>()
    for (const snap of t.values()) {
      for (const s of snap.seats) {
        if (!s.playerId) continue
        const chips = Math.max(0, Math.floor(Number(s.chips || 0)))
        const name = (s.name || 'Player').slice(0, 32)
        // if they appear twice for some reason, take max chips
        const prev = alive.get(s.playerId)
        if (!prev || chips > prev.chips) alive.set(s.playerId, { playerId: s.playerId, name, chips })
      }
    }

    const aliveNonZero = [...alive.values()].filter((p) => p.chips > 0)

    // winner condition
    if (aliveNonZero.length === 1) {
      const w = aliveNonZero[0]
      const winner: Winner = { playerId: w.playerId, name: w.name, chips: w.chips }
      this.winners.set(tournamentId, winner)

      this.broadcastToTournamentTables(tournamentId, {
        type: 'tournament-table-complete',
        tournamentId,
        reason: 'winner',
        winner,
      })
    }
  }

  getWinner(tournamentId: string): Winner | null {
    return this.winners.get(tournamentId) || null
  }
}
