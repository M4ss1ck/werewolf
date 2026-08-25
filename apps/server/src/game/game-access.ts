import type { GameRepository, MembershipMutation } from "@werewolf/db";
import type {
  GameAdmissionResult,
  GameEntryMode,
  GameEntryPreview,
  GameEntryReference,
  GameId,
  UserId,
} from "@werewolf/protocol";
import { normalizeGameCode } from "@werewolf/protocol";
import { type GameLock, gameLocks } from "./locks.ts";

export type GameAccessViewer = { userId: UserId; username?: string | null };
export type GameAccessSurface = "game" | "events" | "live" | "replay" | "mutation";
export type GameAccessGrant = {
  gameId: GameId;
  membership: "active" | "replay";
  surface: GameAccessSurface;
};

export class GameAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type EntryReference =
  | GameEntryReference
  | { kind: "invitation"; code: string }
  | { kind: "public-game"; gameId: string };

export class GameAccess {
  constructor(
    private readonly repository: GameRepository,
    private readonly lock: GameLock = gameLocks,
    private readonly now: () => number = Date.now,
    private readonly notify: (gameId: GameId) => Promise<void> = async () => {},
  ) {}

  async preview(reference: EntryReference, viewer: GameAccessViewer): Promise<GameEntryPreview> {
    const resolved = await this.resolve(reference, viewer);
    return this.previewResolved(resolved.gameId, viewer, resolved.invitation);
  }

  async admit(
    reference: EntryReference,
    viewer: GameAccessViewer,
    mode: GameEntryMode,
  ): Promise<GameAdmissionResult> {
    const username = viewer.username;
    if (!username) throw new GameAccessError("USERNAME_REQUIRED");
    const resolved = await this.resolve(reference, viewer);
    return this.lock.run(resolved.gameId, async () => {
      const game = await this.repository.getGame(resolved.gameId);
      if (!game) throw new GameAccessError("INVITATION_NOT_FOUND");
      const membership = await this.repository.getMembership(resolved.gameId, viewer.userId);
      if (membership?.membershipAccess === "denied") {
        throw new GameAccessError("INVITATION_ACCESS_DENIED");
      }
      if (!resolved.invitation && !membership && game.visibility === "private") {
        throw new GameAccessError("GAME_NOT_FOUND");
      }
      if (membership) return admissionForMembership(resolved.gameId, membership.membershipAccess);

      const settings = readSettings(game.settingsJson);
      validateMode(game.status, settings.spectatingEnabled, mode);
      const mutation: MembershipMutation = {
        kind: "insert",
        player: {
          gameId: resolved.gameId,
          userId: viewer.userId,
          displayName: username,
          status: mode === "player" ? "lobby" : "spectator",
          joinedAt: this.now(),
          ...(mode === "replay"
            ? { role: null, faction: null, membershipAccess: "replay" as const }
            : { membershipAccess: "active" as const }),
        },
      };
      const commit = await this.repository.commitMembership(
        resolved.gameId,
        game.version,
        mutation,
      );
      if (!commit.ok) throw new GameAccessError("CONFLICT");
      if (commit.activeChanged) await this.notify(resolved.gameId);
      return { gameId: resolved.gameId, destination: mode === "replay" ? "replay" : "game" };
    });
  }

  async ownerInvitation(gameId: GameId, viewer: GameAccessViewer) {
    const game = await this.repository.getGame(gameId);
    if (!game) throw new GameAccessError("GAME_NOT_FOUND");
    if (game.ownerUserId !== viewer.userId) {
      throw new GameAccessError(
        game.visibility === "private" ? "GAME_NOT_FOUND" : "NOT_GAME_OWNER",
      );
    }
    const code = await this.repository.getJoinCode(gameId);
    if (!code) throw new GameAccessError("GAME_NOT_FOUND");
    return { code };
  }

  async leave(gameId: GameId, viewer: GameAccessViewer) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new GameAccessError("GAME_NOT_FOUND");
      if (game.status !== "lobby" && game.status !== "scheduled") {
        throw new GameAccessError("GAME_ALREADY_STARTED");
      }
      const membership = await this.repository.getMembership(gameId, viewer.userId);
      if (!membership || membership.membershipAccess !== "active") return;
      const commit = await this.repository.commitMembership(gameId, game.version, {
        kind: "delete",
        userId: viewer.userId,
      });
      if (!commit.ok) throw new GameAccessError("CONFLICT");
      if (commit.activeChanged) await this.notify(gameId);
    });
  }

  async kick(gameId: GameId, owner: UserId, target: UserId) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new GameAccessError("GAME_NOT_FOUND");
      if (game.ownerUserId !== owner) throw new GameAccessError("NOT_GAME_OWNER");
      if (owner === target) throw new GameAccessError("ACTION_NOT_AVAILABLE");
      if (game.status !== "lobby" && game.status !== "scheduled") {
        throw new GameAccessError("GAME_ALREADY_STARTED");
      }
      const membership = await this.repository.getMembership(gameId, target);
      if (!membership || membership.membershipAccess !== "active") return;
      const isBot = membership.controllerJson !== null;
      const mutation: MembershipMutation = isBot
        ? { kind: "delete", userId: target }
        : { kind: "update", userId: target, changes: { membershipAccess: "denied" } };
      const commit = await this.repository.commitMembership(gameId, game.version, mutation);
      if (!commit.ok) throw new GameAccessError("CONFLICT");
      if (commit.activeChanged) await this.notify(gameId);
    });
  }

  async authorize(
    gameId: GameId,
    viewer: GameAccessViewer,
    surface: GameAccessSurface,
  ): Promise<GameAccessGrant> {
    const game = await this.repository.getGame(gameId);
    if (!game) throw new GameAccessError("GAME_NOT_FOUND");
    const membership = await this.repository.getMembership(gameId, viewer.userId);
    if (!membership || membership.membershipAccess === "denied") {
      throw new GameAccessError("GAME_NOT_FOUND");
    }
    if (membership.membershipAccess === "replay" && surface !== "replay") {
      throw new GameAccessError("GAME_NOT_FOUND");
    }
    if (surface === "replay" && game.status !== "finished") {
      throw new GameAccessError("GAME_NOT_STARTED");
    }
    return {
      gameId,
      membership: membership.membershipAccess as "active" | "replay",
      surface,
    };
  }

  private async resolve(reference: EntryReference, viewer: GameAccessViewer) {
    if (reference.kind === "invitation") {
      const code = normalizeGameCode(reference.code);
      if (!code) throw new GameAccessError("INVITATION_NOT_FOUND");
      const gameId = await this.repository.getGameIdByJoinCode(code);
      if (!gameId) throw new GameAccessError("INVITATION_NOT_FOUND");
      const membership = await this.repository.getMembership(gameId, viewer.userId);
      if (membership?.membershipAccess === "denied") {
        throw new GameAccessError("INVITATION_ACCESS_DENIED");
      }
      return { gameId, invitation: true };
    }
    const gameId = reference.gameId as GameId;
    const game = await this.repository.getGame(gameId);
    if (!game) throw new GameAccessError("GAME_NOT_FOUND");
    const membership = await this.repository.getMembership(gameId, viewer.userId);
    if (membership?.membershipAccess === "denied") throw new GameAccessError("GAME_NOT_FOUND");
    if (game.visibility === "private" && !membership) throw new GameAccessError("GAME_NOT_FOUND");
    return { gameId, invitation: false };
  }

  private async previewResolved(
    gameId: GameId,
    viewer: GameAccessViewer,
    invitation: boolean,
  ): Promise<GameEntryPreview> {
    const game = await this.repository.getGame(gameId);
    if (!game) throw new GameAccessError(invitation ? "INVITATION_NOT_FOUND" : "GAME_NOT_FOUND");
    const membership = await this.repository.getMembership(gameId, viewer.userId);
    if (membership?.membershipAccess === "denied") {
      throw new GameAccessError(invitation ? "INVITATION_ACCESS_DENIED" : "GAME_NOT_FOUND");
    }
    if (!invitation && !membership && game.visibility === "private") {
      throw new GameAccessError("GAME_NOT_FOUND");
    }
    const owner = await this.repository.getMembership(gameId, game.ownerUserId as UserId);
    const players = await this.repository.getStatePlayers(gameId);
    const settings = readSettings(game.settingsJson);
    const memberMode = membership
      ? membershipMode(game.ownerUserId as UserId, viewer.userId, membership)
      : null;
    const capabilities = memberMode
      ? { canJoin: false, canSpectate: false, canReplay: memberMode === "replay" }
      : capabilitiesFor(game.status, settings.spectatingEnabled);
    const base = {
      name: game.name,
      ownerDisplayName: owner?.displayName ?? game.ownerUserId,
      status: game.status as GameEntryPreview["status"],
      ...(game.scheduledAt === null ? {} : { scheduledAt: game.scheduledAt }),
      playerCount: players.filter((player) => player.status !== "spectator").length,
      ...capabilities,
      ...(memberMode ? { membership: memberMode, gameId } : { membership: null }),
    };
    return base as GameEntryPreview;
  }
}

function readSettings(json: string) {
  const settings = JSON.parse(json) as { spectatingEnabled?: boolean };
  return { spectatingEnabled: settings.spectatingEnabled !== false };
}

function capabilitiesFor(status: string, spectatingEnabled: boolean) {
  if (status === "lobby" || status === "scheduled") {
    return { canJoin: true, canSpectate: spectatingEnabled, canReplay: false };
  }
  if (status === "running") {
    return spectatingEnabled
      ? { canJoin: false, canSpectate: true, canReplay: false }
      : {
          canJoin: false,
          canSpectate: false,
          canReplay: false,
          unavailableReason: "spectating_disabled" as const,
        };
  }
  if (status === "finished") {
    return spectatingEnabled
      ? { canJoin: false, canSpectate: false, canReplay: true }
      : {
          canJoin: false,
          canSpectate: false,
          canReplay: false,
          unavailableReason: "spectating_disabled" as const,
        };
  }
  return {
    canJoin: false,
    canSpectate: false,
    canReplay: false,
    unavailableReason: "cancelled" as const,
  };
}

function validateMode(status: string, spectatingEnabled: boolean, mode: GameEntryMode) {
  if (status === "cancelled") throw new GameAccessError("GAME_CANCELLED");
  if (mode === "player" && (status === "running" || status === "finished")) {
    throw new GameAccessError("GAME_ALREADY_STARTED");
  }
  if (mode === "spectator" && status === "finished") {
    throw new GameAccessError("GAME_ALREADY_STARTED");
  }
  if (mode === "replay" && status !== "finished") {
    throw new GameAccessError("GAME_NOT_STARTED");
  }
  if ((mode === "spectator" || mode === "replay") && !spectatingEnabled) {
    throw new GameAccessError("SPECTATING_DISABLED");
  }
}

function membershipMode(
  ownerUserId: UserId,
  viewerUserId: UserId,
  membership: { membershipAccess: string; status: string },
) {
  if (membership.membershipAccess === "replay") return "replay" as const;
  if (membership.status === "spectator") return "spectator" as const;
  return ownerUserId === viewerUserId ? ("owner" as const) : ("player" as const);
}

function admissionForMembership(gameId: GameId, access: string): GameAdmissionResult {
  return { gameId, destination: access === "replay" ? "replay" : "game" };
}
